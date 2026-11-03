# 视频探望 relay 测试与交付报告（2026-10-27）

- 工作区：`<WORKSPACE>`；环境：Windows / PowerShell / Asia-Shanghai；Node `v24.19.0`
- 契约：`competition/evidence/2026-10-27-battery-video-visit/CONTRACTS/VIDEO-VISIT-CONTRACT.md`（§1 DAYU 协议 / §2 relay）
- 交付范围：relay 服务（local+agent 双模式）+ PC agent + node:test 全量测试 + ECS 部署件 + 文档
- 分级：**REAL**（本轮实测可复核）/ **FAKE-LABELED**（合成帧源，已标注，不冒充真实画面）/ **SOURCE-ONLY** / **BLOCKED-BY-DEPLOY**

## 0. 一句话结论

relay 与 PC agent 已按契约实现并通过 **30/30** 自动化测试；用**真实 DAYU200 相机 + 真实 relay local 模式 + 真实 WebSocket** 实测收到 640×480 JPEG 连续帧（3.54 fps、20 帧 unique hash、首帧 431ms、离开后 3.0s 空闲停止）；生产后端 token 复核真实生效（无 token / 伪造 token 均 401）；**ECS 公网路径 BLOCKED-BY-DEPLOY**（部署件已完成并在本机做过 Caddy/compose 静态校验，需用户在 Workbench 执行）。

## 1. 交付物

```text
competition/video/relay/                     # relay + agent + 测试 + 文档
  server.js  agent.js  src/*  vendor/ws/  test/*  .env.example  README.md
competition/deploy/video/                    # ECS 部署件
  compose.video.yaml  install-on-ecs.sh  rollback.sh
  Caddyfile.video.snippet  video.env.example  README.md
competition/evidence/2026-10-27-battery-video-visit/video-relay/   # 本报告与测试日志
```

## 2. 自动化测试（REAL：本机真实 TCP/HTTP/WS，依赖为 fake）

命令（工作目录 `competition/video/relay`）：

```powershell
npm test        # node --test --test-timeout=60000 "test/**/*.test.js"
```

结果：**tests 30 / pass 30 / fail 0**（约 5s）。完整输出：`npm-test.log`

覆盖点（全部通过）：

| 契约要求 | 用例 |
|---|---|
| 无 token/伪造 token → 401 且无帧 | `auth.test.js`：缺 Bearer、伪造 token（fake 后端 401）、后端 503 均 401 且 `dayu.connections=0` |
| ticket 一次性 / 过期 | `stream.test.js`：同 ticket 二次升级被拒（401）；TTL 150ms 过期不可用 |
| viewer 收到 ≥N 帧且逐帧 JPEG 头尾 | `stream.test.js`：≥8 帧全部 `FF D8 ... FF D9`，`uniqueHashes == frames`（非静态图） |
| 最后 viewer 关闭后 ≤5s fake DAYU 收到 stop | `stream.test.js`：`waitFor(dayu.stops>=1, 5000)`；日志 `idle stop` |
| DAYU 断开 → viewer 保留 + 自动恢复；超时 1011 | `resilience.test.js`：kick 后重连 → `resumed` + 继续收帧；宽限 400ms 超时 → `error DAYU_DOWN` + 1011 |
| 并发上限 | `stream.test.js`：maxViewers=2，第 3 个 1013 + `error BUSY` |
| agent 模式转发 | `agent-mode.test.js`：无 agent → `NO_AGENT`；agent 注册 → 帧转发、`dayuLink=connected`；空闲 stop 到 DAYU；agent 断线重连 → `resumed` |
| 日志不含 token/key/ticket 明文 | `auth.test.js` + `agent-mode.test.js` 捕获 logger 全量断言；限流 429、心跳、healthz 字段、405/404 |
| 帧解析健壮性 | `frames.test.js`：逐字节切分/多帧混包/长度越界重置 |
| 配置校验 | `config.test.js`：模式推断、fail-fast、别名、publicSummary 不含 key |

## 3. 真实网络自测（本机，真实端口）

### 3.1 真实 DAYU200 探针（REAL，不经 relay）

命令：`node test/tools/probe-dayu.js --frames 25 --timeout-ms 25000`（日志 `probe-real-dayu.log`）

- hello：`{"type":"hello","proto":1,"device":"dayu200-living","camera":"640x480","cameraActive":true}`
- 25 帧、640×480、27,785–28,371 B（均值 28,149）、uniqueHashes=25、fps 3.56、start→首帧 253ms、`FFD8/FFD9` 全部通过
- 主动 stop 后退出，未长期占用相机

