// ═══════════════════════════════════════════════════
// Google OAuth Callback — GET /api/voicenotes/google-auth-callback
// ═══════════════════════════════════════════════════
//
// Google redirects here after user consents.
// Exchanges the auth code for tokens and stores them in Supabase.

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'https://las-link-board.vercel.app/api/voicenotes/google-auth-callback';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

module.exports = async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send('<html><body><h2>Authorization cancelled</h2><p>' + error + '</p><script>setTimeout(()=>window.close(),2000)</script></body></html>');
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  // Decode state to get supabase_token
  let supabaseToken;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
    supabaseToken = decoded.supabase_token;
  } catch (e) {
    return res.status(400).send('Invalid state parameter');
  }

  // Get the user from Supabase token
  let userId;
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + supabaseToken }
    });
    if (!userRes.ok) return res.status(401).send('Invalid Supabase session');
    const user = await userRes.json();
    userId = user.id;
  } catch (e) {
    return res.status(401).send('Auth check failed');
  }

  // Exchange code for tokens
  let tokens;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      }).toString()
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return res.status(400).send('Token exchange failed: ' + errText);
    }
    tokens = await tokenRes.json();
  } catch (e) {
    return res.status(502).send('Token exchange error: ' + e.message);
  }

  // Store tokens in orah_settings (upsert)
  try {
    const headers = {
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };

    // Check if settings row exists
    const checkRes = await fetch(
      SUPABASE_URL + '/rest/v1/orah_settings?user_id=eq.' + userId + '&limit=1',
      { headers }
    );
    const existing = checkRes.ok ? await checkRes.json() : [];

    const tokenData = {
      google_access_token: tokens.access_token,
      google_refresh_token: tokens.refresh_token || '',
      google_token_expiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    };

    if (existing.length > 0) {
      await fetch(SUPABASE_URL + '/rest/v1/orah_settings?user_id=eq.' + userId, {
        method: 'PATCH', headers, body: JSON.stringify(tokenData)
      });
    } else {
      await fetch(SUPABASE_URL + '/rest/v1/orah_settings', {
        method: 'POST', headers,
        body: JSON.stringify({ user_id: userId, ...tokenData })
      });
    }
  } catch (e) {
    return res.status(500).send('Failed to store tokens: ' + e.message);
  }

  // Success — show a nice page that closes itself
  res.send(`<!DOCTYPE html>
<html>
<head><style>
  body { font-family: 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #F8F9FA; color: #0B2545; }
  .card { background: #fff; border-radius: 16px; padding: 2.5rem; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.1); max-width: 400px; }
  h2 { font-family: 'Montserrat', sans-serif; color: #0B2545; margin-bottom: 0.5rem; }
  p { color: #6B7C8D; font-size: 0.9rem; }
  .check { font-size: 3rem; margin-bottom: 1rem; }
</style></head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h2>Google Calendar Connected!</h2>
    <p>You can close this window. Transport requests will now auto-add to your calendar.</p>
    <script>setTimeout(() => window.close(), 3000);</script>
  </div>
</body>
</html>`);
};
