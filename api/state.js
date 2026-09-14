// CRASS sync + zero-knowledge account store.
//
// LEGACY passphrase sync (unchanged, still supported):
//   GET  /api/state?k=<64hex>[&meta=1]        -> { data, updatedAt } | { updatedAt }
//   POST /api/state  { k, data, updatedAt }   -> { ok:true }
//
// ACCOUNTS (end-to-end encrypted; the server only ever sees ciphertext + hashes):
//   GET  /api/state?acct=<64hex>[&meta=1]     -> { exists, record, blob, updatedAt }
//   POST { action:'create', acct, record, blob, updatedAt }              -> { ok } | { error:'exists' }
//   POST { action:'write',  acct, authToken, blob, updatedAt }           -> { ok } | { error:'auth' }
//   POST { action:'rekey',  acct, authToken, salt, authHashP, wrapP }    -> { ok } | { error:'auth' }
// `record` = { v, salt, saltR, authHashP, authHashR, wrapP, wrapR }. The server can
// authenticate writes (via SHA-256(authToken) == authHashP|authHashR) but can NEVER
// decrypt `blob` or the wrapped keys — that needs the user's password or recovery code.
//
// Backed by Vercel KV / Upstash Redis (REST). Env vars:
//   KV_REST_API_URL + KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL + _TOKEN)

import crypto from 'crypto';

const sha256hexOfB64 = (b64) => crypto.createHash('sha256').update(Buffer.from(String(b64 || ''), 'base64')).digest('hex');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return res.status(500).json({ error: 'no_store', message: 'No KV store attached. Add a Vercel KV / Upstash store and its env vars.' });
  }

  const redis = async (cmd) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const j = await r.json();
    return j.result;
  };

  const valid = (k) => /^[a-f0-9]{64}$/.test(k || '');
  // account redis keys
  const recK = (a) => `crass:acctrec:${a}`;
  const blobK = (a) => `crass:acctblob:${a}`;
  const atK = (a) => `crass:acctat:${a}`;

  try {
    // -------------------------------------------------------------- GET
    if (req.method === 'GET') {
      const acct = String(req.query.acct || '');
      if (acct) {
        if (!valid(acct)) return res.status(400).json({ error: 'bad_key' });
        if (req.query.meta) {
          const at = await redis(['GET', atK(acct)]);
          return res.status(200).json({ exists: at != null, updatedAt: Number(at) || 0 });
        }
        const recRaw = await redis(['GET', recK(acct)]);
        if (!recRaw) return res.status(200).json({ exists: false });
        let record; try { record = JSON.parse(recRaw); } catch { record = null; }
        const blob = await redis(['GET', blobK(acct)]);
        const at = await redis(['GET', atK(acct)]);
        return res.status(200).json({ exists: true, record, blob: blob || null, updatedAt: Number(at) || 0 });
      }
      // legacy passphrase mode
      const k = String(req.query.k || '');
      if (!valid(k)) return res.status(400).json({ error: 'bad_key' });
      if (req.query.meta) {
        let at = await redis(['GET', `crass:at:${k}`]);
        if (at == null) {
          const raw = await redis(['GET', `crass:state:${k}`]);
          if (raw) { try { at = String(Number(JSON.parse(raw).updatedAt) || 0); } catch { at = '0'; } }
          else at = '0';
          if (at !== '0') { try { await redis(['SET', `crass:at:${k}`, at]); } catch { /* ignore */ } }
        }
        return res.status(200).json({ updatedAt: Number(at) || 0 });
      }
      const raw = await redis(['GET', `crass:state:${k}`]);
      if (!raw) return res.status(200).json({ data: null });
      let parsed; try { parsed = JSON.parse(raw); } catch { parsed = { data: null }; }
      return res.status(200).json(parsed);
    }

    // -------------------------------------------------------------- POST
    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}');

      // ---- account actions ----
      if (body.action) {
        const acct = String(body.acct || '');
        if (!valid(acct)) return res.status(400).json({ error: 'bad_key' });

        if (body.action === 'create') {
          const exists = await redis(['GET', recK(acct)]);
          if (exists) return res.status(409).json({ error: 'exists' });
          const rec = body.record || {};
          if (!rec.salt || !rec.saltR || !rec.authHashP || !rec.authHashR || !rec.wrapP || !rec.wrapR) {
            return res.status(400).json({ error: 'bad_record' });
          }
          const at = Number(body.updatedAt) || Date.now();
          const blob = String(body.blob || '');
          if (blob.length > 6_000_000) return res.status(413).json({ error: 'too_large' });
          await redis(['MSET', recK(acct), JSON.stringify(rec), blobK(acct), blob, atK(acct), String(at)]);
          return res.status(200).json({ ok: true });
        }

        // both write + rekey require a valid auth token (proves password or recovery code)
        const recRaw = await redis(['GET', recK(acct)]);
        if (!recRaw) return res.status(404).json({ error: 'notfound' });
        let record; try { record = JSON.parse(recRaw); } catch { return res.status(500).json({ error: 'corrupt' }); }
        const tokHash = sha256hexOfB64(body.authToken);
        const authed = tokHash === record.authHashP || tokHash === record.authHashR;
        if (!authed) return res.status(401).json({ error: 'auth' });

        if (body.action === 'write') {
          const at = Number(body.updatedAt) || Date.now();
          const blob = String(body.blob || '');
          if (blob.length > 6_000_000) return res.status(413).json({ error: 'too_large' });
          await redis(['MSET', blobK(acct), blob, atK(acct), String(at)]);
          return res.status(200).json({ ok: true });
        }
        if (body.action === 'rekey') {
          if (!body.salt || !body.authHashP || !body.wrapP) return res.status(400).json({ error: 'bad_record' });
          const next = { ...record, salt: body.salt, authHashP: body.authHashP, wrapP: body.wrapP };
          await redis(['SET', recK(acct), JSON.stringify(next)]);
          return res.status(200).json({ ok: true });
        }
        return res.status(400).json({ error: 'bad_action' });
      }

      // ---- legacy passphrase write ----
      const k = String(body.k || '');
      if (!valid(k)) return res.status(400).json({ error: 'bad_key' });
      const at = Number(body.updatedAt) || Date.now();
      const value = JSON.stringify({ data: body.data || {}, updatedAt: at });
      if (value.length > 5_000_000) return res.status(413).json({ error: 'too_large' });
      await redis(['MSET', `crass:state:${k}`, value, `crass:at:${k}`, String(at)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String((e && e.message) || e) });
  }
}
