# 变更清单（LOCAL-ALARM-SPEECH-FINAL，2026-10-26）

修改前快照：`source-before/`；修改后快照：`source-after/`。SHA-256 大写。
工作区 `<WORKSPACE>`。只改两块固定板的告警语音链路，未改 bridge/broker/homemon/public-sync/DAYU/手机 APP/公网后端。

---

## 1. 公共树 `competition/esp32-node/`（厨房固件构建源）

| 文件 | 修改前 | 修改后 | 说明 |
|---|---|---|---|
| `main/local_voice.c` | `CC83F416493349A224DEDB5E24955ABEA738D724186A7B16A7D5F267C028CB4E` (8,458 B) | `42A609D4FA7178004AA4988EF0BC281529391FF7DAF376BE580F9A825B17860D` (11,823 B) | 6 片段表 + IMA ADPCM 解码播放；去掉固定 `PCM ÷2` 衰减；功放使能后先等 60 ms 再送 I2S；播放结束关功放逻辑保留 |
| `main/local_voice.h` | `E09E516330C9615A67D15EE11DF82BB040CC6D3F55027ED56BFA60DECA2F3C7B` (293 B) | `4EDB673595DD132D24235B406FBB196F5377960B8C18B00BF56107AB8C462826` (1,928 B) | 片段编号 `VOICE_CLIP_*` 与 `local_voice_play/cancel/text` 接口 |
| `main/adpcm_ima.h` | 新增 | `1D1260A3BF4CF6E01E7C8ADB6C284314A941003DCE425DC9DB81933CA6DCFD89` (3,532 B) | 纯逻辑 IMA ADPCM 4bit 解码器（与主机测试共用同一份头文件） |
| `main/node_main.c` | `6D5CC5A149244CCCBBC41F83A5E9CC479ADB03F957B49BF55421AB62615FF4D0` (69,807 B) | `2D0D65E2293A2579E89242E86A9145C0A5268F16F4CD6C8180A303E4EBE1EECF` (74,973 B) | 新增 `announce_start/cancel/tick`（短提示音→完整语音、互不重叠）；`voice_clip_for_alarm()` 按真实原因选文案；删除 `s_buzzer_until_ms` 连续 10 s 鸣响；stop/ACK/暂停/恢复/异常解除统一走 `announce_cancel()`；台架新增 `inj voice <1..6>` |
| `main/Kconfig.projbuild` | `B491D0FDD72857C5EA192C18284FB426DBC7DDF23BB74DAB55ACBE5AA3B4B0D9` (12,038 B) | `FF57B21FF7363670272B551E351016F928E7A6D699422879B75E65209D51EC64` (13,725 B) | 新增 `NODE_VOICE_AMP_SETTLE_MS`、`NODE_ALARM_CHIRP_ON_MS/GAP_MS/COUNT/COUNT_SOS`、`NODE_ALARM_VOICE_GAP_MS`；`NODE_ALARM_BEEP_SEC` 标记为已弃用（保留符号兼容旧 profile）；`NODE_VOICE_VOLUME` 范围 0..20 → 0..33 并更新说明（厨房改用 30） |
| `main/CMakeLists.txt` | `21A145D88DA3B10BC97D4454DDFEBF1BD2361085CA4D28107DE193AEBB4BAECD` (481 B) | `3995D6F8D84BC5C351FFF19637E7CDCD02E11F3C927D7326723A6854B83FFA28` (851 B) | EMBED 由 `sos.pcm/warning.pcm` 改为 6 个 `.adpcm`；不再嵌入 `test.pcm` |
| `main/alarm_logic.h` | `0A833CD62D5EFD4FA6FFBBF81C88E75E353EC7EC89866F965840B9072C9C1F51` (15,269 B) | `65443BB54CBED97DFC7028719898F9B981179236D184048513BA6C00A40C6DDB` (16,580 B) | 新增 `climate_reason_code()`（温度/湿度/两者/未知，无效读数不猜） |
| `main/voice/sos.pcm` | `B60358815B4CD4CDF92B000AD7BF26C47B10082613CC2C39C52E7736D3959A38` (39,996 B) | **删除** | 实测为正弦“滴滴”提示音，SOS 听不到人声的直接原因 |
| `main/voice/warning.pcm` | `8912FBF1D8AAA3A79C6716FBE3BAD6C4B48C15E0A3CE231B7C86C9CD0686E644` (90,342 B) | **删除** | 旧通用文案，被 4 条按原因区分的语音取代 |
| `main/voice/test.pcm` | `E9F914D5D36423347E17158A10F419434E91434F0713A35A226E8152A1C0208C` (107,030 B) | **删除** | 仅开机诊断用，生产固件从不嵌入 |
| `main/voice/{test,warning}.wav` | `A7CEE576…` / `F137CB19…` | **删除** | TTS 中间产物，已由 `audio/` 保留 |
| `main/voice/sos.adpcm` | 新增 | `6358C55B5B4E0C160D851C1217FC15D8ED424ECCDBF0A31373CF796E1B847AC7` (27,791 B) | “我需要帮助，请尽快过来。” |
| `main/voice/climate_temp.adpcm` | 新增 | `079AD208B6066CF454695E9D0BC82C9C07B8234B8F53FDD13FABA607F2066941` (30,139 B) | “室内温度异常，请前来查看。” |
| `main/voice/climate_rh.adpcm` | 新增 | `D73C6D14420272D037AF4F90796DB0046F4B0DC95C0B0BEF4749ECC17C60335D` (30,313 B) | “室内湿度异常，请前来查看。” |
| `main/voice/climate_both.adpcm` | 新增 | `FAB1E5B25271B51720665BA19F9CC71BF7B6601126114000F0F1A54B07DA89D5` (36,193 B) | “室内温度和湿度异常，请前来查看。” |
| `main/voice/no_motion.adpcm` | 新增 | `51DFF9D9A4F7A2D96B490F9734B577A03609B0DDF4F91608798DC040FB4B3016` (39,889 B) | “长时间未检测到活动，请确认家人情况。” |
| `main/voice/climate_generic.adpcm` | 新增 | `66EF85131CC8F74EA6C662EE90E9130C4048648CD37AC3058B1318E67EA11BFA` (31,999 B) | 兜底：“室内温湿度异常，请前来查看。” |
| `test/host_alarm_logic_test.c` | `BB703B9EE37683B5C2C68443735C215D0891C48D43B522035E966E3467F6009D` (14,288 B) | `D1E90099E986CE0D972B0801E3A234BBDE04EA3F9703C85F5EB35442BA66027B` (15,750 B) | 新增 `test_climate_reason_code()` 8 条断言（含“无效读数不得猜原因”） |
| `test/host_adpcm_test.c` | 新增 | `44EE89193FC1B18FA101A80EA1225817EF2567A22669C7C235E33DC108A42C67` (2,767 B) | 用固件同一解码器解码 `.adpcm`，与 audioop 参考 PCM 逐字节比对 |
| `profiles/alarm-closure.sdkconfig.defaults` | `D29DAA070E6E49DBD192BF6AC00788D6F5A9176C0FB06027EA4D500D0C45C30B` (1,116 B) | `8B24E0AE40A887C8DAACEF2D5FAEDFDEA779D5F000AA0CEA6BCCF0C5D3FAA9C8` (1,533 B) | 显式写入本次提示音/语音间隔/功放等待参数 |
| `profiles/alarm-bench.sdkconfig.defaults` | `997F992B478B8298DE0F036FCE0EB456594FD3A2AD7B45D03EBB3C8D45D13A71` (996 B) | `F6CAFFAF2347B43DD8B2619ADEFE86FD1F5523EB907D95D06A612BF8C0119425` (1,416 B) | 同上（台架） |
| `profiles/voice-volume30.sdkconfig.defaults` | 新增 | `D6EA1D05E546DECA0172A9714C3D7DF575CD2CF5E02B2F997ABCAB71F0187C43` (395 B) | 厨房音量 30（用户 22:0x 明确要求与卫生间一致） |

