const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'googleSignIn') {
    handleGoogleSignIn().then(sendResponse);
    return true; // keep channel open for async response
  }
});

async function handleGoogleSignIn() {
  const redirectUrl = chrome.identity.getRedirectURL();
  const authUrl = SUPABASE_URL + '/auth/v1/authorize?' + new URLSearchParams({
    provider: 'google',
    redirect_to: redirectUrl
  }).toString();

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    });

    // Supabase may return tokens in the hash fragment or query params
    const url = new URL(responseUrl);
    const hash = url.hash.substring(1);
    const params = new URLSearchParams(hash || url.search);
    let accessToken = params.get('access_token');
    let refreshToken = params.get('refresh_token');

    // If Supabase returned a code instead of a token, exchange it
    const code = params.get('code');
    if (!accessToken && code) {
      const tokenRes = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=pkce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
        body: JSON.stringify({ auth_code: code, code_verifier: '' })
      });
      const tokenData = await tokenRes.json();
      accessToken = tokenData.access_token;
      refreshToken = tokenData.refresh_token;
    }

    if (!accessToken) {
      return { error: 'No token received. Response: ' + responseUrl.substring(0, 200) };
    }

    // Fetch user info from Supabase
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + accessToken
      }
    });
    const user = await userRes.json();
    const name = user.user_metadata?.full_name || user.email?.split('@')[0] || 'User';

    await chrome.storage.local.set({
      lb_token: accessToken,
      lb_refresh: refreshToken,
      lb_user_id: user.id,
      lb_user_name: name
    });

    return { success: true, name };
  } catch (e) {
    return { error: e.message || 'Sign-in cancelled' };
  }
}
