// CRASS device-sync store.
// GET  /api/state?k=<64-hex>          -> { data, updatedAt } | { data: null }
// POST /api/state  { k, data, updatedAt } -> { ok: true }
// Backed by Vercel KV / Upstash Redis (REST). Set env vars when you attach a store:
//   KV_REST_API_URL + KV_REST_API_TOKEN   (Vercel KV)
//   or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN

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

  try {
    if (req.method === 'GET') {
      const k = String(req.query.k || '');
      if (!valid(k)) return res.status(400).json({ error: 'bad_key' });
      // Cheap metadata poll: return ONLY updatedAt (a few bytes) so idle clients
      // don't transfer the whole state blob every cycle. Falls back to (and
      // backfills) the timestamp from the blob for data written before this key existed.
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
    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}');
      const k = String(body.k || '');
      if (!valid(k)) return res.status(400).json({ error: 'bad_key' });
      const at = Number(body.updatedAt) || Date.now();
      const value = JSON.stringify({ data: body.data || {}, updatedAt: at });
      if (value.length > 5_000_000) return res.status(413).json({ error: 'too_large' });
      // Atomic single-command write of the blob + its small companion timestamp
      // key, so the `?meta=1` poll can never advertise a stale updatedAt.
      await redis(['MSET', `crass:state:${k}`, value, `crass:at:${k}`, String(at)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: String((e && e.message) || e) });
  }
}
