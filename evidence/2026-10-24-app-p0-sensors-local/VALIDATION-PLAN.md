# APP-P0-Sensors 后续真实验收计划（本轮未执行）

## 当前状态

```text
候选已构建、未安装
冻结 8A722 HAP 保留
未联网、未重启服务、未操作设备
MQ/PIR 字段链路仍为 SOURCE VERIFIED / RUNTIME NOT VERIFIED
```

## 安装前

1. 明确授权；
2. 再次核对候选 SHA-256：`F91852D055DDD7A11B8207D1E1C14B11D6C018D441331401ADE42D9701FEE819`；
3. 确认目标为 `127.0.0.1:5555`，保留数据/会话；
4. 备份当前冻结 HAP 和当前数据；安装失败立即回退 `8A722…`。

## 同一时间窗口验收

```text
厨房自然 JSON
→ MQTT home/esp32-kitchen/status
→ Bridge
→ gateway normalizeIncoming
→ public-sync 202
→ 已认证 backend /api/v1/devices
→ APP DTO/ViewMapper
→ MonitorPage
→ DevicePage
```

要求：

- 只恢复既有 Broker/Bridge/public-sync 单实例；
- 不发送手工 MQTT，不使用 retained；
- 不操作 COM5/COM14/COM8；
- 不重烧设备；
- 记录 `sensors.gas.raw/valid`、`sensors.smoke.raw/valid`、`sensors.motion.lastActiveTs/countToday`；
- MQ 报警禁用语义不变；
- 卫生间 PIR 以真实人体移动为触发，不用模拟数据；
- 失败立即回退冻结 HAP。

## DevicePage 验收

- 厨房卡片显示 MQ-5/MQ-2 名称、状态、`原始 ADC n`、报警未启用/未标定详情；
- 卫生间卡片显示 PIR 最近活动/今日次数；
- 离线时保留上次读数，不显示在线；
- 无 PIR 的厨房不出 motion；无 MQ 的卫生间不出 gas/smoke。

## MonitorPage 验收

- 与 DevicePage 使用同一 SensorView；
- 已有内联在线摘要不回归；
- 离线/无有效值仍保持原语义；
- 不重装冻结 HAP，不覆盖 8A722。
