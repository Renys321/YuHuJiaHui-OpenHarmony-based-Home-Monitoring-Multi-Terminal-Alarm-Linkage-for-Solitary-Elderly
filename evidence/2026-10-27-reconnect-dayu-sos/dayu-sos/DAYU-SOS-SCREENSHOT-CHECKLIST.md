# 修复后真机验收清单（Lead 安装 1.0.5 后拍摄）

设备：DAYU200 `450100445634303332012847942eca00`（720×1280）。
采集方式（与基线一致，只读）：

```powershell
$hdc = '<WORKSPACE>\tools\hdc\hdc.exe'; $t = '450100445634303332012847942eca00'
& $hdc -t $t shell 'uitest dumpLayout -p /data/local/tmp/after-layout.json'
& $hdc -t $t file recv /data/local/tmp/after-layout.json dayu-sos/after/dayu-layout-after.json
& $hdc -t $t shell 'snapshot_display -f /data/local/tmp/after.jpeg'
& $hdc -t $t file recv /data/local/tmp/after.jpeg dayu-sos/after/dayu-screen-after.jpeg
```

## 必拍清单

| # | 场景 | 成功标志 | 备注 |
|---|---|---|---|
| 1 | 任意房间 → 设备信息卡 | `APP 版本 1.0.5 · 2026-10-27 随身 SOS 显示 + PIR 能力契约` | 证明装的是 1.0.5 |
| 2 | 顶部房间标签 | 出现第 4 个房间 `随身求助`（镜像收到真实数据后） | mirror 运行且 `hasData=true`；无数据时不应出现假房间 |
| 3 | 选中“随身求助” | 卡片显示：来源 esp32-sos、在线/离线、告警状态、事件时间、`定位：…/暂无定位`、确认状态、最近上报、数据来源 | **无 fix 必须显示“暂无定位”，不得出现 0,0** |
| 4 | 任意其他房间 tab（如客厅）时发生/存在随身 SOS | 顶部全局“随身求助”横幅显示 来源/事件时间/GPS/ACK 状态 | 点按横幅跳到随身设备 |
| 5 | 随身 SOS 真实事件 → 手机 APP ACK 之前 | DAYU 显示“待处理（等待设备确认）”或“设备离线·待处理”，**不得**显示已确认 | 不提供本机 ACK 按钮 |
| 6 | 手机 APP ACK 且设备真实回执后 | DAYU 变为“设备已确认”，确认时间为真实 ACK 时间 | 若只点了手机确认、设备未回执，DAYU 仍应为待处理 |
| 7 | 同一事件持续/心跳期间 | 预警处置列表只有 **1 条**该 alarmId 记录 | 验证同 alarmId 不重复 |
| 8 | 客厅（无 PIR） | 实时状态/统计报告显示“未配置 PIR，无活动监测（不判定长时间无活动）” | 需 homemon 新版本上报 `sensors.motion.supported=false`；旧 homemon 回退为静态能力表 |
| 9 | 厨房/卫生间告警卡 | 房间标签取各自告警自身房间；**不出现**把客厅告警标成厨房/卫生间 | 基线缺陷回归项 |
| 10 | 既有功能不回归 | 客厅摄像头预览/拍照/暂停恢复、远程探望状态行（9301）、语音播报、房间节点 ACK 仍正常 | 1.0.5 未改这些路径 |

## 需要另外拿到的证据（非截图）

- `runtime/mirror-status.json`（mirror 运行中，`source=api`、`hasData=true`、`phase` 随事件变化）。
- mirror 日志：`runtime/mirror.log`（应只有脱敏配置；不得有用户名/口令）。
- `hdc -t $t shell 'bm dump -n com.dsh.eldercare | grep version'` → 1.0.5 / 1000005。
- 若使用 tcp 通道：`hdc -t $t fport ls` 中应有 `tcp:9002 tcp:9002 [Reverse]`。
- 如做断连/重连测试：停 mirror 再启动后，DAYU 不出现第二条同 alarmId 告警（重连补发当前状态）。

## 基线对照

修复前基线在 `../baseline/`：可见厨房 tab 下 `长时间无活动 · 厨房 · 20:23`（房间标签跟随选中 tab
的缺陷）且无“随身求助”房间。修复后同一位置应与 #8/#9 一致。
