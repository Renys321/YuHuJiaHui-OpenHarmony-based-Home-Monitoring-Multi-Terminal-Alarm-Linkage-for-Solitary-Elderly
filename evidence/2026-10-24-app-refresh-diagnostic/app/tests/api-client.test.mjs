/**
 * ApiClient 测试（实际 core/api/ApiClient.ts 编译产物）+ SIMULATED fake HttpTransport。
 *
 * 所有 HTTP 状态/JSON 都由 fake-transport.mjs 脚本提供，是明确的模拟 API 响应；
 * 本文件不访问公网、不证明真实后端可用（NOT TESTED）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_BASE, FakeTransport, route, jsonResponse, textResponse,
  simulatedNetworkError, simulatedTimeout, loadCore, parseBody
} from './fake-transport.mjs';

const { ApiClient, baseUrlOf } = loadCore('api/ApiClient.js');
const { ApiErrorKinds } = loadCore('api/Errors.js');

function clientWith(...routes) {
  const transport = new FakeTransport(routes);
  return { transport, client: new ApiClient(API_BASE, transport) };
}

test('login 成功：解析 sessionToken/tokenType/expiresIn，并使用 POST /api/v1/auth/app', async () => {
  const { transport, client } = clientWith(
    route('POST', '/api/v1/auth/app', jsonResponse(200, {
      sessionToken: 'fake-token-000',
      tokenType: 'Bearer',
      expiresIn: 7200
    }))
  );
  const result = await client.login('family-guardian', 'fake-password-000000000000000000000');
  assert.equal(result.ok, true);
  assert.ok(result.error === null);
  assert.ok(result.value);
  assert.equal(result.value.sessionToken, 'fake-token-000');
  assert.equal(result.value.tokenType, 'Bearer');
  assert.equal(result.value.expiresIn, 7200);

  assert.equal(transport.requests.length, 1);
  const req = transport.lastRequest('POST', '/api/v1/auth/app');
  assert.ok(req);
  assert.equal(req.token, '', '登录请求不应携带 Bearer token');
  const body = parseBody(req);
  assert.deepEqual(body, {
    guardianId: 'family-guardian',
    password: 'fake-password-000000000000000000000'
  });
  transport.assertAllConsumed();
});

test('login 401：kind=unauthorized，不得把服务端文案当业务成功', async () => {
  const { client } = clientWith(
    route('POST', '/api/v1/auth/app', textResponse(401, JSON.stringify({ error: 'invalid credentials' })))
  );
  const result = await client.login('family-guardian', 'wrong-password-000000000000000000');
  assert.equal(result.ok, false);
  assert.ok(result.value === null);
  assert.ok(result.error);
  assert.equal(result.error.kind, ApiErrorKinds.UNAUTHORIZED);
  assert.equal(result.error.status, 401);
  assert.doesNotMatch(result.error.message, /family-guardian|wrong-password/);
});

test('login 429：携带 Retry-After 秒数（SIMULATED 响应）', async () => {
  const { client } = clientWith(
    route('POST', '/api/v1/auth/app', textResponse(429, JSON.stringify({ error: 'too many attempts' }), {
      retryAfterSeconds: 42
    }))
  );
  const result = await client.login('family-guardian', 'fake-password-000000000000000000000');
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.error.kind, ApiErrorKinds.RATE_LIMITED);
  assert.equal(result.error.status, 429);
  assert.equal(result.error.retryAfterSeconds, 42, '429 必须把 Retry-After 传给上层用于倒计时');
});

test('login 503：kind=service_unavailable（服务端登录未配置）', async () => {
  const { client } = clientWith(
    route('POST', '/api/v1/auth/app', textResponse(503, JSON.stringify({ error: 'service unavailable' })))
  );
  const result = await client.login('family-guardian', 'fake-password-000000000000000000000');
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.error.kind, ApiErrorKinds.SERVICE_UNAVAILABLE);
  assert.equal(result.error.status, 503);
});

test('login 网络失败：kind=network，不伪造会话', async () => {
  const { client } = clientWith(
    route('POST', '/api/v1/auth/app', simulatedNetworkError())
  );
  const result = await client.login('family-guardian', 'fake-password-000000000000000000000');
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.error);
  assert.equal(result.error.kind, ApiErrorKinds.NETWORK);
  assert.equal(result.error.status, 0);
});

test('login 请求超时：kind=timeout（与网络失败区分）', async () => {
  const { client } = clientWith(
    route('POST', '/api/v1/auth/app', simulatedTimeout())
  );
  const result = await client.login('family-guardian', 'fake-password-000000000000000000000');
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.error.kind, ApiErrorKinds.TIMEOUT);
});

test('login 返回 200 但不是合法 JSON：kind=malformed，不产生假 token', async () => {
  const { client } = clientWith(
    route('POST', '/api/v1/auth/app', textResponse(200, '<html>proxy error</html>'))
  );
  const result = await client.login('family-guardian', 'fake-password-000000000000000000000');
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.error.kind, ApiErrorKinds.MALFORMED);
  assert.equal(result.value, null);
});

test('业务 GET：overview/rooms/devices/alerts 携带传进来的 Bearer token', async () => {
  const { transport, client } = clientWith(
    route('GET', '/api/v1/overview', jsonResponse(200, { deviceCount: 0, latestAlert: null })),
    route('GET', '/api/v1/rooms', jsonResponse(200, { rooms: [] })),
    route('GET', '/api/v1/devices', jsonResponse(200, { devices: [] })),
    route('GET', '/api/v1/alerts', jsonResponse(200, { alerts: [] }))
  );
  const token = 'fake-token-000';
  const overview = await client.overview(token);
  const rooms = await client.rooms(token);
  const devices = await client.devices(token);
  const alerts = await client.alerts(token);

  assert.equal(overview.ok, true);
  assert.equal(rooms.ok, true);
  assert.deepEqual(rooms.value, []);
  assert.equal(devices.ok, true);
  assert.deepEqual(devices.value, []);
  assert.equal(alerts.ok, true);
  assert.deepEqual(alerts.value, []);

  for (const req of transport.requests) {
    assert.equal(req.token, token, `${req.path} 必须带 Bearer token`);
    assert.equal(req.method, 'GET');
  }
  transport.assertAllConsumed();
});

test('业务请求 token 为空：直接 unauthorized，不发网络请求', async () => {
  const { transport, client } = clientWith();
  for (const result of [
    await client.overview(''),
    await client.rooms(''),
    await client.devices(''),
    await client.alerts('')
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, ApiErrorKinds.UNAUTHORIZED);
  }
  assert.equal(transport.requests.length, 0, '无会话时不得发出无凭据请求');
});

test('业务 401：kind=unauthorized 供 service 清会话并跳登录', async () => {
  const { client } = clientWith(
    route('GET', '/api/v1/overview', textResponse(401, JSON.stringify({ error: 'unauthorized' })))
  );
  const result = await client.overview('fake-token-expired');
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, ApiErrorKinds.UNAUTHORIZED);
  assert.equal(result.error.status, 401);
});

test('业务 403：kind=forbidden（账号停用）', async () => {
  const { client } = clientWith(
    route('GET', '/api/v1/devices', textResponse(403, JSON.stringify({ error: 'forbidden' })))
  );
  const result = await client.devices('fake-token-000');
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, ApiErrorKinds.FORBIDDEN);
});

test('ACK 202 PENDING：只代表命令入队，返回 serverStatus=PENDING', async () => {
  const { transport, client } = clientWith(
    route('POST', '/api/v1/alerts/alarm-1/ack', jsonResponse(202, {
      accepted: true,
      status: 'PENDING',
      commandId: 'cmd-1'
    }))
  );
  const result = await client.ack('fake-token-000', 'alarm-1', '已电话确认，老人安全');
  assert.equal(result.ok, true);
  assert.ok(result.value);
  assert.equal(result.value.accepted, true);
  assert.equal(result.value.status, 'PENDING');
  assert.notEqual(result.value.status, 'ACKED', '202 不得被解释为设备已确认');
  assert.equal(result.value.commandId, 'cmd-1');

  const req = transport.lastRequest('POST', '/api/v1/alerts/alarm-1/ack');
  assert.ok(req);
  assert.equal(req.token, 'fake-token-000');
  assert.deepEqual(parseBody(req), { note: '已电话确认，老人安全' });
});

test('ACK 202 但 body 非法：仍按 PENDING 上抛，绝不视为 ACKED', async () => {
  const { client } = clientWith(
    route('POST', '/api/v1/alerts/alarm-1/ack', textResponse(202, 'not-json'))
  );
  const result = await client.ack('fake-token-000', 'alarm-1', '备注');
  assert.equal(result.ok, true);
  assert.ok(result.value);
  assert.equal(result.value.status, 'PENDING');
  assert.notEqual(result.value.status, 'ACKED');
});

test('ACK 404：kind=not_found（告警不存在或已失效），不产生成功结果', async () => {
  const { client } = clientWith(
    route('POST', '/api/v1/alerts/alarm-gone/ack', textResponse(404, JSON.stringify({ error: 'alarm not found' })))
  );
  const result = await client.ack('fake-token-000', 'alarm-gone', '备注');
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.equal(result.error.kind, ApiErrorKinds.NOT_FOUND);
});

test('ACK 400/409/网络失败：均不得本地成功', async () => {
  const cases = [
    { make: () => route('POST', '/api/v1/alerts/alarm-1/ack', textResponse(400, '{"error":"bad"}')), kind: ApiErrorKinds.BAD_REQUEST, status: 400 },
    { make: () => route('POST', '/api/v1/alerts/alarm-1/ack', textResponse(409, '{"error":"conflict"}')), kind: ApiErrorKinds.CONFLICT, status: 409 },
    { make: () => route('POST', '/api/v1/alerts/alarm-1/ack', simulatedNetworkError()), kind: ApiErrorKinds.NETWORK, status: 0 }
  ];
  for (const item of cases) {
    const { client } = clientWith(item.make());
    const result = await client.ack('fake-token-000', 'alarm-1', '备注');
    assert.equal(result.ok, false, `${item.kind} 不得返回 ok`);
    assert.equal(result.value, null);
    assert.equal(result.error.kind, item.kind);
    assert.equal(result.error.status, item.status);
  }
});

test('ACK alarmId 会做 URL 编码，避免路径注入', async () => {
  const { transport, client } = clientWith(
    route('POST', '/api/v1/alerts/a%2Fb%20c/ack', jsonResponse(202, { accepted: true, status: 'PENDING', commandId: '1' }))
  );
  const result = await client.ack('fake-token-000', 'a/b c', '备注');
  assert.equal(result.ok, true);
  assert.equal(transport.lastRequest('POST', '/api/v1/alerts/a%2Fb%20c/ack') !== null, true);
});

test('baseUrlOf: 去掉末尾斜杠，避免 //api/v1 双斜杠', () => {
  assert.equal(baseUrlOf('https://api.luxunacc.xyz/'), 'https://api.luxunacc.xyz');
  assert.equal(baseUrlOf('https://api.luxunacc.xyz'), 'https://api.luxunacc.xyz');
});
