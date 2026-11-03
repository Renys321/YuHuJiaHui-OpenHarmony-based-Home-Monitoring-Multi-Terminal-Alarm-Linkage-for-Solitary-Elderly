# P0-A public-sync supervisor 真实验收（2026-10-24）

结论：**P0-A PASS（REAL）**。

本轮不是审计或本地测试替代：一键入口由用户从 Windows Explorer 真实双击、隐藏输入一次
`INGEST_KEY`，supervisor 真实运行；三设备自然 202、受控 worker 终止自动恢复、15 分钟稳定性、
API `lastSeenTs` 前进均有现场证据。

## 1. 现场环境（验收时）

```text
时间窗口        2026-10-24 22:32:26 ~ 22:56:46 CST
DAYU HDC target 450100445634303332012847942eca00（USB Connected，shell root）
DAYU homemon    /data/homemon/homemon
                sha256=0d243539403de89c547defacf43c86a4980142ef8ec686b277be7133c42881e6（匹配冻结原版）
原演示网络      SSID=ElderCareLab，PC WLAN=10.127.130.179
厨房 ESP32      esp32-kitchen，MAC 50:78:7d:16:ed:60（ARP 可见，COM6/CH340 现场映射由用户确认）
卫生间 ESP32    esp32-bath，MAC 14:c1:9f:42:dd:b4（ARP 可见，COM9/CH340 现场映射由用户确认）
backend         https://api.luxunacc.xyz（DNS/TCP 443 可达，未修改 backend）
```

注意：交接文档旧端口记录为 COM14/COM5，用户本轮最新口径为 **厨房=COM6、卫生间=COM9、
DAYU200=COM11**；本轮未打开、未烧录、未修改任何 COM 端口。

## 2. 真实启动与进程事实

```text
22:32:26  一键入口 preflight PASS：文件/端口/lock/DAYU/homemon 哈希/fport 全部通过
22:32:26  DAYU 校时 SET：2017-08-04T09:23:14.608Z -> 2026-10-24T14:32:26.327Z
22:32:2x  DAYU 原版 homemon 启动，9000 LISTEN
22:32:2x  hdc fport tcp:9001 -> tcp:9000 建立，PC 127.0.0.1:9001 可连
22:32:2x  Broker 1883 启动；Bridge 9101 启动
22:32:32  supervisor LOCK_ACQUIRED pid=11872
22:32:3x  隐藏输入一次 INGEST_KEY（不回显、不落盘）
22:32:48  WORKER_START pid=45928
22:32:49  HEALTHY pid=45928
```

稳定期核对：

```text
supervisorCount=1        supervisorPid=11872（lock/state 一致）
workerCount=1            workerPid=50580
worker parent           = 11872（父子关系正确）
state                   = HEALTHY（heartbeatAt 持续刷新）
第二实例                被 lock + 跨入口进程保护拒绝
```

## 3. 受控 worker 终止与自动恢复（只杀一次 worker）

```text
22:35:49  只执行 Stop-Process -Id 45928 -Force（supervisor 未动）
          日志：WORKER_EXIT code=4294967295 signal=null durationMs=180644
          RESTART_IN 1000ms restartCount=1
22:35:50  WORKER_START pid=50580；HEALTHY pid=50580
恢复耗时  1282 ms
核验       supervisorPid 仍为 11872；workerCount=1；无双实例
           KEY_READ ok=set 计数保持 1，WAITING_FOR_KEY 计数保持 1（未再次要求密钥）
           living 自然 202 由 6 继续增长到 8
```

证据：`evidence/2026-10-24-public-sync-supervisor-candidate/worker-restart-acceptance-2026-10-24.log`

## 4. 三设备自然 202（非 retained，非手工发布）

观察窗口 22:41:33 ~ 22:56:46（15 分钟，30 秒采样）：

```text
supervisor PID 全程 11872；worker 全程 1 个（50580）
累计 status=202：111
  esp32-kitchen  32
  esp32-bath     32
  dayu200-living 47
每个采样点计数单调增加，证明是自然持续上报，不是订阅瞬间的 retained。
```

证据：
- `evidence/2026-10-24-public-sync-supervisor-candidate/watch15-2026-10-24.log`
- `evidence/2026-10-24-public-sync-supervisor-candidate/runtime/public-sync-supervisor.log`
  （supervisor 事件 + worker stdout/stderr 持久日志，不含 key）

## 5. API lastSeen 前进（认证探针，凭据不落地）

22:45:36 ~ 22:47:36，同一会话认证一次、读取 `/api/v1/devices` 两次（间隔 120 秒）：

```text
lastSeenAdvanced：
  esp32-kitchen  true
  esp32-bath     true
  dayu200-living true
```

同次证据中的真实业务字段（脱敏白名单）：

