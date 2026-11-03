# 2026-10-27 真实电量检测 + 手机远程视频探望 — 交付证据目录

先读 [`REPORT.md`](REPORT.md)（总报告）。

| 目录/文件 | 内容 |
|---|---|
| `REPORT.md` | 总交付报告：逐项结论（已实现/已构建/已部署/真实设备验收）、变更清单、测试回归、限制与回滚 |
| `CONTRACTS/` | 本轮冻结的两份契约：`VIDEO-VISIT-CONTRACT.md`、`BATTERY-CHAIN-CONTRACT.md` |
| `dayu-1.0.4/` | DAYU200 板端 APP 1.0.4（视频推流）：源码实现说明、签名/验签 HAP、构建与安装记录、真机实时帧样例与运行截图 |
| `video-ip/` | 手机 APP（模拟器 1.0.9）端到端视频验收：真实实时画面截图序列、加载/失败/重试/重连/退出停止证据、relay 与板端原始日志、Lead 独立 WS 客户端真实 token 帧统计 |
| `video-relay/` | relay 服务与 ECS 部署件交付报告：30/30 单测、真实 DAYU 探针/冒烟、鉴权 401、Caddy/compose 静态校验日志 |
| `app/` | 手机 APP 1.0.9：电量展示与视频探望页实现报告、tsc/502 测试/构建日志、HAP+SHA256、安装与 bm dump、模拟器截图、改造前源码快照 |
| `battery/` | 电量链路：Lead 硬件核验、`REPORT.md` 三态结论、`FIRMWARE-BUILD.md`（5 个固件构建与 bin 扫描）、BOM/接线表、校准与真实验收方案、固件/适配器/网关/后端测试日志、APP 电量 UI 实拍 |
| `../2026-10-27-real-capability-app/` | 上一轮 APP 1.0.8 / DAYU 1.0.3 基线证据（本轮回滚参照） |

环境：DAYU200 `450100445634303332012847942eca00`（OpenHarmony 7.0.0.38 / API 26）；手机侧 HarmonyOS 模拟器 `127.0.0.1:5555`；生产后端 `https://api.luxunacc.xyz`（本轮只读登录与 GET，无写入）。