> 说明：这是**真实板端相机帧**，用于证明 relay 依赖的板端协议/帧格式与当前事实一致。

### 3.2 真实 DAYU200 → 真实 relay local 模式 → 真实 WebSocket（REAL）

命令：`node test/tools/smoke-real-dayu.js --frames 20 --port 9443`（日志 `smoke-real-dayu.log`）

- relay 真实进程（local 模式）连 `127.0.0.1:9301`；WS 客户端经 `POST /video/session`（token 用 **fake 后端替身**，本机无生产 APP token 且不把 token 写进脚本）连接
- 收到 20 帧真实 JPEG：640×480、27,943–28,317 B、uniqueHashes=20、fps 3.54
- **WS open → 首帧 431ms**（满足“1s 内出第一帧”）；relay 日志 `viewer first frame firstFrameAfterMs=425`
- 关闭 viewer 后 relay 日志 3.0s 出现 `idle stop: no viewers`（向 DAYU 发 stop），healthz 回到 `dayuLink:"down"`
- relay 日志无 token/key/ticket 明文

### 3.3 fake DAYU 合成帧源 → 真实 relay local → WS（FAKE-LABELED）

命令：`node test/tools/smoke-local.js --frames 100 --port 9443`（日志 `smoke-local-fake-dayu.log`）

- fake DAYU TCP 假帧源（`test/tools/fake-dayu.js`），帧由 `test/tools/jpeg.js` 生成：
  640×480 合成 JPEG，图上写 “FAKE DAYU FRAME SOURCE (TEST ONLY)”，每帧 COM 段带帧号；
  名义最大寿命 120s，日志首行明确 `FAKE-DAYU`（**不是真实画面，不作为视频验收证据**）
- 结果：100 帧、100 unique hash、全部 FFD8/FFD9、首帧 139ms、实测 ≈9.0fps、
  最后 viewer 关闭后 **3014ms** fake DAYU 收到 stop；三次 curl `/video/healthz` 输出均记录在日志
  （无人：`dayuLink=down`；观看中：`connected, framesReceived=100, fps=9, viewers=1`；停止后：`down`）

### 3.4 生产后端鉴权（REAL，不发送/不打印 token）

命令：`node test/tools/real-backend-auth-check.js --port 9444`（日志 `real-backend-auth-check.log`）

- relay 配 `BACKEND_BASE=https://api.luxunacc.xyz`
- 无 token → relay 本地短路 **401**；伪造 token → relay 真实调 `/api/v1/overview`，后端 401 → relay **401**
- 日志：`session rejected: token verification failed backendStatus=401`（不含 token 原文）
- 证明鉴权是“后端复核”而非本地放行；未对生产做任何写操作

### 3.5 Lead 独立复验（REAL，真实 APP 登录 token）

Lead 用生产 APP 账号真实 token 复验，证据在 Lead 目录（非本报告产生）：
`evidence/2026-10-27-battery-video-visit/video-ip/relay-ws-real-token.log`、
`video-ip/relay-frames/relay-live-frame-00..04.jpg`

- `POST /video/session` 200 → WS ready + **12s 内 44 帧真实 DAYU JPEG**（640×480，27.9–28.3KB，uniqueHashes=44，3.27fps）
- 首帧 341ms；heartbeat 正常；`POST /video/session/end` 200
- 无 token / 伪造 token → 401
- viewer 离开 3.0s 后 relay `idle stop`，DAYU 板端日志“停止取帧 / 观看者断开”，healthz 回 `down`

## 4. 联调服务状态（供 APP 模拟器验收）

- 当前本机 relay 以 local 模式常驻：`0.0.0.0:9443`，`DAYU=127.0.0.1:9301`，`BACKEND_BASE=https://api.luxunacc.xyz`
- 启动命令与验收记录：`relay-local-acceptance.log`；`/video/healthz` 输出见该日志与第 3 节
- 无免 token 调试入口；APP 使用自身会话 token
- 联调记录（真实 APP 会话，见 `relay-local-acceptance.log` 2026-10-27T12:37Z）：
  `POST /video/session` 200（1538ms，含后端复核）→ viewer 加入 → DAYU hello/started →
  `viewer first frame firstFrameAfterMs=284` → 3s 内收到 10 帧 → viewer 离开 →
  `session/end` 200（verified=true）→ 3.0s 后 `idle stop: no viewers` → `dayuLink=down`。
