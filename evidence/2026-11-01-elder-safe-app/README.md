# 2026-11-01 老人自述安全：云端记录 + 手机 APP + DAYU200 只读广播

本目录是这一轮“S3 说‘我没事’”全链路的证据与操作记录。

## 1. 目标链路

```text
S3 说“我没事”
  ├─ ① 两台 ESP32 音箱播报（原有）
  ├─ ② 上报云端 /internal/v1/elder-safe（新增）
  │      └─ 手机 APP 拉取 /api/v1/elder-safe 并显示“未确认”
  └─ ③ 9302 广播 s3_asr / s3_safe（新增）
         └─ DAYU200 只读 AI 页显示（不含音频）
原告警保持 pending，不自动 ACK。
```

## 2. 已完成的验证

| 项目 | 结果 | 证据 |
|---|---|---|
| 后端接口与单测（写入/读回/401/非法输入/容量/持久化/保留期） | PASS | `competition/cloud/backend/test/elder-safe-api.test.js` |
| 本地后端 + 网关上报 | PASS | `gateway-localtest.log`：`云端已记录 eventId=es-1` |
| 9302 广播 `s3_asr` / `s3_safe` | PASS | `gateway-board-broadcast.log`：ASR 后 +1 ms 收到 `s3_safe` |
| DAYU200 1.0.13 只读页 | PASS | `dayu-01-ai-page-connected.jpeg`、`dayu-02-elder-safe.jpeg` |
| 手机 APP 成功态（本地联调） | PASS | `phone-08-home-elder-safe-localstaging.png`、`phone-09-home-elder-safe-linked-localstaging.png` |
| 点击“查看原预警”跳转 | PASS | `phone-10-alarm-detail-pending-localstaging.png` |
| 原告警仍 pending、不自动 ACK | PASS | 截图详情页“待确认”；本地接口 `state=ALARM`、`acknowledgedAt=0` |
| 失败可见（生产后端 404） | PASS | `phone-07.png`：显示“老人自述安全加载失败”，无假数据 |
| 公网后端部署 | **PASS（2026-11-01 13:54）** | Workbench 上传 5 个文件 → `build --no-cache` → `up -d`；登录后 `/api/v1/elder-safe` 返回 200 |
| 生产网关 INGEST_KEY | **PASS** | 网关日志“云端上报已启用”；生产事件 `es-2 room=厨房` 已写入 |

## 3. 制品

| 文件 | 说明 |
|---|---|
| `dayu/dayu-eldercare-1.0.13-norpc.hap` | DAYU200 1.0.13，已去除 `rpcid.sc` |
| `dayu/dayu-eldercare-1.0.13-signed.hap` | 上述 HAP 的调试签名版，已安装到 DAYU200 |
| `phone/phone-eldercare-v2-production-unsigned.hap` | 手机 APP 生产构建（`https://api.luxunacc.xyz`） |
| `phone/phone-eldercare-v2-localstaging-unsigned.hap` | 仅用于本地联调的构建（`http://127.0.0.1:18080`），不要交付 |
| `phone-00-launch.png` | APP 启动页 |
| `phone-07.png` | 部署前的失败态：显示“老人自述安全加载失败”，无假数据 |
| `phone-11-production-kitchen.jpg` | 生产环境成功态（9303 回放）：厨房 / 我没事 / 未确认 |
| `phone-12-production-s3-live.jpg` | **生产环境成功态（S3 现场真人）**：厨房 / 我没事 / 未确认；对应 `es-3` |
| `gateway-production-s3-live.log` | S3 现场录音 → 二次识别 → 云端 `es-3` 的网关日志 |
| `phone-13-production-after-ack.jpg` | 家属对原告警发起 ACK 后，自述安全绿卡自动隐藏；旧“测试”记录不会顶上来 |
| `phone-14-linked-before-ack.jpg` | S3 上传带 `alarmId`，未 ACK 时显示厨房绿卡 |
| `phone-15-linked-after-ack.jpg` | 对同一 `alarmId` ACK 后绿卡消失 |
| `gateway-alarmid-linked.log` | 网关 hello 带 `alarmId` + 云端 `es-6` 记录 |
| `phone-16-unconfirmed-before-ack.jpg` | 三态之一：未点 ACK，显示“未确认” |
| `phone-17-pending-device-ack.jpg` | 三态之二：已点 ACK，显示“家属已确认，等待设备回执” |
| `dayu-target-bathroom-persisted-1.0.17.jpeg` | 重启后 DAYU 播放目标仍为卫生间（最终演示配置） |
| `dayu-speaker-target-1.0.17.jpeg` | DAYU 1.0.17 播放音箱选择（全部/厨房/卫生间） |
| `dayu-speaker-target-kitchen-1.0.17.jpeg` | 选厨房后提问，网关只推 kitchen |
| `dayu-quick-questions-settings-1.0.16.jpeg` | DAYU 1.0.16 快捷问题设置面板（4 个输入框） |
| `dayu-quick-qa-1.0.16.jpeg` | DAYU 1.0.16 快捷提问按钮态 |
| `dayu-quick-qa-1.0.15.jpeg` | DAYU200 1.0.15 快捷提问：点“我头晕”显示 DeepSeek 回答 |
| `phone-19-forced-prompt-safe.jpg` | 提示后强制识别，“我没事”正常更新到 APP |
| `mic-noise-fix.log` | 麦克风降增益/高通后的底噪 RMS 记录 |
| `gateway-key1-onekey-health.log` | 一键 KEY1：clip 先于 answer，S3 本地播放健康语音 |
| `gateway-key1-health-localclip.log` | KEY1 health → 本地 clip=9 播放证据 |
| `gateway-ack-audio-retry.log` | 回执语音修复后：2 节点、123520B、done ok=1 |
| `gateway-prompt-forced-safe.log` | `reason=prompt` → ASR 我没事 → 云端 es-12 → 音箱 |
| `phone-18-acked-final.jpg` | 三态之三：关联告警已 ACKED，绿卡消失；首页/预警页只保留最新一条 |
| `phone-08-home-elder-safe-localstaging.png` | 手机首页绿色“老人自述安全”卡片（本地联调） |
| `phone-09-home-elder-safe-linked-localstaging.png` | 带“查看原预警”的卡片（本地联调） |
| `phone-10-alarm-detail-pending-localstaging.png` | 跳转后的原告警详情：仍为“待确认” |
| `dayu-01-ai-page-connected.jpeg` | DAYU200 AI 页只读、已连接 |
| `dayu-02-elder-safe.jpeg` | DAYU200 显示 `s3_safe`、来源、2 台音箱、时间 |
| `dayu-03-elder-safe-production-mode.jpeg` | 生产模式（未配置 INGEST_KEY）下仍能广播：播报正常、板端显示正常 |
| `gateway-production-mode.log` | 生产模式网关日志：无密钥时跳过云端上报，播报/广播不受影响 |
| `gateway-localtest.log` | 本地联调网关完整日志 |
| `gateway-board-broadcast.log` | 9302 订阅端收到的广播 |
| `_work/` | 原始截图、本地后端数据与日志 |

