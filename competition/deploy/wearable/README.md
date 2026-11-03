# 随身 SOS 公网适配服务 — ECS 部署包（wearable-mqtt）

本目录是 `competition/cloud/wearable-mqtt` 的 ECS 部署包：
**只新增 `wearable-mqtt` 一个容器服务**，不改 backend 源码、不重建 backend/caddy、
不重新部署公网后端；安装前自动备份 `/opt/eldercare/deploy`，失败可一键回滚。

| 文件 | 作用 |
|---|---|
| `compose.wearable.yaml` | Compose override：复用 `eldercare-cloud-backend:local` 镜像 + entrypoint 覆盖，唯一对外端口 1883/tcp |
| `install-on-ecs.sh` | 备份（compose/env/**线上源码**）→ 同步源码 → 生成 `wearable.env`(600) → `up -d --force-recreate` → 校验 healthy/1883//healthz/端口边界/**容器内回归测试** |
| `rollback.sh` | “首次安装”回滚：只移除 wearable-mqtt，恢复备份文件，默认保留数据卷 |
| `rollback-upgrade.sh` | “升级”回滚：恢复升级前源码归档 + 强制重建容器，让服务继续以旧版本运行（见 §8.5） |
| `wearable-mqtt.Dockerfile` | 备用独立镜像（默认不用；基础镜像与 backend 一致 `node:24-alpine`） |
| `README.md` | 本文件 |

> 为什么复用 backend 镜像：ECS 上已有 `eldercare-cloud-backend:local`（含 Node 运行时），
> wearable-mqtt 零 npm 依赖，源码只读挂载 + `entrypoint: ["node","/opt/wearable/server.js"]`
> 即可运行，省掉一次镜像构建/拉取，降低 Workbench 操作失败率。

---

## 0. 前置检查（在 ECS Workbench 执行一次）

```bash
# 1) ECS 主栈（backend/caddy）在运行
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'eldercare-public-(backend|caddy)-1'

# 2) 复用镜像存在（必须；不存在说明 backend 未部署，先不要继续）
docker image inspect eldercare-cloud-backend:local >/dev/null && echo IMAGE_OK

# 3) 1883 当前无人占用（若已有旧 broker，先确认能停；本服务只加 1883）
ss -ltnp | grep ':1883 ' || echo PORT_1883_FREE

# 4) 主栈网络名（安装脚本也会自动探测）
docker network ls --format '{{.Name}}' | grep public-edge
```

安全组：只放行 **1883/tcp**（来源尽量限定；M100 SIM 出口 IP 不固定时只能 0.0.0.0/0，
请务必使用强随机密码）。**不要**放行 8080/9000/9001/9100/9101。

---

## 1. 上传部署包（本机 → ECS）

在仓库根目录（Windows PowerShell）：

```powershell
tar -czf wearable-deploy.tgz -C <WORKSPACE>\competition cloud\wearable-mqtt deploy\wearable
```

在 ECS Workbench 文件面板把 `wearable-deploy.tgz` 上传到 `/root/`，然后：

```bash
mkdir -p /root/wearable-src
tar -xzf /root/wearable-deploy.tgz -C /root/wearable-src
ls /root/wearable-src/cloud/wearable-mqtt/server.js   # 存在即可
```

解压后目录结构必须是：

```
/root/wearable-src/
├── cloud/wearable-mqtt/{server.js,package.json,src/...}
└── deploy/wearable/{install-on-ecs.sh,compose.wearable.yaml,rollback.sh,...}
```

---

## 2. 一条命令安装（Workbench）

```bash
bash /root/wearable-src/deploy/wearable/install-on-ecs.sh --mqtt-user wearable-sos-001
```

执行后脚本会：

1. 备份 `/opt/eldercare/deploy`（compose、`.env.deploy`、容器/端口状态，备份目录 700/文件 600）；
2. 探测 `public-edge` 真实网络名；
3. 交互提示输入 `MQTT_PASS`（不回显；不会出现在 shell history）；
4. 从 `.env.deploy` 抽取 `INGEST_KEY`，生成 `/opt/eldercare/deploy/wearable.env`（600）；
5. 同步源码到 `/opt/eldercare/wearable`（容器只读挂载 `/opt/wearable`）；
6. `docker compose -f compose.public.yaml -f compose.wearable.yaml up -d wearable-mqtt`；
7. 校验容器 healthy、1883 可连、`/healthz` 200、端口表只有 1883/tcp、backend/caddy 未被改动。

非交互/自动化写法（密码会进 shell history/进程环境，仅演示机可用）：

```bash
WEARABLE_MQTT_PASS='<强随机密码>' \
  bash /root/wearable-src/deploy/wearable/install-on-ecs.sh --mqtt-user wearable-sos-001
```

没有现成凭据时可以让脚本生成并只打印一次：

```bash
bash /root/wearable-src/deploy/wearable/install-on-ecs.sh --generate-credentials
```

> `MQTT_USER` / `MQTT_PASS` 必须与 M100 配置一致；凭据只写入
> `/opt/eldercare/deploy/wearable.env`（600），脚本绝不回显密码/INGEST_KEY。
> 重复执行脚本 = 升级（保留数据卷与已有凭据；显式传参会更新凭据）。

---

## 3. 成功标志

脚本输出应包含：

- `容器健康状态: healthy`
- `自检通过: /healthz 200`
- `自检通过: 0.0.0.0:1883 可连接`
- `自检通过: 端口映射仅 1883/tcp`
- `自检通过: backend 仍在运行`
- `wearable-mqtt 安装完成` + 备份目录路径

再手工确认（容器名以 `docker ps` 为准）：

```bash
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep wearable-mqtt
# 期望：Up ... (healthy)，Ports 只有 0.0.0.0:1883->1883/tcp

# 诊断（容器内回环，不对外）
docker exec $(docker ps -qf name=wearable-mqtt) node -e \
  "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log(JSON.stringify({config:j.config,broker:j.broker.clients,device:j.adapter.device},null,2)))"
```

M100 连上后，`broker.clients` 会出现 `clientId=wearable-sos-001`；
按键后 APP 出现「随身求助」告警；APP 确认 → 设备蜂鸣停止 →
`/status` 中 `adapter.counters.commandResultOk` +1、`fake` 无（真实后端）告警变 ACKED。

> **M100 重启后等待 20~30 秒**：模块重启后要重新拨号/连接 Broker 并完成下行订阅，
> 请等 **NET 灯 1000ms 慢闪**后再测下行 ACK（APP 确认 → 设备停止蜂鸣）。
> 另外，M100 下行是 payload 原样写串口、**不补换行**；服务端已固定补 `\n`，
> 所以设备端必须按行解析（固件契约如此），不要在下行主题上另外加网关改写。
> 可用 `config,get,netchaninfo,1` 读取通道配置核对通道 1 = MQTT。

---

## 4. M100MG-B1 配置（与契约 §2 完全一致）

| 项 | 值 |
|---|---|
| 服务器地址 | `<ECS 公网 IP>:1883` |
| 协议 | MQTT 3.1.1（不支持 MQTTS/8883） |
| Client ID | `wearable-sos-001`（必须与 `wearable.env` 的 `MQTT_CLIENT_ID` 一致） |
| 用户名/密码 | 安装时设置的值（`wearable.env` 内可查，600） |
| 上行发布主题 | `eldercare/wearable/sos-001/up` |
| 下行订阅主题 | `eldercare/wearable/sos-001/down` |
| Clean Session | 是 |
| Keep Alive | 60s |
| 发布/订阅 QoS | 1（QoS0 也可用） |
| 定位 → GPS 定位 → 主动上报内容格式 | **固定格式**（`经度_纬度`，WGS84；不要选自定义 JSON） |
| 定位 → 更新时间 | 30s（与契约一致；默认 60s 也可，越短越费流量） |
| 主动上报网络通道 | 网络通道 1（即 MQTT 通道） |

> 固定格式示例（真机实测）：`112.55326080300_32.966827393000`
> （经度_纬度，WGS84 十进制度；无时间字段，服务端用收到时间作 `fixTime`）。
> 适配器以十进制为主路径，同时兼容度分 `ddmm.mmmm`（如 `11358.4220_2231.5626`）与
> `GPS_E_..._N_..._END` 自定义格式；坏报文只计数、不写假坐标。
>
> 下行 ACK payload 固定带结尾 `\n`（`{"v":1,"t":"ack","alarm":"...","cmd":"..."}\n`）：
> M100 透传下行原样写串口、不补换行，ESP32 固件按行解析，缺 `\n` 会卡住不处理（真机已复现）。

---

## 5. 日志 / 排障

```bash
DEPLOY=/opt/eldercare/deploy
COMPOSE="docker compose -p eldercare-public --env-file $DEPLOY/.env.deploy -f $DEPLOY/compose.public.yaml -f $DEPLOY/compose.wearable.yaml"

$COMPOSE logs --tail=200 -f wearable-mqtt
$COMPOSE ps
docker inspect -f '{{.State.Health.Status}}' $(docker ps -qf name=wearable-mqtt)

# 常见失败码（日志中固定短码，不含密钥）
#   BAD_CREDENTIALS / CONNECT_REJECTED    M100 用户名密码或 Client ID 不匹配
#   KEEPALIVE_TIMEOUT                     设备网络中断
#   DEVICE_STATUS_POST_FAILED             backend 不可达/INGEST_KEY 错
#   COMMAND_POLL_FAILED                   backend 查询失败（自动指数退避）
#   COMMAND_RESULT_POST_FAILED            回执回写失败（会重试，命令保持 PENDING）
```

失败时安装脚本会打印回滚命令，也可直接：

```bash
bash /opt/eldercare/deploy/rollback-wearable.sh            # 回滚到最近一次备份
bash /opt/eldercare/deploy/rollback-wearable.sh --backup /opt/eldercare/deploy/backup/wearable-<时间戳>
```

---

## 6. 回滚

```bash
# 只移除 wearable-mqtt（保留 seq/游标数据卷；backend/caddy 不动）
bash /root/wearable-src/deploy/wearable/rollback.sh

# 连带删除数据卷（会丢命令游标/GPS 帧计数，谨慎）
bash /root/wearable-src/deploy/wearable/rollback.sh --purge-data
```

回滚会：停止并移除 wearable-mqtt → 恢复安装前的 `compose.wearable.yaml`/`wearable.env`
（安装前不存在的文件则删除）→ 校验 1883 已释放 → 打印 backend/caddy 状态。
`compose.public.yaml` 与 `.env.deploy` 从未被本安装脚本修改。

---

## 7. 约束与风险

- **只发布 1883/tcp**；本包不含 8080/9000/9001/9100/9101 映射。
- 公网 1883 是明文 MQTT（契约要求）：务必强密码 + 最小化安全组来源；后续如需 TLS 单独评审。
- **演示期间不要启动旧家庭网关** `cloud/onenet/public-sync` / `gateway`：
  其 command-sync 会轮询同一全局命令队列且不校验 deviceId，可能抢领 esp32-sos 的 ACK 命令。
- 位置不写独立 location 接口（现网后端无该路由）；坐标随 `device-status.gps` 上报，
  本服务只持久化 seq/命令游标/当日计数/“最后已知设备状态（不含坐标）”，不落盘坐标。
- GPS 固定格式来源为厂家文档截图 + 真机 COM5 实测待 Lead 回传后收紧；当前为双兼容实现。
- 升级/回滚都保留 `/opt/eldercare/deploy/backup/` 备份（含 `.env.deploy`，等同密钥文件，
  目录 700/文件 600，禁止外传或进版本库）。

---

## 8. v1.0.1 断连自愈修复 — 升级 / 回滚（2026-10-27）

### 8.1 本次修复了什么（对运维可感知的部分）

| # | 修复 | 现场效果 |
|---|---|---|
| 1 | 设备链路恢复（`clientConnect`）或任一业务上行（boot/hb/sos/ack）到达时，**立即**把 parked 的 ACK 命令回到可重投 | 「ACK 未送达要 docker restart wearable-mqtt」不再需要；恢复在秒级 |
| 2 | 业务上行静默 > `DEVICE_ALIVE_TIMEOUT_MS`（默认 120000ms=4×心跳）才**如实**上报 `online=false`；恢复后首个业务上行立即 `online=true` | APP 不再把 3 小时前的旧数据当“实时在线”；M100 短暂重连不会闪离线 |
| 3 | 设备重启（boot）时**不再**把未确认告警状态伪造成 NORMAL；只有设备 IDLE 心跳才清本地事件快照（绝不代报 ACKED） | 重启窗口内 APP 不会误显示“已解除” |
| 4 | 后端响应暂时缺少 parked 命令时**保留**并继续重投（不再当作“已外部结算”删除） | 不静默丢 ACK |
| 5 | `DATA_DIR` 额外持久化“最后已知设备状态（state/alarmId/csq/时间戳，**不含坐标**）” | 容器重启后不丢未确认求助、不回退 ACKED；设备离线时仍能纠正后端在线态 |

### 8.2 升级前必读

- 升级 = 重跑 `install-on-ecs.sh`。它现在会额外做三件事：
  1. 备份线上源码到 `<备份目录>/wearable-src-before.tar.gz`（升级回滚用）；
  2. `compose up -d --force-recreate`（源码是只读 bind mount，**不强制重建会继续跑旧进程里的旧代码**）；
  3. 升级后在容器内跑一遍回归测试（`node --test`）。**测试 PASS 才允许演示**；若打印
     “回归测试未全绿（强警告…）”，脚本不中止（容器已 healthy），但必须人工复核下面的输出，
     确认是环境抖动还是代码问题，必要时按 §8.5-A 回滚。
- 升级会让 M100 的 MQTT 连接短暂断开（容器重建）；M100 会自动重连，等 NET 灯 1000ms 慢闪后再验证下行 ACK。
- 只重启 `wearable-mqtt`：backend/caddy 不动，数据卷保留。

### 8.3 升级步骤（ECS Workbench，逐步执行）

```bash
# 0) 本机（Windows PowerShell）打补丁包并记录哈希
cd <WORKSPACE>\competition
# 包内容：cloud/wearable-mqtt（含 test/）+ deploy/wearable
tar -czf wearable-reconnect-fix.tar.gz cloud/wearable-mqtt deploy/wearable
Get-FileHash wearable-reconnect-fix.tar.gz -Algorithm SHA256

# 1) 上传 wearable-reconnect-fix.tar.gz 到 ECS /root（Workbench 文件面板），然后：
mkdir -p /root/wearable-src
rm -rf /root/wearable-src/cloud /root/wearable-src/deploy
tar -xzf /root/wearable-reconnect-fix.tar.gz -C /root/wearable-src
ls /root/wearable-src/cloud/wearable-mqtt/server.js /root/wearable-src/deploy/wearable/install-on-ecs.sh

# 2) 升级（复用 /opt/eldercare/deploy/wearable.env 里已有的 MQTT 用户/密码；
#    若密码不在，会交互提示输入，不回显）
bash /root/wearable-src/deploy/wearable/install-on-ecs.sh --mqtt-user wearable-sos-001
```

### 8.4 升级成功标志（脚本会打印）

```
[wearable-mqtt] 已备份线上源码: /opt/eldercare/deploy/backup/wearable-<时间戳>/wearable-src-before.tar.gz
[wearable-mqtt] 容器健康状态: healthy
[wearable-mqtt] 自检通过: /healthz 200
[wearable-mqtt] 自检通过: 0.0.0.0:1883 可连接
[wearable-mqtt] 自检通过: 端口映射仅 1883/tcp
[wearable-mqtt] 自检通过: backend 仍在运行（同网络服务名 backend 可解析）
[wearable-mqtt] 自检通过: 回归测试全绿（断连自愈 / 不代报 ACK / 不重复告警 / 离线语义）
wearable-mqtt 安装完成（只新增 1 个服务，未改动 backend/caddy）
```

再手工确认版本与自愈计数（应看到 `version=1.0.1` 与 `deviceAliveTimeoutMs=120000`）：```bash
docker exec $(docker ps -qf name=wearable-mqtt) node -e \
  "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log(JSON.stringify({version:j.version,link:j.adapter.link,device:j.adapter.device,counters:{offline:j.adapter.counters.deviceOfflineReports,parkedRecovery:j.adapter.counters.parkedRecoveryTriggers}},null,2)))"
```

### 8.5 回滚（两条路，按场景选）

```bash
# A) 升级回滚：回到升级前的代码版本，服务继续运行（推荐）
bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh \
  --backup /opt/eldercare/deploy/backup/wearable-<升级时日志里打印的时间戳>
# 说明：恢复 wearable-src-before.tar.gz → 强制重建容器 → 校验 /healthz、1883、版本号。
#      保留 backend/caddy 与数据卷；旧版本目录会留一份 <source>.rollback-old-* 供人工核对。

# B) 首次安装回滚：把 wearable-mqtt 整个服务移除（回到“从未安装”状态）
bash /opt/eldercare/deploy/rollback-wearable.sh \
  --backup /opt/eldercare/deploy/backup/wearable-<时间戳>
```

回滚后验证：`/healthz` 200、1883 可连、`version=` 回到升级前版本（本包之前为 `1.0.0`）、
`docker exec ... /status` 里 `state.device`（最后已知设备状态）与 `commandCursor` 不应回退。

### 8.6 回滚风险与数据说明

- 回滚**不删除**数据卷 `eldercare-public_wearable-data`（seq/命令游标/当日 SOS 计数/最后已知设备状态）。
  老版本代码读到新增的可选 `device` 字段会忽略，不会因回滚而拒绝启动。
- 回滚后 v1.0.0 的已知行为会回来：ACK 偶发未送达只能等定时器或再重启容器、设备离线不再报 `online=false`。
- 若升级导致容器起不来：先看 `docker compose ... logs --tail=200 wearable-mqtt`，
  再执行 8.5-A 回滚；必要时用 `--purge-data` 之外的任何操作都**不要**删数据卷（否则命令游标丢失）。

