# 2026-10-27 DAYU200 显示随身 SOS（task-3）— 交付证据

**结论**：PC 侧镜像服务 `competition/cloud/wearable-mirror/` 已实现并通过 37/37 单测；
DAYU 北向 APP **1.0.5**（versionCode 1000005）已构建、签名并通过 `hap-sign-tool verify-app`。
**安装与真机验收由 Lead 统一执行**（本目录不含安装后截图）。

## 目录

| 文件/目录 | 内容 |
|---|---|
| `README.md` | 本索引（含 Lead 执行清单） |
| `ROOT-CAUSE.md` | 根因证据：4G 链路不经过 PC/DAYU，本地链路从未出现 esp32-sos |
| `BUILD-RECORD-1.0.5.md` | 构建记录：版本、大小、SHA-256、签名/验签、构建源与备份 |
| `INSTALL-ROLLBACK.md` | 安装命令、回退包与回退命令、环境恢复步骤 |
| `DAYU-SOS-SCREENSHOT-CHECKLIST.md` | 修复后真机截图/布局验收清单（Lead 拍摄） |
| `CHANGES.md` | 代码改动清单与语义（APP / mirror） |
| `baseline/` | **修复前** 1.0.4 布局 dump + 720×1280 截图（含告警卡房间标签错误复现） |
| `root-cause/` | 本地 broker 状态快照、后端只读镜像状态（esp32-sos 在线）、DAYU 现场事实 |
| `build/` | 1.0.5 unsigned / norpc / signed HAP、verify-app 证书链与 profile、哈希 |
| `source-backup/` | 改动前 1.0.4 源码备份（Index.ets / DeviceModel.ets / DeviceCapabilities.ts / app.json5） |
| `mirror/` | mirror 单测输出（37/37 PASS）、start/stop 脚本自测、**真实 SOS 事件观察记录**（22:52:33 ALARM → 22:53:00 ACKED，只读 api 源，未注入 DAYU） |

## 交付物位置

| 交付物 | 路径 |
|---|---|
| PC 镜像服务（零第三方依赖） | `competition/cloud/wearable-mirror/`（README 见其目录） |
| DAYU HAP 1.0.5（签名） | `build/dayu-eldercare-1.0.5-signed.hap`（1,373,680 B / SHA-256 `7EE16A97…8849FDFF`） |
| 1.0.5 构建源 | `competition/experiments/dayu-eldercare-preview-integration-2026-10-25/`（与 1.0.4 同一工作副本） |
| 回退包（当前 1.0.4） | `competition/evidence/2026-10-27-battery-video-visit/dayu-1.0.4/dayu-eldercare-video-1.0.4-signed.hap` |

## Lead 执行清单（安装/验收）

1. **DAYU 当前已从 hdc 掉线**（2026-10-27 22:48 起 `hdc list targets` 只有手机模拟器，`fport ls` 为空；
   22:20 前 target `450100445634303332012847942eca00` 正常）。需重新连接 USB/HDC 后：
   - 覆盖安装：`hdc -t 450100445634303332012847942eca00 install -r <signed.hap>`（保留应用数据）；
   - 恢复房间链路 fport：`hdc -t 4501… fport tcp:9001 tcp:9000`；
   - 镜像是 tcp 通道时：`hdc -t 4501… rport tcp:9002 tcp:9002`（或让 `start-mirror.ps1` 自动建）。
2. 启动 mirror（当前批准的主路径 = `api` + `tcp`；relay 等 bridge/homemon 配合就绪）：
   `competition/cloud/wearable-mirror/scripts/start-mirror.ps1`
   启动后检查 `runtime/mirror-status.json`：`hasData=true`、`source=api`、`phase` 随真实事件变化。
3. 按 `DAYU-SOS-SCREENSHOT-CHECKLIST.md` 拍摄修复后截图/布局。
4. 验收通过后由 Lead 关闭 task-3；若验收发现问题，按 `INSTALL-ROLLBACK.md` 回退。

## 明确未做/需配合

- 未安装到 DAYU（按要求由 Lead 执行）、未清数据、未改签名信任链。
- relay 注入未对现网启动：需 bridge 新版本 `--relay-ignore esp32-sos` + homemon `MAX_CLIENTS=8`。
- `--source mqtt` 已实现但待 ECS 白名单加入镜像 clientId（见 mirror README §5）。
- DAYU 掉线导致无法在修复前重新抓取 `bm dump`/实时版本行，`baseline/` 中布局与截图已足以复现
  “告警卡房间标签跟随当前 tab”的缺陷（见 `baseline/` 与 `ROOT-CAUSE.md`）。

## 版本线（DAYU APP，同一构建源）

| 版本 | 内容 | 制品/证据 |
|---|---|---|
| 1.0.5 / 1000005 | 随身 SOS 显示（横幅/设备卡/GPS+ACK 语义）+ PIR 未配置文案 + 告警房间归属修复 | `build/`（本轮 task-3 交付） |
| 1.0.6 / 1000006 | 视频改走家庭 Wi-Fi（`VideoStreamServer` 0.0.0.0 + 私网白名单），非本目录交付 | `../2026-10-27-video-wifi/` |
| 1.0.7 / 1000007 | 视频帧率/分辨率质量可配（Lead 侧改动），未单独出 HAP 证据 | 活树源码（快照见 `source-snapshot-pre-task6-1.0.7/`） |
| **1.0.8 / 1000008** | **随身求助横幅可收起/关闭 + 去常驻 + 视觉整改（用户反馈修复）** | **`banner-1.0.8/`**（三件套+哈希+构建/签名/验签日志+改动 diff+截图清单） |

> 1.0.8 构建源 = `competition/experiments/dayu-eldercare-preview-integration-2026-10-25`
> （活树 1.0.7 现状 + 仅横幅局部改动；未改视频/相机/语音/房间 ACK）。
> 隔离副本 `competition/experiments/dayu-banner-1.0.8-2026-10-27/` 仅作逐字节备份，非最终构建源。
> 1.0.8 安装/回退命令与交互说明见 `banner-1.0.8/README.md`；真机截图清单见
> `banner-1.0.8/SCREENSHOT-CHECKLIST-1.0.8.md`。
