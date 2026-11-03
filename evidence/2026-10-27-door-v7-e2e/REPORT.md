# 门磁 schema v7 公网与 APP 闭环 — 交付报告

- 日期：2026-10-27（Asia/Shanghai）
- 范围：卫生间（`esp32-bath`）与厨房（`esp32-kitchen`）两个已接入门磁节点
- 证据目录：`competition/evidence/2026-10-27-door-v7-e2e/`

## 0. 逐项结论（严格区分层级）

| 层级 | 结论 | 依据 |
|---|---|---|
| **本地实现/构建/测试** | ✅ 完成 | 后端 v7：`npm run check` 0、全量 `node --test` **313/313**、门磁定向 26/26、v6→v7 兼容 8/8；镜像 `5a02edcf…`（242 MB）。网关 adapter 补丁：25/25（含 15 类非法格式）+ onenet 回归 141/141。APP 三轮构建测试：tsc 0、`node --test` **270/270**、Hypium **39/39**。固件两版：host 测试全过（bath 141/54 + door + adpcm；kitchen 141 + door + notice + adpcm）、JSON 形状 3/3 合法。 |
| **生产后端部署** | ✅ **已部署**（schema v7） | 生产容器 `RUNNING_IMAGE=sha256:5a02edcfaa42…3ccb9`、`HEALTH=healthy`、公网 healthz/readyz=200；匿名 `/api/v1/door-events`=401；迁移后 `schemaVersion=7`，`devices=8 / alerts=69 / safetyLogs=6` 原样保留，`doorEvents` 台账建立。 |
| **APP 安装** | ✅ **已安装 1.0.4（versionCode 1000004）** | unsigned 覆盖安装（1.0.1→1.0.2→1.0.3→1.0.4），`firstInstallTime` 始终未变、`appSignType=none` 未变；无卸载、无清数据、未换签名；CAMERA-A 已剥离；D/E 保留。 |
| **真实门磁端到端验收** | ✅ **通过（两节点）** | 两节点开/关事件经网关→v7 后端入库（`doorEvents` 26 条，`source=device-cache`、`timeSource=device`、设备隔离、seq 递增无重复）；APP 1.0.4 设备管理两卡片均显示门磁状态与“最近开关记录”；后端重启后记录仍在；离线窗口事件恢复后按序补传；APP 离线/无数据不显示成正常/关闭/0 条。 |

**未完成/受限项**：见 §7。

## 1. 开始前核对（只读）

| 项 | 实测 |
|---|---|
| 生产后端（部署前） | schema **v6**，容器镜像 `sha256:568b6193…b42f74`（D/E 发布版），devices 8、alerts 69、safetyLogs 6、无 `doorEvents` |
| APP（部署前） | `com.example.program_04` 1.0.1 / 1000001，`appSignType=none`，`firstInstallTime` 1792597207955 |
| 厨房固件（部署前） | `08FD7F21…2D0D`（PIR+门磁兼容版，只发旧两键）；门磁 seq=16，FIFO 待补传见 §6 |
| 卫生间固件（部署前） | `F56A5A64…258BEFC`（三合一兼容版，只发旧两键）；seq=22 |
| 共享文件 | 工作区 backend 已是 v7、APP 含 D/E+门磁+CAMERA-A；全部改动在隔离副本/最小补丁中进行，未整文件覆盖生产 D/E 行为 |

## 2. 后端 v7 发布

### 2.1 候选与测试（本地，隔离副本）

- 源码：工作区 `competition/cloud/backend`（v7）隔离副本 47/47 文件哈希一致；`npm run check` exit 0；`node --test` **313/313**；门磁定向 **26/26**；D/E 隔离 1/1。
- v6→v7 兼容 **8/8**：v6 快照可读 → 写入升 v7 → devices/alerts/safetyLogs 保留 → `doorEvents` 追加（seq 101/102，device 时间）→ 重启仍在 → 重传幂等 → 未来版本 fail-closed。
- 镜像：`eldercare-cloud-backend:door-v7-2026-10-27` = **`sha256:5a02edcfaa42db6360068ceb6b09b9c0fa53a9128caa698a0e73521a3813ccb9`**，242 MB；tar 61,754,880 B / SHA-256 `79f6586f58428779cb090060f8762f5bfbf18d7f683db276f6163601d55578ce`。
- 本地 smoke 21/21：healthz/readyz 200、匿名 401、登录后 door-events 200、扩展 v7 ingest 202 且生成事件、旧两键仍 202。

### 2.2 生产部署（主机侧）

