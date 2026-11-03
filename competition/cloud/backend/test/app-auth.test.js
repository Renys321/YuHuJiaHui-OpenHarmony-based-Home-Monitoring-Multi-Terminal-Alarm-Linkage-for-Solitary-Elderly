'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseAppGuardianConfig, verifySessionToken } = require('../src/auth');
const { createApiServer } = require('../src/server');

const TOKEN_SECRET = 'app-auth-token-secret-at-least-32-characters';
const PASSWORD = 'app-auth-password-at-least-32-characters';

async function start(options = {}) {
  const appAuth = parseAppGuardianConfig('family-guardian', PASSWORD);
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: 'app-auth-ingest-key-at-least-32-characters',
    appAuth,
    authorizeIdentity: (identity) => identity === appAuth.subject,
    ...options
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  return {
    ...created,
    url: `http://127.0.0.1:${created.server.address().port}`,
    close: () => new Promise((resolve, reject) =>
      created.server.close((error) => error ? reject(error) : resolve()))
  };
}

async function login(app, guardianId, password) {
  return fetch(`${app.url}/api/v1/auth/app`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guardianId, password })
  });
}

test('APP guardian login issues a two-hour Bearer token accepted by household APIs', async (t) => {
  const app = await start();
  t.after(app.close);
  const response = await login(app, 'family-guardian', PASSWORD);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tokenType, 'Bearer');
  assert.equal(body.expiresIn, 7200);
  assert.equal(verifySessionToken(body.sessionToken, TOKEN_SECRET).sub, 'app:family-guardian');
  const overview = await fetch(`${app.url}/api/v1/overview`, {
    headers: { authorization: `Bearer ${body.sessionToken}` }
  });
  assert.equal(overview.status, 200);
});

test('APP login rejects bad credentials without returning a token', async (t) => {
  const app = await start();
  t.after(app.close);
  const response = await login(app, 'family-guardian', `${PASSWORD}-wrong`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid credentials' });
});

test('APP login rate limits repeated failures and exposes Retry-After', async (t) => {
  const app = await start();
  t.after(app.close);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await login(app, 'family-guardian', 'wrong-password')).status, 401);
  }
  const limited = await login(app, 'family-guardian', PASSWORD);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.deepEqual(await limited.json(), { error: 'too many attempts' });
});

test('APP and WeChat login endpoints fail closed when their provider is disabled', async (t) => {
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: 'app-auth-ingest-key-at-least-32-characters',
    authorizeIdentity: () => false
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) =>
    created.server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${created.server.address().port}`;
  assert.equal((await fetch(`${url}/api/v1/auth/app`, { method: 'POST' })).status, 503);
  assert.equal((await fetch(`${url}/api/v1/auth/wechat`, { method: 'POST' })).status, 503);
});
