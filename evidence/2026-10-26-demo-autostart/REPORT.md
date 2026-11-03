# DEMO-AUTOSTART 报告

日期：2026-10-26
入口：`<WORKSPACE>\competition\materials\start-demo-all.cmd`
分类：`DEMO_AUTOSTART_REAL_PASS_WITH_LIMITS`（不是无条件 REAL PASS）
继承基线：P0-A/Worker、P0-B、P0-C、正式 DAYU 1.0.2、P1-B 320 / rotate=0、conf0.7 候选。

## 1. 实现

```text
Explorer 双击 start-demo-all.cmd
  -> 单实例看护器 demo-autostart.ps1
  -> 检查/复用 P0（1883 + 9101 + supervisor HEALTHY）
       缺少时打开既有 start-demo-supervisor.cmd（密钥只在那个可见窗口输入）
  -> 识别 HDC target
  -> 检查/启动 DAYU homemon
  -> 检查/恢复 hdc fport tcp:9001 -> tcp:9000
  -> 启动/唤起正式应用 EntryAbility
  -> 部署并启动独立目录 P1-B 320（rotate=0, conf=0.7）
  -> 检查正式应用帧是否产生新推理事件
  -> 持续状态显示、单实例、重连和组件级恢复
```

不新增 Broker/Bridge/supervisor，不创建 Windows 服务/计划任务，不修改手机 APP，不重装/替换正式 HAP。

### 独立推理部署

