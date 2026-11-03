# 制品与源码指纹

记录时间：2026-10-15（Asia/Shanghai）

> 注意：本文是 2026-10-15 的历史冻结指纹。此后固件/HAP/source 已多次重建，
> 哈希可能不再对应当前磁盘产物；需要核对时请用 `Get-FileHash` 现场重算，或到
> `<WORKSPACE>Backup\archive\docs-legacy-2026-10-30\` 查看历史记录。

> 2026-10-15 更新：五个预置语音资源（`check_in.wav` / `please_respond.wav` /
> `medicine_reminder.wav` / `family_message.wav` / `emergency_contacting.wav`）已生成并写入
> `northbound/entry/src/main/resources/rawfile/`，unsigned HAP 已重新构建
> （1774208 字节，SHA-256 `384DD3B8...`），包内 rawfile 共 6 个文件（sos.wav + 5 个预置语音，
> 5 个预置语音哈希互不相同）。生成路线与校验见 `tools/tts/README.md`。
> 当前语音版 HAP 已签名、验签、安装到唯一 USB Connected 的 DAYU200，并完成五种
> 预置语音 `playing -> completed`、五次匹配回执 HTTP 200 和未知资源失败路径验收。
> 证据见 `docs/evidence/2026-10-15-dayu-preset-voice-playback.md`。进一步使用真实本地后端、
> 真实 PersistentStore、真实代理和 DAYU HAP 完成一条 `QUEUED -> DELIVERED -> PLAYED`，
> 见 `docs/evidence/2026-10-15-real-backend-dayu-played.md`。人工听觉内容与实体按钮
> `ACKED` 仍待确认；公网后端不在本轮覆盖范围内。

状态定义：

- `CURRENT`：当前可作为工程基线。
- `REFERENCE`：保留作其他架构参考，不适用于当前真机用户态。
- `STALE`：生成时间早于对应源码，不可代表当前源码。

## 1. 当前制品

| 状态 | 文件 | 大小 | SHA-256 |
|---|---|---:|---|
| CURRENT | `northbound/signing/eldercare-signed.hap` | 1320429 | `9186C5046AF2C55E4469B31A3FC83BC1294CC924485E08FFC9B37AA517F480BA` |
| CURRENT | `northbound/entry/build/default/outputs/default/entry-default-unsigned.hap` | 1774208 | `384DD3B8A1196F94BF0F065DD2A6E2D8C850BA64E384CE01692A1EA6E49BB533` |
| CURRENT | `southbound/out/homemon-arm` | 166264 | `4F2B5CC1233E21ED1708967371AFCA6625C5A9856B68E3EFDDF4C81275C10649` |
| REFERENCE | `southbound/out/homemon-arm64` | 34936 | `876CB66CD230D4D68D3B6CF608501CE08D7390B9FAB4BBBEECC268CED31E27FF` |
| CURRENT | `vision/yolo11n-pose.pt` | 6255593 | `869E83FCDFFDC7371FA4E34CD8E51C838CC729571D1635E5141E3075E9319DC0` |
| CURRENT | `southbound/say.sh` | 1521 | `725857B3740405C6B87E6D3B9DF27515AE12CEC979E87652D154CD262641AE27` |
| CURRENT | `northbound/entry/src/main/resources/rawfile/sos.wav` | 574286 | `898A09E5F09F23665AB30280CB3A9BCEC52CD7733AAFDBF9AC12C432E6E54528` |
| CURRENT | `northbound/entry/src/main/resources/rawfile/check_in.wav` | 142988 | `7F7C4029CC4C93FF346A77714A40994BAE528CF21A6FC06013AA3AF7EE1FCDE4` |
| CURRENT | `northbound/entry/src/main/resources/rawfile/please_respond.wav` | 122252 | `38272C5E85716B696A8733293C1999F7A50C8F5394D0210F71E2B207C7DBD89F` |
| CURRENT | `northbound/entry/src/main/resources/rawfile/medicine_reminder.wav` | 118796 | `1EF2214DAEDE5FEAF894B28164D872469A6174AC682DBC6E8A20768CAF4648C7` |
| CURRENT | `northbound/entry/src/main/resources/rawfile/family_message.wav` | 157964 | `4034C4EB67D540C738FC2A917C88FCB3BA0AFD67C45E1610F3BA34E77D886087` |
| CURRENT | `northbound/entry/src/main/resources/rawfile/emergency_contacting.wav` | 121100 | `55F992D999811AED235108E8E7A8F2AA4C84E34E58DEAD9150C8BF8148C1571C` |
| CURRENT | `esp32-node/build/esp32_elder_node.bin` | 754800 | `952B7B1CC40B5473196A6E4D565388BB33CBB2A815D6D721D735D8F5A12F267E` |
| CURRENT | `esp32-node/build/esp32_elder_node.elf` | 8366356 | `5D926405DC401E0950855435D8C83B7FD2B609ED87078C460C2FCC7D1D1DCF41` |
| CURRENT | `esp32-node/build/bootloader/bootloader.bin` | 20960 | `BB69B7E3100276A6638DFC21EC30D363210BF5CC46C1E3BF8C7671682A6B81E7` |
| CURRENT | `esp32-node/build/partition_table/partition-table.bin` | 3072 | `7F00B6C042A89B15B0CAC534F82ED988CAF29278FF5700B0C511EB1B5BB7C820` |

当前真机使用 `homemon-arm`。`homemon-arm64` 不适用于已验证的 32 位用户态。

当前 signed HAP 已离线验签通过，包含 `resources/rawfile/sos.wav` 和五种预置语音，且不含
`rpcid.sc`。2026-10-15 已在 DAYU 真机安装并完成五种预置语音选择、真实播放完成回执和未知
资源失败路径，见 `docs/evidence/2026-10-15-dayu-preset-voice-playback.md`。此前 2026-10-14
版本已完成跌倒证据自动抓拍、同事件去重、新事件再次抓拍以及监护失联/恢复回归，见
`docs/evidence/2026-10-14-fall-auto-evidence.md`。Camera 授权/枚举基线见
`docs/evidence/2026-10-13-dayu-final-acceptance.md`；
当前自研 4:3 预览、手动拍照、私有目录 JPEG 保存、关闭/重开和资源释放见
`docs/evidence/2026-10-13-app-camera-preview-photo.md`；比例修复与 YOLO letterbox 边界见
`docs/evidence/2026-10-13-camera-aspect-yolo-letterbox.md`；USB 有界采样帧送入 PC CPU YOLO
Pose 的真机证据见 `docs/evidence/2026-10-13-dayu-usb-yolo-sampled-frames.md`；前台自动监护与
合成 FALL 闭环见 `docs/evidence/2026-10-14-auto-fall-guard.md`。

> `BB994EA9...` 旧 signed HAP 已归档。当前 `9186C504...` signed HAP 与语音版 unsigned HAP
> 对齐并已完成验签、安装和预置语音真机回执验收；DAYU 私有照片 101 张保留边界仍未做
> 真机测试，不能由本轮语音验收外推。

## 2. 当前关键源码

| 文件 | SHA-256 |
|---|---|
| `northbound/entry/src/main/ets/pages/Index.ets` | `708E9B2547B532FE56A19D61AF08D725100F6436E25B67BA507AB344000C7208` |
| `northbound/entry/src/main/ets/entryability/EntryAbility.ets` | `6D348B1DC2CABF0C24A9F2FBC5FDFBD5499B0B78DEFA1C85D6A0040A7F32CA9D` |
| `northbound/entry/src/main/ets/model/CameraModel.ets` | `19D5AE49EB72F5F39E875BB1EC0E3FD4AE2ACAD1A3B6CDB88C80C3159C22371B` |
| `northbound/entry/src/main/ets/model/PhotoRetention.ts` | `E4CBD772CCFE2DC575BDBE74F2C6DD8AA0327EB28DC0B04AFCF84239A69A352F` |
| `northbound/tests/photo-retention.test.mjs` | `C0D89BF6C2FBD1ECE4BD8E5AEFC1C2CC927C9EEA2AC5F229D08793239FCA482A` |
| `northbound/entry/src/main/ets/model/VisionFrameStreamer.ets` | `31D49CC1E570648644AE826D89BE1E2316850DA66993DD38014090867260401E` |
| `northbound/entry/src/main/module.json5` | `18CCD83235462B8E0C58E91BAB959732EBD9B0F78864EA8DDBFDDB856985091A` |
| `southbound/src/homemon.c` | `327CDDCE90C596488DC62E773C4EF6C9BF9C21287D31968E3B3C9F91C8FCC929` |
| `southbound/out/homemon-arm` | `3C6680DC3C2582126F810F3E0188B71FDB8C68D4EFA927914ACA31903B800602` |
| `southbound/out/homemon-arm64` | `13073673C1B323B2074CF8C490DDC09A0E3506B467EE8919443477877F2E1B53` |
| `southbound/hdc-player.js` | `B9CC148D4B05030CAD83525AEB8BA65FCF7CD24BD753C1AA6B50B39B5882562C` |
| `southbound/hdc-player.test.js` | `80F5FC33B0BC5AA7E7CDB22BAC063EC500C0F4A2887A528401A9D9A6114B1905` |
| `southbound/comms-run.js` | `E8EF3868330DD52C1DEB547FA838DA6847708D1CCB5C810AAB836977A1C78BC6` |
| `tools/acceptance/dayu-comms-hdc.js` | `C62BCE8DF0BE63BC903951643B55532D9E249A1E3DD4190A625E54B2C1C18CFA` |
| `bridge/mqtt_bridge.js` | `6B629E6ACBD102C977DEAB805725F940308209814A20EC50E3258EB89BA71482` |
| `bridge/sim_node.js` | `7D301F7FEF867961B344EE4ABF26D1D1FFC45EE7E97DA594A36D04AA4F6E9379` |
| `bridge/test_duplicate_device.js` | `E2D88AD4361B746BF63128EB33DB9E35F24E8CE510133518CB5CE7DC17D967BC` |
| `northbound/entry/src/main/ets/model/DeviceModel.ets` | `50C7BCC17FE8A0E84BC8F17874492F68291EEED7744918AF9D2109610773E30D` |
| `vision/fall_detector.py` | `EAE6F7C8A99FBA870FB8ABB74FC2A2D14660A732AB676BA1E2F65D4258DD113D` |
| `vision/yolo_pose_service.py` | `7E8DF471C48409AED589487027FD1590B3F8622541CF4E30F92D6378489679C8` |
| `vision/evidence_uploader.py` | `FD5F4F462859D4A555655715072FC696F00048B07FF0EDF1224461F3BC242D4D` |
| `vision/test_evidence_uploader.py` | `ADD3B0F3AD6D24F0210DCBFD5FD01F3A6F190BD15A388220BC4F35E0A2848B27` |
| `vision/test_fall_evidence.py` | `2222C30EAD290E9E14DC2E7AEE258619E96480B0BC9DB86AB1254DA9FD47B89B` |
| `vision/test_frame_ingest.py` | `A57B25A6FC525F7139D4D1BD4E16C6D969F01D790ED0A3E2AE41AF177D0E5C97` |
| `vision/acceptance_fall_stub.py` | `946777897FFFC46D64142F598208A974BDE504B4AA4FDCE540C7FB5004905649` |
| `vision/test_frame_watchdog.py` | `063DB63A5211D86CFE1C9897CDAA30C133DC20B312EA58854732B20BCDE0F251` |
| `vision/test_yolo_pose_service.py` | `FD6C968FC33856FA78FAA380C3B7409717C8F33266E656230EFF2BA0E879CD44` |
| `vision/start_dayu_usb_vision.cmd` | `B73287FC5299139C3A6E39D4AFBB8ABA5252A8960588CE22F821B73F985662F8` |
| `vision/start_dayu_usb_guard.cmd` | `7A290B47E660B8137BA35113246B088B9E98885308A54EC4D856C652EAB206F3` |
| `vision/requirements-pc.txt` | `F4C6B7B21A207A4E0E29268BB34845930655D60EEAD3F72BDA981FF73AD8B455` |
| `cloud/onenet/cloud-sync.js` | `5A67F3B3A39BAC55729492B153FFA131DA1275D80F6906AB1F5D62FCD112B412` |
| `cloud/backend/src/store.js` | `4CBBE16AF8B15BE41BADC060C2434C54B3E7CDD8F38971AE441DA4292BC3638D` |
| `cloud/backend/src/persistent-store.js` | `5136F816ED0CE748AAB8C62D024EA5130298E19D27A1167B2A613E0575CFEA55` |
| `cloud/backend/src/evidence-store.js` | `00E36802087A4B2C15BA776689CDD347374BFE0CBFDE05644A76A1572E03D818` |
| `cloud/backend/src/server.js` | `069B39B4395A925DC25C809ACC699F906601A8F7BE9404CE9069C197C6B7DBEF` |
| `mobile/wechat-miniprogram/services/api.js` | `CF751176BCAC18428D5445BE5A8D066BD1BA5DA0635C21D22DC4E06C43554842` |
| `mobile/wechat-miniprogram/utils/validators.js` | `5F09A3D88CC78AA1AD542AEFA05A736FE83881DA3CAF896C30925B6848B5432E` |
| `mobile/wechat-miniprogram/pages/alarms/index.js` | `BACFE11A2A7BCAA0002BAA5C61992C8AED0FF2BFDF9B2D38214C71EC779BC2FD` |
| `esp32-node/main/node_main.c` | `307FA68182D61AF833A8FA7463AAD93E8B0F84CE23D874AD64A4B58B3CD28F17` |
| `esp32-node/sdkconfig` | `C399CB22B86D9221B9934E71BE87C689771040F0D94AE15A95F950E53FE814AC` |
| `esp32-node/sdkconfig.defaults` | `C14E45AC269FE92C5D07DB30F9B5E0CB585367D1819A50B26125B1643DBABADA` |
| `esp32-node/flash_esp32.ps1` | `63F73C0CE94DE279A49D10F8D783CB0143C0F9476DE4E5A64F6A81072A572460` |
| `materials/demo_start.ps1` | `BEE0C81182AB0CA45A1B9EEE3B03796BA2CF73675E0EC54AE2D17DB19F741646` |
| `materials/make_voice.ps1` | `1239E93A60AE93CCD1409A52DBFB7576E8606F8EA4462596849F84D02E1A31EB` |
| `cloud/onenet/gateway.js` | `E2E10446537591BD2B8726632B050936E15399C31D3C3805FFA8089A50246F43` |
| `cloud/onenet/gateway.test.js` | `4E3AD08ADE95469EE114F1D65289AB366FEDCEFB30B8416DE21B845242095A93` |
| `cloud/onenet/gateway-local-integration.js` | `4C5B8C0C4B2C4E8143F19F2BB4678553A1BEF3A810D250E33F0D0A52371D8EDE` |
| `cloud/onenet/real-device-harness.js` | `8F57BB43326C2FF2C12A783C876792298FEB128ED2748BB5EBDC33F0E6827BF0` |
| `cloud/onenet/real-device-acceptance.ps1` | `88B58611FD7E7141ADBDA1079732687AFAEAF91A82AEB9F665FC6A29BF098012` |
| `cloud/onenet/real-device-reset-acceptance.ps1` | `52D0E518B5BDFC1CE224A0E01440805A891151F9F87658894125175E227DCB26` |
| `cloud/onenet/gateway-toctou-check.js` | `7D3DB73A409338F49AB858D19DBCBDA99ACC616273F259CC9C295E546D5D8F22` |
| `cloud/onenet/tls-live-check.js` | `1D711E798B3FFD60F8E60A4A8B25CEDA7F38B461CC5AE7DBD87B30BF9199B2DE` |
| `cloud/onenet/cloud-sync.js` | `5A67F3B3A39BAC55729492B153FFA131DA1275D80F6906AB1F5D62FCD112B412` |
| `cloud/onenet/cloud-sync.test.js` | `F1BCCBE95691CF2E2797DB66015E52BB12F90204D7EBBC98A6772301E924CBA4` |
| `cloud/onenet/cloud-sync-integration.js` | `470D693F3EEC6819E578AFB8295C6CAEC11697411DA87C527085A2B4B0B3EFF0` |
| `materials/device-preflight.ps1` | `6F76371B7C367727E78657A45EA8E77B8FA4EFA574F52A48693A1CA526AC7404` |
| `cloud/onenet/package.json` | `570ADC7AD20DCDA82A62A4A21947658AC6D2B8F8CA9F01ED4014D7A578EAD5C9` |

## 3. 脚本版本边界

| 版本 | 文件 | SHA-256 | 说明 |
|---|---|---|---|
| 2026-10-09 文档基线 | `materials/demo_start.ps1` | `29466510C4BB6B0BBAC5251636C9BFD7B72DBE3E6E6F02CEFDC3BC5D55569976` | 旧文档记录，不能代表第三轮脚本 |
| 2026-10-10 加固前 | `materials/demo_start.ps1` | `3FC93B7E632BDF954E8FE602B787947C229114E96D941C83E08BB4499864A4B3` | 见 `evidence/2026-10-10-script-hardening-static-review.txt` |
| 2026-10-10 静态复核冻结 | `materials/demo_start.ps1` | `00E032ADF42408682EF9696565804888D25EBDB62C8624C0C0ACD703CC1B5F2B` | 第三轮预检时版本；首次运行暴露 HAP 多行输出误判 |
| 2026-10-10 真机通过 | `materials/demo_start.ps1` | `3041764611938A921044C1169B4ACFE1AB91BD09A280A08A66EA1F9C9EFE6B1D` | 修复多行输出匹配后，`08-third-demo-start-retry.txt` 以 `EXIT_CODE=0` 收尾 |
| 2026-10-10 参数化版 | `materials/demo_start.ps1` | `604F9662F474C338BD75EE087F2955808AFBD0BA588877753744CFEC9C54DCC9` | 支持独立 `-BridgePort` / `-FportPort`；当时只完成 Parser 检查 |
| 2026-10-13 当前真机通过 | `materials/demo_start.ps1` | `BEE0C81182AB0CA45A1B9EEE3B03796BA2CF73675E0EC54AE2D17DB19F741646` | USB Connected 门禁、默认无浮空传感器、1800 秒阈值、独立端口与 PowerShell 7；整脚本返回 0 |
| 2026-10-10 加固前 | `materials/make_voice.ps1` | `16DD6FE8614FDF3CB509ADF90B25D4A281287B70C179C0C572C65585484DEFE2` | 见脚本静态复核证据 |
| 2026-10-10 静态复核冻结 | `materials/make_voice.ps1` | `F30ADBF789774B1588D3A11872784B7B2AD8DF813230641B6FC3BCDB4DFED192` | Parser 与无文件 FFmpeg 行为测试通过；真实文件测试随后暴露 `$Input` 自动变量冲突 |
| 2026-10-10 当前 | `materials/make_voice.ps1` | `1239E93A60AE93CCD1409A52DBFB7576E8606F8EA4462596849F84D02E1A31EB` | 改用 `$InputPath` 并保留 `-Input` 别名；真实 M4A 转换、格式探测和失败保护已通过 |

旧哈希用于定位历史证据，不能作为当前可执行脚本。第三轮真机 PASS 只绑定 `304176...`；
当前脚本的真机 PASS 绑定 `BEE0C8...` 和 2026-10-13 新证据。

## 4. ESP32 构建元数据

```text
ESP-IDF        v5.1.6-dirty
Target         esp32s3
Compiler       xtensa-esp32s3-elf GCC 12.2.0_20230208
Flash          2 MB, DIO, 80 MHz
App offset     0x10000
Partition      0x8000
Stable baud    115200
```

2026-10-13 因热点私网地址变化，仅更新 Bridge 主机地址配置并重新全量构建；业务源码未变。
当前固件已在本轮识别为 ESP32-S3 的 `COM12` 完成三段哈希校验烧录，并完成真实错误/正确/重复
ACK 与 DAYU UI 验收。最新证据见 `evidence/2026-10-13-esp32-final-ack.md`；此前基线证据仍见
`evidence/2026-10-10-final-esp32-and-bridge-hardening/`。COM 编号不是固定硬件身份。

## 5. 证据版本边界

`evidence/2026-10-09-local-route-integration/README.md` 记录的 `Index.ets` 哈希是：

```text
990023566A1EB4E89E17E9508E09547ACBAF11937FFE1A0F0D367971318FF82C
```

它与当前 `Index.ets` 不同。因此该目录的 8/8 结论可以覆盖当时的 Bridge、模拟节点和协议行为，但不能证明当前北向页面的真机行为。

第三轮 `evidence/2026-10-10-third-device-validation/00-preflight.txt` 记录的 `demo_start.ps1` 为 `00E032...`；同轮首次执行发现并修复安装输出数组误判，因此最终通过日志 `08-third-demo-start-retry.txt` 在文件头重新记录了 `304176...`。第三轮之后 Bridge、模拟节点、南向程序、ESP32 和启动脚本均有变化，第三轮结论不能自动覆盖当前版本。当前 Bridge 重连与最终 ESP32 证据已单独冻结。

## 6. 复核命令

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath <path>
Get-Item -LiteralPath <path> | Select-Object FullName,Length,LastWriteTime
```

