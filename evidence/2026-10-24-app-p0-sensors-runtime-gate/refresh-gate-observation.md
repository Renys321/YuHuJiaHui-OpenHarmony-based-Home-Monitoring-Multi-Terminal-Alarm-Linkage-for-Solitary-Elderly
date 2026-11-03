# APP-P0-Sensors 安装前门禁观察（2026-10-24）

## API 探针

```text
probe=OK
auth_http=200
devices_http=200
capturedAt=2026-10-24T00:48:19.7698551+08:00

esp32-kitchen:
lastSeenTs=1792774096630
gas.raw=236
gas.valid=true
smoke.raw=329
smoke.valid=true

esp32-bath:
lastSeenTs=1792774097160
motion.lastActiveTs=1792773953214
motion.countToday=13
```

结论：**API_CURRENT**。  
证据：`authenticated-devices-whitelist.json`、`probe-result.txt`。  
未输出/保存 Token、Authorization、password。

## 冻结 APP 同进程刷新

页面前置（`pre-refresh.json`）：

```text
3/5 在线
厨房 · 22 小时前
燃气（MQ-5）上次读数 原始 ADC 332
烟雾（MQ-2）上次读数 原始 ADC 527
上次更新 00:48 · 数据已同步
```

操作：只点击 MonitorPage 现有刷新图标一次（坐标 1161,246）。  
刷新后（`after-refresh.json`）：

```text
toast=数据已刷新
netStatus=数据已同步
lastUpdatedAt=00:48
页面仍为：
厨房 · 22 小时前
燃气（MQ-5）上次读数 原始 ADC 332
烟雾（MQ-2）上次读数 原始 ADC 527
```

结论：**API_CURRENT + APP_REFRESH_TOAST_SUCCESS_BUT_DATA_OLD**。

## 判定

- 不安装 `F91852…` 候选。
- 当前旧数据不属于认证失败：刷新没有提示登录失效，API 探针认证 200。
- 首个差异位于 **API 之后、冻结 APP 的 devices 快照提交/页面刷新路径**；不是 gateway/backend 摄入（202 已连续）。
- 本轮没有安装、没有重启 APP/服务、没有操作 COM5/COM14/COM8、没有触发 PIR/SOS/ACK。
- `8A722…` 仍是最终冻结版本。
