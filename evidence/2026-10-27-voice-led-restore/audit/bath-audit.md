# 卫生间三合一固件 + INVALID_STATUS 根因审计（只读）

- 时间：2026-10-27 00:47–01:05 +08；工作区 `<WORKSPACE>`；审计者全程只读（未开 COM4/5/8、未 esptool/烧录/复位、未改源码/.local/bridge/cloud、未重启 bridge/broker/public-sync、未按键）。
- 事实分级：**[实算]** 本轮计算/读取；**[产物]** 构建产物/日志；**[文档]** 既有报告；**[推断]** 需上板复验。

## 0. 结论速览

| 判据 | 结果 |
|---|---|
| 镜像存在 + 哈希一致 | ✅ **[实算]** 1,011,648 B，`42F24D5FED61DBD11A768E0ADDB54EDC78C9A36C02F7F58C0603CECE79793715` 逐位一致（不触发 STOP） |
| 三功能齐全（GPIO14 门磁/6 clips 中文语音/GPIO1 低有效 LED） | ✅ **[产物]** sdkconfig+源码+`.map` 互证（§2） |
| 覆盖并行变更（语音/LED/300s/ACK/音量 30/GPIO） | ✅ 覆盖；相对 bath-prod 仅多“门磁 + 跨房间播报 + 音量上限 33”（§3） |
| 不丢门磁恢复语音/LED+上报 | 🟡 可行，但须先做 §5 兼容改法并重建；直接烧本镜像只恢复语音/LED，云端仍被拒 |
| INVALID_STATUS 根因 | ✅ PC 侧 public-sync worker 的 gateway/adapter 门磁严格键白名单，**非 bridge、非后端**（§4） |

## 1. 镜像与源码树

**[实算]** `competition/esp32-node/.local/notice-20261026/bath-merged2/esp32_elder_node.bin`：1,011,648 B（`0xF6FC0`），mtime 2026-10-27 00:18:57+08，`Get-FileHash SHA256` 与任务值一致 ✅。同名旧构建 `…\bath-merged\…bin`=1,009,456 B/`64AECC1F…03B94`，**勿用**。

**[产物]** 源码树 `competition/esp32-node/.local/notice-20261026/bath-merged-src`（`bath-merged2/project_description.json` 的 `project_path`/`build_dir`）。构建证据 `evidence/2026-10-26-wireless-sos-button-final/build/build-bath-merged2.log:3`：`-DSDKCONFIG_DEFAULTS=.local/sdkconfig.bathroom.defaults; bath-merged-src/profiles/bathroom.sdkconfig.defaults; esp32-node/profiles/voice-candidate…; voice-volume30…; alarm-closure…`；日志尾 `binary size 0xf6fc0 … 0x9040 bytes (4%) free`（1 MiB app 分区余 36,928 B，已告警 nearly full）。注意：源树内 `bath-merged-src/sdkconfig` 是旧配置（`VOICE not set`/`LED_GPIO=-1`/`REPEAT=120`），**不是**本镜像配置；重建必须沿用上述 defaults 链，否则语音/LED/300s 会静默丢失。

## 2. 三功能证据

