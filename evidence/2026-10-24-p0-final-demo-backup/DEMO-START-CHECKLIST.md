# 演示启动检查清单（2026-10-24 冻结基线）

逐项勾选；任何一项失败先停在该项，不要继续后续步骤。

## A. 硬件与网络

- [ ] 厨房 ESP32（现场 COM6，历史文档 COM14）供电、USB 连接正常。
- [ ] 卫生间 ESP32（现场 COM9，历史文档 COM5）供电、USB 连接正常。
- [ ] DAYU200（现场 COM11）供电、USB HDC 连接正常。
- [ ] 演示电脑与 ESP32 处于原演示网络；ESP32 固件配置的网关主机可达。
- [ ] 未操作/未烧录 ESP32，未修改 Wi-Fi/AP/DNS/backend/设备绑定。

## B. 一键启动

- [ ] 双击 `<WORKSPACE>\competition\materials\start-demo-supervisor.cmd`。
- [ ] 预检输出 PASS（文件/端口/DAYU/homemon 哈希/fport/运行锁）。
- [ ] 可见窗口隐藏输入一次 `INGEST_KEY`（不回显、不粘贴到聊天/文档）。
- [ ] 窗口保持打开，未关闭。
- [ ] supervisor 输出 `LOCK_ACQUIRED`、`WORKER_START`、`HEALTHY`。

## C. 进程与状态（只读核对）

- [ ] 恰好一个 supervisor 进程。
- [ ] 恰好一个 worker 进程，父进程是 supervisor。
- [ ] lock 内容 = supervisor PID；state `supervisorPid` 一致。
- [ ] state = `HEALTHY`，heartbeat 持续刷新。
- [ ] 无第二个 supervisor/worker（跨入口保护不会启动第二实例）。

## D. 业务数据（自然上报，禁止手工注入）

- [ ] `esp32-kitchen` 出现自然 `status=202`。
- [ ] `esp32-bath` 出现自然 `status=202`。
- [ ] `dayu200-living` 出现自然 `status=202`。
- [ ] 三条计数持续增长（非订阅瞬间 retained）。
- [ ] API `lastSeenTs` 三台均前进。
- [ ] MQTT 观察中 retained=0（人工观察记录，不伪装证据）。

## E. 手机 APP

- [ ] 既有模拟器 `127.0.0.1:5555` 已启动（不新建、不清数据）。
- [ ] `hdc list targets` 同时可见模拟器与 DAYU USB 目标。
- [ ] APP bundle `com.example.program_04` 已安装，`install -r` 不丢数据。
- [ ] APP 首页在线数 = MonitorPage 在线数（三目标在线时应为 3/5）。
- [ ] 保留历史设备（5 台），不删除历史设备对齐数字。
- [ ] 厨房：MQ-5/MQ-2 显示原始 ADC，明确“报警未启用”，不显示 ppm/浓度/正常。
- [ ] 卫生间：PIR 显示真实最近活动与今日次数（缺失不冒充 0），无 MQ 卡片。
- [ ] 厨房无 PIR 卡片；房间不串。
- [ ] DevicePage 显示 stateText/valueText/detailText。
- [ ] 三个自然轮询周期后页面自动更新（不重启 APP）。
- [ ] 超过 90 秒未上报 → 2/5 且卡片“离线/上次读数”，不冒充当前有效。
- [ ] 恢复自然上报后同一 APP PID 自动回到 3/5。
- [ ] DAYU ALARM 如实显示；不触发 SOS/ACK/reset。

## F. 结束与回退

- [ ] 如需结束：只关闭 supervisor 窗口（由用户操作）；不要杀进程。
- [ ] 任一关键项失败：保留证据，按 `RESTORE-GUIDE.md` 第 5 节回退到 8A722。
- [ ] 回退使用 `install -r`，不卸载、不清数据。
- [ ] 记录回退时间、失败点、APP PID 与证据路径。
