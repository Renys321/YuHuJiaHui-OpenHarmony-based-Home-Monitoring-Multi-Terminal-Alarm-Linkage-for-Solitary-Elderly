# MANIFEST

任务：DEMO-AUTOSTART（统一启动、DAYU 摄像头/本机人物检测自动启停与断线恢复）
日期：2026-10-26
状态：`DEMO_AUTOSTART_REAL_PASS_WITH_LIMITS`（P0 冷启动/三节点最终 2/3 等限制见 REPORT）

## 交付物校验

- `DELIVERABLE-SHA256.txt`：入口、看护器、推理二进制/模型哈希
- `SHA256SUMS.txt`：本证据目录全部文件哈希

## 正式 HAP（未修改、未重装）

- 包：`com.dsh.eldercare`
- 版本：`1.0.2 / 1000002`
- 路径：`/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap`
- 大小：1,883,399 B
- SHA-256：`A696698A627CFEEE1EE90D4F94A3FAF49B4A2F1BB8A2D813CA3AD245324DAFFE`

## 正式入口

- `<WORKSPACE>\competition\materials\start-demo-all.cmd`
- `<WORKSPACE>\competition\materials\demo-autostart\demo-autostart.ps1`

## DAYU 推理部署包（独立目录，不依赖 P1-B 偶然残留）

- `materials\demo-autostart\dayu\dayu_local_fall`
  - 3,102,112 B；SHA-256 `EF58405E2C930C476B80E520FE2BC61E86929D301CC65879023A1FBA556BBF0A`
- `materials\demo-autostart\dayu\models\320\model.ncnn.param`
  - 25,354 B；SHA-256 `105F6E42BB4B5151FFB17C6D78BCFF97B7419D98386DCC60143985F1E496C413`
- `materials\demo-autostart\dayu\models\320\model.ncnn.bin`
  - 11,508,260 B；SHA-256 `5DF9BAA9EE42DB00E408B59F5A707072B294DB1B0F38765B928FAB0E9DA537E1`
- 设备目录：`/data/local/tmp/dayu-demo-autostart-2026-10-26/`
- 参数：320 / `rotate=0` / `conf=0.7` / 4 threads / loopback 9200

## 交付文档

- `START-HERE.md`
- `REPORT.md`
- `RECOVERY-TESTS.md`
- `CURRENT-STATE.md`
- `ROLLBACK.md`
- `MANIFEST.md`
- `SHA256SUMS.txt`

## 本轮证据

- `runtime\demo-autostart.log`：看护器事件/恢复动作
- `runtime\watcher-state.json`：最新状态
- `runtime\demo-events-mid.jsonl`：稳定性中段事件
- `demo-stats.jsonl`：独立推理真实 summary（1320.9s、2.16 capture FPS、1.53 infer FPS）
- `stability-15min.csv`：15 分钟状态采样
- `final-summary.json` / `demo-current.jpeg`：最终 UI
- `formal-*`：预检/当前 UI
- `stability-start.json`：稳定性起始 UI
- `room-kitchen.json` / `room-bath.json` / `room-living.json`：房间隔离
- `ui-now.json` / `ui-now.jpeg`：正式应用相机卡片
- `p0-supervisor-state.json`：P0 supervisor 快照
- `SHA256SUMS.txt`：本目录文件校验

## 回退

见 `ROLLBACK.md`。正式 HAP 未修改；新增文件删除不会影响 P0/正式应用。
