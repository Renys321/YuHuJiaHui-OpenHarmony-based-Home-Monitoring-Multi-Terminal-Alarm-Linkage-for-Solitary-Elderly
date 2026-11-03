# 1.0.8 真机验收清单（Lead 安装后拍摄；不伪造告警）

设备：DAYU200 `450100445634303332012847942eca00`（720×1280）。
前置：mirror 运行中（`wearable-mirror/scripts/start-mirror.ps1`，`runtime/mirror-status.json` 里
`hasData=true`、`source=api`）；随身求助状态只能来自真实设备（需要真机按键/真实 ACK，**不得软件伪造**）。

采集方式（与基线一致）：

```powershell
$hdc='<WORKSPACE>\tools\hdc\hdc.exe'; $t='450100445634303332012847942eca00'
& $hdc -t $t shell 'uitest dumpLayout -p /data/local/tmp/after108.json'
& $hdc -t $t file recv /data/local/tmp/after108.json dayu-sos/banner-1.0.8/after/dayu-layout-after-1.0.8.json
& $hdc -t $t shell 'snapshot_display -f /data/local/tmp/after108.jpeg'
& $hdc -t $t file recv /data/local/tmp/after108.jpeg dayu-sos/banner-1.0.8/after/dayu-screen-after-1.0.8.jpeg
```

## 必拍

| # | 场景 | 成功标志 |
|---|---|---|
| 1 | 设备信息卡 | `APP 版本 1.0.8 · 2026-10-27 随身求助横幅可收起/关闭` |
| 2 | **无事件**（esp32-sos `state=NORMAL` 且无 10 分钟内事件）时任意房间页顶部 | **完全没有横幅**（原 1.0.5 的大红块消失，不占位、不遮挡房间内容） |
| 3 | 真实 SOS 触发后（ALARM） | 细长告警条（约 44px）：`!` + `随身求助 · 待处理 HH:MM` + `查看` + `收起`；非全宽大红块、低饱和浅红 |
| 4 | 点“收起” | 折叠为 40px 小胶囊（`!` + 文字 + `展开`），**不整条消失**；同时“随身求助” tab 出现红点 `●` |
| 5 | 点“查看” | 跳到“随身求助”tab；设备卡仍显示 来源/事件时间/告警状态/GPS 状态与定位时间/确认状态/最近上报（1.0.5 字段未回归） |
| 6 | 真实设备 ACK 后（手机 APP 确认→设备回执，`state=ACKED`） | 浅绿细条：`随身求助 · 已确认 HH:MM` + `×` |
| 7 | 点 ACKED 条的 `×` | 横幅完全消失；同一 alarmId 不再弹出（切页/等待心跳/重开 APP 后仍不出现） |
| 8 | 新的真实 SOS（新 alarmId） | 横幅重新出现（ALARM 细条），验证“新事件重显” |
| 9 | `收起` 后杀进程/重开 APP（同 alarmId 仍在待处理） | 保持小胶囊（preferences 持久化生效），tab 红点仍在 |
| 10 | 回归 | 客厅/厨房/卫生间页面、摄像头预览/拍照/暂停恢复、远程探望状态、PIR“未配置”文案、告警房间归属、房间节点 ACK 均正常；1.0.7 视频 Wi-Fi 能力未回退 |

## 另需（非截图）

- `runtime/mirror-status.json`（事件期间 phase/online/alarmId）。
- `hdc -t $t shell 'bm dump -n com.dsh.eldercare | grep version'` → `1.0.8 / 1000008`。
- 若重开 APP 测试，可用 `aa force-stop com.dsh.eldercare` 后从桌面/`aa start` 启动（不影响应用数据）。
