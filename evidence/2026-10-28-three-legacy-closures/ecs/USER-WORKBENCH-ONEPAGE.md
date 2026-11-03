# 一页纸：ECS wearable-mqtt `1.0.0` → `1.0.1`（用户在阿里云 Workbench 执行）

> **当前状态（2026-10-28 00:35 Asia/Shanghai）：待部署 / 未验收。**
> 本页由 teammate `ecs-verify` 编写；**ECS 只能由你（用户）通过 Workbench 操作**，本机没有 SSH 凭据，
> Lead/teammate 不会也不能自行上传或部署。全程只需要一个终端窗口 + 一次文件上传，预计 3–5 分钟。

## 0. 开始前（30 秒自检，只读）

在 Workbench 终端粘贴（**不会改动任何东西**）：

```bash
whoami; ls -l /opt/eldercare/wearable/server.js /opt/eldercare/deploy/compose.wearable.yaml /opt/eldercare/deploy/wearable.env 2>&1 | head -20
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'wearable-mqtt|backend|caddy'
docker exec $(docker ps -qf name=wearable-mqtt) node -e "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log('BEFORE version='+j.version+' aliveTimeoutMs='+(j.adapter&&j.adapter.link&&j.adapter.link.aliveTimeoutMs)))"
```

**预期输出**
- `whoami` → `root`
- 三个文件都存在（`server.js`、`compose.wearable.yaml`、`wearable.env`）
- `eldercare-public-wearable-mqtt-1` 处于 `Up ... (healthy)`，端口只有 `1883/tcp`
- 最后一条打印 `BEFORE version=1.0.0 aliveTimeoutMs=?`（1.0.0 没有断连自愈字段 → 可能是 `undefined`）

**失败处理**
- `wearable-mqtt` 容器不存在 → 说明 1.0.0 不是用这套 compose 装的，**先停下并把 `docker ps` 输出发回 Lead**，不要继续。
- `/opt/eldercare/wearable/server.js` 不存在 → 同上，停下反馈（回滚依赖该目录的备份）。
- `docker` 无权限 → Workbench 需用 root；换 root 会话重试。

## 1. 上传补丁包（Workbench 文件面板）

把本机文件

```
<WORKSPACE>\competition\deploy\wearable\release\wearable-reconnect-fix-v1.0.1.tar.gz
```

大小 **90,027 B**，SHA-256 `D118A41A8A2ECA8F6317C926DCF6FC70B07A1325F47917ECCC2E69B173A68C8B`，
通过 Workbench「文件」面板上传到 ECS 的 **`/root/`**。

> 包内不含任何密钥；不要改文件名（下面的命令按文件名走）。

## 2. 校验 + 解包（只读检查，先不升级）

```bash
cd /root
ls -l wearable-reconnect-fix-v1.0.1.tar.gz
sha256sum wearable-reconnect-fix-v1.0.1.tar.gz
mkdir -p /root/wearable-src
rm -rf /root/wearable-src/cloud /root/wearable-src/deploy
tar -xzf /root/wearable-reconnect-fix-v1.0.1.tar.gz -C /root/wearable-src
ls -l /root/wearable-src/cloud/wearable-mqtt/server.js \
      /root/wearable-src/cloud/wearable-mqtt/test/reconnect-recovery.test.js \
      /root/wearable-src/deploy/wearable/install-on-ecs.sh \
      /root/wearable-src/deploy/wearable/rollback-upgrade.sh
grep -n "SERVICE_VERSION" /root/wearable-src/cloud/wearable-mqtt/src/main.js | head -2
```

**预期输出（逐条核对）**
- `ls -l` 显示 `90027` 字节
- `sha256sum` = `d118a41a8a2eca8f6317c926dcf6fc70b07a1325f47917eccc2e69b173a68c8b  wearable-reconnect-fix-v1.0.1.tar.gz`（小写显示也算一致）
- 4 个文件都列出（大小 > 0）
- `grep` 命中 `const SERVICE_VERSION = '1.0.1';`

