// Google Health API — server-side OAuth token exchange/refresh.
//
// This exists ONLY because Google's OAuth token endpoint requires a
// client_secret for "Web application" registered clients even when the
// request includes a valid PKCE code_verifier — there is no secret-less
// public-client path for this client type. The secret lives ONLY here, read
// from the GOOGLE_HEALTH_CLIENT_SECRET environment variable, and is never
// sent to or embedded in the browser bundle. The Client ID is not secret and
// is safely duplicated client-side too (see src/lib/googleHealth.js).
//
// POST body: { action: 'exchange', code, code_verifier } -> Google token response
//         or { action: 'refresh',  refresh_token }        -> Google token response
//
// redirect_uri is fixed to https://www.google.com, Google's documented
// placeholder for apps with no server to receive an OAuth redirect callback
// (see developers.google.com/health/setup) — the user copies the `code`
// query param out of that URL by hand after consenting.

const CLIENT_ID = '269308035810-mgqjcge4ehso93rhsvh5bdq7bdjeo1gp.apps.googleusercontent.com';
const REDIRECT_URI = 'https://www.google.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const secret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
  if (!secret) {
    return res.status(500).json({
      error: 'no_secret',
      message: "Add GOOGLE_HEALTH_CLIENT_SECRET in the Vercel project's Settings -> Environment Variables, then redeploy.",
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { action, code, code_verifier, refresh_token } = body || {};

  const params = new URLSearchParams({ client_id: CLIENT_ID, client_secret: secret });

  if (action === 'exchange') {
    if (!code || !code_verifier) return res.status(400).json({ error: 'missing_params' });
    params.set('code', code);
    params.set('code_verifier', code_verifier);
    params.set('grant_type', 'authorization_code');
    params.set('redirect_uri', REDIRECT_URI);
  } else if (action === 'refresh') {
    if (!refresh_token) return res.status(400).json({ error: 'missing_params' });
    params.set('refresh_token', refresh_token);
    params.set('grant_type', 'refresh_token');
  } else {
    return res.status(400).json({ error: 'unknown_action' });
  }

  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    return res.status(200).json(j);
  } catch (e) {
    return res.status(502).json({ error: 'token_exchange_failed', message: String(e) });
  }
}
