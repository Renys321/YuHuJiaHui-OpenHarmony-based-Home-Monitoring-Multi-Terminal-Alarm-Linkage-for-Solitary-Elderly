# 电量链路 grep 证据（2026-10-27，battery-chain）

## 1) 固件：battery 只在 CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0 时编译/上报
```
node_main.c:80: #if CONFIG_NODE_BATTERY_ADC_CHANNEL > 9
node_main.c:83: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0 && \
node_main.c:84: (CONFIG_NODE_BATTERY_ADC_CHANNEL == CONFIG_NODE_MQ2_ADC_CHANNEL || \
node_main.c:85: CONFIG_NODE_BATTERY_ADC_CHANNEL == CONFIG_NODE_MQ5_ADC_CHANNEL)
node_main.c:88: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0 && CONFIG_NODE_BATTERY_MIN_MV > CONFIG_NODE_BATTERY_MAX_MV
node_main.c:196: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
node_main.c:204: #if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0 || CONFIG_NODE_MQ5_ADC_CHANNEL >= 0 || CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
node_main.c:508: #if CONFIG_NODE_MQ2_ADC_CHANNEL >= 0 || CONFIG_NODE_MQ5_ADC_CHANNEL >= 0 || CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
node_main.c:509: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
node_main.c:528: (int)CONFIG_NODE_BATTERY_ADC_CHANNEL,
node_main.c:550: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
node_main.c:553: ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, (adc_channel_t)CONFIG_NODE_BATTERY_ADC_CHANNEL, &chan_cfg));
node_main.c:558: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
node_main.c:576: ? adc_oneshot_read(s_adc, (adc_channel_t)CONFIG_NODE_BATTERY_ADC_CHANNEL, &raw)
node_main.c:586: (int)CONFIG_NODE_BATTERY_ADC_CHANNEL);
node_main.c:609: static void battery_tick(void)
node_main.c:1468: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
node_main.c:1471: battery_tick();
node_main.c:1665: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
node_main.c:1670: char battery_json[240];
node_main.c:1675: snprintf(battery_json, sizeof(battery_json),
node_main.c:1685: const char *battery_json = "";
node_main.c:1712: battery_json);
node_main.c:1726: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
node_main.c:1728: (int)CONFIG_NODE_BATTERY_ADC_CHANNEL, s_batt.raw_median, s_batt.mv,
```

