# 2026-11-02 · 板载 APP 自动跳转收窄

## 问题

`northbound/entry/src/main/ets/pages/Index.ets` 的 `applySnap()` 在发现“新告警 id”时无条件
`this.current = 3`，即切到 AI 问答页。设备侧频繁新增 `NO_MOTION` 告警时，用户刚点完
“确认闭环”就被强制切走。

## 改动

```ts
if (newId.length > 0 && newId !== this.lastSafeAlarmId) {
  this.lastSafeAlarmId = newId;
  // 仅严重告警、且用户不在预警处置页时跳转，并做 30s 节流
  let severe: boolean = false;
  for (let k: number = 0; k < s.alarms.length; k++) {
    if (s.alarms[k].id === newId &&
        (s.alarms[k].type === 'FALL' || s.alarms[k].type === 'MANUAL_SOS')) {
      severe = true;
      break;
    }
  }
  const nowMs: number = Date.now();
  if (severe && this.current !== 1 && nowMs - this.lastAutoSwitchMs > 30000) {
    this.lastAutoSwitchMs = nowMs;
    this.current = 3;
  }
}
```

新增字段：`private lastAutoSwitchMs: number = 0;`

## 验证

- 用 `hvigorw assembleHap` 重新构建；
- 使用 OpenHarmony Release 证书链签名，`hdc install -r` 覆盖安装（数据保留）；
- 在“预警处置”页点确认闭环、等待 NO_MOTION 新增，页面不再跳转；
- 新跌倒仍生成“疑似跌倒”卡片。

证据：`evidence/2026-11-02-fall-live-verification/`（APP 截图、`fall-events.jsonl`）。
