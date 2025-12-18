(function () {
  let currentUser = null;
  let csrfToken = null;
  let fetchWrapped = false;
  const LAST_EMAIL_KEY = 'ha_last_email_v1';

  function setAuthError(msg) {
    const el = document.getElementById('authError');
    if (!el) return;
    if (!msg) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'block';
    el.textContent = msg;
  }

  function showAuthGate(show) {
    const gate = document.getElementById('authGate');
    if (gate) gate.style.display = show ? 'flex' : 'none';

    const badge = document.getElementById('authUserBadge');
    const emailEl = document.getElementById('authUserEmail');
    if (badge && currentUser) {
      badge.style.display = show ? 'none' : 'flex';
      if (emailEl) emailEl.textContent = currentUser.email || '';
    } else if (badge) {
      badge.style.display = 'none';
    }
  }

  function switchAuthTab(tab) {
    const login = document.getElementById('loginForm');
    const signup = document.getElementById('signupForm');
    const tabLogin = document.getElementById('authTabLogin');
    const tabSignup = document.getElementById('authTabSignup');
    setAuthError('');

    if (tab === 'signup') {
      if (login) login.style.display = 'none';
      if (signup) signup.style.display = 'block';
      if (tabLogin) tabLogin.classList.remove('active');
      if (tabSignup) tabSignup.classList.add('active');
    } else {
      if (login) login.style.display = 'block';
      if (signup) signup.style.display = 'none';
      if (tabLogin) tabLogin.classList.add('active');
      if (tabSignup) tabSignup.classList.remove('active');
    }
  }

  async function ensureCsrfToken() {
    const resp = await fetch('/api/auth/csrf', { credentials: 'include' });
    const data = await resp.json();
    if (resp.ok && data.csrfToken) csrfToken = data.csrfToken;

    if (!fetchWrapped) {
      fetchWrapped = true;
      const orig = window.fetch.bind(window);
      window.fetch = (url, options = {}) => {
        const opts = options || {};
        opts.credentials = opts.credentials || 'include';
        const method = (opts.method || 'GET').toUpperCase();
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          opts.headers = opts.headers || {};
          if (csrfToken && !opts.headers['X-CSRF-Token'] && !opts.headers['x-csrf-token']) {
            opts.headers['X-CSRF-Token'] = csrfToken;
          }
        }
        return orig(url, opts).then((r) => {
          try {
            const u = String(url || '');
            if (r.status === 401 && !u.startsWith('/api/auth')) {
              currentUser = null;
              showAuthGate(true);
            }
          } catch (e) {
            // ignore
          }
          return r;
        });
      };
    }
  }

  async function refreshAuthState() {
    try {
      const resp = await fetch('/api/auth/me', { credentials: 'include' });
      const data = await resp.json();
      currentUser = data?.user || null;
      showAuthGate(!currentUser);
      return currentUser;
    } catch (e) {
      currentUser = null;
      showAuthGate(true);
      return null;
    }
  }

  async function handleLogin(e, onAuthenticated) {
    e.preventDefault();
    setAuthError('');
    try {
      await ensureCsrfToken();
      const email = document.getElementById('loginEmail')?.value || '';
      const password = document.getElementById('loginPassword')?.value || '';
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await resp.json();
      if (!resp.ok) {
        setAuthError(data.error || 'Login failed');
        return;
      }
      currentUser = data.user;
      try { localStorage.setItem(LAST_EMAIL_KEY, email); } catch {}
      showAuthGate(false);
      if (typeof onAuthenticated === 'function') onAuthenticated(currentUser);
    } catch (e2) {
      setAuthError('Network error logging in');
    }
  }

  async function handleSignup(e, onAuthenticated) {
    e.preventDefault();
    setAuthError('');
    try {
      await ensureCsrfToken();
      const email = document.getElementById('signupEmail')?.value || '';
      const password = document.getElementById('signupPassword')?.value || '';
      const resp = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await resp.json();
      if (!resp.ok) {
        setAuthError(data.error || 'Sign up failed');
        return;
      }
      currentUser = data.user;
      try { localStorage.setItem(LAST_EMAIL_KEY, email); } catch {}
      showAuthGate(false);
      if (typeof onAuthenticated === 'function') onAuthenticated(currentUser);
    } catch (e2) {
      setAuthError('Network error signing up');
    }
  }

  async function handleLogout(onLogout) {
    try {
      await ensureCsrfToken();
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      // ignore
    }
    currentUser = null;
    showAuthGate(true);
    if (typeof onLogout === 'function') onLogout();
  }

  async function init({ onAuthenticated, onLogout } = {}) {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => handleLogout(onLogout));

    const loginForm = document.getElementById('loginForm');
    const signupForm = document.getElementById('signupForm');
    if (loginForm) loginForm.addEventListener('submit', (e) => handleLogin(e, onAuthenticated));
    if (signupForm) signupForm.addEventListener('submit', (e) => handleSignup(e, onAuthenticated));

    const tabLogin = document.getElementById('authTabLogin');
    const tabSignup = document.getElementById('authTabSignup');
    if (tabLogin) tabLogin.addEventListener('click', () => switchAuthTab('login'));
    if (tabSignup) tabSignup.addEventListener('click', () => switchAuthTab('signup'));

    // Remember last-used email for convenience
    try {
      const last = localStorage.getItem(LAST_EMAIL_KEY);
      const loginEmail = document.getElementById('loginEmail');
      const signupEmail = document.getElementById('signupEmail');
      if (last && loginEmail && !loginEmail.value) loginEmail.value = last;
      if (last && signupEmail && !signupEmail.value) signupEmail.value = last;
    } catch {}

    await ensureCsrfToken();
    await refreshAuthState();
    if (currentUser && typeof onAuthenticated === 'function') onAuthenticated(currentUser);
    return currentUser;
  }

  window.AuthClient = {
    init,
    ensureCsrfToken,
    refreshAuthState,
    getCurrentUser: () => currentUser,
    getCsrfToken: () => csrfToken
  };
})();