## 2) 适配器 / cloud-sync / 网关
```
adapter.js:12: /* 电量（契约 BATTERY-CHAIN-CONTRACT.md §2/§3）：
adapter.js:13: *   - source: "battery"（设备接了电池采样）| "fixed"（固定供电，不输出该字段时缺省）
adapter.js:17: *   - valid=true 必须 source="battery" 且 mv 是正整数（0mV 永远不是有效电池电压）
adapter.js:22: const BATTERY_SOURCES = new Set(['battery', 'fixed']);
adapter.js:23: const BATTERY_FIELDS = ['source', 'present', 'valid', 'mv', 'percent', 'low', 'calibrated', 'reason'];
adapter.js:24: const BATTERY_REQUIRED_FIELDS = ['source', 'present', 'valid', 'mv', 'percent', 'low', 'calibrated'];
adapter.js:25: const BATTERY_REASON_RE = /^[A-Z_]{0,16}$/;
adapter.js:26: const BATTERY_MV_MAX = 60000;
adapter.js:313: * 缺失（undefined）返回 undefined -> normalizeStatus 返回 battery: undefined；
adapter.js:315: function normalizeBattery(value) {
adapter.js:317: const battery = requirePlainObject(value, 'status.battery');
adapter.js:318: requireExactKeys(battery, BATTERY_FIELDS, 'battery', BATTERY_REQUIRED_FIELDS);
adapter.js:319: const source = battery.source;
adapter.js:320: if (typeof source !== 'string' || !BATTERY_SOURCES.has(source)) {
adapter.js:321: fail('battery.source must be "battery" or "fixed"');
adapter.js:323: const present = requireBoolean(battery.present, 'battery.present');
adapter.js:324: const valid = requireBoolean(battery.valid, 'battery.valid');
adapter.js:325: const low = requireBoolean(battery.low, 'battery.low');
adapter.js:326: const calibrated = requireBoolean(battery.calibrated, 'battery.calibrated');
adapter.js:327: const mv = battery.mv === null ? null : requireInteger(battery.mv, 'battery.mv', 0, BATTERY_MV_MAX);
adapter.js:328: const percent = battery.percent === null
adapter.js:330: : requireInteger(battery.percent, 'battery.percent', 0, 100);
adapter.js:331: const reason = battery.reason === undefined ? '' : battery.reason;
adapter.js:332: if (typeof reason !== 'string' || !BATTERY_REASON_RE.test(reason)) {
adapter.js:333: fail('battery.reason must match [A-Z_]{0,16}');
adapter.js:337: fail('fixed power supply must not report battery presence/voltage/percent');
adapter.js:341: if (source !== 'battery') fail('valid battery requires source "battery"');
adapter.js:342: if (mv === null || mv <= 0) fail('valid battery requires a positive mv reading');
adapter.js:345: fail('invalid battery must not carry mv/percent/low');
adapter.js:348: fail('battery.percent requires calibrated=true and valid=true');
adapter.js:368: const battery = normalizeBattery(status.battery);
adapter.js:371: return { deviceId, room, online, state, motion, door, ...climate, gas, smoke, fall, alarm, gps, battery, csq };
adapter.js:394: for (const key of ['motion', 'door', 'temperature', 'humidity', 'gas', 'smoke', 'fall', 'alarm', 'gps', 'battery', 'csq']) {
cloud-sync.js:91: /* 电量（契约 §4）：只在设备真的上报了 battery 时透传；缺失 = 该设备无电量数据，
cloud-sync.js:93: if (device.battery !== undefined) payload.battery = cloneBoundedObject(device.battery, 'device.battery');
gateway.js:126: battery: normalized.battery,
gateway.js:383: battery: snapshot.battery,
gateway.js:407: device.battery = snapshot.battery;
gateway.js:548: if (isPlainObject(device.battery)) status.battery = device.battery;
gateway.js:848: battery: params.battery ? params.battery.value : undefined,
```

