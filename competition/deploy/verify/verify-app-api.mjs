#!/usr/bin/env node

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

function baseUrl() {
  const parsed = new URL(required('API_BASE_URL'));
  const localHttp = process.env.ALLOW_HTTP_LOCAL === '1' &&
    parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) throw new Error('API_BASE_URL must use HTTPS');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('API_BASE_URL must not contain credentials, query or fragment');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('API_BASE_URL must be the origin without a path');
  }
  return parsed.origin;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/json', ...(options.headers || {}) }
  });
  return response;
}

async function expectStatus(label, url, status, options) {
  const response = await request(url, options);
  if (response.status !== status) throw new Error(`${label}: expected ${status}, received ${response.status}`);
  console.log(`PASS  ${label}`);
  return response;
}

async function expectJson(label, url, token, requiredField) {
  const response = await expectStatus(label, url, 200, {
    headers: { authorization: `Bearer ${token}` }
  });
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('application/json')) throw new Error(`${label}: expected JSON`);
  const value = await response.json();
  if (!value || typeof value !== 'object' || !(requiredField in value)) {
    throw new Error(`${label}: missing ${requiredField}`);
  }
}

async function main() {
  const origin = baseUrl();
  const guardianId = required('APP_GUARDIAN_ID');
  const password = required('APP_GUARDIAN_PASSWORD');
  console.log(`TARGET ${origin}`);

  await expectStatus('health endpoint', `${origin}/healthz`, 200);
  await expectStatus('readiness endpoint', `${origin}/readyz`, 200);
  await expectStatus('household API rejects anonymous access', `${origin}/api/v1/overview`, 401);
  await expectStatus('internal API rejects a missing ingest key', `${origin}/internal/v1/commands?after=0`, 401);
  await expectStatus('APP login rejects an incorrect password', `${origin}/api/v1/auth/app`, 401, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guardianId, password: 'public-verifier-intentionally-wrong' })
  });

  const login = await expectStatus('APP login accepts configured guardian', `${origin}/api/v1/auth/app`, 200, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guardianId, password })
  });
  const loginBody = await login.json();
  if (loginBody.tokenType !== 'Bearer' || loginBody.expiresIn !== 7200 ||
      typeof loginBody.sessionToken !== 'string' || loginBody.sessionToken.length < 20) {
    throw new Error('APP login returned an invalid session contract');
  }
  const token = loginBody.sessionToken;

  await expectJson('overview contract', `${origin}/api/v1/overview`, token, 'generatedAt');
  await expectJson('rooms contract', `${origin}/api/v1/rooms`, token, 'rooms');
  await expectJson('devices contract', `${origin}/api/v1/devices`, token, 'devices');
  await expectJson('alerts contract', `${origin}/api/v1/alerts`, token, 'alerts');
  await expectJson('contacts contract', `${origin}/api/v1/contacts`, token, 'contacts');
  await expectJson('location contract', `${origin}/api/v1/location`, token, 'locations');
  await expectJson('communications contract', `${origin}/api/v1/communications/messages?limit=1`, token, 'messages');
  console.log('RESULT PASS');
}

main().catch((error) => {
  console.error(`RESULT FAIL: ${error && error.message ? error.message : 'verification failed'}`);
  process.exitCode = 1;
});
