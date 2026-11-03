# START HERE — DAYU 演示统一启动

## 1. 开机后我需要做什么

1. 确认 DAYU 已上电、USB 数据线连接电脑、USB 调试已打开。
2. 在 Explorer 双击：

```text
<WORKSPACE>\competition\materials\start-demo-all.cmd
```

3. 保持打开的黑色窗口不要关闭。窗口会显示 P0、DAYU、应用、相机、检测、三节点状态。
4. 如果 P0/公网同步尚未运行，会自动打开现有 P0 入口窗口；在该窗口**只输入一次隐藏 INGEST_KEY**。普通启动通常不需要输入。

## 2. 正常情况下需要点击几次

- 正常情况下：**双击一次**。
- 已有 P0/看护器健康时再次双击：第二个窗口会提示复用现有看护器后退出，不会重复启动推理、不抢相机。
- 如果 P0 不在运行：仍是一次双击，随后在自动打开的 P0 窗口输入一次密钥。

## 3. 什么时候输入密钥

只有在 P0 公网同步入口需要启动、且尚无健康 supervisor 时。密钥只在 P0 自己的隐藏输入提示中输入；本看护器不读取、不记录、不写入文件/命令行/日志。

## 4. 怎么知道摄像头和检测真的在运行

启动窗口状态行示例：

```text
P0=healthy target=OK app=active detect=running frames=LIVE nodes=3/3
```

判定标准：

- `target=OK`：HDC 识别到正确 DAYU；
- `app=active`：正式应用在前台，演示监护开启；
- `detect=running`：DAYU 本机 P1-B 320 进程和 9200 监听存在；
- `frames=LIVE`：正式应用 JPEG 正在产生新的推理事件，而不是旧结果；
- `nodes=3/3`：页面显示三节点自然在线（若为 1/1 或 2/3，页面会如实显示）。

正式应用相机卡片下方还会显示“检测到人体 · N 帧 · x ms”，这是推理真实消费帧的辅助证据。

### 页面 “ms” 是什么

页面 `检测到人体 · N 帧 · 248 ms` 的 `ms` 是正式应用侧的**抓取 Surface + JPEG 编码 + HTTP 请求往返 + 解析响应**时间，不是服务端单帧推理耗时，也不是 summary 的 `inferMs`。两者口径不同，不能直接比较；详细追踪见 followup 的 `LATENCY-FIELD.md`。不要用页面 ms 宣称推理性能。

### 三节点

页面会如实显示全屋在线 X/Y。若某无线节点正在另行调试而离线，不影响本地相机/推理；不要把 2/3 或 1/3 写成全部在线。

## 5. USB 断开、DAYU 重启后会怎样

- 启动窗口继续运行；HDC 断开时显示等待，不把离线误报成“没人”。
- 恢复后自动检查/重启 homemon、重建 `tcp:9001→tcp:9000`、打开正式应用、启动推理。
- DAYU 正常重启已验证：无需 AI 命令，约 1 分钟内自动恢复。
- 注意：若 DAYU 上应用被用户**主动暂停**，看护器会尊重暂停，不会强行恢复。

## 6. 点停止后会不会又自动打开

不会。两种停止方式：

- 正式应用页面点“暂停监护”：看护器识别到“自动监护已暂停/恢复监护”后停止推理，并至少保持 60 秒不反向拉起；点“恢复监护”后恢复。
- 在看护窗口按 `S`：设置停止标志，停止本看护器拥有的推理；按 `R` 恢复。

本看护器不会强杀未知进程，也不会循环抢前台。

## 7. 关闭电脑窗口会停止哪些功能，DAYU 哪些继续

- 关闭看护窗口：停止 PC 看护/自动恢复逻辑；P0、正式应用和 DAYU 推理不会被主动停止。
- 关闭看护窗口后，PC 不再监测 USB/设备重启，也不自动恢复故障。
- 若 P0 窗口也关闭，则公网同步 supervisor 停止；本地相机和推理仍可继续（只要 DAYU 应用和推理进程在运行）。

## 8. 电脑关闭后哪些能力仍然可用

- DAYU 本机推理进程已用 `setsid` 启动，电脑关机/拔线不会立即停止它；
- 正式应用相机在应用前台可继续，但 PC 不再做自动恢复；
- 三节点自然数据只在本机页面/网关可用，PC 公网同步停止；
- 需要恢复电脑时重新双击入口即可。

## 9. 出错时用户该看哪里

1. 看启动窗口最后几行：`WAIT`/`ERROR`/`CONFLICT` 前的模块名。
2. 日志：

```text
<WORKSPACE>\competition\evidence\2026-10-26-demo-autostart\runtime\demo-autostart.log
```

3. 正式应用页面看相机是否预览、底部是否“检测到人体”、三节点是否在线。
4. 处理顺序：检查 DAYU 供电/USB → 重新插拔 → 重新双击入口；不需要先找 AI。
5. 不要手工结束未知 PID；不要关闭 P0 冻结制品。

## 常用按键

```text
S  停止自动看护（记录停止意图，不自动反向拉起）
R  恢复自动看护
Q  退出看护窗口（保留已运行服务）
```

## 入口与关键文件

- 正式入口：`<WORKSPACE>\competition\materials\start-demo-all.cmd`
- 看护器：`<WORKSPACE>\competition\materials\demo-autostart\demo-autostart.ps1`
- DAYU 推理部署包：`<WORKSPACE>\competition\materials\demo-autostart\dayu\`
- 设备独立目录：`/data/local/tmp/dayu-demo-autostart-2026-10-26/`
- 证据目录：`<WORKSPACE>\competition\evidence\2026-10-26-demo-autostart\`
