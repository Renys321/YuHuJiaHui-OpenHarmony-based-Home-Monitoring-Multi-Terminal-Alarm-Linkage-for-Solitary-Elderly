# 2026-11-02 固件重构复核证据（归档 + 独立复核）

## 背景

上一轮“逐 token/字符串对比基线 + 主机逻辑测试 + 报文模拟 + 三副本一致性”复核由另一会话完成，
结论为“代码级与报文级检查全部通过，本轮无需重新烧录”。本轮（2026-11-02 12:2x）做两件事：

1. **归档**：把临时目录里的基线快照、主机测试和比对脚本收进仓库，避免 `%TEMP%` 被清理后证据丢失；
2. **补验**：构建 living（此前未构建），验证“三工程均可编译”。

归档时对原报告做了独立复核，发现一处结论不成立（见 `REVIEW.md` 与“已知问题”）。

## 目录结构

| 路径 | 内容 |
|---|---|
| `baseline/firmware/` | 重构前基线（23:04 快照）：`common` 18 个文件 + 三工程 `main/` |
| `comment-baseline/` | 注释整理前的快照（00:0x），用于区分“注释改动”和“逻辑改动” |
| `hostsim/` | 主机测试可执行文件与源码：`alarm_test.exe`、`battery_test.exe`、`adpcm_test.exe`、`notice_test.c/.exe` |
| `checks/` | 比对/模拟脚本：`deep-check.py`、`sim-report.py`、`verify-all.ps1`、`compare-*.{js,ps1,py}`、`bin-diff.py`、`build-both.ps1`、`check-code-lines.sh` |
| `outputs/firmware-check.log` | 本机重跑主机测试 + deep-check + sim-report 的完整输出 |
| `outputs/living-build.log` | living 构建失败日志（含根因） |
| `current/source-sha256.txt` | 当前 `common` 母本 31 个文件的 SHA-256 |
| `current/build-state.txt` | 三工程构建产物哈希/大小/mtime + 已刷写记录 |
| `SHA256SUMS.txt` | 本目录全部归档文件的校验和 |

## A/B 实测（2026-11-02 13:00–13:08，卫生间）

为回答“重构版刷上去效果是否和旧固件一样”，只刷卫生间、厨房保持旧固件对照，并用 `esptool read_flash`
把两块板的旧固件完整读回（哈希与 `SHA256SUMS.txt` 一致，可随时恢复）。

结果：状态帧（443 B/同键同段）、门磁 seq、WiFi/网关、网络 PCM（241,120 B）、本地 clip=9
（`RX local clip=9 (key-parse)` → 93,488 B → 11.7 s → `STOP OK cancelled=0`）、ASR/TTS、定向路由、
云端 healthz 均与旧固件一致；差异仅日志详尽度与 main 栈余量（1,772→2,980 B）。
详见 `ab/README.md`，原始串口与镜像在 `ab/` 下。

注意：`voice-chain-test` 是模拟节点连 9303，不经过真实板，不能用来证明板端 clip；
本轮用网关 `text_query`（“我不舒服”）触发 `pushClipToSpeakers(9)` 才真正验证板端播放。

## 本次实测结果

| 项 | 结果 |
|---|---|
| 主机测试 | alarm `PASS=141 FAIL=0`、battery `35/0`、notice `18/0`（可复现） |
| ADPCM | 报告称 6 段 0 失配；`adpcm_test.exe` 需要 `<clip.adpcm> <clip.refpcm>`，临时目录未留存参考 PCM，本轮未重跑（历史证据见 `evidence/2026-10-26-kitchen-sos-led-speech-final/host-tests`） |
| 报文模拟 | `sim-report.py` 重跑：6 帧全部 PASS 严格 JSON，字节数 555 / 422 / 470 / 489 / 544 / 557 |
| token 对比 | `deep-check.py`：头文件内联函数 33 个一致、`#define` 改动 0、差异均为拆分/改名/移文件（完整输出见 log） |
| 三副本 | `common` 与 kitchen/bathroom/living 的 `.c/.h/Kconfig.projbuild/voice` 87/90 相同，3 处不同均为 `common/components/.../CMakeLists.txt` 与工程 `main/CMakeLists.txt` 的布局差异（预期）；三工程 `main/CMakeLists.txt` 哈希完全一致 |
| kitchen/bathroom 构建 | `7f69c512…`（1,168,720 B，12:17:32）、`177e8ae9…`（1,157,728 B，12:17:56），均晚于源码最后修改 00:15:19 |
| **living 构建** | 修复前失败（`CONFIG_NODE_MIC_*` 未定义）；12:30 加语音保护后**通过**：771,920 B / `d8b49f9e…` |

## 修复记录（12:29–12:30，已合入 common + 三工程）

