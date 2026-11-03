# BATHROOM-LOCAL-VOICE 构建与镜像清单（2026-10-26）

本文件只含大小、哈希与配置项；固件本体含网络配置，仅存在于私有目录
`esp32-node\.local\bathroom-voice-20261026\build\`，不进入可分发证据。

## 源码快照

- 独立工作副本：`esp32-node\.local\bathroom-voice-20261026\src\`（从公共树复制，
  另有本地补丁，见 `bathroom-voice-volume30.patch`）。
- 公共树本轮未被本任务修改；盘点见 `build/PUBLIC-TREE-HASHES-AFTER.txt`。
- 冻结源码哈希见 `build/SOURCE-HASHES.txt`（初始快照）与
  `build/SOURCE-HASHES-USED-v30.txt`（最终音量候选使用的快照）。
- 关键文件：
  - `main/local_voice.c` 公共版本 SHA-256 `472C89C2…B2FF`，
    卫生间工作副本（去掉 PCM /2）SHA-256 `B89B88B2…5999`。
  - `main/Kconfig.projbuild` 公共版本 `F66AE357…860A`，
    工作副本（音量范围 0..33）`941DAA4C…6D34`。
  - 新增 `profiles/voice-volume30.sdkconfig.defaults` `832A7FC0…C948`。

## 候选镜像（ESP-IDF v5.1.6，独立干净构建目录）

| 候选 | 构建目录 | 大小 (B) | SHA-256 | 主任务栈 | 音量 | BOOT_TEST |
|---|---|---:|---|---:|---:|---|
| V20 试听 | `build/listening-v20` | 1,040,096 | `83E1FE48D61B52A8C777C40638FA291A6F804FC22E2B14C86C29BD585A8A8350` | 8192 | 20 | y |
| V20 正常 | `build/normal-v20` | 933,040 | `A6ABAF56D7D1EEA873EBDD5B9B5C7DB202449F32E29E6265A4FF7F20066619B6` | 8192 | 20 | n |
| V30 试听 | `build/listening-v30` | 1,040,080 | `B0CF170E586D3CD53019FE35F42163B7B64391BFFB8AE42403CB1F4DC44FBD79` | 8192 | 30 | y |
| V30 正常 | `build/normal-v30` | 933,024 | `93C9A7A2786210EB312D53261D5653C0212536DB8952CC5B99C5629D03C5A11C` | 8192 | 30 | n |

- 实际主任务栈取自生成的 `sdkconfig` 和 `config/sdkconfig.h`，均为
  `CONFIG_ESP_MAIN_TASK_STACK_SIZE=8192`（不是只看 defaults 文件）。
- esptool `image_info --version 2` 校验：四个镜像 checksum/validation hash 均 valid。
- 应用分区：实测设备分区表 `factory app 0x10000 长度 1M`；
  最大镜像 1,040,080 B < 1,048,576 B，试听候选余量 8,496 B（约 0.8%）。
- 构建使用卫生间既有私有配置（编译器消费，不打印）：13 项非秘密部署键
  （deviceId/room/PIR/SOS/AHT20 I2C/蜂鸣器/MQ 关闭/无活动阈值等）与板上
  当前部署 `sdkconfig.bathroom` 逐项一致；Wi-Fi/网关地址未改动。

## 写入记录

- 只写应用分区：`write_flash --verify 0x10000 <bin>`，未使用 erase_flash，
  未写 bootloader/partition table/NVS。
- V20 试听：写入 1,040,096 B，`Hash of data verified` + `-- verify OK (digest matched)`。
- V30 试听：写入 1,040,080 B，`Hash of data verified` + `-- verify OK (digest matched)`。
- 日志：`logs/flash-listening.txt`、`logs/flash-listening-v30.txt`、
  `logs/flash-normal-v30.txt`。
- 最终安装一致性：写入 normal-v30 后独立读回 0x10000 起 1 MB，前 933,024 字节
  与 normal-v30 二进制逐字节相同；读回整段 SHA-256
  `6C4C2D0B289B97ED82BCEF89FDA98584967432C5081B3971B0B1359F53ADB5B1`
  （备份仅存私有目录 `backup/readback-app-normal-v30.bin`）。
- 设备实际 Flash 16 MB，但既有 bootloader/应用镜像头按 2 MB 配置运行（烧录前
  启动日志已证实），本轮保持该既有约定，未整片擦除或改 Flash 参数。