## 3) 后端
```
store.js:17: * 电量（契约 BATTERY-CHAIN-CONTRACT.md §2/§5）。
store.js:19: * 非法 battery 也只降级为“无电量”并记录内部 code，绝不让整条设备状态被丢弃。
store.js:21: const BATTERY_SOURCES = new Set(['battery', 'fixed']);
store.js:22: const BATTERY_FIELDS = ['source', 'present', 'valid', 'mv', 'percent', 'low', 'calibrated', 'reason'];
store.js:23: const BATTERY_REASON_RE = /^[A-Z_]{0,16}$/;
store.js:24: const BATTERY_MV_MAX = 60000;
store.js:78: * 返回值 `{ battery, code }`：
store.js:79: *   - battery = null：没有电量数据（缺失），或非法而被降级为“无电量”；
store.js:83: * 契约 §5 要求“非法 battery 不得导致设备状态整体丢弃”。其他字段（deviceId/state）
store.js:86: function normalizeBattery(input) {
store.js:87: if (input === undefined || input === null) return { battery: null, code: null };
store.js:89: return { battery: null, code: 'BATTERY_INVALID_SHAPE' };
store.js:92: if (!BATTERY_FIELDS.includes(key)) return { battery: null, code: 'BATTERY_INVALID_SHAPE' };
store.js:95: if (typeof source !== 'string' || !BATTERY_SOURCES.has(source)) {
store.js:96: return { battery: null, code: 'BATTERY_INVALID_SHAPE' };
store.js:99: if (typeof input[key] !== 'boolean') return { battery: null, code: 'BATTERY_INVALID_SHAPE' };
store.js:102: if (mv !== null && (!Number.isSafeInteger(mv) || mv < 0 || mv > BATTERY_MV_MAX)) {
store.js:103: return { battery: null, code: 'BATTERY_OUT_OF_RANGE' };
store.js:107: return { battery: null, code: 'BATTERY_OUT_OF_RANGE' };
store.js:110: if (typeof reason !== 'string' || !BATTERY_REASON_RE.test(reason)) {
store.js:111: return { battery: null, code: 'BATTERY_INVALID_SHAPE' };
store.js:116: return { battery: null, code: 'BATTERY_INCONSISTENT' };
store.js:120: if (source !== 'battery') return { battery: null, code: 'BATTERY_INCONSISTENT' };
store.js:122: if (mv === null || mv <= 0) return { battery: null, code: 'BATTERY_INCONSISTENT' };
store.js:124: return { battery: null, code: 'BATTERY_INCONSISTENT' };
store.js:127: return { battery: null, code: 'BATTERY_INCONSISTENT' };
store.js:129: return { battery: { source, present, valid, mv, percent, low, calibrated, reason }, code: null };
store.js:151: const battery = normalizeBattery(input.battery);
store.js:162: battery: battery.battery,
store.js:163: batteryRejectCode: battery.code,
store.js:214: if (status.batteryRejectCode) {
store.js:215: console.warn(`[store] BATTERY_REJECTED code=${status.batteryRejectCode} device=${status.deviceId}`);
store.js:499: * batteryRejectCode 只是内部诊断码，绝不进入设备对外序列化。 */
store.js:500: if (device.battery) publicDevice.battery = device.battery;
store.js:720: /* 部分回执（ACK 只证明状态变更）没带 battery 时保留上次真实电量，
store.js:722: if (rawDeviceState.battery === undefined) deviceState.battery = previousDevice.battery;
store.js:745: BATTERY_FIELDS,
store.js:746: BATTERY_MV_MAX,
store.js:747: BATTERY_REASON_RE,
store.js:748: BATTERY_SOURCES,
store.js:755: normalizeBattery,
persistent-store.js:41: const { ALARM_ID_RE, COMMAND_ID_RE, DEVICE_ID_RE, DOOR_EVENT_CAP, DOOR_EVENT_ID_RE, EVIDENCE_ID_RE, MemoryStore, normalizeBattery, normalizeWearableLocation } = require('./store');
persistent-store.js:185: battery: device.battery ? cloneJson(device.battery) : null,
persistent-store.js:347: * 新快照里出现非法 battery 时降级为 null（遥测字段不值得让整个库拒绝启动），
persistent-store.js:349: const battery = normalizeBattery(raw.battery);
persistent-store.js:360: battery: battery.battery,
```