- PC 包：`materials\demo-autostart\dayu\`
- 设备目录：`/data/local/tmp/dayu-demo-autostart-2026-10-26/`
- 启动参数：`--size 320 --rotate 0 --conf 0.7 --threads 4 --serve 127.0.0.1:9200`
- 启动方式：`setsid sh -c '... > log 2>&1 < /dev/null'`，避免 hdc shell 被常驻进程阻塞；Hdc 启动器由看护器限时回收。
- 事件/统计：设备 `evidence/demo-events.jsonl`、`evidence/demo-stats.jsonl`；不接生产 FALL 告警、不上传候选跌倒事件。
- 部署时按本地/设备 SHA-256 校验，避免依赖 `/data/local/tmp` 偶然残留。

### 状态与停止

看护窗口显示：

```text
P0=healthy target=OK app=active detect=running frames=LIVE nodes=3/3
```

- `S`：设置 `runtime\user-stop.flag`，停止本看护器拥有的推理，禁止自动反向拉起；
- `R`：清除停止标志并恢复；
- `Q`：只退出看护器，P0/应用/推理保留；
- 正式应用“暂停监护”被识别为 `app=paused`，推理停止；连续 65 秒观察无自动拉起；点“恢复监护”后恢复；
- UI 查询超时/未知时保持暂停，不再 `aa start`，避免 UI 读取失败导致反向拉起。

### 单实例与安全

- 命名 Mutex `Global\DayuDemoAutostart20261026`；
- 重复双击第二个窗口提示“复用现有看护器”后退出；
- 推理启动前检查 9200 和 `pidof`，只恢复本独立目录的进程；未知 9200 占用显示 CONFLICT，不强杀；
- 不使用历史 PID 作为身份；当前 PID 从设备进程/命令行动态获取；
- 不结束正式应用/未知推理；不删除仍有效的 P0 lock；
- DAYU 断开时使用有上限的 HDC 重启/退避，恢复后重建 fport。

## 2. 验收结果（截至本轮）

| 项目 | 结果 | 证据 |
|---|---|---|
| 一键启动（推理关闭、应用后台） | REAL PASS | 入口自动启动 9200、恢复 app、frames LIVE |
| 相机自动启动 | REAL PASS | 正式应用 EntryAbility、frames LIVE |
| 人物检测自动启动 | REAL PASS | 独立目录进程 + 9200 + 新事件 |
| 重复双击单实例 | REAL PASS | 第二窗口复用退出；仅 1 个推理 |
| HDC 掉线/重连 | REAL PASS（HDC server 重启模拟） | fport 自动重建、推理继续 |
| DAYU 正常重启 | REAL PASS | 自动 homemon/fport/app/推理；nodes 3/3 |
| 应用关闭重开 | REAL PASS | 应用新 PID，推理保持旧 PID |
| 推理异常恢复 | REAL PASS | 受控终止后新 PID、9200 恢复 |
| 用户暂停 | REAL PASS | 65s 无自动拉起；恢复后重启推理 |
| 三节点 | PARTIAL（本轮曾 3/3 并完成房间隔离；最终现场 2/3） | 页面全屋在线 3/3→2/3，节点自然波动 |
| 房间隔离 | REAL PASS（3/3 时） | 客厅有摄像头；厨房/卫生间“未配置摄像头” |
| 并行 15 分钟 | REAL PASS（稳定运行；实测 inferFps=1.53） | 见第 3 节，不声称维持 ≥2 FPS |
| 公网同步 | LOCAL/INHERITED（P0 HEALTHY） | 复用既有 supervisor/worker；未构造生产 202 |
| PC 冷启动 P0 | NOT TESTED | P0 已健康复用；未为造冷启动结束现有 P0 |
| 手机 APP | 未修改 | 继承基线 |

## 3. 15 分钟稳定性

观察窗口：2026-10-26 00:38:17–00:53:17；看护器未重启；`app=active`、`inference=running`、`frames=LIVE` 持续。

结束时对当前推理执行一次受控 SIGTERM，取得真实 summary：

```text
elapsedSec=1320.9（22.0 min，包含 15 min 观察窗口）
framesReceived=2851
framesInferred=2022
framesDropped=828
errors=0
inferMsP50=605 ms
inferMsP95=655 ms
inferMsMax=1394 ms
captureFps=2.16
inferFps=1.53
rssKb=63136（约 61.7 MiB）
tempC=52.5
fallConfirmedEvents=0
```

- 实测 **inferFps=1.53**，没有维持 ≥2 FPS；不把历史 ≥2 当作本轮结论。
- 推理在 SIGTERM 后由看护器自动重启（PID 19619，9200 LISTEN）；应用相机继续，最终 frames LIVE。
- 三节点现场 UI：观察窗口内一度 3/3；最终为 **2/3，仅客厅摄像头**。节点自然波动未被伪装成 3/3。
- P0 supervisor/worker：`HEALTHY`，restartCount=0；Broker 1883/Bridge 9101 监听。
- 正式应用检测辅助显示：`检测到人体 · 2694 帧 · 222 ms`（最终 UI 快照）。

结论：15 分钟稳定性/帧新鲜度/异常恢复 **REAL PASS**；性能按实测 1.53 inferFps 记录，**不写 ≥2 FPS PASS**。

## 4. 已知限制

1. P0 冷启动路径已实现（自动打开既有 P0 入口），但本轮未做 PC 重启，未真实执行无 P0 的第一次启动；P0 健康复用路径已实测。
2. 公网同步沿用既有 supervisor/worker；本轮只检查 P0 HEALTHY，不重新构造生产 202，不手工发布 MQTT/HTTP。
3. `conf=0.7` 是候选演示参数，不宣称普适精度或正式跌倒阈值。
4. 真实危险跌倒未测；候选事件不接生产告警。
5. HAP 未修改；正式页预览调节按钮位于相机卡片上方，页面滚动到完整按钮行后可见/可用；本机实测画面宽度 60%、高度缩放 130% 控件和暂停/恢复按钮。
6. 未创建 OS 级开机自启/Windows 服务；入口是用户双击脚本，符合本轮边界。
7. 最终三节点 UI 为 2/3（厨房/卫生间之一离线），未声称 3/3 通过；曾 3/3 时完成房间隔离。

## 5. 回退

- 入口/看护器为新增文件，不覆盖 P0 冻结制品；
- 停止方式：关闭看护窗口或按 Q；如需停推理，可在正式页暂停监护；
- 删除新增文件不会影响正式 HAP/P0；详见 `ROLLBACK.md`。
