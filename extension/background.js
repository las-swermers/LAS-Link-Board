const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

console.log('[LB] Background service worker loaded');

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'googleSignIn') {
    console.log('[LB] Received googleSignIn message');
    handleGoogleSignIn();
    sendResponse({ started: true });
  }
  return true;
});

async function handleGoogleSignIn() {
  // Clear any previous error/status
  await chrome.storage.local.remove(['lb_auth_error']);
  await chrome.storage.local.set({ lb_auth_pending: true });

  const redirectUrl = chrome.identity.getRedirectURL();
  console.log('[LB] Redirect URL:', redirectUrl);
  console.log('[LB] ↑ Make sure this EXACT URL is in Supabase → Auth → URL Configuration → Redirect URLs');

  // Build the OAuth URL with proper scopes
  const params = new URLSearchParams({
    provider: 'google',
    redirect_to: redirectUrl,
    scopes: 'openid email profile',
    // Force implicit flow to get tokens directly in the URL fragment
    response_type: 'token',
    // Skip the Supabase consent screen
    skip_http_redirect: 'true'
  });

  const authUrl = SUPABASE_URL + '/auth/v1/authorize?' + params.toString();
  console.log('[LB] Auth URL:', authUrl);
  console.log('[LB] Starting launchWebAuthFlow...');

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    });

    console.log('[LB] Got response URL:', responseUrl);
    console.log('[LB] Response URL length:', responseUrl?.length);

    if (!responseUrl) {
      throw new Error('No response URL returned from launchWebAuthFlow');
    }

    // Parse tokens — Supabase puts them in the hash fragment for implicit flow
    const url = new URL(responseUrl);
    const hashParams = new URLSearchParams(url.hash.substring(1));
    const queryParams = new URLSearchParams(url.search);

    // Log what we got for debugging
    console.log('[LB] Hash fragment keys:', [...hashParams.keys()].join(', '));
    console.log('[LB] Query param keys:', [...queryParams.keys()].join(', '));

    const accessToken = hashParams.get('access_token') || queryParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token') || queryParams.get('refresh_token');

    // If Supabase returned an authorization code instead (PKCE flow), exchange it
    const code = queryParams.get('code') || hashParams.get('code');
    if (!accessToken && code) {
      console.log('[LB] Got authorization code, exchanging for tokens (PKCE)...');
      return await exchangeCodeForTokens(code);
    }

    // Check for error in the response
    const error = hashParams.get('error') || queryParams.get('error');
    const errorDesc = hashParams.get('error_description') || queryParams.get('error_description');
    if (error) {
      throw new Error('OAuth error: ' + error + ' — ' + (errorDesc || 'no description'));
    }

    if (!accessToken) {
      const errMsg = 'No access_token in response. Hash: ' + url.hash.substring(0, 200) + ' | Search: ' + url.search.substring(0, 200);
      console.error('[LB]', errMsg);
      await chrome.storage.local.set({ lb_auth_error: errMsg, lb_auth_pending: false });
      return;
    }

    console.log('[LB] Got access token (' + accessToken.length + ' chars), fetching user info...');
    await saveSessionFromToken(accessToken, refreshToken);

  } catch (e) {
    console.error('[LB] OAuth error:', e.message || e);
    // "The user did not approve access" = user closed the window, not a real error
    const isUserCancel = (e.message || '').includes('user did not approve')
                      || (e.message || '').includes('canceled')
                      || (e.message || '').includes('cancelled');
    if (isUserCancel) {
      console.log('[LB] User cancelled sign-in, no error stored');
    } else {
      await chrome.storage.local.set({ lb_auth_error: e.message || 'Sign-in failed' });
    }
    await chrome.storage.local.set({ lb_auth_pending: false });
  }
}

// Exchange an authorization code for tokens (PKCE flow)
async function exchangeCodeForTokens(code) {
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=authorization_code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: '' // Supabase may not require this for the implicit-to-code fallback
      })
    });

    const data = await res.json();
    console.log('[LB] Token exchange response status:', res.status);

    if (!res.ok || !data.access_token) {
      const errMsg = 'Token exchange failed: ' + (data.error_description || data.error || JSON.stringify(data).substring(0, 200));
      console.error('[LB]', errMsg);
      await chrome.storage.local.set({ lb_auth_error: errMsg, lb_auth_pending: false });
      return;
    }

    await saveSessionFromToken(data.access_token, data.refresh_token);
  } catch (e) {
    console.error('[LB] Token exchange error:', e);
    await chrome.storage.local.set({ lb_auth_error: e.message || 'Token exchange failed', lb_auth_pending: false });
  }
}

// Fetch user info and save session to chrome.storage.local
async function saveSessionFromToken(accessToken, refreshToken) {
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + accessToken
      }
    });

    if (!userRes.ok) {
      const body = await userRes.text();
      throw new Error('User fetch failed (' + userRes.status + '): ' + body.substring(0, 200));
    }

    const user = await userRes.json();
    console.log('[LB] User response:', JSON.stringify(user).substring(0, 300));

    const name = user.user_metadata?.full_name
              || user.user_metadata?.name
              || user.email?.split('@')[0]
              || 'User';

    await chrome.storage.local.set({
      lb_token: accessToken,
      lb_refresh: refreshToken || '',
      lb_user_id: user.id,
      lb_user_name: name,
      lb_auth_pending: false
    });

    console.log('[LB] SUCCESS — saved to storage. User:', name, '| ID:', user.id);
  } catch (e) {
    console.error('[LB] Save session error:', e);
    await chrome.storage.local.set({ lb_auth_error: e.message || 'Failed to fetch user info', lb_auth_pending: false });
  }
}