任何源码或制品变化后，都应在新证据中记录新哈希；不要直接覆盖本文中的历史基线。


## 7. AI 语音问答制品（2026-10-31）

| 状态 | 文件 | 大小 | SHA-256 |
|---|---|---:|---|
| CURRENT | `evidence/2026-10-31-ai-voice/build/ai-voice-1.0.12-signed.hap` | 1422831 | `84862B0EC7553E4198021DDCC4682F31C197A3ADEAADCD8AD689D3D69F0A837F` |
| CURRENT | `evidence/2026-10-31-ai-voice/build/ai-voice-1.0.12-norpc.hap` | 1405567 | `2691B82DEADA556115BB84FDB9CFC6DBA732D02BEA4356D67744F9DBFA5A4823` |
| CURRENT | 厨房 ESP32-S3 `esp32_elder_node.bin` | 754800 | `78661EEFA03A219CF4063010F9040359270604B3D23A662E8F99BD1FA43AFA6D` |
| CURRENT | 卫生间 ESP32-S3 `esp32_elder_node.bin` | 754800 | `B8DBDE764B3602D146374763683B8BED0F14299C3D109E81345C21182FA36CC7` |

设备端 `/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap` 的 SHA-256 与
`ai-voice-1.0.12-signed.hap` 一致（`84862b0e...`），即 10 轮问答与音箱播报证据绑定该 signed HAP。
`northbound/signing/eldercare-signed.hap` 当前是另一份 1.0.0（2026-10-22，1 860 490 字节，
`1F2529C1...`）制品，**不是**本次 1.0.12 构建，引用时不要混用。

