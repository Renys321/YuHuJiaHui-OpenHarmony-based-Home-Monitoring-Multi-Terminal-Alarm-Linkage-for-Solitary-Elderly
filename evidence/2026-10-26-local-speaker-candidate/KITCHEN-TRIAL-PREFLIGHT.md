# 厨房 COM5 语音试烧录：写入前准备

2026-10-26。用户最新“烧录试试吧”已授权本轮厨房试烧录。此前“不烧录”的约束在这一具体范围内已更新；不扩展到卫生间 COM4、COM8 或 DAYU COM11。

状态：备份和试听候选已准备；尚未写入。等待用户断电确认实物换线，不能在 MQ-5 仍接 GPIO9 时启动音频。

## 实际设备与回退

- COM5：ESP32-S3 rev v0.2，MAC `50:78:7d:16:ed:60`，与厨房冻结记录匹配；物理 Flash 16 MiB。
- 只读安全查询：secure boot 未启用，Flash 加密未启用；未修改 eFuse。
- 已完整读取 16,777,216 B，esptool exit 0，读取完成后自动恢复原固件运行。
- 备份私有位置：`<WORKSPACE>\competition\esp32-node\.local\speaker-backup-2026-10-26-com5\flash-before.bin`。
- 完整 Flash SHA-256：`7A0E9077C8C9B64313AF010BB23878F624B5464F841578865E459CC1069F9979`。
- 真实分区 MD5 通过：NVS `0x9000/0x6000`，phy_init `0xf000/0x1000`，唯一 factory app `0x10000/0x100000`。
- 本次提取的完整 1 MiB app 回退镜像保留在同一私有目录 `factory-app-before-1MiB.bin`，SHA-256 `AC6CCE540ED528C8F85F2D2EE22C3C7696F6C9099617FA732059A0F026349FC4`。
- 当前 app 的有效前缀与原冻结厨房镜像逐字节一致：782,496 B，SHA-256 `330D9CA6EF858B0A4043607CA2EB7E92125A9030F2D06B05DA1218B8CCE62938`。
- 原始 Flash、私有部署镜像都不复制到可分发证据目录，不扫描凭据字符串。

## 候选与实施

`KitchenListening -UseExistingKitchenConfig` 已构建成功，1,046,608 B，SHA-256 `E602AFBD14729153108E34A1AEB1126C392F0ED26654324B9F8C4D103038AF77`。原 1 MiB app 分区余 1,968 B，无需且不允许为此次试听改分区。

`KitchenVoice -UseExistingKitchenConfig` 常规候选也已构建成功，939,552 B，SHA-256 `5753D3D40C21B4C6FDD865FF3079AC454FAAC28E1F9119A249402A753B80F7C5`，余109,024 B。两份私有镜像均未烧录。试听镜像的 esptool image_info checksum/hash 校验通过。

仅让编译器消费既有厨房私有配置，不输出其网络凭据。非秘密配置确认：厨房身份、AHT20 GPIO4/5、MQ-2 ADC1_CH5(GPIO6)、MQ-5 ADC1_CH6(GPIO7)、语音音量15、启动试听开启、两路 MQ 阈值4096（报警未启用）。

1. 用户先切断厨房板和传感器全部供电，确认 IO7 空闲，将原 IO9 的 **MQ-5 已有分压/限压电路输出信号** 移至丝印 IO7，保留电源、共地和保护电路；IO9 必须脱离该信号。若没有确认保护电路，不直接将原始 AO 接入。
2. 用户确认完成并接回后，复核 COM5 身份；只写已验证的 app 地址 `0x10000`，保留 flash 参数，不写 bootloader、分区表、NVS，不执行整片擦除或构建末尾打印的全量 flash 命令。
3. 检查刷写校验、启动、音频初始化及用户听感。诊断台词“语音播放测试，设备未触发告警。”不产生告警。
4. 试听通过后切换不带启动试听的 KitchenVoice 私有镜像，复核 ADC/AHT20、重启、可用的自然链路。禁止通过手工 MQTT/HTTP ingest 或触发 SOS/ACK/reset 来凑验收。
5. 如果失败，恢复本次 app 备份，并协调用户断电将 MQ-5 信号移回 IO9。固件和接线必须成对回退。

## 写入前现场采样

备份完成后以不发送串口命令、不拉动复位线的只读观察器采样25秒，获得5帧厨房数据：设备时间前进、温度24.4–24.5℃、湿度58.2–58.4%、MQ-2原始ADC123→137、MQ-5原始ADC4095，两路valid=true，state=NORMAL。MQ-5已达ADC顶值，不代表浓度、ppm或燃气安全。

仅持久化白名单传感器字段，不保留原始串口日志。参见 `KITCHEN-SERIAL-BEFORE.json`。这些是旧固件基线，不能当作新固件回归结果。真实出声、换线后ADC和语音告警闭环均未验收。

PC只读端口检查：Broker1883、Bridge9101、fport入口9001正在监听。这是进程/端口事实，不替代本轮新固件自然链路验收。

旧 `DEPLOYMENT-PLAN.md` 是此前未授权的卫生间计划，保留为历史；本轮实际执行顺序以本文件为准。
