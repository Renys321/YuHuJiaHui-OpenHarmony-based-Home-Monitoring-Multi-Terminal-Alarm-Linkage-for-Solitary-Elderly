# 固件 A/B 实测记录（2026-11-02 13:00–13:08）

## 目的

验证“重构后固件（app_main 拆分 + 语音 guard）刷到板子上，行为是否与旧固件一致”。
只刷**卫生间**，厨房保持旧固件作对照；旧固件已完整读回备份，可随时恢复。

## 固件身份

| 项目 | 大小 | SHA-256 |
|---|---|---|
| bathroom 旧固件（板载，已备份 `bathroom-old.bin`） | 1,157,232 B | `476e53ba…a6232046`（与 `SHA256SUMS.txt` 一致） |
| bathroom 新固件（`bathroom-new-readback.bin`） | 1,157,744 B | `8c1f07af…ec8690`（回读 = 本地 bin） |
| kitchen 旧固件（板载，已备份 `kitchen-old.bin`） | 1,168,224 B | `38d391bc…2d3cf234`（与记录一致） |

## 步骤

1. 串口基线：COM9/COM6 各采 45 s，旧固件 5 s/帧、JSON 443 B；
2. `esptool read_flash 0x10000 <size>` 读回旧固件，SHA-256 与 `SHA256SUMS.txt` 逐字节一致；
3. 只刷 bathroom（`build-node.ps1 -Action flash -Com COM6`），回读校验 = 本地 bin；
4. 采新固件串口；用网关 `text_query`（“我不舒服”，target esp32-bath）触发 `pushClipToSpeakers(9)`；
5. 用 `stability-test -Cycles 1 -SpeakerTarget esp32-bath` 验证定向 PCM 与云端 health。

## 结果（卫生间，旧 → 新）

| 项 | 旧固件 | 新固件 | 判定 |
|---|---|---|---|
| 状态帧 | 443 B，8 个顶层键，5 段传感器 | 443 B，同键同段 | ✅ 一致 |
| 门磁 seq | 52 | 52（NVS 保留） | ✅ |
| WiFi / 网关 9101 | 在线 | 在线（10.127.130.71） | ✅ |
| 网络 PCM 推送 | 历史 241,120 B 播放 | 241,120 B，PCM begin/end 正常 | ✅ |
| 本地 clip=9 | `RX local clip=9 (key-parse)` → 93,488 B → 11.75 s → STOP OK | 同左，逐行一致 | ✅ |
| ASR→TTS（网关模拟节点） | 2/2 通过 | 1/1 通过（9.1 s） | ✅ |
| 定向路由/无串台 | 10/10（历史） | 1 轮 7/7，仅 esp32-bath | ✅ |
| 云端 healthz | ok | ok | ✅ |
| 启动日志量 | 少（采集时已启动） | 多（含 boot/WiFi/climate 告警） | 差异可解释 |
| main 任务栈余量 | 1,772 B | 2,980 B（+1,208 B） | 更好 |
| 温湿度 | `valid=false`（未接 AHT20） | 同，但新增 W 日志 | 行为一致、日志更详细 |

## 结论

- 关键链路（状态帧、门磁、WiFi/网关、PCM、本地 clip、ASR/TTS、定向路由、云端）与旧固件**逐项一致**；
- 差异只有日志详尽度与 main 栈余量（更宽松），未发现行为回退；
- 旧固件备份哈希与记录完全匹配，出问题可原样恢复；
- 当前仅 bathroom 为新固件，kitchen 仍为旧固件；是否刷 kitchen 待确认。

## 备注

- `voice-chain-test` 是**模拟节点**连 9303，不经过真实板子，不能用它证明板端 clip；本轮用网关 `text_query` + `pushClipToSpeakers` 才真正触发板端播放。
- 板子 NVS 里“监护暂停=PAUSED”仍保留，正式演示前需恢复。

## 重要：测试固件与当前工作区不一致（13:02 又发生了一次源码改动）

- 本 A/B 测的是 **12:53 构建**（bathroom `8c1f07af…`，1,157,744 B），已刷入并回读校验；
- 13:02:29 另一进程又改了 `node_main.c`（四份同步为 `47a1d0e3…`），13:03 重新构建出
  kitchen `a3ad5db9…` / bathroom `7035e25f…` / living `1923fc6d…`；
- 因此**当前工作区构建 ≠ 板上固件**。若要把 kitchen 也刷成新版，必须先冻结源码再自建、再刷，
  否则会再次出现“源码/构建/板子”三不一致。
