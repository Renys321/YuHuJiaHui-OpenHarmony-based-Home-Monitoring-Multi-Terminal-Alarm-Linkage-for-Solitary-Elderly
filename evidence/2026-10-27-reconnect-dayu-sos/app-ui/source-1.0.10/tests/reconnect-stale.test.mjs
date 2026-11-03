/**
 * 断连恢复 / 陈旧数据语义测试（2026-10-27）。
 *
 * 覆盖：
 * - 设备“在线标志陈旧”：online=true 但 lastSeenTs 超过 90s → 视图判离线，旧读数标“上次读数”，不冒充实时；
 * - lastSeenTs 解析：0/负数/非法 → 0（时间未知）；超前超过容差 → 时间未知，不显示“刚刚”；
 * - 设备请求失败时（断网/超时）按“当前时间”重映射缓存 DTO：3 小时前的在线快照在重映射后变离线
 *   （这是 GuardianService.remapCachedDevicesForNow 的纯逻辑核心，服务层接线由本文件静态守卫覆盖）；
 * - 页面 onPageShow 刷新策略（RefreshPolicy）：12s 内刚同步跳过；失败/从未成功/超过 12s 刷新；
 * - homemon 2026-10-27 契约：sensors.motion.supported/reported/reason 兼容解析（旧数据缺失保持原行为）；
 * - monitorReason 解析与“摄像头判定独立展示”；
 * - 静态守卫：Index 含 onPageShow/refreshOnShow、GuardianService 缓存 DTO 并在失败时重映射、
 *   页面不再把客厅当 PIR（不得出现“长时间无活动”瓦片文案）。
 *
 * 说明：本文件全部是 SIMULATED 数据 + 源码静态扫描，不代表真实后端/真机验收（NOT TESTED）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from './fake-transport.mjs';

const { parseDevices } = loadCore('api/Contracts.js');
const {
  mapDevices, isDeviceFresh, DEVICE_OFFLINE_AFTER_MS, monitorReasonTextFor, motionSemanticsFor
} = loadCore('view/ViewMapper.js');
const { shouldRefreshOnShow, RESUME_REFRESH_AFTER_MS } = loadCore('polling/RefreshPolicy.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const NOW = 1730000000000;

function read(rel) {
  return fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
}

function parseOneDevice(overrides = {}) {
  const parsed = parseDevices(JSON.stringify({
    devices: [{
      id: overrides.deviceId || 'd1',
      deviceId: 'esp32-bath',
      name: '卫生间节点',
      roomId: 'r-bath',
      roomName: '卫生间',
      location: '',
      online: true,
      monitorOnline: 1,
      state: 'NORMAL',
      lastSeenTs: NOW - 5000,
      csq: 20,
      sensors: {},
      ...overrides
    }]
  }));
  assert.ok(parsed);
  return parsed[0];
}

// ------------------------------------------------------------ 陈旧数据语义

test('设备在线标志陈旧：online=true + lastSeen 6 小时前 → 视图离线，读数标“上次读数”', () => {
  const dto = parseOneDevice({
    lastSeenTs: NOW - 6 * 60 * 60 * 1000,
    sensors: { gas: { raw: 287, ok: true }, motion: { lastActiveTs: NOW - 6 * 60 * 60 * 1000, countToday: 45 } }
  });
  const view = mapDevices([dto], NOW)[0];
  assert.equal(view.online, false, '超过 90s 没有新数据不能继续显示在线');
  assert.equal(view.stateText, '离线');
  assert.equal(view.lastSeenText, '6 小时前', '必须显示真实的最后上报时间');
  for (const sensor of view.sensors) {
    if (sensor.state === 'unsupported') continue;
    assert.equal(sensor.state, 'offline', `${sensor.kind} 不得继续显示为实时/正常`);
    assert.match(sensor.valueText, /上次读数|暂无数据|^--$/,
      `${sensor.kind} 离线时只能显示上次读数或明确暂无数据`);
  }
});

test('新鲜度边界：恰好 90s 仍在线，90001ms 判离线；online=false 立即离线', () => {
  assert.equal(isDeviceFresh(true, NOW - DEVICE_OFFLINE_AFTER_MS, NOW), true);
  assert.equal(isDeviceFresh(true, NOW - DEVICE_OFFLINE_AFTER_MS - 1, NOW), false);
  assert.equal(isDeviceFresh(false, NOW, NOW), false);
  assert.equal(isDeviceFresh(true, 0, NOW), false, '无 lastSeen 不得当在线');
});

test('lastSeenTs 解析：0/负数/非数字 → 0（时间未知）；超前 >5min → 离线且显示“时间未知”', () => {
  for (const bad of [0, -1, null, 'abc', undefined]) {
    const dto = parseOneDevice({ lastSeenTs: bad });
    assert.equal(dto.lastSeenTs, 0, `lastSeenTs=${String(bad)} 必须归一为 0`);
    const view = mapDevices([dto], NOW)[0];
    assert.equal(view.online, false);
    assert.equal(view.lastSeenText, '时间未知');
  }
  const future = parseOneDevice({ lastSeenTs: NOW + 30 * 60 * 1000 });
  const futureView = mapDevices([future], NOW)[0];
  assert.equal(futureView.online, false, '设备/服务器时钟超前不能当新鲜在线');
  assert.equal(futureView.lastSeenText, '时间未知', '超前时间不得显示“刚刚”');
});

test('设备请求失败时用当前时间重映射缓存 DTO：3 小时前的在线快照会变成离线', () => {
  const dto = parseOneDevice({
    lastSeenTs: NOW - 1000,
    sensors: { motion: { lastActiveTs: NOW - 1000, countToday: 2 } }
  });
  const freshView = mapDevices([dto], NOW)[0];
  assert.equal(freshView.online, true, '刚收到的快照应在线');
  // 模拟“随后 3 小时设备断连、请求持续失败”：服务层用同一批 DTO + 当前时间重映射。
  const laterNow = NOW + 3 * 60 * 60 * 1000;
  const staleView = mapDevices([dto], laterNow)[0];
  assert.equal(staleView.online, false, '重映射后必须按当前时间判离线');
  assert.equal(staleView.lastSeenText, '3 小时前');
  assert.equal(staleView.sensors.find((s) => s.kind === 'motion').state, 'offline');
});

test('onPageShow 刷新策略：12s 内成功同步跳过；失败/从未成功/超过 12s/时钟异常必须刷新', () => {
  assert.equal(RESUME_REFRESH_AFTER_MS, 12000);
  assert.equal(shouldRefreshOnShow(NOW - 5000, 'ok', NOW), false, '5s 前刚同步成功，无需重复请求');
  assert.equal(shouldRefreshOnShow(NOW - 12000, 'ok', NOW), false, '恰好 12s 边界不刷新');
  assert.equal(shouldRefreshOnShow(NOW - 12001, 'ok', NOW), true, '超过 12s 需要刷新');
  for (const status of ['offline', 'error', 'partial', 'unknown', 'loading', 'unauthorized']) {
    assert.equal(shouldRefreshOnShow(NOW - 1000, status, NOW), true, `netStatus=${status} 必须重试刷新`);
  }
  assert.equal(shouldRefreshOnShow(0, 'ok', NOW), true, '从未成功刷新必须请求');
  assert.equal(shouldRefreshOnShow(NOW + 30 * 60 * 1000, 'ok', NOW), true, 'lastUpdatedAt 超前必须重新刷新');
});

// ------------------------------------------- homemon 2026-10-27 能力/数据契约

test('sensors.motion.supported/reported/reason：兼容解析，缺失/非法不改变旧行为', () => {
  const withContract = parseOneDevice({
    sensors: { motion: { lastActiveTs: 0, countToday: 0, supported: false, reported: false, reason: 'PIR_DISABLED' } }
  });
  assert.equal(withContract.sensors.motion.supportedPresent, true);
  assert.equal(withContract.sensors.motion.supported, false);
  assert.equal(withContract.sensors.motion.reportedPresent, true);
  assert.equal(withContract.sensors.motion.reported, false);
  assert.equal(withContract.sensors.motion.reason, 'PIR_DISABLED');

  const legacy = parseOneDevice({ sensors: { motion: { lastActiveTs: NOW - 1000, countToday: 3 } } });
  assert.equal(legacy.sensors.motion.supportedPresent, false, '旧数据没有 supported：保持原行为');
  assert.equal(legacy.sensors.motion.reportedPresent, false);
  assert.equal(legacy.sensors.motion.reason, '');

  // 非法类型按“字段未出现”处理，不信任非法声明。
  const invalid = parseOneDevice({ sensors: { motion: { supported: 'false', reported: 1 } } });
  assert.equal(invalid.sensors.motion.supportedPresent, false);
  assert.equal(invalid.sensors.motion.reportedPresent, false);

  // 只给 supported=false（未给 reported）：语义仍是“未配置 PIR”。
  const onlySupported = parseOneDevice({ sensors: { motion: { supported: false } } });
  const view = mapDevices([onlySupported], NOW)[0];
  const pir = view.sensors.find((s) => s.kind === 'motion');
  assert.ok(pir);
  assert.equal(pir.valueText, '未配置 PIR，无活动监测');
});

test('motionSemanticsFor：状态显式 supported=false 优先；旧数据回退到能力表', () => {
  const dayu = parseOneDevice({ deviceId: 'dayu200-living', roomId: 'r-living', roomName: '客厅', sensors: {} });
  const dayuView = mapDevices([dayu], NOW)[0];
  const dayuProfile = loadCore('capability/DeviceCapabilities.js').resolveCapability('dayu200-living');
  assert.equal(motionSemanticsFor(dayu, dayuProfile), 'camera');

  const explicit = parseOneDevice({
    deviceId: 'esp32-bath',
    sensors: { motion: { lastActiveTs: 0, countToday: 0, supported: false } }
  });
  const bathProfile = loadCore('capability/DeviceCapabilities.js').resolveCapability('esp32-bath');
  assert.equal(motionSemanticsFor(explicit, bathProfile), 'unsupported');
  assert.ok(dayuView);
});

test('monitorReason 解析 + 中文映射：未知短码保留原样，不推断“无人/跌倒”', () => {
  const dto = parseOneDevice({ monitorReason: 'camera_stale' });
  assert.equal(dto.monitorReason, 'camera_stale');
  const view = mapDevices([dto], NOW)[0];
  assert.equal(view.monitorReason, 'camera_stale');
  assert.equal(view.monitorReasonText, '检测结果过期');
  assert.equal(monitorReasonTextFor(''), '');
  assert.equal(monitorReasonTextFor('camera_offline'), '监测离线');
  assert.equal(monitorReasonTextFor('no_data'), '暂无检测结果');
  assert.equal(monitorReasonTextFor('mystery_code'), '监测原因 mystery_code');
  assert.doesNotMatch(monitorReasonTextFor('mystery_code'), /无人|跌倒/);
});

test('摄像头判定独立：缺检测字段时显示“等待检测数据/暂无有效检测数据”，不推断活动', () => {
  const noData = parseOneDevice({ deviceId: 'dayu200-living', roomId: 'r-living', roomName: '客厅', sensors: {} });
  const view = mapDevices([noData], NOW)[0];
  const camera = view.sensors.find((s) => s.kind === 'camera');
  assert.ok(camera);
  assert.equal(camera.valueText, '--');
  assert.match(camera.detailText, /未收到摄像头检测结果/);

  const monitorUnknown = parseOneDevice({
    deviceId: 'dayu200-living', roomId: 'r-living', roomName: '客厅', monitorOnline: -1,
    sensors: { motion: { lastActiveTs: NOW - 1000, countToday: 2 } }
  });
  const view2 = mapDevices([monitorUnknown], NOW)[0];
  const camera2 = view2.sensors.find((s) => s.kind === 'camera');
  assert.ok(camera2);
  assert.equal(camera2.valueText, '暂无有效检测数据');
});

// ---------------------------------------------------------------- 静态守卫

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('静态守卫：Index 在 onPageShow 按策略刷新并恢复轮询', () => {
  const index = read('entry/src/main/ets/pages/Index.ets');
  assert.match(index, /onPageShow\s*\(\s*\)/, '必须实现 onPageShow（回前台/断连恢复立即刷新）');
  assert.match(index, /refreshOnShow\(\)/, 'onPageShow 必须调用 GuardianService.refreshOnShow');
  assert.match(index, /isPolling\(\)/, '回前台时轮询未运行需恢复');
});

test('静态守卫：GuardianService 缓存原始 DTO，并在设备请求失败时按当前时间重映射', () => {
  const service = read('entry/src/main/ets/service/GuardianService.ets');
  assert.match(service, /lastDeviceDtos/, '必须缓存最近一次成功的设备 DTO');
  assert.match(service, /lastRoomDtos/, '必须缓存最近一次成功的房间 DTO');
  assert.match(service, /remapCachedDevicesForNow/, '设备请求失败时必须重映射缓存（旧在线不得冒充实时）');
  assert.match(service, /if \(devicesView === null\)[\s\S]{0,80}remapCachedDevicesForNow/,
    '失败分支（devicesView=null）必须调用重映射');
  assert.match(service, /refreshOnShow\s*\(/, '必须提供 onPageShow 刷新入口');
  assert.match(service, /shouldRefreshOnShow/, '刷新策略必须来自 core/polling/RefreshPolicy');
  assert.match(service, /lastRoomDtos = report\.rooms/, 'rooms 成功响应需写入缓存');
});

test('静态守卫：客厅不显示 PIR/NO_MOTION 文案；摄像头判定独立文案', () => {
  const mapper = stripComments(read('entry/src/main/ets/core/view/ViewMapper.ts'));
  assert.match(mapper, /PIR_UNCONFIGURED_TEXT/, '无 PIR 必须使用固定文案常量');
  assert.match(mapper, /CAMERA_NO_VALID_DATA_TEXT/, '摄像头无效推理必须使用固定文案');
  assert.match(mapper, /buildPirUnconfiguredView/, '缺少“未配置 PIR”独立瓦片');
  assert.match(mapper, /buildCameraMotionView/, '缺少摄像头判定独立瓦片');
  assert.doesNotMatch(mapper, /长时间无活动会触发 NO_MOTION[^\n]*camera/i);
  const profile = stripComments(read('entry/src/main/ets/core/capability/DeviceCapabilities.ts'));
  assert.match(profile, /motionSource\s*=\s*MotionSource\.CAMERA/, '客厅活动检测来源必须标记为摄像头判定');
});

test('静态守卫：设备页展示 monitorReason 中文说明（视觉监测状态不被“在线”掩盖）', () => {
  const device = read('entry/src/main/ets/pages/DevicePage.ets');
  assert.match(device, /monitorReasonText/, '设备页必须展示视觉监测原因');
  const models = read('entry/src/main/ets/core/view/Models.ts');
  assert.match(models, /monitorReasonText/, 'DeviceView 必须有 monitorReasonText 字段');
});