- 注意：PC 关机/拔线/relay 重启期间 APP 会显示断线重连（relay 侧宽限 30s）

## 5. ECS 部署件（SOURCE-ONLY + 本机静态校验，公网 BLOCKED-BY-DEPLOY）

- `competition/deploy/video/` 提供：`compose.video.yaml`（复用 `eldercare-cloud-backend:local`，**无主机端口**，
  `read_only`、健康检查、日志限额、仅 public-edge 网络）；`install-on-ecs.sh`（备份 → video.env 600 →
  源码同步 → Caddyfile 两处幂等修改 → `caddy validate` → 启动 → 重启 caddy → 自检，失败自动回滚）；
  `rollback.sh`（恢复备份/移除 relay/重启 caddy/自检）；README 写明“用户只需在 Workbench 执行一条命令”
- 本机静态校验（`deploy-validation.log`）：
  - `bash -n` install-on-ecs.sh / rollback.sh 均 exit 0
  - 用真实 `deploy/Caddyfile` 跑脚本内 `patch_caddyfile`：插入 `/video/* -> video-relay:9443`，
    保留 `reverse_proxy backend:8080`（计数 1），插入 `request>uri query { delete ticket; delete key }`；
    第二次执行 **changed=0**（幂等）
  - **真实 `caddy:2-alpine caddy validate` → `Valid configuration`**
  - 合并 compose config：服务 `backend/caddy/video-relay`，`video-relay` 有 `expose: ["9443"]`、
    `hasPorts=false`、`read_only=true`、镜像 `eldercare-cloud-backend:local`
- **公网链路状态：BLOCKED-BY-DEPLOY** —— 开发机无 ECS 22 端口可达，必须在阿里云 Workbench 执行安装脚本后，
  按 README §4 复验 `https://<域名>/video/healthz`、401、`/readyz` 与 PC agent 注册。
  未执行前不得宣称公网视频探望可用。

## 6. 关键风险 / 限制（如实记录）

1. **DAYU200 无 IP 网络**：只有 USB/HDC；公网链路依赖 PC agent 常驻，PC 关机/拔线即断。
   不得写成“DAYU 公网直连”。
2. **帧率基线**：DAYU 采集+编码约 2.9–3.6fps（Lead 已更新验收下限 ≥2.5fps）；relay 不转码，
   端到端 fps 与 DAYU 侧一致；relay/WS 未引入额外明显延迟（首帧 431ms，链路握手 253ms）。
3. **模拟器/实体机**：APP 侧 JPEG 解码、PixelMap release、模拟器 WS 明文是否被系统拦截需 APP 实测；
   若模拟器拦截 `ws://`，再评估 relay TLS（当前未加）。
4. **公网部署未执行**（BLOCKED-BY-DEPLOY）；ECS 脚本只做本机静态校验，未在 ECS 实测。
5. 并发上限 2；APP 重试残留会产生 1013/BUSY，需先关旧 WS。
6. 生产后端仅被 `GET /api/v1/overview` 只读调用；未做任何写操作，未记录 token。

## 7. 复现命令汇总

```powershell
cd <WORKSPACE>\competition\video\relay
npm test
node test/tools/probe-dayu.js --frames 25
node test/tools/smoke-real-dayu.js --frames 20
node test/tools/smoke-local.js --frames 100
node test/tools/real-backend-auth-check.js --port 9444
```

```bash
# ECS（用户执行，一条命令）
sudo bash /root/eldercare-upload/competition/deploy/video/install-on-ecs.sh
# 回滚
sudo bash /opt/eldercare/deploy/rollback-video.sh
```

## 8. 本目录证据文件

| 文件 | 内容 |
|---|---|
| `npm-test.log` | `npm test` 全量输出（30/30） |
| `probe-real-dayu.log` | 真实 DAYU200 直连探针 JSON（25 帧/640×480/3.56fps） |
| `smoke-real-dayu.log` | 真实 DAYU → 真实 relay local → WS 全链路（20 帧/3.54fps/首帧 431ms/idle stop） |
| `smoke-local-fake-dayu.log` | FAKE-DAYU 合成帧源 120s + relay + WS（100 帧/首帧 139ms/stop 3014ms + curl healthz） |
| `real-backend-auth-check.log` | 生产后端真实 401 复核（无 token/伪造 token） |
| `deploy-validation.log` | ECS 部署件本机静态校验（caddy validate / compose config / 幂等 patch） |
| `relay-local-acceptance.log` | 供 Lead APP 模拟器验收的 local relay 常驻启动与 healthz 日志 |