```text
esp32-kitchen  gas.raw 145 -> 141, gas.valid=true
               smoke.raw 221（两次一致），smoke.valid=true
esp32-bath     motion.lastActiveTs 前进，motion.countToday 0 -> 1
dayu200-living state=NORMAL
```

证据：`runtime/api-lastseen-20261024-224316.json` / `.txt`
（探针只写 deviceId/lastSeenTs/state/gas/smoke/motion；不写 token、密码、请求头或请求体）

## 6. 正式入口合入

按交接文档第 6 节步骤 12，通过后将 supervisor 与一键入口合入正式目录：

```text
competition/cloud/onenet/public-sync-supervisor.js
  size=16312 sha256=078553D4F7AA2CDCCE365F6B44C4616E6535F8F0C596B995A5A6F23AD20A1D47
competition/cloud/onenet/public-sync-worker.js
  size=1953  sha256=7C4138718CE4FDE259C85123A7DABF5E5C8F2A9C2A2B4022A11B93D401761164
competition/materials/start-demo-supervisor.ps1
  size=15335 sha256=D83101EC90CAB977B2F4CC82D8FE8629C01430C6FDE13EBD8C543EF28F084FBE
competition/materials/start-demo-supervisor.cmd
  size=186   sha256=85FD74D53E56232811D79FDE83FCFBADEF0BA48FEFAFADBDE846D5EFDFF82072
competition/materials/verify-supervisor-acceptance.ps1
  size=8696  sha256=E2150FE01C193C924E32BEDAA18B20E6CF0127A18BC26E0D32A242C2222E9A16
```

正式入口已通过 `-Preflight` 验证（含跨入口双实例保护：检测到已运行 supervisor 时拒绝启动
第二个）。为避免出现第二个 worker，本轮验收结束后未再次启动正式入口；下次演示从
`materials/start-demo-supervisor.cmd` 双击即可（先关闭当前旧入口窗口）。

旧入口 `start-demo-current.cmd` / `demo_recover.ps1` 保留为回退路径。

## 7. 本轮实际修改/新增文件

```text
修改：
  evidence/2026-10-24-public-sync-supervisor-candidate/public-sync-supervisor.js
  evidence/2026-10-24-public-sync-supervisor-candidate/public-sync-worker.js
  evidence/2026-10-24-public-sync-supervisor-candidate/start-demo-supervisor-candidate.ps1
  evidence/2026-10-24-public-sync-supervisor-candidate/test/supervisor.test.js
  evidence/2026-10-24-public-sync-supervisor-candidate/DESIGN.md
新增：
  evidence/2026-10-24-public-sync-supervisor-candidate/start-demo-supervisor-candidate.cmd（未改）
  evidence/2026-10-24-public-sync-supervisor-candidate/verify-supervisor-acceptance.ps1
  evidence/2026-10-24-public-sync-supervisor-candidate/probe-api-lastseen-p0a.ps1
  evidence/2026-10-24-public-sync-supervisor-candidate/test/lifecycle-probe.js
  evidence/2026-10-24-public-sync-supervisor-candidate/test/probe-harness.js
  evidence/2026-10-24-public-sync-supervisor-candidate/test/probe-stub-public-sync.js
  cloud/onenet/public-sync-supervisor.js
  cloud/onenet/public-sync-worker.js
  materials/start-demo-supervisor.ps1
  materials/start-demo-supervisor.cmd
  materials/verify-supervisor-acceptance.ps1
  materials/README.md（新增三行说明，其余保留）
本文件：
  docs/evidence/2026-10-24-p0a-supervisor-real-acceptance.md
```

## 8. 本地回归（修改后，非验收替代）

```text
node --test --test-force-exit test/supervisor.test.js  -> 10/10 PASS
node test/lifecycle-probe.js                           -> 6/6 PASS（真实 supervisor+worker+本地 stub 入口，无网络）
```

证据文件：
`test-output-hardened-2026-10-24.log`、`lifecycle-probe-output-2026-10-24.log`。

## 9. 边界（不得扩大解释）

1. `HEALTHY` 只表示 worker 已返回 `main()`，不等于业务健康；本轮业务健康由三设备自然 202
   和 API `lastSeenTs` 独立证明。
2. supervisor 不能防止自身或整个 Windows Job 被强杀；密钥不持久化，电脑重启后仍需用户
   双击入口并隐藏输入一次。
3. 本轮没有验证“worker 存活但 MQTT 消费卡死”的业务级看门狗；该能力尚未实现。
4. 本轮没有操作 COM5/COM8/COM14，没有烧录 ESP32，没有修改 Wi-Fi/AP/backend/绑定，没有
   恢复 OneNET/4G，没有触发 SOS/ACK/reset。
