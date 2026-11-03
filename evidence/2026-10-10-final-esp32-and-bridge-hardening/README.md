# 最终 ESP32 固件与 Bridge 重连加固证据

记录日期：2026-10-10（Asia/Shanghai）

本目录冻结最终 `now_ms()` ESP32 固件的烧录输出、真实状态快照和当时的 Bridge/Broker 日志；同时记录同 `deviceId` 重连修复的自动化测试结果。历史证据不覆盖、不改写。

## 结论

- 最终 ESP32-S3 固件已完成构建并通过 COM9 以 115200 烧录，bootloader、应用和分区表均显示 `Hash of data verified`，随后硬复位。
- 最终状态快照中 `ts=1791609077775`、`lastActiveTs=1791608769555`，均为 13 位真实毫秒时间戳。
- Bridge 的同 ID 新连接接管、旧连接淘汰、非法 ID、连接改名和不同设备独立路由共 10 项断言通过。
- 最终固件上的 APP 发起 ACK、真实 PIR/门磁/蜂鸣器和实体扬声器听觉效果仍未验收，不能从本目录外推为通过。

## 最终制品

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `esp32-node/build/esp32_elder_node.bin` | 754800 | `AA6055B1692FE0F9538D444D745903AFD218CC4D5D8DCD816FDDA22F07FAA42C` |
| `esp32-node/build/esp32_elder_node.elf` | 8366356 | `F629F3BF35057FC557C1DF55AF031B5936B376BE8EC236804019BAC1BF822690` |

## 文件说明

| 文件 | 内容 |
|---|---|
| `final-flash-stdout.log` | 最终构建后烧录的完整标准输出 |
| `final-flash-stderr.log` | 最终烧录标准错误；为空 |
| `final-firmware-status.json` | 最终固件经 Bridge 落盘的 13 位毫秒状态 |
| `final-runtime-bridge.*.log` | 当时 Bridge 运行日志 |
| `final-runtime-broker.*.log` | 当时 Broker 运行日志 |
| `duplicate-device-results.json` | 同 ID 重连加固的 10 项自动化断言 |

## 证据边界

- ESP32 通过原始 TCP 连接 Bridge；MQTT 由 Bridge 发布，不是 ESP32 原生 MQTT。
- 串口历史记录显示的是 2.4 GHz `bgn`、20 MHz 链路，只能称为连接 2.4 GHz 兼容热点，不能声称实际使用 802.11ac。
- `serial-epoch-ms-final.log` 早于最终 `now_ms()` 源码和最终 BIN，仅保留为中间版串口证据；最终时间戳以本目录的状态快照和最终烧录制品为准。