## 8. 老人自述安全 / 手机 APP / DAYU200 1.0.13（2026-11-01）

| 状态 | 文件 | 大小 | SHA-256 |
|---|---|---:|---|
| CURRENT | `../evidence/2026-11-01-elder-safe-app/dayu/dayu-eldercare-1.0.13-signed.hap` | 1414638 | `EDD3D56EA436F4C72A8687EA80F69118B8FA68EF96E2F68AF90A703145E01A99` |
| CURRENT | `../evidence/2026-11-01-elder-safe-app/dayu/dayu-eldercare-1.0.13-norpc.hap` | 1395012 | `F04ABD8636F6EC8EB395A22912F01F78EC0B6EC2FE30213773DCD6D33DEE0253` |
| CURRENT | `../evidence/2026-11-01-elder-safe-app/phone/phone-eldercare-v2-production-unsigned.hap` | 3663501 | `2AD22DBEA831EE476BB73BD9673A76185F43C11E6A48CF750AC24ED9687130C8` |
| LOCAL ONLY | `../evidence/2026-11-01-elder-safe-app/phone/phone-eldercare-v2-localstaging-unsigned.hap` | 3663497 | `27A9CA51A28DFEE8ECE0A38E16255AE361ED47928844D60C172EFC0CE2C3881C` |

DAYU200 设备端 `/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap` 的 SHA-256
为 `edd3d56e...`，与 1.0.13 signed HAP 一致，即本轮只读 AI 页截图绑定该制品。

手机 APP 两个包都**未签名**（沿用此前记录的模拟器安装方式）。生产包指向
`https://api.luxunacc.xyz`；localstaging 包指向 `http://127.0.0.1:18080`，
仅用于本地联调截图，**不得交付**。
