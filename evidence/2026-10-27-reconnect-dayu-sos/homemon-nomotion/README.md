# 客厅「无 PIR 却报 NO_MOTION」源头修复 + 活动监测能力字段（2026-10-27）

分类：**源码修复 PASS（主机单测 4 套 + ARM32 严格构建 + 本地进程级台架 53 项）；板端部署 NOT PERFORMED（由 Lead 统一执行）；DAYU/APP 真机文案 NOT TESTED（UI 由 dayu-sos / app-ui 落地）。**

- 范围：`competition/southbound/**`（homemon.c、新增纯逻辑头、host 测试、README）。
- 未修改：northbound/APP/backend/bridge；未部署到 DAYU200；未开串口；未删除/ACK/改写任何现网告警与 `safety.log`。
- 本地台架是**Windows 进程级模拟**，不是 DAYU 真机证据（见 §7 边界声明）。

## 1. 结论

1. **根因**：旧 `homemon.c` 无条件用 `idle = now - last_motion_ms` 判定 `NO_MOTION` /
   活动间隔 WARN。客厅没有 PIR 时 `last_motion_ms` 只在启动时赋一次值，运行满
   `no_motion_sec=1800s` 后必然生成一条 `NO_MOTION`。
2. **修复**：在源头按“真实活动监测能力”门控：
   - 仅当配置了 PIR 且启动自检至少一路 GPIO 可读时，才启用 `NO_MOTION` 与活动间隔 WARN；
   - 无 PIR / PIR 不可读 / 本 tick 读失败时**绝不判定**（“无数据”≠“无人”），
     盲区时间不计入 idle；
   - 时钟跳变（RTC 回退 / PC 校时 / `date -s`）时整体平移历史时间戳，不产生假 idle。
3. **字段**：`sensors.motion` 新增 `supported` / `reported` / `reason`（纯增量、向后兼容）。
   无 PIR 时 `supported=false`、`lastActiveTs=0`，UI 据此显示“未配置 PIR 无活动监测”。
4. **独立性**：摄像头/监护字段 `monitorOnline` / `monitorReason` 未改动，且验证了
   “摄像头失联/在线”不会改变 `state`、不会被推导成 PIR 活动。
5. **历史**：现网历史告警与 `safety.log` 未删除/未 ACK/未改写；重启后内存里的旧
   `NO_MOTION` 自然消失（历史仍在后端/APP）。

## 2. 现场根因证据（真实设备，只读）

### 2.1 状态快照（22:19 桥接读取，转录原文）

```json
{"deviceId":"dayu200-living","room":"客厅","ts":1793110773310,"state":"ALARM","sensors":{"motion":{"lastActiveTs":1793073453036,"countToday":0},"door":{"open":false,"lastOpenTs":0},"climate":{"tempC":0.0,"rh":0.0,"ok":true},"gas":{"raw":0,"ok":true},"smoke":{"raw":0,"ok":true}},"history":[0,0,0,0,0,0,0],"slots":[0,0,0,0],"alarm":{"id":"a-1793075253-1","type":"NO_MOTION","countToday":1}}
```

- `lastActiveTs=1793073453036` → **2026-10-27T11:57:33+08:00**（= homemon 启动时刻，不是真实活动）。
- `alarm.id` 时间戳 `1793075253` → **2026-10-27T12:27:33+08:00**。
- 差值 **恰好 1800s**，与 `no_motion_sec=1800` 完全吻合。
- `countToday=0`、`history/slots` 全 0 → 该设备从未有 PIR 活动数据。
- 同一 JSON **缺少** `monitorOnline`、`climate.valid`、`alarm.evidenceId` → 板端当前运行的是
  早于当前源码的旧二进制（部署时统一替换，不影响本修复）。

### 2.2 持续告警与二次 raise

- `live-evidence/bridge-recent-dayu200-living.log`：`home/dayu200-living/status` 最近 200 条
  桥接记录 **200/200 都是 `state=ALARM`**（旧逻辑只要没有活动数据就一直是 ALARM）。
- `live-evidence/board-status-before-fix.json`（22:43:26 抓取，SHA-256
  `66D20A35594BA4B9639B612CD0DF102560907F575DAEB2CAFD882A12C70FD10F`）：
  已变成 `alarm.id=a-1793111963-2 / countToday=2`（22:39:23 再次 raise），
  而 `lastActiveTs` 仍是 11:57:33 —— 旧逻辑在 ACK/复位后仍会因 idle 未清零立刻重新告警，
  进一步说明“源头门控”而不是“UI 隐藏”才正确。**本任务没有执行任何 ACK/reset。**