**失败处理（任一条不符 → 停止，不要升级）**
- 哈希不一致 / 大小不是 90027 → 上传不完整，重新上传后再校验；还不行把 `sha256sum` 输出发回 Lead。
- `tar` 报错 → 同上。
- 解包目录里没有 `deploy/wearable/install-on-ecs.sh` → 包不对，停止。

## 3. 升级（一条命令；会备份旧代码 + 重建 1 个容器）

> 现在设备在线、且没有 PENDING ACK，是合适的升级窗口。升级会重建 `wearable-mqtt` 容器，
> M100 的 MQTT 连接会短暂断开并在 20–30 秒内自动重连，属预期。

```bash
bash /root/wearable-src/deploy/wearable/install-on-ecs.sh --mqtt-user wearable-sos-001
```

脚本默认复用 `/opt/eldercare/deploy/wearable.env` 里的 MQTT 密码（600 权限，不回显、不写 shell history）。

**预期输出（关键行，顺序大致如下）**

```
[wearable-mqtt] 部署目录: /opt/eldercare/deploy
[wearable-mqtt] 源码目录: /root/wearable-src/cloud/wearable-mqtt -> /opt/eldercare/wearable (只读挂载 /opt/wearable)
[wearable-mqtt] 已备份线上源码: /opt/eldercare/deploy/backup/wearable-<时间戳>/wearable-src-before.tar.gz
[wearable-mqtt] 已备份现有部署到: /opt/eldercare/deploy/backup/wearable-<时间戳>
[wearable-mqtt] 使用 Docker 网络: eldercare-public_public-edge
[wearable-mqtt] 已生成 /opt/eldercare/deploy/wearable.env (600)
[wearable-mqtt] 已同步源码到 /opt/eldercare/wearable
[wearable-mqtt] 已安装 /opt/eldercare/deploy/compose.wearable.yaml
[wearable-mqtt] 启动/更新 wearable-mqtt ...
[wearable-mqtt] 容器健康状态: healthy
[wearable-mqtt] 自检通过: /healthz 200
[wearable-mqtt] 自检通过: 0.0.0.0:1883 可连接
[wearable-mqtt] 自检通过: 端口映射仅 1883/tcp -> 0.0.0.0:1883->1883/tcp
[wearable-mqtt] 主栈状态（未改动）: backend=running caddy=running
[wearable-mqtt] 自检通过: backend 仍在运行（同网络服务名 backend 可解析）
[wearable-mqtt] 运行断连自愈回归测试（容器内 node --test）...
[wearable-mqtt] 自检通过: 回归测试全绿（断连自愈 / 不代报 ACK / 不重复告警 / 离线语义）
...
wearable-mqtt 安装完成（只新增 1 个服务，未改动 backend/caddy）
...
  3) 容器内回归自检结果: PASS（必须 PASS 才能演示）
```

**📌 请一定记下并抄回给 Lead 的两行**
1. `已备份现有部署到: /opt/eldercare/deploy/backup/wearable-<时间戳>` ← 回滚要用这个时间戳
2. `容器内回归自检结果: PASS` ← 若为 `FAIL`，见下方处理

**失败处理**
| 现象 | 处理 |
|---|---|
| 交互提示 `MQTT_PASS (输入不回显):` | 说明 `wearable.env` 里的账号/密码与 `--mqtt-user` 不匹配。**输入 M100 的 MQTT 密码**（回显关闭）。若不知道密码，Ctrl+C 停止并告知 Lead（不要猜）。 |
| `ERROR: 1883 已被其它进程/容器占用` | 脚本拒绝停未知进程。把该输出发回 Lead，确认是谁占用后再定，不要手动 kill。 |
| `ERROR: MQTT_PASS 含不安全字符` | 现有口令含 `A-Za-z0-9._~+/=-` 之外的字符，脚本拒绝写入 `.env`。**不要改密码**（会让 M100 立刻连不上），把输出发回 Lead 走人工处理。 |
| `安装失败；请执行回滚` | 按 §6 回滚（用上面的备份时间戳），并把 `docker compose ... logs --tail=120 wearable-mqtt` 输出发回 Lead。 |
| `自检通过: 回归测试全绿` 变成 `回归测试未全绿（强警告…）` | 容器已健康但**不要演示**；把脚本打印的最后 40 行发回 Lead，按 §6 回滚。 |
| 任何 `自检失败` | 按 §6 回滚。 |

