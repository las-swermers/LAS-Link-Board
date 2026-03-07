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

// ── PKCE Helpers ──

function generateRandomString(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return await crypto.subtle.digest('SHA-256', data);
}

function base64urlencode(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Main OAuth Flow ──

async function handleGoogleSignIn() {
  // Clear any previous error/status
  await chrome.storage.local.remove(['lb_auth_error']);
  await chrome.storage.local.set({ lb_auth_pending: true });

  const redirectUrl = chrome.identity.getRedirectURL();
  console.log('[LB] Redirect URL:', redirectUrl);
  console.log('[LB] ↑ This EXACT URL must be in Supabase → Auth → URL Configuration → Redirect URLs');

  // Generate PKCE code verifier and challenge
  const codeVerifier = generateRandomString(64);
  const codeChallenge = base64urlencode(await sha256(codeVerifier));
  console.log('[LB] Generated PKCE code_verifier (' + codeVerifier.length + ' chars)');

  // Build the OAuth URL — use PKCE (code) flow, not implicit (token)
  const params = new URLSearchParams({
    provider: 'google',
    redirect_to: redirectUrl,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scopes: 'openid email profile'
  });

  const authUrl = SUPABASE_URL + '/auth/v1/authorize?' + params.toString();
  console.log('[LB] Auth URL:', authUrl);
  console.log('[LB] Starting launchWebAuthFlow...');

  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    });

    console.log('[LB] Got response URL:', responseUrl?.substring(0, 200));

    if (!responseUrl) {
      throw new Error('No response URL returned from launchWebAuthFlow');
    }

    // Parse the response URL
    const url = new URL(responseUrl);
    const hashParams = new URLSearchParams(url.hash.substring(1));
    const queryParams = new URLSearchParams(url.search);

    // Log what we got
    console.log('[LB] Hash keys:', [...hashParams.keys()].join(', ') || '(none)');
    console.log('[LB] Query keys:', [...queryParams.keys()].join(', ') || '(none)');

    // Check for errors first
    const error = hashParams.get('error') || queryParams.get('error');
    const errorDesc = hashParams.get('error_description') || queryParams.get('error_description');
    if (error) {
      throw new Error('OAuth error: ' + error + ' — ' + (errorDesc || 'no description'));
    }

    // Try to get access_token directly (implicit flow — may work on older Supabase)
    const accessToken = hashParams.get('access_token') || queryParams.get('access_token');
    if (accessToken) {
      console.log('[LB] Got access_token directly (implicit flow)');
      const refreshToken = hashParams.get('refresh_token') || queryParams.get('refresh_token');
      await saveSessionFromToken(accessToken, refreshToken);
      return;
    }

    // Get the authorization code (PKCE flow — expected path)
    const code = queryParams.get('code') || hashParams.get('code');
    if (code) {
      console.log('[LB] Got authorization code (' + code.length + ' chars), exchanging with PKCE...');
      await exchangeCodeForTokens(code, codeVerifier);
      return;
    }

    // Neither token nor code — something went wrong
    const errMsg = 'No token or code in response. Full URL: ' + responseUrl.substring(0, 500);
    console.error('[LB]', errMsg);
    await chrome.storage.local.set({ lb_auth_error: errMsg, lb_auth_pending: false });

  } catch (e) {
    console.error('[LB] OAuth error:', e.message || e);
    const msg = e.message || '';
    const isUserCancel = msg.includes('user did not approve')
                      || msg.includes('canceled')
                      || msg.includes('cancelled');
    if (isUserCancel) {
      console.log('[LB] User cancelled sign-in');
    } else {
      await chrome.storage.local.set({ lb_auth_error: msg || 'Sign-in failed' });
    }
    await chrome.storage.local.set({ lb_auth_pending: false });
  }
}

// Exchange authorization code for tokens using PKCE code_verifier
async function exchangeCodeForTokens(code, codeVerifier) {
  try {
    console.log('[LB] POSTing to /auth/v1/token with grant_type=authorization_code...');

    const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=authorization_code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: codeVerifier
      })
    });

    const data = await res.json();
    console.log('[LB] Token exchange status:', res.status);
    console.log('[LB] Token exchange keys:', Object.keys(data).join(', '));

    if (!res.ok || !data.access_token) {
      const errMsg = 'Token exchange failed (' + res.status + '): '
        + (data.error_description || data.error || data.msg || JSON.stringify(data).substring(0, 300));
      console.error('[LB]', errMsg);
      await chrome.storage.local.set({ lb_auth_error: errMsg, lb_auth_pending: false });
      return;
    }

    console.log('[LB] Token exchange successful, got access_token');
    await saveSessionFromToken(data.access_token, data.refresh_token);
  } catch (e) {
    console.error('[LB] Token exchange error:', e);
    await chrome.storage.local.set({ lb_auth_error: e.message || 'Token exchange failed', lb_auth_pending: false });
  }
}

// Fetch user info and save session to chrome.storage.local
async function saveSessionFromToken(accessToken, refreshToken) {
  try {
    console.log('[LB] Fetching user info from /auth/v1/user...');

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
    console.log('[LB] User:', JSON.stringify(user).substring(0, 300));

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

    console.log('[LB] ✓ SUCCESS — saved to storage. User:', name, '| ID:', user.id);
  } catch (e) {
    console.error('[LB] Save session error:', e);
    await chrome.storage.local.set({ lb_auth_error: e.message || 'Failed to fetch user info', lb_auth_pending: false });
  }
}