| 功能 | sdkconfig（`bath-merged2/sdkconfig`） | 源码 | `.map` |
|---|---|---|---|
| 门磁 GPIO14 | L509-513：`DOOR_GPIO=14`/`OPEN_LEVEL=1`/`CONFIRM=2`/`CACHE_MAX=8`/`CACHE_KEEP=300` | `main/alarm_logic.h` `door_update` 去抖（与门磁工程版同哈希`E140319C7E1A`，相对 bath-prod +82 行 0 删除）；`node_main.c:1380-1413` 采样/基线、`:1391` `door_update()`、`:747-769` 内部上拉初始化、`:363-446` NVS(seq+FIFO)、`:1675-1699` 上报 | L60915 `.text.door_update` @`0x420876e0` |
| 中文语音 6 clips | L485 `VOICE_ENABLED=y`、L486 `VOLUME=30`、L1021 主栈 8192 | `main/CMakeLists.txt:2-11` 6 条 `voice_assets`；`main/voice/*.adpcm` 6 文件与 bath-prod **逐哈希一致**；`local_voice.c:60-70` `s_clips[]`（第 7 项复用 sos，不新增资源；L225 日志 `clips=7`） | L203-214 六个 `.adpcm.S.obj` + `_binary_{sos,climate_temp,climate_rh,climate_both,no_motion,climate_generic}_adpcm_*` |
| GPIO1 低有效 LED | L541 `LED_GPIO=1`、L542 `LED_ACTIVE_LOW=y` | `main/local_led.c/.h` 与 bath-prod 同哈希`C7F6A3C636F1` | L45446 `local_led_start`@`0x4200d79c`；L87860 归属 `local_led.c.obj` |

**[文档]** bath-prod 实测启动日志 `…/2026-10-26-kitchen-sos-led-speech-final/verify/prod-bath-bootline.log:67,69`：`local-led: GPIO1 单色，低电平有效`、`local-voice: READY … clips=6`；候选沿用同一 LED/语音源码与配置，**[推断]** 上板应同样生效（本审计不代替实机验证）。另：候选还含**跨房间定向播报**（`main/notice_logic.h`、map L45279-45373 `notice_*`），但运行中 bridge（PID 42784，仅 `--broker … --listen 9101`）未启用 `--sos-source/--sos-targets`，该功能休眠、不影响三功能。

## 3. 相对 bath-prod 源码差异（并行变更覆盖）

基线 `competition/esp32-node/.local/bathroom-voice-20261026/src`；**[实算]** 其 `main/*` 与 `…/kitchen-sos-led-speech-final/source-after/bath/*` 逐哈希一致，对应 bath-prod 镜像 `…/.local/speech-20261026/bath-prod/esp32_elder_node.bin`=1,005,536 B/`46C7968D…CEA63` ✅。

| 文件 | 差异 | 并行变更是否保留 |
|---|---|---|
| `main/node_main.c` | +457/−31（门磁全局/采样/NVS/FIFO/上报；notice 分支；REMOTE_SOS 播报） | ✅ ACK `:1056-1082`（ID 精确匹配+announce_cancel）、STOP `:1089-1099`、300s 限频 `:1647-1662`（`CONFIG_NODE_ALARM_REPEAT_SEC`）、SOS 快路径/重武装 `:1742-1802`；31 行删除为等价改写，未删功能 |
| `main/alarm_logic.h` | +82/−0（门磁去抖/基线） | ✅ 原 PIR/SOS/温湿度状态机未动 |
| `main/local_voice.c`/`.h` | +clip 7（复用 sos）/ `VOICE_CLIP_REMOTE_SOS`、`MAX` | ✅ 6 个正式素材与解码不变 |
| `main/Kconfig.projbuild` | +58/−4（门磁 5 项 + 音量 `0..20`→`0..33`） | ✅ 音量 30 依赖此上限 |
| `main/profiles/bathroom.sdkconfig.defaults` | 门磁 GPIO14/level1/confirm2/cache8/300s；并入 WiFi/GW/主栈（后由 voice-candidate 覆盖为 8192） | ✅ PIR=36/SOS=15/I2C=4,5/水漏=-1/蜂鸣器=XL9555 未变 |
| `CMakeLists.txt`、`local_led.*`、`voice_pins.h`、`adpcm_ima.h` | 完全相同 | ✅ |
| `main/notice_logic.h` | 新增（见 §2 注） | 额外功能，非并行变更丢失 |

**结论**：未见并行变更被覆盖/回退；`node_main.c` 改动 488 行，建议上板逐项验收 ACK/STOP/300s/语音/LED，而非只看哈希。

## 4. INVALID_STATUS 拒收点与条件

