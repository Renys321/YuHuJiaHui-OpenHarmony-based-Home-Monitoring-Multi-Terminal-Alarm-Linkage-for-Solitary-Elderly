# 生产后端 D/E 部署成功记录（Step 4）

时间：2026-10-27 00:20–00:21 +08:00（维护窗口内）
执行方式：用户在其阿里云 ECS Workbench 会话中执行；因该会话会掉线，切换用 `setsid` 脱离会话执行，输出落盘到 `evidence-of-deploy/`。

## 切换前的可回滚状态（来自 Step 1/3-A）

- 旧镜像 tag：`eldercare-cloud-backend:pre-d-e-20261026` → `sha256:85e940478fec…c9f5c`（生产原在跑）
- 旧镜像归档：`backup/image-pre-d-e-20261026.tar.gz`（60 MB，sha256 `d9cc0d58…db698`）
- 升级前数据整卷备份：`backup/backend-data-20261027-001232.tgz`（sha256 `027d27e6…25c48`，`gzip/tar` 校验通过，mode 600）
- 升级前主快照：`schemaVersion=5 / devices=8 / alerts=62 / safetyLogs=undefined`；`ACTIVITY_FILE_ABSENT`
- 回滚覆盖文件：`deploy/compose.pin-pre-d-e.yaml`
- 当前宿主卷名（从容器解析）：`eldercare-public_backend-data`

## 切换执行

```
# 主机构建（从已校验归档，源码哈希 F82DA474…8526 一致）
eldercare-cloud-backend:de-2026-10-26
Image ID = sha256:568b6193b1400c188f6d39d8f3be55397106c743f4eec546fe8f4e1d16b42f74

# 钉镜像启动（--no-build，仅重建 backend 容器）
docker compose --env-file deploy/.env.deploy \
  -f deploy/compose.public.yaml -f deploy/compose.pin-de.yaml \
  up -d --no-build backend
→ Container eldercare-public-backend-1 Recreated / Started
```

## 切换后实测（`evidence-of-deploy/step4-*`、`post-*`）

| 检查 | 实测 | 判定 |
|---|---|---|
| 容器 | `eldercare-public-backend-1 \| eldercare-cloud-backend:de-2026-10-26 \| Up (healthy)` | ✔ |
| 运行镜像 | `RUNNING_IMAGE=sha256:568b6193b1400c188f6d39d8f3be55397106c743f4eec546fe8f4e1d16b42f74` | ✔ 与主机构建一致 |
| 健康 | `HEALTH=healthy`；公网 `healthz=200`、`readyz=200` | ✔ |
| 启动日志 | `eldercare cloud backend listening on 0.0.0.0:8080`、`Persistent state enabled`、`[notify] configured:false` | ✔ 无异常 |
| 主快照 | `{"schemaVersion":6,"devices":8,"alerts":62,"safetyLogs":0}` | ✔ v5→**v6**，设备/告警数据保留，D 台账字段已建立 |
| `/data` | `activity-state.json`（2,239 B，新建）、`backend-state.json`（32,959 B）、`evidence/` | ✔ E 第二份状态已生成 |
| Caddy | `Up 11 days`（未重建） | ✔ 未动 TLS/端口 |

## PC 侧上行链路（部署后，只读观察）

`public-sync-supervisor.log`（部署完成后）：
```
[cloud-sync] OK device=esp32-kitchen … status=202   （00:22:30 / 00:23:03 / 00:23:36 / 00:24:08 / 00:24:42 持续）
[cloud-sync] OK device=esp32-sos     … status=202   （00:22:20 / 00:22:50 / 00:23:21 / 00:23:55 / 00:24:26 持续）
[command-sync] POLL_OK path=/internal/v1/commands status=200 （每分钟）
```
→ 新 v6 后端正常接收设备状态；broker/bridge/public-sync 未被重启。
（旁注：`esp32-bath` 最近一次 202 为 23:31，bath 节点近期上行在本地 bridge 侧未持续发布——与本任务无关，已在其他报告记录为既有偶发问题。）

## 当前状态

**后端 D/E 已正式部署**（公网 API 为 v6）。回滚路径完整可用（旧镜像 tag + 旧镜像 tgz + 升级前数据 tgz + pin 覆盖文件）。
下一步：D/E 真实数据验收（APP 已更新到 1.0.1，unsigned 覆盖，数据保留）。
