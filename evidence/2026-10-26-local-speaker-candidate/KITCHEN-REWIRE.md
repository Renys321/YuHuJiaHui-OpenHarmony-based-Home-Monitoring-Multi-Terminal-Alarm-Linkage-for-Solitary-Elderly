# 厨房扬声器引脚重分配 — 2026-10-26

状态：已实现候选配置；未改实物接线、未烧录、未做真实 ADC/出声验收。厨房端口为用户确认的 COM5，卫生间 COM4，DAYU COM11。

## 接线分配

| 功能 | 原引脚 | 厨房语音候选引脚 | 处理 |
|---|---|---|---|
| MQ-5 已保护模拟信号 | GPIO9 / ADC1_CH8 | GPIO7 / ADC1_CH6 | 仅迁移这一根 ADC 输入信号线 |
| MQ-2 已保护模拟信号 | GPIO6 / ADC1_CH5 | GPIO6 / ADC1_CH5 | 保持 |
| AHT20 SDA/SCL | GPIO4 / GPIO5 | GPIO4 / GPIO5 | 保持 |
| 音频 MCLK/BCLK/LRCK/DOUT | 板载 GPIO3/46/9/10 | 板载 GPIO3/46/9/10 | 不改板载连线 |
| ES8388/XL9555 I2C0 SDA/SCL | 板载 GPIO41/42 | 板载 GPIO41/42 | 保持 |
| 传感器电源、共地、已有分压/限压 | 既有接线 | 既有接线 | 保持 |

GPIO7 不在当前厨房配置及已检查的 `30_music` BSP 端口占用中。ESP32-S3 ADC1 GPIO 与通道的关系是 GPIO = 通道 + 1；使用 ADC1，不引入 ADC2/Wi-Fi 争用。此为基于代码和 BSP 的核对，不代替实物排针检查。

厂商其他示例的外接 RGB 屏（B6）及摄像头（D3）会使用 GPIO7；当前厨房固件未启用这些功能，部署前仍需确认 IO7 没有被此类外设实际连接。GPIO7 不是对所有扩展板都通用的空闲口。

## 用户接线操作（固件切换前协调执行）

1. 先记录现有接线位置，再断开厨房板及 MQ 模块全部供电，避免带电拔插。
2. 确认板上丝印为 **IO7/GPIO7**；不是排针第七脚，不是标为 ADC 通道 7 的引脚。
3. 将原来接到 IO9 的 **MQ-5 已有分压/限压电路输出线** 移到 IO7。保留分压/限压电路、传感器供电和公共 GND。若线来自原始 AO 且没有确认限压，则停止，不把可能高于 3.3 V 的 AO 直连 ESP32。
4. 确认 IO9 已不再连接外部 MQ-5 模拟信号；该脚接下来用于板载 ES8388 LRCK，不能一线两用。
5. 接线与候选固件必须成对切换：旧固件仍读取 GPIO9，新候选读取 GPIO7。迁线后旧固件的 MQ-5 数据不可作为有效验收，不要在不匹配状态演示。

## 代码与构建入口

原 `profiles/kitchen.sdkconfig.defaults` 保留 ADC1_CH8，作为旧接线基线。新 `profiles/kitchen-voice-rewire.sdkconfig.defaults` 仅覆盖 MQ-5 通道为 6，并在 kitchen 和 voice overlays 之后加载。

本地占位配置编译命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\esp32-node\tools\build-voice-candidate.ps1 -Variant KitchenVoice
```

`KitchenListening` 变体另含启动诊断语音；本次仅承诺实际执行并验证的构建，不将未执行的变体写成通过。默认构建使用占位网络配置，**不能烧入现场**。厨房私有部署配置尚未准备或核对。

原 GPIO9 配置与语音同时开启仍由实际固件编译保护拒绝；GPIO7 新候选编译保护应通过。MQ-2/MQ-5 保持原始 ADC 表述及 4096 禁用报警阈值。

## 部署和回退边界

用户本条授权重分配引脚；未撤销此前“不烧录任何 ESP32”的边界。本轮不打开 COM5、不烧录、不移动实物线。部署需另获明确授权，并先核对芯片/MAC、实际分区及当前 Flash 备份。

新固件失败时，恢复原应用镜像并在断电状态将 MQ-5 线从 IO7 移回 IO9；旧固件和新接线不能混用。未改 Wi-Fi/AP、backend、设备绑定，也未触发真实 SOS/FALL/ACK/reset。

最终需要真实验证：MQ-5/MQ-2 ADC 有效及自然更新、AHT20、扬声器出声、重启恢复和自然链路。代码通过不代表这些已通过。

## 本轮已执行结果

- `KitchenVoice` 完整构建 exit 0；生成的 sdkconfig.h 确认 MQ-2 通道 5、MQ-5 通道 6、语音 enabled。
- 镜像 939,552 B（0xe5620），原 1 MiB factory 分区余 109,024 B，未改分区。
- SHA-256：`A2EB928616125F7119E693B4E75B267A04F3D8C5031738056505A24966FFB69C`。
- 该镜像使用占位网络配置，只用于本地构建检查，未部署。
- 主机告警 54/54、卫生间逻辑 54/54、原房间配置 3/3、新厨房配置 1/1、编译保护 6/6 通过。未打开串口。
