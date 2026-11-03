'use strict';

// Audit only: no sockets, serial ports, production stores, timers or HAP builds.
// Production gateway/store/DTO/mapper run in memory with synthetic input.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const tsPath = process.argv[2] || 'D:/DevEcoStudio/DevEco Studio/tools/hvigor/hvigor/node_modules/typescript/lib/typescript.js';
const ts = require(tsPath);
const core = path.join(root, 'APP/ElderlyCareGuardian/entry/src/main/ets/core');
require.extensions['.ts'] = (mod, filename) => {
  if (!filename.startsWith(core + path.sep)) throw new Error('Outside audited core');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename
  });
  mod._compile(compiled.outputText, filename);
};
const { HomeCloudGateway } = require(path.join(root, 'competition/cloud/onenet/gateway.js'));
const { buildIngestPayload } = require(path.join(root, 'competition/cloud/onenet/cloud-sync.js'));
const { MemoryStore } = require(path.join(root, 'competition/cloud/backend/src/store.js'));
const { parseDevices } = require(path.join(core, 'api/Contracts.ts'));
const { mapDevices } = require(path.join(core, 'view/ViewMapper.ts'));
const { resolveCapability } = require(path.join(core, 'capability/DeviceCapabilities.ts'));
const frozen = 'competition/evidence/2026-10-22-monitor-inline-summary-local/guardian-inline-summary-formal.hap';
const files = [frozen,
  'APP/ElderlyCareGuardian/entry/build/default/outputs/default/entry-default-unsigned.hap',
  ...['pages/MonitorPage.ets', 'pages/DevicePage.ets', 'components/SensorCard.ets',
    'service/GuardianService.ets', 'core/api/Contracts.ts', 'core/view/Models.ts',
    'core/view/ViewMapper.ts', 'core/view/HomeMetrics.ts', 'core/capability/DeviceCapabilities.ts']
    .map(p => 'APP/ElderlyCareGuardian/entry/src/main/ets/' + p),
  'competition/cloud/onenet/gateway.js', 'competition/cloud/onenet/public-sync.js',
  'competition/cloud/onenet/cloud-sync.js', 'competition/cloud/onenet/adapter.js',
  'competition/cloud/backend/src/store.js', 'competition/cloud/backend/src/server.js',
  'competition/bridge/mqtt_bridge.js', 'competition/esp32-node/main/node_main.c',
  'competition/esp32-node/build-kitchen/config/sdkconfig.h'];
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex').toUpperCase();
const hashes = files.map(p => ({ path: p, sha256: sha256(p) }));
assert.equal(hashes[0].sha256, '8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985');
const now = Date.now();
const mq = sensors => ({ gas: sensors.gas, smoke: sensors.smoke });
const sensorViews = device => device.sensors.filter(s => s.kind === 'gas' || s.kind === 'smoke')
  .map(s => ({ kind: s.kind, name: s.name, valueText: s.valueText, state: s.state,
    stateText: s.stateText, validity: s.validity, alarmEnabled: s.alarmEnabled,
    colorToken: s.colorToken, detailText: s.detailText }));

async function replay(label, valid, rawGas = 307, rawSmoke = 160) {
  const raw = { deviceId: 'esp32-kitchen', room: '厨房', ts: now, state: 'NORMAL',
    sensors: { gas: { raw: rawGas, ok: true }, smoke: { raw: rawSmoke, ok: true } },
    alarm: { id: '', type: '', countToday: 0 } };
  if (valid !== undefined) {
    raw.sensors.gas.valid = valid;
    raw.sensors.smoke.valid = valid;
  }
  const gateway = new HomeCloudGateway({ now: () => now,
    transport: { publishProperty: async () => ({}), publishAlarm: async () => ({}) },
    logger: { info() {}, warn() {}, error() {} } });
  const accepted = await gateway.ingest(raw);
  assert.equal(accepted.accepted, true);
  const normalized = gateway.devices.get('esp32-kitchen');
  const cloud = gateway._cloudStatus(normalized);
  const payload = buildIngestPayload(cloud, now);
  const store = new MemoryStore();
  store.ingest(payload, now);
  const devices = store.listPublicDevices();
  const dto = parseDevices(JSON.stringify({ devices }));
  assert.ok(dto);
  const view = mapDevices(dto, now)[0];
  for (const sensors of [normalized.sensors, cloud.sensors, payload.sensors, devices[0].sensors, dto[0].sensors]) {
    assert.equal(sensors.gas.raw, rawGas);
    assert.equal(sensors.smoke.raw, rawSmoke);
    if (valid !== undefined) {
      assert.equal(sensors.gas.valid, valid);
      assert.equal(sensors.smoke.valid, valid);
    }
  }
  const views = sensorViews(view);
  assert.equal(views.length, 2);
  assert.ok(views.every(s => !s.alarmEnabled && s.colorToken !== 'success'));
  assert.ok(views.every(s => s.state === (valid === false ? 'invalid' : 'disabled')));
  return { label, evidenceClass: 'LOCAL SYNTHETIC REPLAY, NOT REAL', input: mq(raw.sensors),
    gateway: mq(normalized.sensors), cloudStatus: mq(cloud.sensors), ingestBody: mq(payload.sensors),
    memoryBackendPublicDevice: mq(devices[0].sensors), dto: mq(dto[0].sensors), views };
}

(async () => {
  const replays = [];
  replays.push(await replay('valid true; raw ADC', true));
  replays.push(await replay('valid false; retain invalid prior readout', false));
  replays.push(await replay('valid absent; validity unknown', undefined));
  replays.push(await replay('valid true; zero ADC remains visible, alarm disabled', true, 0, 0));
  const profile = resolveCapability('esp32-kitchen');
  const historicalPath = 'competition/evidence/2026-10-20-kitchen-esp32/mqtt-kitchen.log';
  const historical = fs.readFileSync(path.join(root, historicalPath), 'utf8').split(/\r?\n/)
    .flatMap(line => { const start = line.indexOf('{'); if (start < 0) return [];
      try { const row = JSON.parse(line.slice(start)); return row.deviceId === 'esp32-kitchen' ? [row] : []; }
      catch { return []; } });
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), node: process.version,
    evidenceClass: 'SOURCE CHECK AND LOCAL SYNTHETIC REPLAY ONLY',
    writes: false, network: false, serial: false, hapBuild: false, installed: false,
    hashes, kitchenCapabilities: profile.entries.filter(s => s.kind === 'gas' || s.kind === 'smoke'),
    replays, historicalCapture: { path: historicalPath, sha256: sha256(historicalPath),
      evidenceClass: 'HISTORICAL ONLY; not current firmware or current readings', samples: historical.length,
      first: historical.length ? { ts: historical[0].ts, sensors: mq(historical[0].sensors) } : null,
      last: historical.length ? { ts: historical.at(-1).ts, sensors: mq(historical.at(-1).sensors) } : null }
  }, null, 2));
})().catch(() => { console.error('OFFLINE_AUDIT_FAILED'); process.exitCode = 1; });
