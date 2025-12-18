const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const PORT = 3101;
const BASE = `http://localhost:${PORT}`;

let proc;

function waitForLine(child, matcher, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for server')), timeoutMs);
    function onData(buf) {
      const s = buf.toString('utf8');
      if (matcher.test(s)) {
        clearTimeout(t);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve();
      }
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function cookieHeaderFrom(setCookies) {
  // setCookies: array like ["ha.sid=...; Path=/; HttpOnly", ...]
  const parts = (setCookies || []).map(c => c.split(';')[0]).filter(Boolean);
  return parts.join('; ');
}

async function fetchWithCookies(url, opts, jar) {
  const headers = Object.assign({}, opts?.headers || {});
  if (jar.cookie) headers.Cookie = jar.cookie;
  const res = await fetch(url, { ...opts, headers });
  // Node fetch (undici) supports headers.getSetCookie()
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const newCookie = cookieHeaderFrom(sc);
  if (newCookie) jar.cookie = jar.cookie ? `${jar.cookie}; ${newCookie}` : newCookie;
  return res;
}

async function getCsrf(jar) {
  const res = await fetchWithCookies(`${BASE}/api/auth/csrf`, { method: 'GET' }, jar);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.csrfToken);
  return body.csrfToken;
}

async function signup(jar, email, password) {
  const token = await getCsrf(jar);
  const res = await fetchWithCookies(
    `${BASE}/api/auth/signup`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token
      },
      body: JSON.stringify({ email, password })
    },
    jar
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.email, email.toLowerCase());
}

async function postActivity(jar, date, steps) {
  const token = await getCsrf(jar);
  const res = await fetchWithCookies(
    `${BASE}/api/activity`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token
      },
      body: JSON.stringify({ date, steps })
    },
    jar
  );
  assert.equal(res.status, 200);
}

async function listActivity(jar) {
  const res = await fetchWithCookies(`${BASE}/api/activity`, { method: 'GET' }, jar);
  assert.equal(res.status, 200);
  return await res.json();
}

before(async () => {
  proc = spawn('npm', ['start'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForLine(proc, new RegExp(`http://localhost:${PORT}`));
});

after(async () => {
  if (proc) proc.kill('SIGINT');
});

test('requires auth for private API', async () => {
  const res = await fetch(`${BASE}/api/activity`);
  assert.equal(res.status, 401);
});

test('CSRF blocks state-changing requests without token', async () => {
  const jar = { cookie: '' };
  // Create session cookie
  await getCsrf(jar);
  const res = await fetchWithCookies(
    `${BASE}/api/auth/signup`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@y.com', password: 'password123' }) },
    jar
  );
  assert.equal(res.status, 403);
});

test('data is isolated per user', async () => {
  const jar1 = { cookie: '' };
  const jar2 = { cookie: '' };

  const email1 = `u1_${Date.now()}@example.com`;
  const email2 = `u2_${Date.now()}@example.com`;

  await signup(jar1, email1, 'password123');
  await signup(jar2, email2, 'password123');

  await postActivity(jar1, '2025-12-12', 1111);
  await postActivity(jar2, '2025-12-12', 2222);

  const a1 = await listActivity(jar1);
  const a2 = await listActivity(jar2);

  assert.ok(a1.some(r => r.steps === 1111));
  assert.ok(!a1.some(r => r.steps === 2222));

  assert.ok(a2.some(r => r.steps === 2222));
  assert.ok(!a2.some(r => r.steps === 1111));
});