- `live-evidence/board-status-before-fix-2219.json` 为 §2.1 转录快照（文件 SHA 见 §11 备注：
  与同时刻另一 10s 帧的哈希不同，属正常刷新）。

### 2.3 旧代码位置（baseline）

`baseline/homemon.c.pre`（SHA-256 `54BA5531C47B3A865DD9EF04AADFC740216E3AF5C068A5523A83507FC714B172`，
即修复前源码，与 2026-10-22 合同记录一致）：

```c
/* --- 判定（基础阈值算法） --- */          /* 约 1087-1111 行 */
ms_t idle = t - g_rt.last_motion_ms;
...
} else if (idle >= limit) {                 /* 无 PIR 时必然命中 */
    if (g_rt.state != ST_ALARM || strcmp(g_rt.alarm_type, "NO_MOTION"))
        alarm_raise("NO_MOTION", "长时间未检测到人体活动");
...
} else if (idle >= warn_at && g_rt.state == ST_NORMAL) {  /* 无 PIR 也会 WARN */
```

## 3. 修改清单与 diff

| 文件 | 变更 |
|---|---|
| `southbound/src/motion_gate.h` | **新增**纯逻辑：能力判定 `mg_monitor_enabled`、判定门控 `mg_judge_allowed`、时钟跳变 `mg_clock_jumped`/`mg_resync_ms`、盲区暂停 `mg_pause_idle_ms`、原因词 `mg_reason` |
| `southbound/src/judge_logic.h` | **新增**纯逻辑：判定段与旧 if/else 链**逐分支等价**的 `judge_decide()`（GAS>SMOKE>SOS>NO_MOTION>CLIMATE>IDLE 优先级 + 无 PIR 门控） |
| `southbound/src/homemon.c` | 启动自检 PIR 能力并记录日志；门控 NO_MOTION/活动间隔 WARN；无数据盲区暂停 idle；时钟跳变平移历史时间戳；JSON 增加 motion 能力字段（lastActiveTs 改真实值，无 PIR 恒 0）；`motion_gpio=-1` 按“禁用”解析；新增 `gpio_root`（仅台架模拟，默认 `/sys/class/gpio`） |
| `southbound/tests/motion_gate_test.c` | **新增** 48 项纯逻辑单测 |
| `southbound/tests/judge_logic_test.c` | **新增** 31 项判定优先级/门控单测 |
| `southbound/tests/hostbench/**` | **新增** Windows 进程级台架兼容层与运行脚本（prelude.h / hostbench_compat.c / run_hostbench.ps1 / include shims） |
| `southbound/build-host-test.ps1` | 扩展为构建并运行 4 套主机单测 |
| `southbound/README.md` | 新增 §六之二：无 PIR 语义、字段合同、测试命令；配置注释补充 `motion_gpio=-1` / `gpio_root` |
| `southbound/homemon.conf` | **未改**（无需改；行为由能力自检决定） |

Diff（`git diff --no-index`）：**169 insertions(+), 42 deletions(-)**，完整补丁见
`diff-homemon.c.patch`。修改前源码/测试/README 备份见 `baseline/`。

## 4. JSON 字段契约（Lead 已确认；已转 dayu-sos / app-ui）

```json
"sensors": {"motion": {
  "lastActiveTs": 0,          // ms；0 = 从未有真实活动（无 PIR 时恒 0，不再伪造为启动时刻）
  "countToday": 0,            // 今日活动次数（无 PIR 恒 0）
  "supported": false,         // 本机是否具备活动监测能力 = 配置了 PIR 且 GPIO 可读
  "reported": false,          // 最近一次采样是否有有效 PIR 数据；false 只表示“无数据”
  "reason": "not_configured"  // ok | not_configured | gpio_unavailable | no_data（排障用）
}}
```

- **唯一事实源** `sensors.motion.supported`：`false` ⇒ 不显示“长时间无活动”，显示
  “未配置 PIR 无活动监测”。未加顶层别名，避免两处不一致。
- `monitorOnline` / `monitorReason` **保持独立**：摄像头“无人 / 无画面 / 离线”不得推导成
  PIR“无活动”；反之 `motion.supported=false` 也不表示摄像头不可用。
- 旧消费者忽略未知键即可（不崩溃）；旧固件缺这三个字段时应按“能力未知”处理。
- `lastActiveTs` 语义收紧：只有真实 PIR 沿（或显式 `motion` 联调命令）才更新。

## 5. 主机单测（PC 真实运行）

命令：`powershell -ExecutionPolicy Bypass -File <WORKSPACE>\competition\southbound\build-host-test.ps1`
输出全文：`unit-tests-output.log`。结果：