| 步骤 | 结果 |
|---|---|
| 上传 tar | 主机 sha256 = `79f6586f…78ce` **一致** |
| 固定旧镜像 | 生产容器 Image = `sha256:568b6193…`，`OLD_MATCH_OK`；tag `pre-door-v7-20261027`；导出 `backup/image-pre-door-v7.tar.gz`，sha256 `9fe30135257a0833b8d9a27bfbed40965de9709b0b8b0930dc471c1c61579b5f` |
| 窗口开始 | `stop backend`（Caddy 保持运行） |
| 迁移前 schema | `{"schemaVersion":6,"devices":8,"alerts":69,"safetyLogs":6}`，`doorEvents` 不存在 |
| 整卷备份 | `backup/backend-data-20261027-015816.tgz`，sha256 `d20d3a13ecb271a93660f86b1915dbf4c4feae7a05c11304e755408f4acbd030`，tar 可读非空、mode 600 |
| 切 v7 | `RUNNING_IMAGE=sha256:5a02edcf…3ccb9`、`HEALTH=healthy`、`STATUS=running`；公网 200；匿名 door-events **401**；启动日志无异常 |
| 迁移后 schema | `{"schemaVersion":7,"devices":8,"alerts":69,"safetyLogs":6,"doorEvents":0}` → **v6→v7 成功，旧数据零丢失** |
| 回滚文件 | `deploy/compose.pin-pre-door-v7.yaml`（钉旧镜像）、旧镜像 tgz、数据卷 tgz |

## 3. 网关（public-sync）兼容补丁

- 根因：`cloud/onenet/adapter.js:153` 原 `requireExactKeys(door,['open','lastOpenTs'])` 拒收 v7 扩展字段。
- 补丁（2 hunk）：白名单扩为 `open,lastOpenTs,lastCloseTs,seq,events`；`open` 允许 `null`；`seq` 正整数、`events` 数组元素 `{seq,open,ts}`、上限 16、严格类型校验；旧格式输出不变。
- 应用：原文件备份 `deploy/adapter.js.before-door-v7`（sha256 `8F03E56F7AA02BAC8A9B43C29A8873296AC2C1958C44E76BDE2CB69AC21B5AF8`）；补丁后工作区文件 sha256 `9453A47DBEBA0E096F625AEAD134550E4EA08997FE1F117269499E0DE5CA64E5`；`node --check` 通过；验证脚本 23/23 实质检查通过（另 2 项“原文件应拒收”因文件已替换而失败，属预期）。
- 生效：重启 public-sync worker（supervisor 32356 保持，worker **32788→52676**，restartCount=1、state=HEALTHY），bath/kitchen/sos `status=202` 持续；**未重启 bridge/broker、未改公网入口**。
- 说明：public-sync 使用 backend-only transport（`publishProperty` 为空操作），**不向 OneNET 物模型上报**，因此“OneNET door 物模型未同步”对本闭环无影响（若启用 OneNET 网关需另行同步，已知限制）。

## 4. 两节点固件（v7 扩展字段）

| 项 | 卫生间 | 厨房 |
|---|---|---|
| 镜像 | `bath-v7-esp32_elder_node.bin` 1,011,648 B，SHA-256 **`56D9A8054EC6B1AA0FB19E5390D6744E55FD2B572DE722742A799F5C3A8CAA6B`** | `kitchen-v7-esp32_elder_node.bin` 1,022,480 B，SHA-256 **`0AA8144D87D76DF3E946FA81A493E67C050CEC8C86DAFC4AA1D8C3A3170E179B`** |
| 改动 | 仅 `report()` 门磁段恢复扩展 JSON（`open` 可 null、`lastCloseTs/seq/events`）；其余不动 | 同左；保留 PIR/MQ-2/MQ-5/语音/LED/KEY0 |
| 分区 | 1 MiB 余 36,928 B（4%） | 1 MiB 余 **26,096 B（2%，风险）** |
| 写前备份 | `COM4-app-before-door-v7-20261027.bin` 1 MiB 整段 `9406D407…`，前缀（1,011,312 B）**=`F56A5A64…`**（在板逐位一致） | `COM5-app-before-door-v7-20261027.bin` 1 MiB 整段 `55D46285…`，前缀（1,022,160 B）**=`08FD7F21…`**（在板逐位一致） |
| 写入 | 仅 app `0x10000`，`Hash of data verified`，`fullErase=false` | 同左 |
| 启动日志 | `door:{open:true,lastOpenTs:0,lastCloseTs:0,seq:22}`、202、无 REJECT、无栈溢出 | `door:{open:false,lastOpenTs:0,lastCloseTs:0,seq:16}`、202、无 REJECT、无栈溢出 |
| 记录 | `acceptance/flash-bath-v7-COM4.json` | `acceptance/flash-kitchen-v7-COM5.json` |

## 5. APP 发布（三轮覆盖安装）