**问题**：living（`CONFIG_NODE_VOICE_ENABLED=n`）编译失败：
`node_main.c:647/648: 'CONFIG_NODE_MIC_RECORD_SEC' / 'CONFIG_NODE_MIC_PORT' undeclared`。

**根因**：串口 `micupload` 分支直接使用只在语音开启时才存在的两个宏，Kconfig 里它们 `depends on NODE_VOICE_ENABLED`。

**修法**：给该分支加 `#if CONFIG_NODE_VOICE_ENABLED / #else ESP_LOGW(“MIC_UPLOAD 未启用…”) / #endif`；
四份 `node_main.c` 同步为同一哈希 `4b24bb98…`。

**重建结果（均 exit=0）**：

| 工程 | 大小 | SHA-256 | 分支校验 |
|---|---|---|---|
| kitchen | 1,168,720 B | `63a99cab…` | 走语音分支（已排队=1，未启用=0） |
| bathroom | 1,157,728 B | `024cf0e9…` | 走语音分支（已排队=1，未启用=0） |
| living | 771,920 B | `d8b49f9e…` | 走未启用分支（已排队=0，未启用=1） |

修复后重跑 `deep-check.py` / `sim-report.py` 均通过（见 `outputs/firmware-check-after-fix.log`）。
注意：这三份 bin **均未刷写**，板子仍是 11-01 22:1x 旧固件。

## 已知问题（必须处理）

1. ~~living 构建失败~~ **已修复**（见上节）。

2. **板子固件 ≠ 当前源码/构建**
   - 已刷写：kitchen `38d391bc…`（1,168,224 B）、bathroom `476e53ba…`（1,157,232 B），来自 11-01 22:1x。
   - 当前构建：kitchen `7f69c512…`（1,168,720 B）、bathroom `177e8ae9…`（1,157,728 B）。
   - 源码期间经历大重构（`node_main.c` 2345→1325 行，新增 13 个模块）。
   - 因此原报告“本轮无需重新烧录”不能作为交付结论：若提交重构版源码，必须刷写并重跑真机回归。

3. **并发构建痕迹**：kitchen/bathroom 的 bin 在 12:17 被另一进程重建（大小相同、哈希因构建时间不同而变化），
   本目录 `current/build-state.txt` 记录的是 12:26 采集值；刷写前请以当时实际 bin 为准。

4. **参考 PCM 缺失**：ADPCM 6 段一致性本轮无法复跑；若要作为证据，需要把参考 PCM 一并归档。

## 复现命令

```bat
:: 主机测试
%TEMP%\shouchao-polish\hostsim\alarm_test.exe
%TEMP%\shouchao-polish\hostsim\battery_test.exe
%TEMP%\shouchao-polish\hostsim\notice_test.exe

:: token/#define 对比 与 6 帧模拟（脚本已归档到 checks/）
python checks\deep-check.py
python checks\sim-report.py

:: living 构建（修复后已通过）
cd firmware
tools\build-node.ps1 -Node living
```

## 结论

- 归档完成，主机测试与报文模拟可复现；
- 原报告的静态等价结论成立，但 **“living 源码齐全”不等于“可编译”**——实测失败后已修复，三工程现均可构建；
- **“无需重新烧录”不成立**：板子仍是旧固件，源码/构建已变，交付前必须刷写并回归，或回退源码到已刷版本。

## 注意：并发改动

13:02 另一进程再次修改 `node_main.c` 并重建（`47a1d0e3…` / `a3ad5db9…` / `7035e25f…`），
与 A/B 所测的 12:53 构建（bathroom `8c1f07af…`）不同。后续刷写前必须先冻结源码，
从冻结副本自建，否则“源码=板子”的前提会被并发改动破坏。

## 第四轮：对“结构搬迁 + 注释修正”报告的独立复核（2026-11-02 13:10–13:17）

复核结论：**静态声明大部分成立，但有 4 处需要纠正**。

成立：
- `node_main.c` MD5 `5d1d06f1…`，四份副本一致；
- 构建产物 kitchen `a3ad5db9…` / bathroom `7035e25f…` / living `1923fc6d…`，大小与报告一致；
- `app_main` 54 行、调用顺序 boot_self_check → local_bench_run → network_start → run_loop；
- `docs/CODE-WALKTHROUGH.md` 已改为 `run_loop()`；
- 主机测试 141/35/18 复现；ADPCM 6 段（有参考）全部 0 mismatch；
- **台架组合独立编译通过**：`LOCAL_BENCH=y / ALARM_BENCH_INJECT=y / DHT11_BENCH=y / DHT11_GPIO=6 / BOOT_BEEP_MS=500`，
  产物 665,344 B；仅 `aht20_read` 未使用（AHT20 与 DHT11 同时打开导致）和 I2S 旧 API 弃用告警；
- 最新 node_main 编译日志无告警（旧告警来自 11-01 的过期构建日志）。

