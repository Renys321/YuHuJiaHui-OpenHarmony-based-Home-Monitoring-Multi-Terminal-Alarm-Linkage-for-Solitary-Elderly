# 视频探望中继 relay（competition/video/relay/）

手机远程视频探望的**中继服务 + PC agent** 实现，严格按
`competition/evidence/2026-10-27-battery-video-visit/CONTRACTS/VIDEO-VISIT-CONTRACT.md` §1/§2。

```text
DAYU200 VideoStreamServer（127.0.0.1:9301，经 hdc fport，板端真实相机 640x480 JPEG）
   │  4 字节大端长度 + JPEG（契约 §1）
   ├── local 模式：relay 自己 TCP 连 DAYU（本机验收）
   └── agent 模式：PC agent TCP 连 DAYU，出站 WSS 注册到 ECS relay
          │
          ▼
   relay（鉴权 + 帧分发；Node 24，零构建依赖）
          │  GET /video/stream?ticket=  → WS 文本 ready + 二进制 JPEG 帧
          ▼
   手机 APP（Image 连续渲染，不入库/不录播）
```

## 目录

```text
relay/
├── server.js              # relay 进程入口（node server.js）
├── agent.js               # PC agent 入口（node agent.js --relay --key --dayu）
├── src/
│   ├── config.js          # 全部 env 解析 + local/agent 模式推断
│   ├── logger.js          # 日志脱敏（token/key/ticket 不出现）
│   ├── frames.js          # 4 字节大端长度 + JPEG 帧解析
│   ├── dayu-link.js       # local 模式 TCP 客户端（hello/start/started/stop + 帧）
│   ├── agent-channel.js   # agent 模式 relay 侧注册/指令/帧
│   ├── agent-client.js    # PC agent 逻辑（DAYU TCP <-> 出站 WSS 双向转发）
│   ├── frame-hub.js       # viewer 集合、空闲停止、断线宽限、心跳、fps/健康
│   ├── relay.js           # HTTP + WS 服务、鉴权、ticket、并发、日志
│   ├── ticket-store.js    # 一次性 64 hex ticket，60s TTL
│   ├── rate-limit.js      # /video/session 限流（429）
│   └── ws.js              # ws 加载器（node_modules 优先，vendor/ws 兜底）
├── vendor/ws/             # ws@8.22.0（MIT）原样 vendored：ECS 复用现成 node 镜像时无需 npm install
├── test/                  # node:test 全量测试 + fake DAYU/fake 后端 + 真实网络脚本
├── .env.example           # 全部配置项样例（无真实密钥）
└── package.json
```

## 快速开始

### local 模式（PC 本机验收，默认）

先建立 HDC 端口映射（只做一次；已存在就不要重复 add）：

```powershell
hdc -t 450100445634303332012847942eca00 fport tcp:9301 tcp:9301
hdc fport ls    # 确认 tcp:9301 -> tcp:9301
```

```powershell
cd <WORKSPACE>\competition\video\relay
$env:VIDEO_MODE='local'
$env:VIDEO_RELAY_HOST='0.0.0.0'                 # 模拟器经 10.0.2.2 访问
$env:VIDEO_RELAY_PORT='9443'
$env:BACKEND_BASE='https://api.luxunacc.xyz'    # token 复核（只读 GET /api/v1/overview）
$env:DAYU_HOST='127.0.0.1'
$env:DAYU_PORT='9301'
node server.js
```

健康检查（无鉴权；没人观看时 `dayuLink=down` 是正确状态）：

```powershell
curl.exe -sS http://127.0.0.1:9443/video/healthz
# {"ok":true,"mode":"local","dayuLink":"down","framesReceived":0,"fps":0,"lastFrameAgeMs":-1,"viewers":0}
```

手机 APP 侧：`POST /video/session`（`Authorization: Bearer <APP 会话 token>`）拿 ticket，
再连 `ws://<host>:9443/video/stream?ticket=...`（http→ws / https→wss）。

### agent 模式（ECS 部署）

ECS 上 relay（见 `competition/deploy/video/`）：

```
VIDEO_MODE=agent
VIDEO_AGENT_KEY=<48 hex>
BACKEND_BASE=http://backend:8080
```

PC 上常驻 agent（只出站，不监听任何端口）：

```powershell
node agent.js --relay wss://<域名>/video/agent --key <VIDEO_AGENT_KEY> --dayu 127.0.0.1:9301
```

agent 的行为：收到 relay 的 `start` 才连 DAYU 取帧；收到 `stop` 或 relay 断线立即停止；
relay/DAYU 断线都按 0.5/1/2/5/10s 退避自动重连；**没人看就不取帧**。

