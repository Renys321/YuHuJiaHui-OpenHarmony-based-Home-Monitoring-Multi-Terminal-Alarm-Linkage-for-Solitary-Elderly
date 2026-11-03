# 配置模板说明（不包含任何真实秘密）

本目录只放“恢复时需要知道的结构/路径”说明，不放真实配置值。

## public-sync / supervisor

- 必需秘密：`INGEST_KEY` 只在 supervisor 可见终端隐藏输入一次，不落盘、不进 argv/env/日志。
- 非秘密默认值：
  - backend URL：`https://api.luxunacc.xyz`
  - broker URL：`mqtt://127.0.0.1:1883`
  - supervisor state/lock/log 由启动入口传入（正式入口使用
    `competition/bridge/_test/current-runtime/supervisor/`）。

## Bridge / Broker

```text
broker: node mqtt_broker.js 1883
bridge: node mqtt_bridge.js --broker 127.0.0.1:1883 --status-tcp 127.0.0.1:9001 --listen 9101 --relay-to 127.0.0.1:9001 --cmd-out <runtime>/control --status-file <runtime>/status.json
```

## DAYU

- fport：`tcp:9001 -> tcp:9000`（HDC target 需现场确认）。
- homemon：运行设备上的 `/data/homemon/homemon` 原版；本备份含可信本地二进制
  `homemon-board-pre-0D243539`，哈希与冻结原版一致。
- homemon.conf 含现场网络配置，**本备份不包含**；恢复时使用设备现有配置，不覆盖。

## APP

- bundle：`com.example.program_04`
- 模拟器 target：`127.0.0.1:5555`
- 登录凭据（guardianId/password）由使用者在 APP 内输入，不写入任何文件。