## 4) wearable（hb 帧）
```
wearable_logic.c:703: static void wb_jw_battery(wb_jw_t *w, const wb_battery_t *batt)
wearable_logic.c:731: int wb_build_hb_ex(char *out, size_t cap, const char *dev, wb_state_t state,
wearable_logic.c:749: wb_jw_battery(&w, batt);
wearable_logic.c:758: return wb_build_hb_ex(out, cap, dev, state, alarm_id, uptime_ms, csq, NULL);
wearable_main.c:41: * 因此不能把 CONFIG_NODE_BATTERY_CALIBRATED 当 0 用；这里统一折叠成本地 0/1 宏。 */
wearable_main.c:42: #ifdef CONFIG_NODE_BATTERY_CALIBRATED
wearable_main.c:43: #define NODE_BATTERY_CALIBRATED 1
wearable_main.c:45: #define NODE_BATTERY_CALIBRATED 0
wearable_main.c:52: #if CONFIG_NODE_BATTERY_ADC_CHANNEL > 9
wearable_main.c:53: #error "NODE_BATTERY_ADC_CHANNEL 只允许 ADC1_CH0..CH9（-1=未接电池采样）"
wearable_main.c:55: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0 && CONFIG_NODE_BATTERY_MIN_MV > CONFIG_NODE_BATTERY_MAX_MV
wearable_main.c:56: #error "NODE_BATTERY_MIN_MV 必须 <= NODE_BATTERY_MAX_MV"
wearable_main.c:71: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0 && WB_PIN_FORBIDDEN(CONFIG_NODE_BATTERY_ADC_CHANNEL)
wearable_main.c:251: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
wearable_main.c:257: static void wb_battery_init(void)
wearable_main.c:260: s_batt_cfg.divider_num = CONFIG_NODE_BATTERY_DIVIDER_NUM;
wearable_main.c:261: s_batt_cfg.divider_den = CONFIG_NODE_BATTERY_DIVIDER_DEN;
wearable_main.c:262: s_batt_cfg.gain_permille = CONFIG_NODE_BATTERY_CAL_GAIN_PERMILLE;
wearable_main.c:263: s_batt_cfg.offset_mv = CONFIG_NODE_BATTERY_CAL_OFFSET_MV;
wearable_main.c:264: s_batt_cfg.low_mv = CONFIG_NODE_BATTERY_LOW_MV;
wearable_main.c:265: s_batt_cfg.min_mv = CONFIG_NODE_BATTERY_MIN_MV;
wearable_main.c:266: s_batt_cfg.max_mv = CONFIG_NODE_BATTERY_MAX_MV;
wearable_main.c:267: s_batt_cfg.calibrated = NODE_BATTERY_CALIBRATED ? 1 : 0;
wearable_main.c:285: ESP_ERROR_CHECK(adc_oneshot_config_channel(s_batt_adc, (adc_channel_t)CONFIG_NODE_BATTERY_ADC_CHANNEL, &chan_cfg));
wearable_main.c:288: (int)CONFIG_NODE_BATTERY_ADC_CHANNEL,
wearable_main.c:289: (int)CONFIG_NODE_BATTERY_DIVIDER_NUM, (int)CONFIG_NODE_BATTERY_DIVIDER_DEN,
wearable_main.c:290: NODE_BATTERY_CALIBRATED ? "是" : "否(percent=null)",
wearable_main.c:291: (int)CONFIG_NODE_BATTERY_MIN_MV, (int)CONFIG_NODE_BATTERY_MAX_MV,
wearable_main.c:292: (int)CONFIG_NODE_BATTERY_LOW_MV, (int)CONFIG_NODE_BATTERY_SAMPLE_SEC);
wearable_main.c:296: static void wb_battery_tick(uint32_t now_ms)
wearable_main.c:303: s_batt_next_ms = now_ms + (uint32_t)CONFIG_NODE_BATTERY_SAMPLE_SEC * 1000u;
wearable_main.c:307: esp_err_t err = adc_oneshot_read(s_batt_adc, (adc_channel_t)CONFIG_NODE_BATTERY_ADC_CHANNEL, &raw);
wearable_main.c:316: (int)CONFIG_NODE_BATTERY_ADC_CHANNEL);
wearable_main.c:328: static const wb_battery_t *wb_battery_snapshot(void)
wearable_main.c:330: static wb_battery_t snap;
wearable_main.c:341: static void wb_battery_init(void)
wearable_main.c:343: ESP_LOGI(TAG, "电池采样未启用（CONFIG_NODE_BATTERY_ADC_CHANNEL=-1）：hb 帧不含 battery 字段");
wearable_main.c:363: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
wearable_main.c:367: wb_battery_snapshot());
wearable_main.c:684: wb_battery_init();   /* 电池采样（未启用时只打印一行，不影响任何既有链路） */
wearable_main.c:783: #if CONFIG_NODE_BATTERY_ADC_CHANNEL >= 0
wearable_main.c:785: wb_battery_tick(now);
```