## 配置（环境变量，完整样例见 `.env.example`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `VIDEO_MODE` | 推断 | `local` / `agent`；留空时有 `VIDEO_AGENT_KEY` 即 agent，否则 local |
| `VIDEO_RELAY_HOST` | `0.0.0.0` | 监听地址；local 验收要 0.0.0.0 才能被模拟器 NAT 访问 |
| `VIDEO_RELAY_PORT` | `9443` | 端口；`0` 表示内核分配（仅测试）；兼容 `VIDEO_PORT` 别名 |
| `BACKEND_BASE` | `http://127.0.0.1:8080` | token 复核后端；ECS 填 `http://backend:8080` |
| `DAYU_HOST` / `DAYU_PORT` | `127.0.0.1` / `9301` | local 模式 DAYU TCP |
| `DAYU_CONNECT_TIMEOUT_MS` / `DAYU_HELLO_TIMEOUT_MS` | `2000` / `2000` | DAYU 握手超时 |
| `VIDEO_AGENT_KEY` | 空 | agent 模式必填；同时是 `/video/agent` 的鉴权 key |
| `VIDEO_MAX_VIEWERS` | `2` | 并发上限，超出 WS 1013+BUSY |
| `VIDEO_IDLE_STOP_MS` | `3000` | 最后一个 viewer 离开后多久停止取帧 |
| `VIDEO_TICKET_TTL_MS` | `60000` | ticket 有效期（一次性） |
| `VIDEO_RECONNECT_DELAYS_MS` | `500,1000,2000,5000,10000` | DAYU/agent 重连退避 |
| `VIDEO_DAYU_DOWN_GRACE_MS` | `30000` | 断线宽限；超时发 `error DAYU_DOWN` + WS 1011 |
| `VIDEO_HEARTBEAT_MS` | `5000` | 心跳文本间隔；0 关闭 |
| `VIDEO_SESSION_RATE_LIMIT` / `..._WINDOW_MS` | `10` / `60000` | 每 token 申请 session 限流（超出 429） |
| `VIDEO_BACKEND_TIMEOUT_MS` | `5000` | 调后端超时 |
| `VIDEO_ACCESS_LOG` / `VIDEO_LOG_LEVEL` | `1` / `info` | 访问日志（只记 pathname）/ debug | info | warn | error |

## HTTP / WS 接口（契约 §2.2）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/video/healthz` | 无 | `{"ok":true,"mode":"local|agent","dayuLink":"connected|connecting|down","framesReceived":n,"fps":x,"lastFrameAgeMs":n,"viewers":n}` |
| POST | `/video/session` | `Authorization: Bearer <APP token>` | 调 `${BACKEND_BASE}/api/v1/overview` 复核；2xx → `{"ticket":"<64hex>","expiresInMs":60000,"wsPath":"/video/stream?ticket=<ticket>"}`；无/非法 → 401；超频 → 429 |
| GET(WS) | `/video/stream?ticket=` | 一次性 ticket | 先文本 `{"type":"ready","proto":1,"camera":"640x480"}`，之后每条**二进制消息 = 一帧 JPEG**（`FF D8 ... FF D9`） |
| POST | `/video/session/end` | Bearer token | 关闭该 token 的 viewer（1000 session-ended），200 |
| GET(WS) | `/video/agent?key=` | `VIDEO_AGENT_KEY` | agent 出站注册（仅 agent 模式；错误 key → 401） |

控制文本：`error`（`DAYU_DOWN` / `NO_AGENT` / `BUSY`）、`resumed`、`heartbeat {ts,fps}`。
行为约定：ticket 一次性 + 60s TTL；DAYU 断线保留 viewer，退避重连，成功发 `resumed`，
超过宽限发 `error DAYU_DOWN` 并 1011；最后一个 viewer 离开 3s 无新 viewer → 向 DAYU 发 `stop`
并断开；并发上限 2；日志无 token/key、无 ticket 明文。

### agent 内部协议（relay ⇄ PC agent，非手机协议）

```text
agent -> relay   {"type":"hello","proto":1,"device":"dayu200-living","camera":"640x480"}
relay -> agent   {"type":"agent-ready","proto":1}
relay -> agent   {"type":"start","viewer":"v1"}      # 有 viewer
relay -> agent   {"type":"stop"}                     # 空闲停止 / 结束
agent -> relay   {"type":"status","dayuLink":"connected|connecting|down"}
agent -> relay   二进制消息 = 一帧完整 JPEG
```

## 测试与自测

