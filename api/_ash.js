// Shared by api/assistant.js and api/speak.js (a leading "_" keeps Vercel from serving
// this file as its own endpoint). Same account check as api/state.js, plus the owner
// allow-list (ASSISTANT_EMAILS, comma-separated; defaults to the owner).
import crypto from 'crypto';

const OWNER_EMAIL = 'ryan.vigilia@gmail.com';
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sha256hexOfB64 = (b64) => crypto.createHash('sha256').update(Buffer.from(String(b64 || ''), 'base64')).digest('hex');
const accountIdFor = (email) => sha256hex('crass-acct::' + String(email || '').trim().toLowerCase());

export function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return true; }
  return false;
}

export const readBody = (req) => ((req.body && typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}'));

// Upstash / Vercel KV REST. A store failure throws { kv: true } (not "signed out").
export function kv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return null;
  return async (cmd) => {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
    const j = await r.json();
    if (j && j.error) throw Object.assign(new Error('kv'), { kv: true });
    return j.result;
  };
}

// -> null when allowed, else [status, body]
export async function checkCaller(redis, body) {
  const acct = String(body.acct || '');
  if (!/^[a-f0-9]{64}$/.test(acct)) return [401, { error: 'auth' }];
  const allowed = String(process.env.ASSISTANT_EMAILS || OWNER_EMAIL).split(',').map((e) => e.trim()).filter(Boolean).map(accountIdFor);
  if (!allowed.includes(acct)) return [403, { error: 'not_allowed', message: 'The assistant is only enabled for the owner account.' }];
  const recRaw = await redis(['GET', `crass:acctrec:${acct}`]);
  let record = null; try { record = JSON.parse(recRaw || 'null'); } catch { /* corrupt */ }
  const tok = sha256hexOfB64(body.authToken);
  if (!record || !(tok === record.authHashP || tok === record.authHashR)) return [401, { error: 'auth' }];
  return null;
}

const dayKey = (key) => `${key}:${new Date().toISOString().slice(0, 10)}`;

// Gives back what a failed upstream call spent, so errors don't eat the daily cap.
export async function refund(redis, key, amount) {
  try { await redis(['INCRBY', dayKey(key), String(-amount)]); } catch { /* best effort */ }
}

// Adds `amount` to today's counter; -> [used, ok] (ok false once over `limit`).
export async function spend(redis, key, amount, limit) {
  const dayK = dayKey(key);
  const used = Number(await redis(['INCRBY', dayK, String(amount)]));
  if (!Number.isFinite(used) || used < amount) throw Object.assign(new Error('kv'), { kv: true });
  if (used === amount) { try { await redis(['EXPIRE', dayK, '172800']); } catch { /* ignore */ } }
  return [used, used <= limit];
}

export const storeDown = (res) => res.status(503).json({ error: 'store', message: 'The data store is unavailable. Try again shortly.' });