未改动：`main/local_led.c/.h`、`main/voice_pins.h`、`main/local_voice` 的 ES8388 寄存器初始化表、网络/分区/引脚配置（厨房 MQ-5 仍 GPIO7/ADC1_CH6、音频 LRCK 仍 GPIO9、KEY0 仍 XL9555 P1_7 防抖+松开布防）。

## 2. 卫生间私有树 `.local/bathroom-voice-20261026/src/`

| 文件 | 修改前 | 修改后 | 说明 |
|---|---|---|---|
| `main/local_voice.c` | `B89B88B268AC29B2E404E0602FE0F9EE42489DFCC64B9B7DF09A1CF38F0C5999` (8,201 B) | `42A609D4FA7178004AA4988EF0BC281529391FF7DAF376BE580F9A825B17860D` (11,823 B) | 与公共树同一份（卫生间本来就是满幅，本次只是统一到 ADPCM 方案） |
| `main/local_voice.h` | `E09E5163…` (293 B) | `4EDB673595DD132D24235B406FBB196F5377960B8C18B00BF56107AB8C462826` (1,928 B) | 同上 |
| `main/adpcm_ima.h` | 新增 | `1D1260A3BF4CF6E01E7C8ADB6C284314A941003DCE425DC9DB81933CA6DCFD89` | 同一份 |
| `main/node_main.c` | `B2DA25E13F24E4A7CC5784B70AA23B8D4E70879D8519F4213A33C34FB853E2D2` (61,690 B) | `6A2AA97873252B5B487022C3108B32C545FF2F74CAFF2BABEF377028E5F97EDD` (66,858 B) | 用带断言的补丁脚本 `tools/patch-bath-tree2.py` 施加与公共树**同一套 14 处改动**；保留卫生间 GPIO15 SOS、PIR GPIO36、水漏 -1、音量 30 等私有逻辑 |
| `main/Kconfig.projbuild` | `FF77B93BF238E81E10703D0ECBFD2C663C123264B457BA5CB7FFB8D954D9E9D9` (11,052 B) | `BA1F4493B31B7670B5457060E2383521AA25F07A80646033E971DCF8B8565CD2` (12,379 B) | 新增同一组配置项；音量范围保持 0..33 |
| `main/CMakeLists.txt` | `21A145D8…` (481 B) | `3995D6F8D84BC5C351FFF19637E7CDCD02E11F3C927D7326723A6854B83FFA28` (851 B) | 同一份 |
| `main/alarm_logic.h` | `548601CBA785FAA57E19965846324B9849FE57ABFB08C0C98FB0A8E0B3F431D2` (13,226 B) | `29E1D781BD9404CEE48C8F9EB11FC6F67C15C59C942A5EC07F9DE17B6667FCAE` (14,537 B) | 新增同一份 `climate_reason_code()` |
| `main/voice/` | 旧 `sos.pcm/warning.pcm/test.pcm/*.wav` | 6 个 `.adpcm`（哈希同 §1） | 与公共树完全相同的素材 |
| `test/host_bathroom_logic_test.c` | 未单独快照（本次仅追加） | `16D6BED4CE3750FDE07DB25F6851793035DF9B818E2A9CF70A1224131BD0DB3D` (6,281 B) | 追加 `test_climate_reason()` 8 条断言；原 54 条 → 62 条 |
| `profiles/alarm-closure.sdkconfig.defaults` | `D29DAA07…` (1,116 B) | `457913F250AC42511EA99298F580646E6297E4C066E077A689C8C16427750532` (1,536 B) | 同上（行尾差异导致与公共树字节数差 3 B，内容等价） |
| `profiles/alarm-bench.sdkconfig.defaults` | `997F992B…` (996 B) | `F6CAFFAF2347B43DD8B2619ADEFE86FD1F5523EB907D95D06A612BF8C0119425` (1,416 B) | 同上 |