```powershell
npm test          # node:test 全量（30 个用例，全部 fake 依赖 + 真实 ws/TCP/HTTP）
```

覆盖：无/伪造 token 401 且无帧、ticket 一次性/过期、viewer 收到 ≥8 帧且逐帧 JPEG/逐帧 hash 不同、
最后 viewer 关闭 ≤5s fake DAYU 收到 stop、DAYU 断线恢复 `resumed` 与超宽限 1011、
并发上限 1013、agent 模式转发与 NO_AGENT、心跳、限流 429、日志不含 token/key/ticket 明文。

真实网络脚本（会产生日志，均标注是否 fake）：

```powershell
# 真实 DAYU200 探针（直连 9301，验证板端协议/分辨率/帧率）
node test/tools/probe-dayu.js --frames 25

# 真实 DAYU200 经真实 relay local 模式 -> WS（token 用 fake 后端替身）
node test/tools/smoke-real-dayu.js --frames 20

# fake DAYU 合成帧源 + 真实 relay + WS（120s 假帧源，明确 FAKE-DAYU）
node test/tools/smoke-local.js --frames 100

# 生产后端鉴权探针（不发送/不打印任何 token）
node test/tools/real-backend-auth-check.js --port 9444
```

2026-10-27 实测（证据见 `competition/evidence/2026-10-27-battery-video-visit/video-relay/`）：

| 项目 | 结果 |
|---|---|
| `npm test` | **30/30 通过** |
| 真实 DAYU 探针 | 25 帧、640×480、27.8–28.4KB、uniqueHashes=25、fps 3.56、start→首帧 253ms |
| 真实 DAYU 经 relay→WS | 20 帧、640×480、uniqueHashes=20、fps 3.54、WS open→首帧 431ms、idle stop 3.0s |
| fake DAYU（120s 假帧源）经 relay→WS | 100 帧、100 unique hash、首帧 139ms、stop 距最后 viewer 关闭 3014ms |
| 生产后端鉴权 | 无 token→401；伪造 token→后端 401→relay 401 |
| Lead 独立复验（真实 token） | 12s 44 帧、640×480、uniqueHashes=44、3.27fps、首帧 341ms、end 200、idle stop 后板端“停止取帧” |

## 排障

- `dayu busy`：DAYU 只允许单客户端；先停掉其它直连（探针/旧测试进程），再重试。
- `TCP Port listen failed`（hdc fport）：映射已存在，先 `hdc fport ls`，不要重复 add。
- 手机 WS 401：ticket 过期/已用/未带；重新 `POST /video/session`。
- 手机 1013/BUSY：并发上限 2；确认旧 WS 已关闭。
- healthz `dayuLink` 一直 down：local 模式查 `hdc fport` 与 9301；agent 模式看 PC agent 日志
  `agent dayu status` 与 relay `agent disconnected`。
- 画面卡顿：DAYU 采集+编码本身约 3–3.6fps；relay 不做转码，`framesReceived`/`fps` 与 DAYU 侧一致即可。
- 日志排障：`VIDEO_LOG_LEVEL=debug`；日志只含 pathname、ticket 前 6 位、hash 前缀，不含 token/key。

## 安全边界

- 不提供无鉴权流；`/video/stream` 必须一次性 ticket（来自 Bearer token 的后端复核）。
- token 只走 `Authorization` 头，不进 URL；relay 访问日志不记 query；Caddy 侧对
  `ticket`/`key` query 做 delete（见部署件）。
- 日志不记录 token / agent key / ticket 明文（只允许 ticket 前 6 位、sha256 前 8 位）。
- 不直通 DAYU 端口；relay 不解码、不转码、不落盘、不录像，只转发 JPEG 帧。
- **本实现不提供“免 token 调试入口”**。若未来确需 dev-only 绕过，必须：显式配置项、
  默认关闭、启动时打印 WARN、且只允许 loopback；当前版本没有该配置项。
- 不改后端/DAYU 代码；不碰 9200 推理口。

## 已知限制

- DAYU200 当前无 IP 网络（只有 USB/HDC）：PC 关机/拔线即断，这是硬件/网络现状；
  ECS 公网路径依赖 PC agent 常驻，不能写成“DAYU 公网直连”。
- 实体手机无签名材料，本期验收用 HarmonyOS 模拟器（10.0.2.2 访问宿主 relay）。
- 公网 ECS 部署需用户在 Workbench 执行（本机无 ECS SSH）：状态 **BLOCKED-BY-DEPLOY**，
  部署件与“一条命令”说明见 `competition/deploy/video/README.md`。
