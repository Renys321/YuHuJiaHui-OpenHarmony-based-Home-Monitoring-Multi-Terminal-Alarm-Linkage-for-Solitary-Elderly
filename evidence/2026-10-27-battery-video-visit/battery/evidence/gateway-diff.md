# gateway.js 电量透传：改动前/后对照（Lead 审批项，2026-10-27）

批准来源：Lead 消息（2026-10-27）——“gateway.js 的 4 处加性透传批准（契约 §4）。约束：
只加 battery 透传，不改既有 topic/命令/校验/限频/去重/回执语义；gateway 既有 47 项测试必须全绿”。

实际改动 = **5 处、每处仅新增 1 行 battery 透传（部分带 1 行说明注释）**，无删除、无重排、
无既有表达式变更。既有 `gateway.test.js` 实测 **49 pass / 0 fail**（见 `evidence/onenet-tests.log`）。

## 1) `normalizeIncoming()`（line 848）——从 adapter 归一化结果取 battery

改动前（return 对象末尾）：

```js
    sensors,
    fall: params.fall ? params.fall.value : undefined,
    gps: params.gps ? params.gps.value : undefined,
    csq: params.csq ? params.csq.value : undefined
```

改动后（新增注释 + 1 行）：

```js
    sensors,
    fall: params.fall ? params.fall.value : undefined,
    gps: params.gps ? params.gps.value : undefined,
    /* 电量：adapter.normalizeStatus 已严格校验（契约 §3），这里只取归一化结果透传。 */
    battery: params.battery ? params.battery.value : undefined,
    csq: params.csq ? params.csq.value : undefined
```

含义：battery 缺失 → `undefined`（不补默认值/不编 0）；非法 battery 在 adapter 层已被拒绝整条报文。

## 2) `describeSnapshot()`（line 126）——设备快照保留 battery

改动前：`sensors / fall / gps / csq`。
改动后（新增注释 + 1 行）：`battery: normalized.battery,`。

## 3) 新设备聚合（line 383）——device.battery 初始化为快照值

```js
        sensors: snapshot.sensors,
        fall: snapshot.fall,
        gps: snapshot.gps,
        battery: snapshot.battery,     // ← 新增 1 行
        csq: snapshot.csq,
```

## 4) 既有设备聚合（line 407）——同设备新状态覆盖旧状态

```js
      device.sensors = snapshot.sensors;
      device.fall = snapshot.fall;
      device.gps = snapshot.gps;
      device.battery = snapshot.battery;   // ← 新增 1 行（与 sensors/gps/csq 完全同语义）
      device.csq = snapshot.csq;
```

## 5) `_cloudStatus()`（line 548）——上云 property/post 与后端同步载荷带上 battery

改动前：

```js
    if (isPlainObject(device.sensors) && Object.keys(device.sensors).length > 0) status.sensors = device.sensors;
    if (isPlainObject(device.fall)) status.fall = device.fall;
    if (isPlainObject(device.gps)) status.gps = device.gps;
    if (device.csq !== undefined) status.csq = device.csq;
```

改动后（新增注释 + 1 行）：

```js
    /* 电量：adapter 已归一化校验，这里只按“有就带、没有就不带”透传（契约 §4）。 */
    if (isPlainObject(device.battery)) status.battery = device.battery;
```

含义：固定供电设备（无 battery）上云状态/后端载荷里**不会出现** battery 字段；电池设备才有。

## 语义未变声明

- 未改 `_signature()`（限频判定只看 online/state/alarmId/room/monitorOnline）：电量变化不会额外触发上云风暴。
- 未改任何 MQTT 主题、命令处理、ACK/RESET 回执、告警去重记忆、离线判定逻辑。
- 严格校验仍在 `adapter.normalizeStatus`（未知字段/范围/自相矛盾一律拒绝）；gateway 只做“有就带”透传。
- 测试：新增 `gateway-battery.test.js` 5 条（上云保留 / 后端同步保留 / 无 battery 时字段集合不变 /
  新状态覆盖旧值 / 非法 battery 报文被拒绝且不污染已聚合状态），既有 49 条全绿。