| 测试 | 结果 |
|---|---|
| `time_util_test` | PASS=24 FAIL=0（64 位毫秒 / 可信时间回归） |
| `climate_valid_test` | PASS（温湿度 valid 合同回归） |
| `motion_gate_test` | PASS=48 FAIL=0（无 PIR 超阈值/重启/时钟跳变/负 idle 永不 NO_MOTION；有 PIR 1800s 仍触发；WARN 60%；盲区暂停；原因词） |
| `judge_logic_test` | PASS=31 FAIL=0（无 PIR 永不 NO_MOTION/不 WARN；GAS>SMOKE>SOS>NO_MOTION>CLIMATE>IDLE 优先级不回归；已有告警不重复 raise；负 idle 安全） |
| `homemon --selftest`（host exe） | PASS=11 FAIL=0 |

## 6. ARM32 交叉编译（严格模式）

```powershell
powershell -ExecutionPolicy Bypass -File <WORKSPACE>\competition\southbound\build.ps1 -Strict
```

- 产物：`southbound/out/homemon-arm`（副本 `out-candidate/homemon-arm`）
- 大小：**177,704 bytes**（修复前本机旧产物 173,488 B；差异来自新增逻辑与新字段）
- SHA-256：**F6F4497C57492CA00F9AC70BF9A00330EBD5C658E2C134EAE006CB5F0DE2899B**
- 架构：`ELF32 / Machine: ARM / interpreter: /lib/ld-musl-arm.so.1`（见 `readelf-arm32.log`）
- 构建日志：`build-arm32-strict.log`；`-Strict` 零告警通过
- 可复现性：同一 `homemon.c` 连续两次构建得到**相同** SHA-256（`F6F4497C…899B`）
- 源码 SHA-256：`homemon.c` = `23B0976BF7C1C7DD97265299263828DCC0AFF3BFEFD671084191C6D8A74B27CD`
- 未部署到 DAYU200（按任务约定由 Lead 统一执行）。

## 7. 本地台架（Windows 进程级模拟，**非真机**）

**边界声明**：homemon 本体是 Linux/POSIX 守护进程。台架用
`tests/hostbench/prelude.h + hostbench_compat.c` 把**同一份 `src/homemon.c`** 编译成 Windows
进程（不修改生产源码、无条件编译），补上 winsock 套接字/fd 分流/`mkdir`/`localtime_r`/
`fcntl(FIONBIO)`/时钟偏移等最小 POSIX 能力。台架特征：

- GPIO 用目录模拟（`gpio_root=...\fake-gpio-*`），**不是真实引脚**；
- 没有 I2C/ADC：温湿度 `valid=false`、燃气/烟雾保持 `ok=true`（等价“未接传感器”）；
- “校时”只改进程内时钟偏移（`hostbench_compat.c`），**绝不修改本机系统时钟**；
- 因此本节的 PASS **不能**替代 DAYU200 真机验收。

运行：

```powershell
powershell -ExecutionPolicy Bypass -File <WORKSPACE>\competition\southbound\tests\hostbench\run_hostbench.ps1
```

配置与日志：`bench/`（`bench-*.conf`、`run-*/homemon.log`、`run-*/status.json`、
`run-*/stdout.log`）；汇总结果：`bench/hostbench-results.txt`（最终一次运行
2026-10-27T22:47+08:00，PASS=53 FAIL=0）；台架 exe：`southbound/out/homemon-host.exe`，
SHA-256 `5340E9EEE430171585DF22F8954103CEAC985110745C666E0103292CF7079BF5`
（PE 构建时间戳导致每次构建哈希略有差异，属正常）。

场景与断言（**PASS=53 FAIL=0**）：