注：卫生间 `node_main.c` 是较早基线（没有 KEY0、没有 `alarm_id_build`、没有 SOS 送达三段日志），本次**没有**顺带合并这些无关差异；只用补丁脚本施加语音编排相关改动，避免引入未经台架验证的行为变化。

## 3. 证据/工具新增（不参与固件）

- `REPORT.md`、`CHANGES.md`、`SHA256SUMS.txt`、`audio/`（TTS 原始 WAV、最终 `.adpcm`、试听 WAV、MANIFEST、superseded 旧素材）、`diag/`、`run/`、`verify/`、`build/`、`host-tests/`、`source-before/`、`source-after/`。
- `tools/`：`make-voice-assets.py`（TTS→重采样→归一化→ADPCM 编码+参考解码+audioop 交叉校验）、`make-preview-all.py`、`dump-adpcm-reference.py`、`patch-bath-tree2.py`、`extend-bath-host-test.py`、`build-all.ps1`、`build-kitchen-v30.ps1`、`build-firmware.ps1`、`flash-app.ps1`、`device-identity-backup.ps1`、`hash-evidence.ps1`、`bench-serial.py`、`reset-capture.py`、`scenarios/*.json`。

## 4. 明确未改

- **APP / DAYU / 公网后端 / bridge / broker / homemon / public-sync 源码与配置**：未改、未重启（除用户自行操作的一键入口）。未安装任何 APP。
- **Wi-Fi / deviceId / NVS / 分区表 / bootloader / 接线**：未改；烧录只写 app 分区 `0x10000`。
- **传感器与安全策略**：MQ-5 仍 GPIO7/ADC1_CH6、MQ-2 仍 GPIO6、音频 LRCK GPIO9、KEY0 防抖与松开布防、LED GPIO1 低有效、暂停持久化、重启不重放，全部保留。
- **燃气/水漏/门磁**：仍未启用（阈值 4096 / GPIO -1），不播报未校准浓度。
- **COM8 独立按钮分支**：未继续排查/烧录（本次也未碰 COM8）；**COM11/DAYU**：未操作。