| 版本 | HAP SHA-256 | 目的 | 安装结果 |
|---|---|---|---|
| 1.0.2 / 1000002 | `2D1A7268F9F7C6DAA6CD6B286473D6AECD5FF9A64D58328AF1DF36C7D5E8D56D` | D/E+门磁 UI（CAMERA-A 剥离） | 安装成功，发现门磁区块被能力表隐藏 |
| 1.0.3 / 1000003 | `933B0B4473D85E79646C441E2527200416FBDA562DEEAC746CED6BFDD9785996` | 能力表把厨房/卫生间门磁置为已接入 | 安装成功，厨房显示记录；发现只加载第一个门磁设备 |
| **1.0.4 / 1000004（最终）** | **`45FDCCD1E73A95CDEEE1CCE0C4F27627BB72A344444BEA4F652386CAD30D9E1A`** | 遍历所有门磁设备合并记录 | **已安装并验证**：两卡片均显示 |

- 每次均 `hdc install -r`（覆盖、不卸载），`firstInstallTime=1792597207955` 始终未变，`appSignType=none` 未变 → **未更换签名身份、未清数据**。
- HAP 内 CAMERA-A 字符串（`loadEvidence`/`evidence/content`/`image/jpeg`/`camera_fill`/`查看证据` 等）**全部不存在**；D（处置结果/安全日志）、E（活动报告）与门磁（门磁/最近开关记录/doorEvents/DoorEventView）符号存在。

## 6. 真实门磁端到端验收

### 6.1 事件台账（生产 `/data/backend-state.json`，`schemaVersion=7`）

验收后 `doorEventCount=26`，全部 `source=device-cache`、`timeSource=device`、设备隔离正确、seq 严格递增、无重复：

| 设备 | seq 范围 | 事件数 | 说明 |
|---|---|---|---|
| `esp32-kitchen`（厨房） | 17–27 | 10 | 开/关交替；含离线窗口内 24/25/26 |
| `esp32-bath`（卫生间） | 23–37 | 16 | 开/关交替；含离线窗口内 36/37 |

时间线示例（设备时间）：厨房 seq17 02:03:40.560 开 → seq18 02:03:42.750 关 → …；卫生间 seq23 02:03:51.807 关 → seq24 02:03:55.087 开 → …；两设备按各自 seq 连续、后端按接收顺序追加、eventId `dr-1..dr-26` 严格递增。

### 6.2 APP 展示（1.0.4）

- 厨房节点卡片：能力“门磁”已启用，`门磁 开启` + “最近开启/关闭 3 分钟前”+ **最近开关记录**（打开/关闭…，设备时间）；截图 `acceptance/screenshots/08-app-kitchen-card-1.0.4.jpeg`。
- 卫生间节点卡片：`门磁 关闭` + 最近开启/关闭 + **最近开关记录**（关闭/打开/关闭/打开/关闭，设备时间）；截图 `acceptance/screenshots/05-app-recovered.jpeg`。
- 两设备记录各最多 5 条、按 deviceId 隔离、按时间倒序。

### 6.3 后端重启持久化

| 时点 | doorEvents | 说明 |
|---|---|---|
| v7 刚部署 | 0 | 迁移完成 |
| 首次门磁验收后 | 9 | kitchen 17–20、bath 23–27 |
| 第一次重启（离线测试1，02:11:49 停 / 02:12:49 启） | 16（保留 9 + 新增 7） | 重启后旧记录**全部仍在** |
| 第二次重启（离线测试2，02:17:48 停 / 02:18:22 启） | 26（保留 16 + 新增 10） | 再次重启后旧记录**全部仍在** |

### 6.4 离线补传与去重（第二次测试为准）

- 后端停止窗口：`BACKEND_STOPPED 02:17:48` → `BACKEND_STARTED 02:18:22`；期间 public-sync 持续 `cloud-sync FAIL code=SYNC_HTTP_ERROR`（kitchen/bath/sos），恢复后 `18:12:50Z`（本地 02:12:50）与第二次的 02:20:4x 恢复 202。
- **离线窗口内产生的真实事件**（设备时间落在停/启之间）：
  - 厨房 seq24 02:18:10.850（开）、seq25 02:18:15.290（关）、seq26 02:18:19.730（开）
  - 卫生间 seq36 02:17:59.637（开）、seq37 02:18:07.347（关）
- 恢复后这些事件全部出现在 v7 台账（`source=device-cache`），**按 seq 顺序、无重复、无丢失**；此前 16 条原样保留。→ **断网/后端不可用期间的补传路径验证通过（窗口 34 秒，远小于固件 300s 缓存 TTL）**。

### 6.5 APP 离线/无数据语义

- 后端停止期间截图（`acceptance/screenshots/03-app-current-screen.jpeg`，02:20）首页显示 **“离线 · 显示上次数据 / 服务端错误，请稍后重试”**，未显示为正常或 0 条。
- 离线设备卡片（`acceptance/screenshots/06-app-kitchen-card-1.0.4.jpeg`）显示 **“离线 · 暂无数据 / 设备离线，且暂无历史读数”**，未把离线画成“正常/关闭/零事件”。
- 恢复后（`05`/`08`）刷新显示在线与真实门磁状态、记录。

