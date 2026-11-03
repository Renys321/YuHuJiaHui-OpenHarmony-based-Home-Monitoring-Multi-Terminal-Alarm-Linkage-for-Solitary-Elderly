# APP 模拟器冒烟验收取证（app-owner 自测，正式验收由 Lead 执行）

时间：2026-10-27 20:32–20:41（Asia/Shanghai）
环境：HarmonyOS 模拟器 `127.0.0.1:5555`；APP `com.example.program_04` **1.0.9 / 1000009**；relay `http://10.0.2.2:9443`（Lead 启动，local 模式，DAYU200 1.0.4 真实相机推流）。
说明：以下为 **APP 侧冒烟**，不是 Lead 的最终端到端验收；真实播放归 Lead 验收，本目录截图可作为 APP 侧证据。

## 0. 安装与版本

- `hdc install -r guardian-battery-video-1.0.9-unsigned.hap` → `install bundle successfully`（`install-1.0.9.log`）
- `bm dump` → `"versionName": "1.0.9"`、`"versionCode": 1000009`（`bm-dump-1.0.9.txt`）
- 冷启动截图 `app-launch-1.0.9.jpeg`：首页“视频探望 **可用**”，底部说明“视频探望为本次会话实时预览（不录像、不留存）”。`app-launch-1.0.9.log`。

## 1. 电量展示（真机模拟器运行截图）

- `device-page-1.0.9-1.jpeg`：设备管理页（4 台家庭设备、0 在线/4 离线）。
- `device-page-1.0.9-2.jpeg`：卫生间节点电量块：
  “**固定供电，无电池电量数据** / 卫生间节点为 USB 固定供电，板卡无电池电压采样电路与 ADC 分压接线。”
- `device-page-1.0.9-3.jpeg`：DAYU200 电量块：
  “固定供电，无电池电量数据 / DAYU200 由电源适配器固定供电，系统无 power_supply 设备；系统 BatteryService 的容量是模拟值，不是真实电量，APP 不使用。”
  以及 esp32-sos 电量块：
  “**电量未知（设备未上报电量）** / 未接入电量检测（无采样模块）：随身求助板当前由 USB 供电，板卡无电池座/充电/ADC 分压，固件未上报 battery。补齐条件：1S 锂电 + TP4056 充电保护 + 100k/100k 分压到 ADC1（避开按钮 GPIO4 / 蜂鸣 GPIO5），固件每 30s 采样并至少 2 点校准后上报 battery。”
- 全程没有出现任何 0%/100%/估算百分比。

## 2. 视频探望（真实 relay + DAYU200 真实相机画面）

| 证据 | 内容 |
|---|---|
| `video-page-smoke-1.jpeg` | 首页点“视频探望”进入后：`第 10 帧`、`4 fps`、`640×480`；画面为 DAYU200 相机实景（有真实人物/房间），状态“实时画面 · 已接收 10 帧 · 4 fps”，`最近帧 20:37:38`，中继地址 `http://10.0.2.2:9443`，隐私文案固定可见 |
| `video-page-smoke-3.jpeg` | 同一会话继续收到 `第 127 帧`、`3.4 fps`、`最近帧 20:38:44`；画面中人物姿态与上一张不同（连续帧变化，不是静态图） |
| `video-page-layout.json` | `uitest dumpLayout`：`pagePath=pages/VideoVisitPage`，`第 188 帧`、`3.5 fps`，结束探望按钮 bounds `[49,2027][1231,2181]` |
| `hilog-app-pid.log` | APP 进程 `NETSTACK websocket` 收帧 + `ImageSource: CreatePixelMap success ... srcSize: (640,480)`（640×480 真实 JPEG 解码，非占位图） |
| `video-page-reconnecting-after-relay-restart.jpeg` | relay 短暂中断后，页面进入“**正在申请视频会话…**”加载态（不是假画面、不显示直播成功）；恢复后布局 dump 显示 `第 188 帧 / 3.5 fps` 继续播放。注：自动化点击可能同时命中失败态“重新连接”按钮，真实环境“自动重连 vs 手动重试”的首次触发未严格区分（自动重连由单测覆盖，正式验收由 Lead 做） |
| `video-page-ended-return-home.jpeg` | 点“结束探望”后返回首页 |

### 退出停止（APP→relay）实测

点“结束探望”后立即查询 relay `/video/healthz`：

```json
{"ok":true,"mode":"local","dayuLink":"down","framesReceived":79,"fps":0,"lastFrameAgeMs":2562,"viewers":0}
```

→ `viewers=0`、`dayuLink=down`、`lastFrameAge 2562ms`：APP 关闭 WS 后 relay 约 3s 内停止 DAYU200 推流（relay 空闲停止策略）。

另一次观察（relay 重启前）：最后一次 viewer 关闭后 `{"viewers":1,"dayuLink":"down","lastFrameAgeMs":6300}` 出现在 relay 处理窗口内，随后 relay 重启；未作为正式结论。

## 3. 未在本轮冒烟中覆盖（由 Lead 正式验收）

- 401/伪造 token 不得出画面（APP 侧有失败态+重试按钮，单测覆盖；真实 401 由 Lead 验）。
- 连续 ≥60s 播放与退出后 ≤5s 停止的严格计时（Lead 执行）。
- 断网/拔 hdc 的失败与恢复路径（APP 侧重连逻辑已有单测；真实断网由 Lead 验）。
- 真实电池采样（无硬件，BLOCKED-BY-HARDWARE，BATTERY-CHAIN-CONTRACT §7）。