## 4. 升级后确认（核心验收点，一条命令）

```bash
docker exec $(docker ps -qf name=wearable-mqtt) node -e "
fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>{
  console.log(JSON.stringify({version:j.version, link:j.adapter.link, device:j.adapter.device,
    counters:{offline:j.adapter.counters.deviceOfflineReports,
              parkedRecovery:j.adapter.counters.parkedRecoveryTriggers,
              commandResultOk:j.adapter.counters.commandResultOk},
    brokerClients:(j.broker&&j.broker.clients||[]).map(c=>c.clientId)}, null, 2));
}).catch(()=>process.exit(1))"
```

**预期输出**
```json
{
  "version": "1.0.1",
  "link": { "deviceClientId": "wearable-sos-001", "aliveTimeoutMs": 120000, "watchdogArmed": true, "offlineReported": false },
  "device": { "online": true, "state": "NORMAL", ... },
  "counters": { "offline": 0, "parkedRecovery": 0, "commandResultOk": <升级前已有的累计值> },
  "brokerClients": ["wearable-sos-001"]
}
```

**判定**：`version=1.0.1` **且** `link.aliveTimeoutMs=120000` **且** `watchdogArmed=true` **且** `brokerClients` 含 `wearable-sos-001`
（设备刚上电时 `online` 可能还是 false，等 30 秒再跑一次；M100 重连约需 20–30 秒）。

**失败处理**
- `version` 仍是 `1.0.0` → 升级没生效（源码 bind mount 需要 `--force-recreate`）。重新执行 §3 一次；仍不行则 §6 回滚并反馈。
- `brokerClients` 里没有 `wearable-sos-001` → 设备没连上：先检查设备供电/NET 灯 1000ms 慢闪，等 30–60 秒再查；若 3 分钟仍无，反馈 Lead（不要 docker restart）。

## 5. 保存证据（两条命令，输出贴回 Lead，均不含密钥）

```bash
# 5.1 完整 /status（已确认不含任何密钥），存成文件
docker exec $(docker ps -qf name=wearable-mqtt) node -e \
  "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))" \
  > /root/status-after.json
wc -c /root/status-after.json

# 5.2 最近 30 分钟容器日志（结构化单行日志，不含密钥）
docker logs --since 30m $(docker ps -qf name=wearable-mqtt) > /root/logs-after.txt 2>&1
grep -cE 'SERVICE_STARTED|ADAPTER_STARTED|DEVICE_LINK_UP|DEVICE_UPLINK_TIMEOUT|PARKED_RECOVERY_TRIGGERED|COMMAND_RECEIPT_ACCEPTED|COMMAND_RESULT_ACKED|DEVICE_BOOT|SOS_STATUS_POST_FAILED|DEVICE_STATUS_POST_FAILED' /root/logs-after.txt
grep -E 'SERVICE_STARTED|ADAPTER_STARTED|DEVICE_LINK_UP|DEVICE_BOOT' /root/logs-after.txt | tail -20
```

**预期输出**
- `status-after.json` 大小约 2–6 KB
- `grep -c` 输出 ≥ 2（至少有一次启动 + 一次链路）
- 最后一条能看 `DEVICE_LINK_UP`（M100 重连）与 `ADAPTER_STARTED ... deviceAliveTimeoutMs=120000`

