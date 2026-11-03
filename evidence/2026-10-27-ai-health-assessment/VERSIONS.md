# 环境与版本

| 项 | 值 |
| --- | --- |
| 采集时间 | 2026-10-27（Asia/Shanghai） |
| 工作区 | `<WORKSPACE>`（无 Git 仓库，改动以文件哈希+备份留证；未覆盖 D/E、门磁 v7、COM4/5/8、M100/GPS 成果） |
| 操作系统 | Windows（PowerShell 5.1 / pwsh 均可用；DSH 会话最终文件策略 danger-full-access） |
| Node.js | v24.19.0 |
| npm | 11.17.0 |
| 后端 | `competition/cloud/backend`（CommonJS，Node ≥20） |
| 后端基线 | 已部署生产 v7 源码快照 `competition/evidence/2026-10-27-door-v7-e2e/_work/backend-src` |
| 后端测试基线 | 313/313（v7）；本次发布源码 **377/377** |
| APP | `APP/ElderlyCareGuardian`（HarmonyOS ArkTS，bundleName `com.example.program_04`） |
| APP 基线测试 | 300/300；本次 **368/368**；隔离构建副本 **338/338** |
| DevEco Studio | `D:\DevEcoStudio\DevEco Studio` |
| TypeScript（测试编译） | `tools\hvigor\hvigor\node_modules\typescript\bin\tsc`（4.9.5） |
| hvigor | wrapper `tools\hvigor\bin\hvigorw.bat`；构建环境 `DEVECO_SDK_HOME=D:\DevEcoStudio\DevEco Studio\sdk`、`JAVA_HOME=D:\DevEcoStudio\DevEco Studio\jbr` |
| 构建产物 | `entry-default-unsigned.hap` 2,980,999 B，SHA-256 `935A24CCB3FC4F71B30E569E87F1DD7C5BFB31DE1A207D1C09AC7B2B1D8B7C3D` |
| Docker | Docker Desktop 29.9.2（本地构建/冒烟用） |
| 生产后端镜像 | `eldercare-cloud-backend:health-2026-10-27`，image id `sha256:084ed3c3f9d203e379b735d3170103577c89393676e121beef4941e6d27bcd8e`，242,058,886 B |
| 生产前端入口 | Caddy（`https://api.luxunacc.xyz` → backend:8080，不改动） |
| 真机 | DAYU200，OpenHarmony `7.0.0.38`，UDID `DC3ABD0514880C60A274F7442EC3C068F4E3C2EE59F28D1BF2DD35CE49C0D54C` |
| DeepSeek | `https://api.deepseek.com/chat/completions`，model `deepseek-chat`，HTTPS，12s 超时，最多 1 次重试 |

## 未使用的环境（如实标注）

- 未使用微信小程序、OneNET 设备链路、固件/串口（COM4/5/8）、M100/GPS、CAMERA-A。
- 未运行 `hvigor test`（Hypium 需连接设备侧测试框架；设备签名策略阻塞安装，见 REPORT）。
- 未执行 `npm test` 原生命令（DSH 沙箱内 `node --test` 的每文件子进程会 `spawn EPERM`，统一改用 `node --test --test-isolation=none` 得到同等覆盖面）。