## 7. 未完成/受限项（如实披露）

1. **厨房 8 条历史待补传事件在 v7 上线前已过期**：它们产生于 01:34–01:35，固件补传缓存 TTL=300s，v7 于 01:58 才上线；烧录后开机日志 `seq=16` 且状态无 `events` 字段（待补传=0），说明已按设计过期，**无法补传**。未伪造、未清空队列（固件 TTL 自然过期）；本次已用 02:17–02:18 的离线窗口事件验证补传路径。
2. **厨房分区余量仅 26,096 B（2%）**：后续不可再加语音素材/大字段。
3. **APP 能力表 PIR 不一致**：厨房 note 已写“PIR 已接入”，但 `motion` 能力项仍为 false → PIR 瓦片仍未显示（门磁不受影响）。如需显示 PIR 需另发 1.0.5。
4. **OneNET 物模型**：`thing-model.json` 的 door 仅定义 open/lastOpenTs；本闭环走 backend-only transport，未使用 OneNET 物模型（无影响）；若启用 OneNET 网关需同步扩容。
5. **历史未确认告警**：APP 首页仍显示约 40 条历史待确认告警（既有生产数据，多为早期遗留），本任务未自动 ACK/清除。
6. **DevicePage 门磁记录加载无自动化断言**（UI 层不在 Node/Hypium 覆盖范围），本项以 HAP 符号验证 + 真机截图为准。

## 8. 回滚凭据（不含秘密）

| 对象 | 凭据 |
|---|---|
| 后端旧镜像 | tag `eldercare-cloud-backend:pre-door-v7-20261027` = `sha256:568b6193b1400c188f6d39d8f3be55397106c743f4eec546fe8f4e1d16b42f74`；tgz `backup/image-pre-door-v7.tar.gz` sha256 `9fe30135…79b5f` |
| 后端数据（迁移前） | `backup/backend-data-20261027-015816.tgz` sha256 `d20d3a13…bd030` |
| 部署配置 | `deploy/compose.pin-pre-door-v7.yaml`（回滚启动：`docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml -f deploy/compose.pin-pre-door-v7.yaml up -d --no-build backend`） |
| 网关 | 原 `adapter.js` 备份 `deploy/adapter.js.before-door-v7`（sha256 `8F03E56F…AF8`）；回滚后需重启 public-sync worker |
| 固件 | 卫生间回刷 `COM4-app-before-door-v7-20261027.bin`（1 MiB，前缀 `F56A5A64…`）；厨房回刷 `COM5-app-before-door-v7-20261027.bin`（1 MiB，前缀 `08FD7F21…`） |
| APP | 覆盖安装方式升级，未保留旧包回滚路径；如需回退可用历史 HAP 覆盖安装（版本号需更高或同版本 `-r`） |

回滚注意：v7→v6 旧镜像**不能**直接读 v7 快照（`doorEvents` 未知字段会 fail-closed）；回滚必须恢复迁移前数据卷备份，会**丢失 v7 后产生的门磁事件**（26 条），需先留档。

## 9. 证据索引

| 文件 | 内容 |
|---|---|
| `backend/PREP-REPORT.md`、`backend/logs/`、`backend/evidence/` | 后端测试/兼容/烟测原始记录 |
| `backend/image/eldercare-cloud-backend-door-v7-2026-10-27.tar` | v7 镜像归档 |
| `backend/adapter-door-v7.patch`、`deploy/adapter.js.before-door-v7` | 网关补丁与原始备份 |
| `firmware/FIRMWARE-BUILD.md`、两份 bin、构建日志、`door-json-samples.jsonl` | 固件构建与 JSON 形状验证 |
| `acceptance/flash-bath-v7-COM4.json`、`flash-kitchen-v7-COM5.json` | 烧录记录（MAC 复核、hash verified、只写 app） |
| `acceptance/bath-v7-boot-20261027.log`、`kitchen-v7-boot-20261027.log` | 两节点启动日志（扩展字段、seq、202） |
| `acceptance/bath-door-e2e-live.log`、`kitchen-door-e2e-live.log` | 门磁动作串口采集 |
| `acceptance/screenshots/01–08` | APP 门磁展示、离线态、恢复态截图 |
| `acceptance/app-bm-dump-*.txt` | APP 安装前后版本/签名/首次安装时间 |
| `app/APP-BUILD*.md`、三份 HAP、`isolation-diff*.patch` | APP 构建、剥离、符号验证 |
| `SHA256SUMS.txt` | 本目录文件哈希清单 |
