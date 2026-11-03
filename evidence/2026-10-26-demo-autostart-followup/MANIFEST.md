# MANIFEST — followup

日期：2026-10-26
范围：冷启动、物理 USB 恢复、页面耗时字段核对。
无线节点用户另行调试，本轮排除；当前 1/1～2/2 不作为通过/失败条件。

## 交付/运行文件

- `materials\start-demo-all.cmd`
  - SHA-256 `A7BE5C158C81779C84ADB24F4E1D921EBE4B16734C4291852E12D7773A52BE64`
- `materials\demo-autostart\demo-autostart.ps1`
  - SHA-256 `3E639C47913FCEE7968E3785A3699A0B3B78618F7038F4D50503307518269F48`
  - 本轮修复：`Get-HomemonRunning` 改 `pidof homemon`，增加 15s 启动冷却，避免 HDC 抖动重复 homemon。
- `materials\demo-autostart\dayu\dayu_local_fall` `EF58405E…6BBF0A`
- model param `105F6E42…496C413`；model bin `5DF9BAA9…0E9DA537E1`

正式 HAP：`com.dsh.eldercare 1.0.2/1000002`，1,883,399 B，
`A696698A627CFEEE1EE90D4F94A3FAF49B4A2F1BB8A2D813CA3AD245324DAFFE`；
本轮未修改/未重装。

## 证据

- `REPORT.md`
- `ACCEPTANCE.md`
- `LATENCY-FIELD.md`
- `COLD-START-HANDOFF.md`
- `pre-ui.json` / `pre-ui.jpeg`：页面 `检测到人体 · 4909 帧 · 248 ms`
- `usb-before-uptime.txt`：拔插前 uptime 2526.69s
- `usb-unplug-targets.txt` / `usb-disconnected-state.json`：USB Offline、看护器 WAIT
- `usb-after-recovery.txt` / `usb-after-state.json`：重连后 app/inference/homemon、9200、事件
- `usb-after-watcher.log`：USB 恢复日志
- `recover.jpeg`：重连后应用页面
- `followup-now.json`：最终页面状态
- `hap-sha256.txt` / `preview-prefs.txt`
- `DELIVERABLE-SHA256.txt` / `SHA256SUMS.txt`

## 状态

- 无 P0 启动：**NOT TESTED**（用户选择稍后重启 PC）
- PC 重启后启动：**NOT TESTED**
- 物理 USB 纯通信：**FAILED**（拔插实际断电重启，uptime 2526→41.57s；不是纯通信）
- USB 断电重启后的自动恢复：**REAL PASS**（单实例 app/homemon/推理、fport、LIVE 帧）
- 页面耗时字段核对：**REAL PASS**（页面 ms 是抓取+JPEG+HTTP 往返，不是 inferMs）
- homemon 重复启动修复：已修复并在 USB 恢复后保持单实例；冷启动复验待做。