| 场景 | 内容 | 关键结果 |
|---|---|---|
| A（无 PIR，`no_motion_sec=60`，跑 90s） | 无 PIR 超阈值 | 全程 `state=NORMAL`；stdout 19 条状态行无 `NO_MOTION`；`supported=false/reported=false/reason=not_configured/lastActiveTs=0`；`monitorOnline=-1` |
| A2（同目录重启） | 重启语义 | `state=NORMAL`、`alarm.id=""`、日志保留两次启动记录 |
| B（PIR 假 gpio5，20s/50%） | 既有规则不回归 | 10s→WARN；活动→NORMAL 且 `lastActiveTs` 更新；停止后→`NO_MOTION`（id/type/detail 完整） |
| C（NO_MOTION 后重启） | 历史/内存 | 重启后 `state=NORMAL`、`alarm.id=""`；`homemon.log` 旧 ALARM 记录仍在（未删除/未改写） |
| D（进程内校时 +1h） | 时钟跳变 | 日志 `校时跳变 +3599095 ms：历史时间戳已平移`；跳变后立即仍 `NORMAL`（未因 1h 假 idle 告警）；随后按观测 idle 于 12s 进 WARN，仍未误报 NO_MOTION |
| E（无 PIR + 摄像头字段） | 语义独立 | `monitor offline no_frame`→`monitorOnline=0/reason=no_frame`，state 不变；`online frames_resumed`→1；全程无 NO_MOTION；非法时间 999 被拒；`sos`→`MANUAL_SOS`（无 PIR 不影响求助） |
| F（门磁 gpio29 + SOS gpio30，无 PIR） | 传感器不回归 | 门磁开/合 `door.open` 正确、`lastOpenTs` 有值；按钮消抖→`MANUAL_SOS`；全程 `motion.supported=false`、无 NO_MOTION |

代表性日志（A，无 PIR）：

```text
活动监测能力：配置 0 路 PIR，启动自检可读 0 路 → NO_MOTION=关闭（无有效 PIR：不产生 NO_MOTION，也不因活动间隔进 WARN）
```

代表性日志（D，时钟跳变）：

```text
校时跳变 +3599095 ms：历史时间戳已平移（不据此判定无活动）
TIME 已接受，系统时钟已校准： UTC=2026-10-27T15:45:22Z epoch_ms=1793115922764
活动间隔达阈值 50% -> WARN
```

代表性日志（E，摄像头监护字段独立）：

```text
MONITOR offline：no_frame
MONITOR online：frames_resumed
```

（E 段日志里 `MONITOR offline/online` 之后的重启与 `ALARM ... type=MANUAL_SOS` 是 E9/E10
主动求助断言，不是摄像头推导出的告警。）

**未在台架覆盖**：真实 1800s 墙钟长跑（用 20s 等比阈值 + 单测的 1800s 常量覆盖）、
真机 GPIO/I2C/ADC 电平与权限、DAYU/APP 显示（需 UI 与真机）。

## 8. 部署步骤（**由 Lead 统一执行，本任务未部署**）

前置：确认现场不存在第二个 homemon 实例；板端当前 `/data/homemon/homemon` 为 164,276 B、
SHA-256 `0D243539…81E6`（旧二进制）。本次**只替换二进制，不改 `homemon.conf`**。

```powershell
$h  = '<WORKSPACE>\tools\hdc\hdc.exe'
$ts = '20261027-2315'                # 用实际部署时间
$ev = '<WORKSPACE>\competition\evidence\2026-10-27-reconnect-dayu-sos\homemon-nomotion'
New-Item -ItemType Directory -Force -Path "$ev\board-backup" | Out-Null

# 0) 只读核对现状（PID / 文件大小 / 哈希 / 配置里是否真的没有 motion_gpio）
& $h shell "pidof homemon; ls -l /data/homemon/homemon /data/homemon/homemon.conf; sha256sum /data/homemon/homemon /data/homemon/homemon.conf"
& $h shell "cat /data/homemon/homemon.conf"

# 1) 备份（板端 + 本地各一份）
& $h shell "cp -p /data/homemon/homemon /data/homemon/homemon.rollback-$ts; cp -p /data/homemon/homemon.conf /data/homemon/homemon.conf.rollback-$ts"
& $h file recv /data/homemon/homemon      "$ev\board-backup\homemon.board-$ts"
& $h file recv /data/homemon/homemon.conf "$ev\board-backup\homemon.conf.board-$ts"

# 2) 推送新二进制到 .new 并校验哈希（不要直接覆盖运行中的文件）
& $h file send "<WORKSPACE>\competition\southbound\out\homemon-arm" /data/homemon/homemon.new
& $h shell "chmod 755 /data/homemon/homemon.new; sha256sum /data/homemon/homemon.new"
# 期望：F6F4497C57492CA00F9AC70BF9A00330EBD5C658E2C134EAE006CB5F0DE2899B

# 3) 停旧进程（先记录 PID，再按 PID kill；确认 pidof homemon 为空）
& $h shell "pidof homemon"
& $h shell "kill <上一步PID>; sleep 1; pidof homemon"

# 4) 原子替换 + 用现场既有方式启动（不要同时起两个实例）
& $h shell "mv /data/homemon/homemon.new /data/homemon/homemon"
& $h shell "/data/homemon/homemon /data/homemon/homemon.conf"   # 前台方式；或按 materials 启动脚本/既有后台方式

# 5) 验证（关键：motion.supported 必须为 false）
& $h shell "cat /data/homemon/status.json"
# 期望：state=NORMAL、alarm.id=""、sensors.motion.supported=false、reported=false、
#       reason=not_configured、lastActiveTs=0，且带 monitorOnline/climate.valid
& $h shell "grep '活动监测能力' /data/homemon/homemon.log | tail -1"
# 期望：配置 0 路 PIR，启动自检可读 0 路 → NO_MOTION=关闭
```

