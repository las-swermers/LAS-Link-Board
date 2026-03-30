// ═══════════════════════════════════════════════════
// Google OAuth Start — GET /api/voicenotes/google-auth
// ═══════════════════════════════════════════════════
//
// Redirects the user to Google's OAuth consent screen.
// After consent, Google redirects back to google-auth-callback.
//
// Query params: ?supabase_token=xxx (to identify the user)

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const REDIRECT_URI = 'https://las-link-board.vercel.app/api/voicenotes/google-auth-callback';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabaseToken = req.query.supabase_token || '';
  if (!supabaseToken) {
    return res.status(400).send('Missing supabase_token parameter');
  }

  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).send('GOOGLE_CLIENT_ID not configured');
  }

  // Build Google OAuth URL
  // Pass supabase_token in state so we can identify the user in the callback
  const state = Buffer.from(JSON.stringify({ supabase_token: supabaseToken })).toString('base64');

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',     // get a refresh_token
    prompt: 'consent',          // always show consent to get refresh_token
    state: state
  }).toString();

  res.redirect(302, authUrl);
};