需纠正：
1. **“板子上仍然是旧固件”不成立**：bathroom 已在 13:00 刷成 `8c1f07af…`（12:53 构建），kitchen 仍是旧
   `38d391bc…`；当前工作区构建 `7035e25f…` 两边都不是。
2. “29 个共享源文件”：实际是 **28 个 `.c/.h`**（另 8 个 voice、1 个 Kconfig）；88/88 对比一致。
3. “字符串只多出 MIC_UPLOAD 一条”：`deep-check` 显示 8 条缺失 / 13 条新增，包含合并后的 `#error` 文案、
   新增头文件名与 guard 日志；“只多一条”忽略了这些类别。
4. “MIC_UPLOAD guard 重构前就存在”：**不成立**，它是 12:29 为修 living 编译新增的；重构前基线没有该字符串。
5. deep-check 现状为 33 个函数体一致 / 19 个不同 / 1 个无对应（`app_main` 1001→176 token），
   与早前“34/18”口径不同；差异来自函数拆分，属预期，但仍只是静态推断。

## 第四轮：对“结构搬迁 + 注释修正”报告的独立复核（2026-11-02 13:10–13:17）

复核结论：**静态声明大部分成立，但有 4 处需要纠正**。

成立：
- `node_main.c` MD5 `5d1d06f1…`，四份副本一致；
- 构建产物 kitchen `a3ad5db9…` / bathroom `7035e25f…` / living `1923fc6d…`，大小与报告一致；
- `app_main` 54 行、调用顺序 boot_self_check → local_bench_run → network_start → run_loop；
- `docs/CODE-WALKTHROUGH.md` 已改为 `run_loop()`；
- 主机测试 141/35/18 复现；ADPCM 6 段（有参考）全部 0 mismatch；
- **台架组合独立编译通过**：`LOCAL_BENCH=y / ALARM_BENCH_INJECT=y / DHT11_BENCH=y / DHT11_GPIO=6 / BOOT_BEEP_MS=500`，
  产物 665,344 B；仅 `aht20_read` 未使用（AHT20 与 DHT11 同时打开导致）和 I2S 旧 API 弃用告警；
- 最新 node_main 编译日志无告警（旧告警来自 11-01 的过期构建日志）。

需纠正：
1. **“板子上仍然是旧固件”不成立**：bathroom 已在 13:00 刷成 `8c1f07af…`（12:53 构建），kitchen 仍是旧
   `38d391bc…`；当前工作区构建 `7035e25f…` 两边都不是。
2. “29 个共享源文件”：实际是 **28 个 `.c/.h`**（另 8 个 voice、1 个 Kconfig）；87/87 对比一致。
3. “字符串只多出 MIC_UPLOAD 一条”：`deep-check` 显示 8 条缺失 / 13 条新增，包含合并后的 `#error` 文案、
   新增头文件名与 guard 日志；“只多一条”忽略了这些类别。
4. “MIC_UPLOAD guard 重构前就存在”：**不成立**，它是 12:29 为修 living 编译新增的；重构前基线没有该字符串。
5. deep-check 现状为 33 个函数体一致 / 19 个不同 / 1 个无对应（`app_main` 1001→176 token），
   与早前“34/18”口径不同；差异来自函数拆分，属预期，但仍只是静态推断。

## 冻结刷写（2026-11-02 13:17–13:22）

- 冻结快照：`freeze-src/`（161 个文件，含三工程 `main/`、`common`、`tools/build-node.ps1`、CMakeLists/partitions/sdkconfig），
  刷写后复核源码与冻结快照 **38/38 × 4 全部一致**，`node_main.c` MD5 `5d1d06f1…`；
- 重建：kitchen `a3ad5db9…`（1,168,736 B）、bathroom `7035e25f…`（1,157,744 B）、living `1923fc6d…`（771,936 B）；
- 刷写：kitchen COM9、bathroom COM6，均 **回读校验 = 本地 bin**（`ab/*-frozen-readback.bin`）；
- 启动：两板均获取 IP、连上 9101，门磁 seq 保留（23 / 52），状态帧 5 s 一条；
- 回归：`core-start -CheckOnly` = **OK=11 / WARN=0 / FAIL=0**；`stability-test -Cycles 3` = **21/21**；
  `voice-chain-test -Cycles 2` = **2/2**（注意：该测试是模拟节点，不代表板端播报）；
- 板端 clip（真实节点，网关 `text_query("我不舒服")` 触发）：`RX local clip=9 (key-parse)` →
  `PLAY clip=9 bytes=93488` → 11.7 s → `STOP clip=9 result=ESP_OK cancelled=0`；
- 未覆盖：SOS→云端→ACK 全链（需手机操作）、小时级浸泡、断网恢复；
- 已知告警：I2S 旧 API 弃用、bathroom 未接 AHT20（valid=false）、启动瞬间 WiFi 202/205 重连——均为既有现象。