链路 **[实算]**：设备 JSON → bridge `competition/bridge/mqtt_bridge.js:350-355` `publishStatus()`（仅 `JSON.stringify` 发 `home/<deviceId>/status`，**不校验字段**）→ broker → PC 侧 public-sync worker（PID 32788/父 32356，均 `<WORKSPACE>\competition\cloud\onenet\*.js`）→ `gateway.js:41,244-245` 订阅 `home/+/status` 调 `ingest()` → `gateway.js:294` → `:327 normalizeIncoming(raw)` → `adapter.js:263 normalizeStatus()` → `:271 normalizeDoor()`。

- `adapter.js:145-158 normalizeDoor()`：`requireExactKeys(door,['open','lastOpenTs'],'door')`（**L153**）——门磁只允许这两键；`open` 必须 boolean（L155→`:44-47`），`lastOpenTs` 必须 13 位毫秒或 0（L156→`:81-87`，`allowZero`）。
- `adapter.js:26-34 requireExactKeys()`：白名单外键即 `fail('door contains unknown field: …')`。
- `gateway.js:325-334`：归一化抛错被捕获→非 timestamp→`code='INVALID_STATUS'`→`_reject`（L333）；`gateway.js:579-583` 打印 `[gateway] REJECT code=… device=…`（与日志逐字一致）。
- 触发字段：门磁候选 `node_main.c:1675-1699`（门磁工程同源 `…/door-contact-20261026/src/main/node_main.c:1577-1591`）发 `"door":{"open":bool|null,"lastOpenTs":…,"lastCloseTs":…,"seq":…,"events":[…]}`：①`lastCloseTs` 等白名单外键→首错 `door contains unknown field: lastCloseTs`（主因）；②基线未知 `open:null` 违反 `requireBoolean`；③`lastOpenTs` 非 13 位毫秒/非 0 会被拒。
- **[实算]** 日志 `…/bridge/_test/current-runtime/supervisor/public-sync-supervisor.log`：首条 `L4181 2026-10-26T15:41:43.293Z [worker:stderr] [gateway] REJECT code=INVALID_STATUS device=esp32-bath`；至 2026-10-27T01:00:13+08 累计 **856 条**（最新 L5953），间隔≈5 s（固件 `REPORT_SEC=5`）；15:41 后 `cloud-sync OK device=esp32-bath` **0 条**（最后成功 L4148 15:31:42.831Z，字段为旧合同）。本地链路正常：`broker.out.log:21625+` 仍有 `PUBLISH home/esp32-bath/status (437B) → 转发给 1 个订阅者`。
- 排除：bridge 无门磁白名单；拒收在 `ingest` 内、`cloud-sync` HTTP 之前，**后端未参与**；生产为 D/E v6（[文档] `…/2026-10-26-d-e-production-release/REPORT.md:11,18,40`，v7 未发布；工作区 `cloud/backend/src/persistent-store.js:63 SCHEMA_VERSION=7` 未部署）。

## 5. 最小向后兼容改法（保留门磁采集，v7 前不下发未支持字段）

