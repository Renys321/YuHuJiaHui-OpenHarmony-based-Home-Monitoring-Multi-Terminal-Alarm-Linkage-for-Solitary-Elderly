# P0 影响检查（P1-B，含现场异常与恢复）

检查时点：2026-10-25 02:16–02:21 CST（P1-B 收尾）。

## 1. 结论

**P0-A 核心链路可用；P0-B 在 P1-B 期间经历一次外部重启，当前已恢复可用，但冻结基线“同一 PID 26710 未重启”不再成立。**

- P1-B 技术结论：`POSE_VALIDATION_FAILED`（性能达标、真机姿态验证失败）。
- P0 当前状态：可用（fport 已重建、supervisor/worker/homemon 未动、模拟器/APP 已重新运行、三设备 202 继续）。
- 没有把 P0 分类为 `P0_REGRESSION_ABORTED`，因为收尾时 P0 已可用；但 P0-B 需要用户按原基线重新确认一次。

## 2. 发生的两个现场异常

1. **fport 丢失（已恢复）**
   - 收尾检查 `hdc fport ls` 为空、PC 9001 无监听。
   - 按 P0 文档既有恢复方式重建：
     `hdc -t 450100445634303332012847942eca00 fport tcp:9001 tcp:9000` → OK。
   - 重建后客厅 `dayu200-living` 自然 202 于 **02:17:26** 恢复；最终 l=352。

2. **模拟器/手机 APP 丢失后自动重启（外部触发，不是本任务启动）**
   - 收尾时 5555 无监听、`hdc list targets` 仅 DAYU、无 emulator 进程、`hdc tconn` 失败。
   - 随后 `Emulator` 进程于 **02:18:57** 重新运行（PID 67520），5555 重新 LISTEN；手机 APP `com.example.program_04` 于 **02:19:11** 以新 PID **5698** 运行；`hdc tconn 127.0.0.1:5555` 成功，两个 target 均在线。
   - 本任务没有执行任何启动/重启模拟器命令；无法确认外部触发者（系统/DevEco/用户），但重启事实已记录。
   - 结果：P0-B 当前可用，但**不是冻结时的同一运行实例**；原 PID 26710 不再存在。

## 3. P0-A 核心（仍可用）

- supervisor/worker：11872/50580，state `HEALTHY`，heartbeat 持续；lock=11872。
- Broker 1883：43624；Bridge 9101：47704；hdc 9001：43868（fport 重建后 LISTEN）。
- fport：`tcp:9001 → tcp:9000` 已恢复。
- DAYU homemon：PID 2449，SHA-256 仍 `0d243539…81e6`，未替换/未重启。
- 三设备 202：最终 k=333、b=355、l=352（02:21 快照），持续增长。
- PC 9200：NO-LISTEN（候选只绑 DAYU loopback；已停止）。

## 4. P1-B 动作影响

| 动作 | 影响 | 恢复 |
|---|---|---|
| 用户打开 DAYU 正式 APP 相机页 | 相机/CPU/温度占用；未改 APP | `aa force-stop` + kill 残留，当前 STOPPED |
| 候选监听 DAYU `127.0.0.1:9200` | 仅 loopback | SIGTERM 停止；无 LISTEN（仅 TIME_WAIT） |
| 候选 CPU/温度 | 320 推理约 1 核，55–59 °C | 停止后释放 |
| fport 丢失 | 客厅链路短暂中断 | 已重建，202 恢复 |
| 模拟器/APP 丢失 | P0-B 短暂不可用 | 外部自动重启；当前可用但 PID 变化 |

## 5. 明确未做

- 未启停/重启 Broker、Bridge、public-sync supervisor/worker、homemon、手机 APP。
- 未执行模拟器启动/重启命令；未安装/卸载 HAP；未改 APP/后端。
- 未做 COM/烧录、Wi-Fi/AP/DNS 修改、生产 MQTT/HTTP ingest、SOS/ACK/reset。
- 未覆盖 P0 ZIP/冻结证据；未读取/记录密钥。

## 6. 建议

1. 由用户确认模拟器/手机 APP 已按冻结基线恢复（当前新 PID 5698），重新做一次 P0-B UI/自动刷新冒烟。
2. 保持 fport 重建后的 `tcp:9001→tcp:9000`；若 USB 插拔后丢失，按既有方式重建。
3. P1-B 证据（性能/离线/姿态失败）可复用；P0-B 重新确认后再决定是否继续正式集成。