## 4. 本地联调复现（无需公网）

1. 启动后端（示例值，勿用于生产）：
   ```bash
   cd competition/cloud/backend
   API_TOKEN_SECRET=local-test-token-secret-0123456789abcdef \
   INGEST_KEY=local-test-ingest-key-0123456789abcdef \
   APP_GUARDIAN_ID=<与 .secrets/app_guardian.txt 第一行一致> \
   APP_GUARDIAN_PASSWORD=<第二行> \
   CONTACTS_JSON='[]' \
   BACKEND_DATA_FILE=.../backend-data/backend-state.json \
   node src/main.js
   ```
2. 启动网关（指向本地后端）：
   ```bash
   cd competition/voice-gateway
   CLOUD_BASE_URL=http://127.0.0.1:18080 \
   INGEST_KEY=local-test-ingest-key-0123456789abcdef node server.js
   ```
3. 用 9303 客户端上传 16 kHz、单声道、PCM S16LE 的“没事”录音；
   干净命中时网关日志出现 `[elder-safe] 云端已记录 eventId=...`。
4. 手机 APP 本地联调构建：把 `GuardianService.ets` 的 `API_BASE_URL`
   临时改为 `http://127.0.0.1:18080`，构建安装后执行
   `hdc -t 127.0.0.1:5555 rport tcp:18080 tcp:18080`。
   截图完成后必须改回生产地址并重新构建（本目录已包含生产构建）。
5. DAYU200：`hdc -t <序列号> rport tcp:9302 tcp:9302`，打开 AI 问答页。

## 5. 后端部署记录（已完成 2026-11-01 13:54）

公网状态：`GET https://api.luxunacc.xyz/api/v1/elder-safe` 携带真实监护人 Bearer 后
返回 **200**，事件 `es-1`（测试）与 `es-2`（厨房）已写入。执行过程：

- Workbench 上传 `elder-safe-backend-files.zip`（5 个文件）到 `/opt/eldercare/`；
- `unzip -o ... -d cloud/backend/`；
- `docker compose ... build --no-cache backend` + `up -d backend`；
- 容器内 `grep elder-safe /app/src/server.js` 确认新代码；
- 本地写入 `.secrets/ingest_key.txt`，重启 PC 网关，日志显示“云端上报已启用”。

```sh
cd /opt/eldercare                      # 按实际目录
# 1) 同步本仓库的 cloud/backend 到服务器（Workbench 上传/解压，或 git pull）
# 2) 重建并替换（会保留命名卷 backend-data）
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml \
  build --no-cache backend
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml \
  up -d backend
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps
docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml \
  logs --tail=100 backend
```

验证（不要把密钥写进命令历史）：

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://api.luxunacc.xyz/healthz   # 200
# 用 APP 登录后：GET /api/v1/elder-safe?limit=5 应为 200，events 可为空
# 用 x-ingest-key 调用 POST /internal/v1/elder-safe 应返回 202 + eventId
```

部署后已完成：

1. `INGEST_KEY` 已写入 `competition/.secrets/ingest_key.txt` 并重启网关；
2. 手机 APP 生产构建已显示“厨房 · 我没事 · 刚刚 · 未确认”，截图
   `phone-11-production-kitchen.jpg`；
3. `docs/VALIDATION-MATRIX.md` 第 14 节 BLOCKED 项已改为 PASS。

数据文件：默认 `BACKEND_ELDER_SAFE_FILE` 与 `BACKEND_DATA_FILE` 同目录，
容器内为 `/data/elder-safe-state.json`，位于 `backend-data` 命名卷，容器重启保留。

## 6. 边界

- `phone-11` 是 9303 回放；`phone-12` 是 S3 现场真人触发，事件 `es-3`；两者都是生产后端。
- 单次现场通过，不等于远场/口音/连续多轮都通过，不能外推通用识别率。
- 语音输入为 PC 回放的 PCM，不是 S3 咪头现场人声；真人现场复测仍需补做。
- DAYU200 依赖 USB 与 `hdc rport`；重插/重启后必须重新执行。
- 本目录不含任何密钥、完整手机号、Token 或录音原文件。