部署后观察（PC 侧，只读）：等待 bridge 发布 `home/dayu200-living/status`，确认
`state=NORMAL` 且不再出现新的 `NO_MOTION`；仓库里 `bridge/_test/current-runtime/supervisor/status.json`
可用于快速核对。**注意**：如果第 0 步发现板端 `homemon.conf` 里仍有 `motion_gpio=117,114`
且这些 GPIO 实际可读（即使没接 PIR），启动自检会判为 `supported=true`，30min 后仍可能产生
`NO_MOTION`。此时必须先把该行改成 `motion_gpio=-1`（或删除）再重启；conf 已在第 1 步备份。
**部署后若 `motion.supported=true` 而现场确无 PIR，按此处理，不要靠 UI 文案掩盖。**

## 9. 回滚（应急）

```powershell
$h  = '<WORKSPACE>\tools\hdc\hdc.exe'
$ts = '20261027-2315'                # 与部署时一致
& $h shell "pidof homemon"
& $h shell "kill <PID>; sleep 1; pidof homemon"
& $h shell "cp -p /data/homemon/homemon.rollback-$ts /data/homemon/homemon; cp -p /data/homemon/homemon.conf.rollback-$ts /data/homemon/homemon.conf"
& $h shell "chmod 755 /data/homemon/homemon"
& $h shell "/data/homemon/homemon /data/homemon/homemon.conf"
& $h shell "cat /data/homemon/status.json"
```

回滚后旧 bug 仍在（无 PIR 时约 30min 后会再次产生 `NO_MOTION`），且 JSON 不再有
`supported/reported/reason` —— 仅用于应急，UI 需按“能力未知”处理。

## 10. 历史与数据保留

- 未删除/未 ACK/未改写任何现网告警、`safety.log`、`daily.txt`、`homemon.log`。
- 修复后的二进制启动时内存状态为 NORMAL、`alarm.id=""`：板端内存中旧的 `NO_MOTION`
  不会跨重启存在；历史告警仍在后端/APP 历史列表（由既有链路负责）。
- 旧 `homemon.log`/`safety.log` 以追加方式保留；本次台架场景 C 已证明“重启不删历史”。

## 11. 未解决 / 风险

1. **未部署、未真机验证**：dayu200 上的效果需要 Lead 部署后确认
   `motion.supported=false` 与 30min 内无新 `NO_MOTION`。
2. **板端 conf 待核对**：见 §8 风险段；若 `motion_gpio` 有值但无硬件，必须改 conf 为 `-1`。
3. **UI 文案未改**：DAYU/APP 需要按新字段展示“未配置 PIR 无活动监测”并让摄像头状态独立
   （已把契约转给 dayu-sos / app-ui）。本任务只保证源头字段与判定。
4. **既有语义未改**：有 PIR 时 ACK `NO_MOTION` 后若仍无活动会再次 raise（旧行为，本次未改，
   单测中已固定为防止误回归）；无 PIR 设备已不受影响。
5. **台架非真机**：GPIO/I2C/ADC 与真实 1800s 长跑未覆盖；时钟跳变是进程内模拟（安全，
   不改本机时钟）。真机验收见 Lead 统一安排。
6. 台架遗留的 4 个已退出 `homemon-host` 进程条目（`HasExited=True`）是 Windows 句柄回收
   延迟，不占用端口/文件；不影响交付。

## 12. 证据文件索引

```text
homemon-nomotion/
  README.md                       本文件
  baseline/                       修改前备份（homemon.c.pre 54BA5531…、tests-pre、README.pre、build-host-test.ps1.pre）
  diff-homemon.c.patch            完整 unified diff
  unit-tests-output.log           4 套主机单测输出
  host-selftest.log               homemon --selftest（host 构建）输出
  build-arm32-strict.log          ARM32 -Strict 构建输出
  readelf-arm32.log               ELF32/ARM/interpreter 记录
  out-candidate/homemon-arm       候选二进制（177,704 B，F6F4497C…）
  live-evidence/                  现场根因证据（status.json、bridge 记录、时间换算）
  bench/                          Windows 台架配置/日志/结果（hostbench-results.txt）
```
