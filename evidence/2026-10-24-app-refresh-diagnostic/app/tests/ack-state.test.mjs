/**
 * ACK 状态机测试（实际 core ApiClient/Contracts/ViewMapper 编译产物）。
 *
 * 关键规则（REAL-API-INTEGRATION-SPEC §1/§4/§5）：
 * - POST ack 返回 202 {status:'PENDING'} 只代表命令入队，AlertView 仍是“等待设备确认”；
 * - 只有后续 GET alerts 返回 state='ACKED' 且 ackPending=false 才算设备确认；
 * - 404 表示不存在/已失效：Detail 查不到就不显示、不本地归档、不回退 Mock；
 * - 400/409/网络失败都不得在本地改成 ACKED。
 *
 * 所有响应均为 SIMULATED fake transport 脚本，不是真实后端。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_BASE, FakeTransport, route, jsonResponse, textResponse,
  simulatedNetworkError, simulatedTimeout, loadCore
} from './fake-transport.mjs';

const { ApiClient } = loadCore('api/ApiClient.js');
const { ApiErrorKinds } = loadCore('api/Errors.js');
const { parseAlerts } = loadCore('api/Contracts.js');
const { mapAlerts, findAlert } = loadCore('view/ViewMapper.js');
const { LoginOutcome, RefreshOutcome, AckOutcome } = loadCore('service/Outcomes.js');

const TOKEN = 'fake-token-000';
const ALARM_ID = 'alarm-ack-1';

function alertJson(overrides = {}) {
  return {
    id: ALARM_ID,
    alarmId: ALARM_ID,
    deviceId: 'esp32-bath',
    roomName: '卫生间',
    type: 'MANUAL_SOS',
    message: '检测到异常',
    state: 'ALARM',
    ackPending: false,
    createdAt: 1730000000000,
    acknowledgedAt: 0,
    acknowledgedBy: '',
    evidence: { available: false },
    ...overrides
  };
}

function makeClient(routes) {
  const transport = new FakeTransport(routes);
  return { transport, client: new ApiClient(API_BASE, transport) };
}

function mapOne(alertObject) {
  const parsed = parseAlerts(JSON.stringify({ alerts: [alertObject] }));
  assert.ok(parsed);
  const views = mapAlerts(parsed);
  assert.equal(views.length, 1);
  return views[0];
}

test('ACK 全流程：202 PENDING → 等待设备确认 → 服务端 ACKED 才算确认', async () => {
  const { transport, client } = makeClient([
    route('POST', `/api/v1/alerts/${ALARM_ID}/ack`, jsonResponse(202, {
      accepted: true, status: 'PENDING', commandId: 'cmd-1'
    })),
    // 第一次轮询：命令仍在队列，服务端 state=ALARM, ackPending=true
    route('GET', '/api/v1/alerts', jsonResponse(200, {
      alerts: [alertJson({ state: 'ALARM', ackPending: true })]
    })),
    // 第二次轮询：设备真实回执后 state=ACKED, ackPending=false
    route('GET', '/api/v1/alerts', jsonResponse(200, {
      alerts: [alertJson({ state: 'ACKED', ackPending: false, acknowledgedAt: 1730000008000, acknowledgedBy: 'guardian' })]
    }))
  ]);

  const ack = await client.ack(TOKEN, ALARM_ID, '已电话确认');
  assert.equal(ack.ok, true);
  assert.equal(ack.value.status, 'PENDING');
  assert.notEqual(ack.value.status, 'ACKED', '202 不是设备确认');

  const firstPoll = await client.alerts(TOKEN);
  assert.equal(firstPoll.ok, true);
  const waiting = findAlert(mapAlerts(firstPoll.value), ALARM_ID);
  assert.ok(waiting);
  assert.equal(waiting.statusKey, 'waiting');
  assert.equal(waiting.statusText, '等待设备确认');
  assert.notEqual(waiting.statusKey, 'acked', '202 后第一次轮询仍不得显示已确认');

  const secondPoll = await client.alerts(TOKEN);
  assert.equal(secondPoll.ok, true);
  const confirmed = findAlert(mapAlerts(secondPoll.value), ALARM_ID);
  assert.ok(confirmed);
  assert.equal(confirmed.statusKey, 'acked');
  assert.equal(confirmed.statusText, '设备已确认');
  assert.equal(confirmed.acknowledgedAt, 1730000008000);

  assert.equal(transport.requestCount('POST', `/api/v1/alerts/${ALARM_ID}/ack`), 1);
  assert.equal(transport.requestCount('GET', '/api/v1/alerts'), 2);
});

test('ACK 404：错误语义为 not_found；随后 alerts 不含该告警 → Detail 语义“不存在/已失效”', async () => {
  const { client } = makeClient([
    route('POST', `/api/v1/alerts/${ALARM_ID}/ack`, textResponse(404, JSON.stringify({ error: 'alarm not found' }))),
    route('GET', '/api/v1/alerts', jsonResponse(200, { alerts: [] }))
  ]);

  const ack = await client.ack(TOKEN, ALARM_ID, '备注');
  assert.equal(ack.ok, false);
  assert.equal(ack.error.kind, ApiErrorKinds.NOT_FOUND);

  const poll = await client.alerts(TOKEN);
  assert.equal(poll.ok, true);
  assert.deepEqual(poll.value, []);
  // Detail 页通过 findAlert 查找；找不到必须返回 null（页面文案“告警不存在或已失效”），不得取第一条假数据。
  assert.equal(findAlert(mapAlerts(poll.value), ALARM_ID), null);
});

test('ACK 400/409/网络失败/超时：不得本地归档为 ACKED，仍需服务端 ACKED 才确认', async () => {
  const failures = [
    { response: textResponse(400, '{"error":"alarm already acknowledged"}'), kind: ApiErrorKinds.BAD_REQUEST },
    { response: textResponse(409, '{"error":"conflict"}'), kind: ApiErrorKinds.CONFLICT },
    { response: simulatedNetworkError(), kind: ApiErrorKinds.NETWORK },
    { response: simulatedTimeout(), kind: ApiErrorKinds.TIMEOUT }
  ];

  for (const failure of failures) {
    const { client } = makeClient([
      route('POST', `/api/v1/alerts/${ALARM_ID}/ack`, failure.response),
      route('GET', '/api/v1/alerts', jsonResponse(200, {
        alerts: [alertJson({ state: 'ALARM', ackPending: false })]
      }))
    ]);
    const ack = await client.ack(TOKEN, ALARM_ID, '备注');
    assert.equal(ack.ok, false, `${failure.kind} 不得被视为提交成功`);
    assert.equal(ack.error.kind, failure.kind);

    // 重新拉取服务端状态后仍是 ALARM；没有本地“归档”通道能把它改成 ACKED。
    const poll = await client.alerts(TOKEN);
    const view = findAlert(mapAlerts(poll.value), ALARM_ID);
    assert.ok(view);
    assert.equal(view.statusKey, 'pending');
    assert.notEqual(view.statusKey, 'acked');
    assert.equal(view.acknowledgedAt, 0, '失败 ACK 不得伪造 acknowledgedAt');
  }
});

test('ACK 等待期间 ackPending=true：状态是 waiting，不是 acked', () => {
  const view = mapOne(alertJson({ state: 'ALARM', ackPending: true }));
  assert.equal(view.ackPending, true);
  assert.equal(view.statusKey, 'waiting');
  assert.equal(view.statusText, '等待设备确认');
  assert.notEqual(view.statusKey, 'acked');
});

test('ACK 202 后重复点击由调用方防抖：API 层本身不产生本地状态变更', async () => {
  const { transport, client } = makeClient([
    route('POST', `/api/v1/alerts/${ALARM_ID}/ack`, jsonResponse(202, { accepted: true, status: 'PENDING', commandId: 'cmd-1' })),
    route('POST', `/api/v1/alerts/${ALARM_ID}/ack`, jsonResponse(202, { accepted: true, status: 'PENDING', commandId: 'cmd-1' }))
  ]);
  const first = await client.ack(TOKEN, ALARM_ID, '备注');
  const second = await client.ack(TOKEN, ALARM_ID, '备注');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.value.status, 'PENDING');
  assert.equal(second.value.status, 'PENDING');
  assert.equal(transport.requestCount('POST', `/api/v1/alerts/${ALARM_ID}/ack`), 2);
});

test('Outcomes 默认值：失败不会被当成成功', () => {
  const login = new LoginOutcome();
  assert.equal(login.ok, false);
  assert.equal(login.message, '');
  assert.equal(login.retryAfterSeconds, 0);

  const refresh = new RefreshOutcome();
  assert.equal(refresh.ok, false);
  assert.equal(refresh.partial, false);
  assert.equal(refresh.unauthorized, false);

  const ack = new AckOutcome();
  assert.equal(ack.accepted, false);
  assert.equal(ack.serverStatus, '');
});
