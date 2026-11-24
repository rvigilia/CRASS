// Ash's voice: turns a short line of text into speech with Inworld TTS.
//
//   POST /api/speak { acct, authToken, text } -> { audio: <base64 mp3>, mime, lipsync? } | { error }
//   lipsync = { v: OpenXR visemes, s: start seconds, e: end seconds } for Ash's mouth (v0.53)
//
// The Inworld key lives only in Vercel env (INWORLD_API_KEY, the Base64 credential from
// the Inworld portal, sent as-is). Same owner-only check as /api/assistant. A daily
// character cap (ASH_TTS_DAILY_CHARS, default 20000 ≈ 20 min of speech, under $0.50)
// bounds the cost. The voice is INWORLD_VOICE (default "Brooke"): a voiceId, or the
// display name of one of the account's own voices, looked up once and cached.
// Nothing is stored except the counter and that lookup.
//
// Env: INWORLD_API_KEY, KV_*; optional INWORLD_VOICE, INWORLD_MODEL (default
// inworld-tts-2; inworld-tts-2-flash is cheaper), ASH_TTS_DAILY_CHARS.
import { cors, readBody, kv, checkCaller, spend, refund, storeDown } from './_ash.js';

export const config = { maxDuration: 30 };

const MAX_TEXT = 600;
const API = 'https://api.inworld.ai';

async function resolveVoice(redis, key, wanted) {
  const cacheK = `crass:ash:voice:${wanted.toLowerCase()}`;
  const cached = await redis(['GET', cacheK]).catch(() => null);
  if (cached) return cached;
  let id = wanted;
  try {
    const r = await fetch(`${API}/voices/v1/voices?pageSize=500`, { headers: { Authorization: `Basic ${key}` } });
    const j = await r.json();
    const list = Array.isArray(j.voices) ? j.voices : [];
    const lc = wanted.toLowerCase();
    // the account's own voice (a clone named "Brooke") wins over a stock voice of the same name
    const own = (v) => v.source && v.source !== 'SYSTEM';
    const hit = list.find((v) => own(v) && String(v.displayName || '').toLowerCase() === lc)
      || list.find((v) => own(v) && String(v.voiceId).toLowerCase() === lc)
      || list.find((v) => String(v.voiceId).toLowerCase() === lc)
      || list.find((v) => String(v.displayName || '').toLowerCase() === lc)
      || list.find((v) => String(v.voiceId).toLowerCase().endsWith(`__${lc}`));
    if (hit) {
      id = hit.voiceId;
      try { await redis(['SET', cacheK, id, 'EX', '86400']); } catch { /* ignore */ }   // cache only a real match
    }
  } catch { /* list failed: try the name as given, look it up again next time */ }
  return id;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const key = process.env.INWORLD_API_KEY;
  if (!key) return res.status(503).json({ error: 'no_voice_key', message: 'Ash’s voice isn’t set up yet: add INWORLD_API_KEY in Vercel.' });
  const redis = kv();
  if (!redis) return res.status(500).json({ error: 'no_store' });

  try {
    const body = readBody(req);
    const denied = await checkCaller(redis, body);
    if (denied) return res.status(denied[0]).json(denied[1]);

    const text = String(body.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return res.status(400).json({ error: 'empty' });
    if (text.length > MAX_TEXT) return res.status(413).json({ error: 'too_long' });

    const limit = Number(process.env.ASH_TTS_DAILY_CHARS) || 20000;
    const capKey = `crass:ashtts:${body.acct}`;
    const [, ok] = await spend(redis, capKey, text.length, limit);
    if (!ok) return res.status(429).json({ error: 'daily_limit', message: 'Ash has talked enough for today (daily voice limit).' });

    const voiceId = await resolveVoice(redis, key, String(process.env.INWORLD_VOICE || 'Brooke'));
    const modelId = String(process.env.INWORLD_MODEL || 'inworld-tts-2');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    // lipsyncConfig: timed mouth shapes (OpenXR visemes) for Ash's hologram. If Inworld ever
    // refuses it, the line is asked for again without it (the avatar falls back to loudness).
    const ask = (lipsync) => fetch(`${API}/tts/v1/voice`, {
      method: 'POST',
      headers: { Authorization: `Basic ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, voiceId, modelId, audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000 }, ...(lipsync ? { lipsyncConfig: {} } : {}) }),
      signal: ctl.signal,
    });
    let r;
    try {
      r = await ask(true);
      if (r.status === 400) r = await ask(false);
    } catch (e) {
      await refund(redis, capKey, text.length);
      throw e;
    } finally { clearTimeout(timer); }
    const out = await r.json().catch(() => null);
    if (!r.ok || !out || !out.audioContent) {
      await refund(redis, capKey, text.length);
      const msg = (out && (out.message || (out.error && out.error.message))) || 'The voice service did not answer.';
      if (/voice/i.test(msg) && /not found|unknown/i.test(msg)) { try { await redis(['DEL', `crass:ash:voice:${String(process.env.INWORLD_VOICE || 'Brooke').toLowerCase()}`]); } catch { /* ignore */ } }
      return res.status(502).json({ error: 'upstream', status: r.status, message: msg });
    }
    // { v: [viseme], s: [start s], e: [end s] } when Inworld sent them (they may be absent)
    const la = out.timestampInfo && out.timestampInfo.lipsyncAlignment;
    const lipsync = la && Array.isArray(la.visemes) && la.visemes.length
      && la.visemes.length === (la.visemeStartTimeSeconds || []).length && la.visemes.length === (la.visemeEndTimeSeconds || []).length
      ? { v: la.visemes, s: la.visemeStartTimeSeconds, e: la.visemeEndTimeSeconds } : undefined;
    return res.status(200).json({ audio: out.audioContent, mime: 'audio/mpeg', lipsync });
  } catch (e) {
    if (e && e.kv) return storeDown(res);
    const aborted = e && e.name === 'AbortError';
    return res.status(aborted ? 504 : 500).json({ error: aborted ? 'timeout' : 'server_error', message: aborted ? 'The voice took too long.' : String((e && e.message) || e) });
  }
}
