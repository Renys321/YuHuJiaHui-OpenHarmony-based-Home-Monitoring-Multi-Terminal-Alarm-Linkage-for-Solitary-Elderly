# RECOVERY-TESTS

所有测试使用正式入口/正式应用真实帧；没有使用模拟帧、retained 或历史统计。

## A. 正常一键启动（warm component start）

前置：P0 supervisor/worker 健康；DAYU 1.0.2 运行；正式应用在后台；9200 推理关闭。

操作：双击 `start-demo-all.cmd`。

结果：

- 自动创建独立目录并部署 `dayu_local_fall` + 320 model（SHA-256 校验）；
- 自动启动推理，9200 LISTEN；
- 自动把正式应用带到前台，相机恢复；
- 状态：`P0=healthy target=OK app=active detect=running frames=LIVE`；
- 未重装 HAP、未修改 P0。

判定：REAL PASS（组件未全部运行状态下的一次入口启动）。

限制：P0 已健康，未做 PC 冷启动；P0 不存在时的自动打开逻辑是本地实现，本轮未真实触发。

## B. 重复启动

操作：在已运行看护器时再次启动同一入口。

结果：第二窗口输出 `An existing demo-autostart watcher is running. Reusing it; this window will close.`，6 秒后退出；只有一个看护器和一个推理实例；相机未被抢占。

判定：REAL PASS。

## C. HDC 掉线/重连

操作：重启 hdc server 模拟 HDC 断开（未拔 USB，避免设备侧进程被误判）。

结果：看护器检测 target 短暂不可用，未把离线当无人；恢复后重建 `tcp:9001→tcp:9000`，正式应用和推理继续；状态恢复 `frames=LIVE`。

判定：REAL PASS（HDC 层）；物理拔插 USB 未单独执行（用户未操作）。

## D. DAYU 正常重启

操作：用户正常重启 DAYU；PC 看护窗口保持，未手动执行命令。

结果：

- 看护器等待 HDC 恢复并重启 hdc server；
- 自动启动 homemon、重建 fport；
- 自动启动正式应用 EntryAbility；
- 自动重新启动推理（PID 2201，9200 LISTEN）；
- 状态恢复 `app=active detect=running frames=LIVE nodes=3/3`。

判定：REAL PASS。

## E. 推理异常恢复

操作：只对本看护器独立目录内的推理进程执行一次 `kill -TERM`（不使用未知 PID/整个 Job）。

结果：看护器检测 9200/进程缺失，启动新实例（新 PID、9200 LISTEN），正式相机/tracker 未重启；没有第二个常驻推理。

判定：REAL PASS。

## F. 用户主动停止与恢复

操作：正式页点“暂停监护”；观察 65 秒；再点“恢复监护”。

结果：

- 应用显示“自动监护已暂停/自动监护已停止”；
- 看护器状态 `app=paused detect=stopped frames=STOPPED userPaused=True`；
- 65 秒内没有自动拉起推理（修复了 UI 超时导致反向启动的问题）；
- 点击恢复后推理重启，状态恢复 running/LIVE。

另：看护窗口 `S` 设置 `runtime\user-stop.flag` 时同样禁止自动拉起；`R` 清除；文件停止路径已在无键盘窗口测试。

判定：REAL PASS（应用按钮路径）；S/R 键为同一停止标志实现。

## G. 15 分钟稳定性

观察窗口 00:38:17–00:53:17，看护器未重启；`app=active`、`inference=running`、`frames=LIVE` 持续。结束读取真实 summary：

```text
elapsedSec=1320.9
framesReceived=2851 / inferred=2022 / dropped=828
errors=0
p50=605ms / p95=655ms / max=1394ms
captureFps=2.16 / inferFps=1.53
RSS=63,136 KB / temp=52.5 C
fallConfirmedEvents=0
```

实测 inferFps=1.53，**不声称 ≥2 FPS**。判定：REAL PASS（稳定性），性能按实测记录。

## H. 房间隔离

三节点自然恢复 3/3 后：

- 客厅：显示“客厅摄像头”和预览；
- 厨房：显示“该房间未配置摄像头”“客厅摄像头仅在选中「客厅」时显示与控制”；
- 卫生间：同上；
- 无伪造节点、未借用客厅画面。

判定：REAL PASS（3/3 时）。**最终现场 UI 为 2/3**（一个无线节点自然离线），不得把最终状态写成 3/3；房间隔离逻辑仍成立，节点需用户检查供电/重连。

## 额外：正式应用关闭重开

操作：`aa force-stop com.dsh.eldercare`。

结果：看护器发现应用进程缺失，自动重新 `aa start`；应用新 PID 2621，推理保持 2201；相机恢复。判定：REAL PASS。

## 未完成/未测试

- PC 重启后的第一次 P0 冷启动（本轮 P0 已健康；未为造冷启动结束现有 P0）；
- 物理 USB 拔插（HDC restart + DAYU reboot 已覆盖同层恢复；如需严格 C 项可现场补拔插）；
- 真实危险跌倒、生产 FALL/ACK/SOS、手机 APP、OS 级开机自启（本轮边界）。
