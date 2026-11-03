# 校验清单（2026-10-26 / v4）

状态图例：✅ 已通过（有证据） · 🟡 部分完成 / 已实现待实机 · ⛔ 未执行（有明确阻塞） · ⏸ 不适用

## A. 前置安全与身份

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| A1 | COM8 芯片/MAC/设备身份核对 | ✅ | `wifi:mode : sta (30:30:f9:08:76:84)`；基线与历次 chip_id 一致 |
| A2 | COM8 16MB 全片备份仍在且校验一致 | ✅ | `16777216 B`，SHA-256 `17D0EFAF…E5EA8E4`，本轮未重复读全片 |
| A3 | COM8 固件未被改动 | ✅ | 仍为 `D40990F7…920D19`（`build/flash-sos-gpio5-hl-COM8.json`） |
| A4 | 厨房烧录前身份核对 + app 分区备份 | ✅ | `build/identity-backup-COM5.json`；备份前 1,016,864 B = `446A5B87…E29167` |
| A5 | 只写 app 分区、不全片擦除、不改身份/网络 | ✅ | `flash-app.ps1` 固定 `0x10000`，`fullErase=false`，`Hash of data verified` |
| A6 | 未占用 COM4、未强杀任何并行会话 | ✅ | 卫生间全程只读（MQTT 状态观察），未开 COM4 |
| A7 | 报告/日志无密码、Token、`INGEST_KEY` | ✅ | 本目录检索无凭据 |

## B. 联网（判据 1）

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| B1 | COM8 通过真实 AP 取到地址 | ✅ | `sta ip: 10.127.130.91` |
| B2 | 连上真实网关 | ✅ | `已连接网关 10.127.130.179:9101` |
| B3 | 公网后端真实接收（非模拟） | ✅ | `[cloud-sync] OK device=esp32-sos … status=202`，`deviceTs` 与串口 `ts` 相同 |
| B4 | 长时间稳定（无栈溢出/重启） | ✅ | 734 s 连续运行，`STACK_FREE gateway-net=2696` |
| B5 | 未修改路由器 / 未更换家庭网络 | ✅ | 未做任何网络侧配置变更 |
| B6 | `reason=202` 根因定性 | 🟡 | 仅记录为“间歇性认证失败 + AP 侧瞬态限制”的观察，未强行下结论 |

## C. 定向两板播报（判据 2）

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| C1 | 唯一原始事件（来源 `esp32-sos`，`MANUAL_SOS`） | ✅ | 仅 `state=ALARM ∧ type=MANUAL_SOS` 触发派发（`sosFanoutObserve`） |
| C2 | 同一 `alarmId` 显式发给两个 deviceId，无 MQTT 广播 | ✅ | 逐台 `routeCommand()`；隔离测试 A1/A2/A3 |
| C3 | 重试/抖动/重复上报不新建事件、不新建 ID | ✅ | 隔离测试 A4/A5；设备侧单测 42 断言 |
| C4 | 一块离线另一块照常播报 + 逐目标记录 | ✅ | 隔离测试 B1/B2（`failed_offline` / `delivered`） |
| C5 | 重连后不重复触发声音 | ✅ | 隔离测试 D1；设备侧 `last_id` 去重单测 |
| C6 | 固定板不伪造本地 `MANUAL_SOS`/新 ID/新设备来源 | ✅ | `notice` 分支不改 `s_state/s_alarm_id/s_alarm_type`，不 `report()` |
| C7 | 保留本地 SOS 优先级 / stop / ACK / 离线本地告警 | ✅ | `NOTICE_BEGIN_LOCAL_ALARM` + `notice_yield`；原 `ack/stop/reset` 分支未改 |
| C8 | 环境告警不改成跨房间广播 | ✅ | 隔离测试 E1 |
| C9 | `notice` 不能被 MQTT 侧注入 | ✅ | 回归冒烟 H3 |
| C10 | 厨房板烧录并在线 | ✅ | `43C1183A…`；IP `10.127.130.168`，公网 202 |
| C11 | **卫生间板烧录** | ⛔ | 需用户授权（板上现为门磁候选固件，见报告 §6.1） |
| C12 | **两块板同时真实出声** | ⛔ | 阻塞于 C11 + D1（bridge 切换）+ 用户按键 |

## D. 共享服务与协议接入

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| D1 | bridge 定向扇出**启用到运行中进程** | ⛔ | 需用户批准维护窗口；`enable-sos-fanout.ps1` 已 dry-run 验证 |
| D2 | 不传参数时旧行为零变化 | ✅ | 回归冒烟 4/4 |
| D3 | 未重启/替换 broker(1883)、public-sync | ✅ | 仅 dry-run 探测 PID，未发信号 |
| D4 | APP / 后端 / public-sync 代码未改 | ✅ | 未打开写操作 |

## E. APP 与 ACK（判据 3、4）

| # | 项目 | 状态 | 证据 |
|---|---|---|---|
| E1 | APP 展示原始来源（`esp32-sos` / `随身求助`）与事件身份 | 🟡 | 只读代码核对：`ViewMapper.mapAlert` → `location=roomName`、`description=…· 设备 {deviceId}`；未实机 |
| E2 | 固定板不产生第二条告警（APP 不会多出厨房/卫生间求助） | ✅ | 设备侧不 `report()` 新告警 |
| E3 | 用户 ACK → 同一事件回 COM8 | 🟡 | 隔离测试 G1 证明 `home/esp32-sos/cmd` 的 `ack` 能路由到来源节点；真实 ACK 待用户 |
| E4 | 用户 ACK → 两板停止播报（`noticeack`） | 🟡 | 隔离测试 C1~C4；真实效果待 C11/C12 |
| E5 | ACK 只代表“已收到”，不代表“人已安全” | ✅ | 设备日志、bridge 日志、报告与代码注释统一措辞 |

## F. 交付物

| # | 项目 | 状态 |
|---|---|---|
| F1 | 报告 `REPORT.md` | ✅ |
| F2 | 变更清单 `CHANGELOG.md` | ✅ |
| F3 | 接线说明 `WIRING.md` | ✅ |
| F4 | 固件身份与 SHA-256（见 REPORT §5.4） | ✅ |
| F5 | 必要日志与测试产物（`verify/`、`build/`） | ✅ |
| F6 | 独立供电（电池/移动电源） | ⛔ 用户侧 |
| F7 | APP 实机安装 | ⛔ 未安装（按约束不装含 D/E、CAMERA-A、门磁的包） |

## G. 复现命令

```powershell
# 设备侧纯逻辑单测
cd <WORKSPACE>\competition\esp32-node\test
gcc -std=c11 -Wall -Wextra -Werror -I..\main host_notice_logic_test.c -o host_notice.exe; .\host_notice.exe

# 隔离集成测试（独立端口 18830/9111，不碰生产）
cd <WORKSPACE>\competition\evidence\2026-10-26-wireless-sos-button-final
D:\Node\node.exe tools\sos-fanout-isolated-test.js --work-dir verify\fanout-isolated

# 旧行为回归（独立端口 18831/9112）
D:\Node\node.exe tools\bridge-regression-smoke.js --work-dir verify\bridge-regression

# 切换运行中 bridge（默认 dry-run；加 -Confirm 才真的切换）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\enable-sos-fanout.ps1
```
