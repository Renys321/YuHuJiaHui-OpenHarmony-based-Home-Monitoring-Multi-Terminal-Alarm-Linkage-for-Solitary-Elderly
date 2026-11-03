'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexSource = fs.readFileSync(path.resolve(
  __dirname, '..', 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), 'utf8');

/* ---------- 逻辑镜像（与 ArkTS 规则同步；上方源码守卫防止漂移） ---------- */
function labelsFor(order, snaps) {
  const labels = order.map((id) => (snaps[id] ? snaps[id].room : id));
  const counts = new Map();
  labels.forEach((label) => counts.set(label, (counts.get(label) || 0) + 1));
  return labels.map((label, index) => (counts.get(label) > 1 ? label + '·' + order[index] : label));
}

function applyIncoming(state, incoming) {
  const order = state.order.slice();
  if (incoming.deviceId === 'dayu200-01' && order.includes('dayu200-living')) {
    return state;
  }
  if (!order.includes(incoming.deviceId)) order.push(incoming.deviceId);
  if (incoming.deviceId === 'dayu200-living') {
    for (const alias of ['dayu200-01']) {
      const at = order.indexOf(alias);
      if (at >= 0) order.splice(at, 1);
      delete state.snaps[alias];
      if (state.selectedId === alias) state.selectedId = 'dayu200-living';
    }
  }
  state.order = order;
  state.snaps[incoming.deviceId] = { room: incoming.room };
  if (!state.selectedId) state.selectedId = incoming.deviceId;
  state.labels = labelsFor(order, state.snaps);
  return state;
}

test('page declares canonical identity, legacy aliases and the migration hook', () => {
  assert.match(indexSource, /CANONICAL_LIVING_DEVICE_ID: string = 'dayu200-living'/);
  assert.match(indexSource, /LEGACY_DEVICE_IDS: string\[\] = \['dayu200-01'\]/);
  assert.match(indexSource, /if \(dev === CANONICAL_LIVING_DEVICE_ID\)[\s\S]{0,220}dropLegacyDevice/);
  assert.match(indexSource, /private dropLegacyDevice\(alias: string\): void/);
  assert.match(indexSource, /this\.snaps\.delete\(alias\)/);
  assert.match(indexSource, /this\.order = this\.order\.filter/);
  assert.match(indexSource, /this\.routes\.delete\(alias\)/);
  assert.match(indexSource, /this\.selectedId = CANONICAL_LIVING_DEVICE_ID/);
});

test('legacy 客厅 alias is migrated away once the canonical device reports', () => {
  const state = { order: [], snaps: {}, selectedId: '', labels: [] };
  applyIncoming(state, { deviceId: 'dayu200-01', room: '客厅' });
  assert.deepEqual(state.order, ['dayu200-01']);
  applyIncoming(state, { deviceId: 'dayu200-living', room: '客厅' });
  assert.deepEqual(state.order, ['dayu200-living'], '旧别名必须被移除');
  assert.deepEqual(state.labels, ['客厅'], '最终只显示一个客厅标签');
});

test('selection migrates from the legacy alias to the canonical device', () => {
  const state = { order: [], snaps: {}, selectedId: '', labels: [] };
  applyIncoming(state, { deviceId: 'dayu200-01', room: '客厅' });
  assert.equal(state.selectedId, 'dayu200-01');
  applyIncoming(state, { deviceId: 'dayu200-living', room: '客厅' });
  assert.equal(state.selectedId, 'dayu200-living', '选中旧别名时必须自动切换');
});

test('late legacy reports cannot recreate a second living-room node', () => {
  const state = { order: [], snaps: {}, selectedId: '', labels: [] };
  applyIncoming(state, { deviceId: 'dayu200-living', room: '客厅' });
  applyIncoming(state, { deviceId: 'dayu200-01', room: '客厅' });
  assert.deepEqual(state.order, ['dayu200-living']);
  assert.deepEqual(state.labels, ['客厅']);
  assert.match(indexSource, /LEGACY_DEVICE_IDS\.indexOf\(dev\) >= 0[\s\S]{0,180}CANONICAL_LIVING_DEVICE_ID/);
});

test('esp32-bath is not affected by the migration', () => {
  const state = { order: [], snaps: {}, selectedId: '', labels: [] };
  applyIncoming(state, { deviceId: 'esp32-bath', room: '卫生间' });
  applyIncoming(state, { deviceId: 'dayu200-01', room: '客厅' });
  applyIncoming(state, { deviceId: 'dayu200-living', room: '客厅' });
  assert.deepEqual(state.order, ['esp32-bath', 'dayu200-living']);
  assert.deepEqual(state.labels, ['卫生间', '客厅']);
});

test('same-room devices get distinguishable labels', () => {
  const labels = labelsFor(['dayu200-living', 'dayu200-bedroom'], {
    'dayu200-living': { room: '客厅' },
    'dayu200-bedroom': { room: '客厅' },
  });
  assert.equal(new Set(labels).size, 2, '同名房间必须可区分');
  assert.match(indexSource, /total > 1 \? key \+ '·' \+ ids\[i\] : key/);
});

test('camera ownership is fixed to the living-room node and the title says so', () => {
  assert.match(indexSource, /CAMERA_OWNER_DEVICE_ID: string = 'dayu200-living'/);
  assert.match(indexSource, /private hasCameraSelected\(\): boolean/);
  assert.match(indexSource, /Text\('客厅摄像头'\)/);
  assert.equal(/Text\('室内摄像头'\)/.test(indexSource), false, '标题必须明确写"客厅摄像头"');
  assert.match(indexSource, /Text\('该房间未配置摄像头'\)/);
});

test('non-camera rooms hide the picture and disable controls without unmounting the Surface', () => {
  assert.match(indexSource, /\.visibility\(this\.hasCameraSelected\(\) \? Visibility\.None : Visibility\.Visible\)/);
  assert.match(indexSource, /\.enabled\(this\.cameraGuardEnabled && this\.hasCameraSelected\(\)\)/);
  assert.match(indexSource, /\.enabled\(!this\.cameraBusy && this\.cameraPreviewActive && this\.cameraPhotoAvailable[\s\S]{0,60}hasCameraSelected\(\)\)/);
  // XComponent 保持稳定挂载：不得被 if 条件包裹
  assert.equal(/if \([^)]*\) \{\s*XComponent\(/.test(indexSource), false,
    'XComponent 不得条件挂载/卸载（会导致原生 Surface 重建）');
  assert.match(indexSource, /id: 'eldercareCameraPreview'/);
  assert.match(indexSource, /if \(this\.hasCameraSelected\(\)\) \{\s*Text\(this\.cameraStatusText\)/,
    '非摄像头房间不得显示客厅相机状态文字');
});

test('monitoring keeps running regardless of the selected room', () => {
  assert.match(indexSource, /visionStreamer\.start\(this\.cameraSurfaceId\)/);
  assert.equal(/stopCameraGuardRuntime[\s\S]{0,200}hasCameraSelected/.test(indexSource), false,
    '切换房间不得停止相机/送帧');
  assert.equal(/hasCameraSelected[\s\S]{0,120}visionStreamer\.stop/.test(indexSource), false,
    '选中项不得影响 VisionFrameStreamer 生命周期');
});
