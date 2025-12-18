const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

function tokenHash(token) {
  // simple SHA256; store hash only
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function requireAuth({ getDb, runDb } = {}) {
  return async function authMiddleware(req, res, next) {
    if (req.session?.user?.id) return next();

    // Bearer token for mobile clients
    const auth = String(req.headers.authorization || '');
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && getDb) {
      const token = m[1].trim();
      const h = tokenHash(token);
      const row = await getDb(
        `SELECT t.user_id, u.email
           FROM api_tokens t
           JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ?
            AND t.revoked_at IS NULL
          LIMIT 1`,
        [h]
      ).catch(() => null);
      if (row?.user_id) {
        // Attach as req.authUser for downstream
        req.authUser = { id: row.user_id, email: row.email };
        // Best-effort update last_used_at
        if (runDb) {
          runDb('UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_hash = ?', [h]).catch(() => {});
        }
        return next();
      }
    }

    return res.status(401).json({ error: 'Not authenticated' });
  };
}

function attachApiAuthGuard(app, deps) {
  const middleware = requireAuth(deps);
  // Require auth for all API routes except /api/auth/*
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    // Public metadata endpoints (no user data)
    if (req.method === 'GET' && req.path === '/llm/models') return next();
    return middleware(req, res, next);
  });
}

function attachAuthRateLimit(app) {
  app.use('/api/auth', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false
  }));
}

function registerAuthRoutes(app, { csrfProtection, getDb, runDb, bcrypt, normalizeEmail }) {
  app.get('/api/auth/csrf', csrfProtection, (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });

  app.get('/api/auth/me', (req, res) => {
    const u = req.session?.user;
    if (!u) return res.json({ user: null });
    res.json({ user: { id: u.id, email: u.email } });
  });

  app.post('/api/auth/signup', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');
      if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

      const existing = await getDb('SELECT id FROM users WHERE email = ?', [email]);
      if (existing) return res.status(409).json({ error: 'Email already in use' });

      const hash = await bcrypt.hash(password, 12);
      const r = await runDb('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash]);
      req.session.user = { id: r.lastID, email };
      res.json({ message: 'Signed up', user: { id: r.lastID, email } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const user = await getDb('SELECT id, email, password_hash FROM users WHERE email = ?', [email]);
      if (!user) return res.status(401).json({ error: 'Invalid email or password' });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

      req.session.user = { id: user.id, email: user.email };
      res.json({ message: 'Logged in', user: { id: user.id, email: user.email } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(process.env.SESSION_COOKIE_NAME || 'ha.sid');
      res.json({ message: 'Logged out' });
    });
  });

  // Mobile login: returns a Bearer token (no cookies required)
  app.post('/api/auth/mobile-login', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');
      const label = req.body?.label ? String(req.body.label) : 'mobile';
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const user = await getDb('SELECT id, email, password_hash FROM users WHERE email = ?', [email]);
      if (!user) return res.status(401).json({ error: 'Invalid email or password' });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

      const token = crypto.randomBytes(32).toString('base64url');
      const h = tokenHash(token);
      await runDb('INSERT INTO api_tokens (user_id, token_hash, label) VALUES (?, ?, ?)', [user.id, h, label]);
      res.json({ token, user: { id: user.id, email: user.email } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  requireAuth,
  attachApiAuthGuard,
  attachAuthRateLimit,
  registerAuthRoutes
};

