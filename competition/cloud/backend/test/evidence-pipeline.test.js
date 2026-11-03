'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionToken } = require('../src/auth');
const { EvidenceStore } = require('../src/evidence-store');
const { PersistentStore } = require('../src/persistent-store');
const { createApiServer } = require('../src/server');
const { createCloudSync } = require('../../onenet/cloud-sync');
const { HomeCloudGateway } = require('../../onenet/gateway');
const { toPropertyPost, toAlarmEvent } = require('../../onenet/adapter');

test('real gateway validation and cloud-sync HTTP preserve evidence through backend restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-evidence-pipeline-'));
  const tokenSecret = 'pipeline-token-secret-at-least-32-characters';
  const ingestKey = 'pipeline-ingest-key';
  const dataFile = path.join(directory, 'state.json');
  const evidenceDirectory = path.join(directory, 'evidence');
  let server;
  let gateway;
  t.after(async () => {
    if (gateway) await gateway.stop('TEST_DONE');
    if (server && server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function startBackend() {
    const created = createApiServer({
      store: new PersistentStore({ filePath: dataFile }),
      evidenceStore: new EvidenceStore({ directory: evidenceDirectory }),
      tokenSecret,
      ingestKey,
      authorizeIdentity: (openid) => openid === 'pipeline-guardian'
    });
    server = created.server;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  let baseUrl = await startBackend();
  const cloudSync = createCloudSync({ backendUrl: baseUrl, ingestKey });
  const completions = [];
  // Keep the real HTTP sync, but observe its promises for deterministic tests.
  const trackedSync = {
    enabled: true,
    publish(...args) {
      const promise = cloudSync.publish(...args);
      completions.push(promise);
      return promise;
    }
  };
  let cloudProperty;
  gateway = new HomeCloudGateway({
    cloudSync: trackedSync,
    transport: {
      async publishProperty(status, options) { cloudProperty = toPropertyPost(status, options); },
      async publishAlarm(status, options) { return toAlarmEvent(status, options); },
      on() {}, off() {}
    },
    statusSource: { subscribe: () => () => {}, publish() {}, close: async () => {} },
    logger: { info() {}, warn() {}, error() {} }
  });
  gateway.start();
  const evidenceId = 'fall-1791609077775-7';
  const status = {
    deviceId: 'dayu200-living', room: '客厅', state: 'ALARM', ts: 1791609077775,
    alarm: { id: 'a-pipeline-1', type: 'FALL', countToday: 1, evidenceId }
  };
  assert.equal((await gateway.ingest(JSON.stringify(status))).accepted, true);
  assert.equal((await Promise.all(completions))[0].ok, true);
  assert.equal(Object.hasOwn(cloudProperty.params.alarm.value, 'evidenceId'), false);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9]);
  const uploaded = await fetch(`${baseUrl}/internal/v1/evidence/${evidenceId}`, {
    method: 'PUT', headers: {
      'content-type': 'image/jpeg', 'x-ingest-key': ingestKey, 'x-device-id': status.deviceId
    }, body: jpeg
  });
  assert.equal(uploaded.status, 201);
  assert.equal((await uploaded.json()).bound, true);

  await gateway.stop('RESTART');
  gateway = null;
  await new Promise((resolve) => server.close(resolve));
  baseUrl = await startBackend();
  const headers = { authorization: `Bearer ${createSessionToken('pipeline-guardian', tokenSecret)}` };
  const alerts = await (await fetch(`${baseUrl}/api/v1/alerts`, { headers })).json();
  assert.equal(alerts.alerts[0].evidence.evidenceId, evidenceId);
  assert.equal(alerts.alerts[0].evidence.available, true);
  const content = await fetch(`${baseUrl}/api/v1/alerts/a-pipeline-1/evidence/content`, { headers });
  assert.equal(content.status, 200);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), jpeg);
});