范围仅门磁源码副本（本审计不改；行号针对 `bath-merged-src/main/node_main.c`）：
1. `main/Kconfig.projbuild` 门磁段（L163-171 附近）加 `config NODE_DOOR_UPLINK_EXTENDED`（bool，default n）。
2. `report()`（L1667-1737）门磁段（L1677-1696）：`#if CONFIG_NODE_DOOR_UPLINK_EXTENDED` 保留 `lastCloseTs/seq/events` 扩展 JSON（L1682-1695 原样）；`#else` 只输出旧合同两键 `"door":{"open":%s,"lastOpenTs":%lld},`，且**仅当 `!s_door_baseline_unknown`**，基线未知时 `door_json` 留空（不发 `sensors.door`，避免把“未知”谎报为“关闭”；adapter 对缺省 door 不校验）。L1704-1724 的 `snprintf` 与 L1715 `door_json` 注入不用改。
3. 本地功能不动：`door_update` 去抖/基线（`:1380-1413`）、NVS seq+FIFO（`:363-446`）、300s 过期（`:389-401`）保留，事件继续本地记账；v7 上线后开关置 `y` 重建即补传。
4. 验证：host 单测 `test/host_door_logic_test.c`（7/7）不受影响；重建后记录新 `.bin` 大小/SHA-256 并复核 §2 全部配置键。临时止血（不推荐长期）：`report()` 令 `door_json[0]='\0'`（门磁整段不下发，网关立即 202，但 APP 期间看不到门态；事件仍本地）。
5. 可行性：可同时成立“本地门磁+语音+LED+云端上报”。**v7 顺序**：①PC 侧 `adapter.normalizeDoor` 白名单扩容（允许 `lastCloseTs/seq/events` 与 `open:null`）→ ②后端 v7 部署 → ③固件开关置 y 重建/烧录。**不要**在本任务内改 bridge/cloud/后端或发布 v7。附加风险：app 余量仅 36,928 B（4%）；门磁极性为常开型 NO、`OPEN_LEVEL=1`（[文档] `door-contact-closure/report.md:142-158` + 真实验收 seq 1→5）。

## 6. STOP 条件

1. 镜像缺失/哈希不符→STOP：本轮**未触发**。
2. **不得把本镜像原样烧录当作“修复上报”**：不先做 §5 改法就烧，只恢复语音/LED，REJECT 每 5 s 继续；仅当 Lead 接受“先恢复语音/LED、云端稍后修”的中间态才可烧。
3. 本会话禁止：开 COM、esptool/烧录/复位/全片擦除、改源码/.local/bridge/cloud、重启服务、按键。
4. 按 §5 重建后哈希必然变化，需先记录并复核（体积 <1 MiB，建议余量 ≥30 KB），不得用旧 42F2 哈希核对。
5. 物理验收不可省（语音可听/LED 可亮/门磁开合与保持去抖）；本审计只证明镜像含对应代码/配置/符号。
6. 未授权不得部署后端 v7 或改共享网关。

## 7. 身份 / 备份 / 写录（本轮未执行）

- **[实算]** `…/kitchen-sos-led-speech-final/build/identity-backup-bath.json`：COM4、MAC `14:c1:9f:42:dd:b4`、ESP32-S3、烧前 app 镜像 937,472 B/`EF2C62FC…72B5`、app 分区整段备份 1,048,576 B（`.local/speech-20261026/device-backup/COM4-app-before-speech-20261026.bin`）；固件内 `CONFIG_NODE_ID="esp32-bath"`、`ROOM="卫生间"`（build sdkconfig L496-497）。
- 回滚镜像（均写 app 0x10000、不擦全片）：bath-prod 语音+LED 1,005,536 B/`46C7968D…CEA63`；当前门磁候选 `…/.local/door-contact-20261026/src/build-door-bathroom/esp32_elder_node.bin` 783,056 B/`16B63A31…17C1`；三合一 1,011,648 B/`42F24D5F…93715`。
- 写录模板（勿在本审计执行）：`esptool.py -p COM4 -b 460800 --before default_reset --after hard_reset --chip esp32s3 write_flash 0x10000 <bin>`（仅 app 0x10000–0x10FFFF，1 MiB；`flasher_args.json` 同为 0x10000），写后读回校验哈希。

参考：[wireless-sos REPORT §6.1](../../2026-10-26-wireless-sos-button-final/REPORT.md)、[door-contact report](../../2026-10-26-door-contact-closure/report.md)、[kitchen-sos-led-speech-final FIRMWARE-MANIFEST](../../2026-10-26-kitchen-sos-led-speech-final/build/FIRMWARE-MANIFEST.md)、[D/E production release](../../2026-10-26-d-e-production-release/REPORT.md)。
