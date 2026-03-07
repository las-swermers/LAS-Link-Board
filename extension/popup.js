const SUPABASE_URL = 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtaG9lcXh1YW12cWx3c2F0b3p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTY2NDYsImV4cCI6MjA4ODM5MjY0Nn0.ktaozIz1XrIUeUrPjtKp3VZ92BptG8xehOFsv_ny12w';

async function init() {
  const stored = await chrome.storage.local.get(['lb_token', 'lb_user_id', 'lb_user_name']);
  if (stored.lb_token && stored.lb_user_id) {
    showMain(stored.lb_user_name || 'User');
  } else {
    document.getElementById('loginSection').style.display = 'block';
  }
}

// Listen for storage changes — if background worker saves credentials while popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lb_token && changes.lb_token.newValue) {
    const name = changes.lb_user_name?.newValue || 'User';
    showMain(name);
  }
});

// ── Google OAuth (delegated to background service worker) ──
document.getElementById('googleBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  document.getElementById('googleBtn').textContent = 'Signing in...';
  document.getElementById('googleBtn').disabled = true;

  // Delegate to background script so the flow survives popup closing
  chrome.runtime.sendMessage({ action: 'googleSignIn' }, (response) => {
    // If popup was closed during auth and reopened, response may be undefined
    if (chrome.runtime.lastError || !response) {
      // Not an error — popup may have closed and reopened, init() will handle it
      return;
    }
    if (response.error) {
      errEl.textContent = 'Sign-in error: ' + response.error;
      errEl.style.display = 'block';
      document.getElementById('googleBtn').textContent = 'Sign in with Google';
      document.getElementById('googleBtn').disabled = false;
    } else if (response.success) {
      showMain(response.name);
    }
  });
});

// ── Email/Password login ──
document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';

  if (!email || !password) { errEl.textContent = 'Enter email and password'; errEl.style.display = 'block'; return; }

  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    errEl.textContent = data.error_description || data.msg || 'Login failed';
    errEl.style.display = 'block';
    return;
  }

  const name = data.user?.user_metadata?.full_name || email.split('@')[0];
  await chrome.storage.local.set({
    lb_token: data.access_token,
    lb_refresh: data.refresh_token,
    lb_user_id: data.user.id,
    lb_user_name: name
  });
  showMain(name);
});

// ── Logout ──
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove(['lb_token', 'lb_refresh', 'lb_user_id', 'lb_user_name']);
  document.getElementById('mainSection').style.display = 'none';
  document.getElementById('loginSection').style.display = 'block';
});

function showMain(name) {
  document.getElementById('loginSection').style.display = 'none';
  document.getElementById('mainSection').style.display = 'block';
  document.getElementById('userInfo').textContent = 'Signed in as ' + name;
}

init();