把 `status-after.json` 的内容、`logs-after.txt` 的相关片段、以及 §3 的两行（备份时间戳 / 回归自检结果）贴回给 Lead。

## 6. 回滚（只在需要时；服务继续运行、保留数据卷）

```bash
# 6.1 先演练（不改动任何东西）
bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh \
  --backup /opt/eldercare/deploy/backup/wearable-<§3 打印的时间戳> --dry-run

# 6.2 真回滚（回到 1.0.0）
bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh \
  --backup /opt/eldercare/deploy/backup/wearable-<§3 打印的时间戳>

# 6.3 回滚后确认
docker exec $(docker ps -qf name=wearable-mqtt) node -e \
  "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log('AFTER_ROLLBACK version='+j.version))"
```

**预期输出**
- dry-run 只打印 4 行 `[rollback-upgrade] [dry-run] 将执行: ...`，不改文件
- 真回滚关键行（顺序）：
  ```
  [rollback-upgrade] 使用备份: /opt/eldercare/deploy/backup/wearable-<时间戳>
  [rollback-upgrade] 停止并移除 wearable-mqtt 容器（保留 backend/caddy 与数据卷）...
  [rollback-upgrade] 已恢复旧源码: /opt/eldercare/wearable（升级版暂时保存在 /opt/eldercare/wearable.rollback-old-<时间戳>...）
  [rollback-upgrade] 以旧版本源码重建 wearable-mqtt ...
  [rollback-upgrade] 容器状态: healthy
  [rollback-upgrade] 自检通过: /healthz 200
  [rollback-upgrade] 回滚后服务版本: wearable-mqtt version=1.0.0
  [rollback-upgrade] 自检通过: 0.0.0:1883 可连接
  [rollback-upgrade] 升级回滚完成。数据卷 eldercare-public_wearable-data 保留（seq/命令游标）。
  ```
- 最后一行 `AFTER_ROLLBACK version=1.0.0`

**边界**：回滚只动 `wearable-mqtt`；**不要** `docker rm` 数据卷、**不要**停 backend/caddy、**不要**删备份目录
（`/opt/eldercare/deploy/backup/wearable-*`）。若脚本报 `备份里没有源码归档` → 说明备份不含旧源码，改用
`bash /opt/eldercare/deploy/rollback-wearable.sh --backup /opt/eldercare/deploy/backup/wearable-<时间戳>`，
并把输出发回 Lead。

## 7. 升级完成后要和 Lead 一起做的事（不属于本页操作）

1. Lead 会通知 teammate `ecs-verify` 开始跑**只读**验收（生产 API 采样 + 你贴回的 `/status`、`logs-after.txt`）；
2. 真实验收需要你配合的物理动作（以下由 Lead 统一指挥，不在本页执行）：
   - 按键产生一次真实 SOS → 在 APP 看到“等待设备确认”；
   - 在 PENDING 窗口内给 ESP32 **断电 30–60 秒再上电**（M100 保持供电），随后在 APP 点“确认”；
   - 另做一轮：ESP32 断电 **>2 分钟**（验证 120s 离线语义），再上电恢复；
   - 全程**不要**执行 `docker restart wearable-mqtt`（这正是 1.0.1 要消灭的动作）。
3. 详细判据与需要记录的时间点见同目录 `CHECKLIST.md`。

## 8. 安全红线（请对照执行）

- 不把 `MQTT_PASS` / `INGEST_KEY` 打印到屏幕或写进 shell history；本页命令均不涉及口令。
- 不改 backend、不改 caddy、不改 `/opt/eldercare/deploy/.env.deploy`。
- 不删除 `/opt/eldercare/deploy/backup/wearable-*` 与数据卷。
- 不向 MQTT `.../up` 主题发布任何消息（本页不含 publish 命令）。
- 不手工 ACK 历史告警、不伪造设备状态。
