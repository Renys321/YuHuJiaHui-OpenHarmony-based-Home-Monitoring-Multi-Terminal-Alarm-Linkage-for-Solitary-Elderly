# 公网部署执行记录（2026-10-27）

## 1. 执行结果（用户在阿里云 Workbench 执行，输出回传）

```
[wearable-mqtt] 部署目录: /opt/eldercare/deploy
[wearable-mqtt] 已备份现有部署到: /opt/eldercare/deploy/backup/wearable-20261027T094324Z
[wearable-mqtt] 使用 Docker 网络: eldercare-public_public-edge
[wearable-mqtt] 已生成 /opt/eldercare/deploy/wearable.env (600)
[wearable-mqtt] 已同步源码到 /opt/eldercare/wearable
[wearable-mqtt] 容器健康状态: healthy
[wearable-mqtt] 自检通过: /healthz 200
[wearable-mqtt] 自检通过: 0.0.0.0:1883 可连接
[wearable-mqtt] 自检通过: 端口映射仅 1883/tcp
[wearable-mqtt] 自检通过: backend 仍在运行（同网络服务名 backend 可解析）
wearable-mqtt 安装完成（只新增 1 个服务，未改动 backend/caddy）
```

- 未重建 backend/caddy；既有 D/E、门磁 v7、健康评估部署保持不变。
- 备份目录：`/opt/eldercare/deploy/backup/wearable-20261027T094324Z`（含 compose/.env.deploy/容器状态，700/600）。
- 回滚命令：`bash /opt/eldercare/deploy/rollback-wearable.sh --backup /opt/eldercare/deploy/backup/wearable-20261027T094324Z`

## 2. 安全组

- 入方向新增：自定义 TCP `1883/1883`，源 `0.0.0.0/0`，描述 `wearable-mqtt`。
- 既有 22/80/443 规则未改动。
- 演示结束后建议删除 1883 规则（明文 MQTT，仅演示用）。

## 3. 公网连通性验证（Lead 本机）

```
tcp 47.76.70.118:1883 -> True
MQTT CONNECT clientId=wearable-sos-001 username=wearable-sos-001 -> CONNECTED ok
```

## 4. M100 侧连接确认（适配器 /status）

```
clients: [ { clientId: "wearable-sos-001", remoteAddress: "39.144.182.107",
             subscriptions: ["eldercare/wearable/sos-001/down"] } ]
```

## 5. 适配器最终计数（运行期快照，重启会清零）

第一次（联调中期）：
```
uplinks=44 hbReceived=17 sosReceived=13 sosDuplicates=9 deviceStatusOk=25 deviceStatusFailed=0
gpsMessages=10 gpsParsed=10 ackReceipts=3 commandResultOk=3 commandsPublished=12 commandPublishFailures=0
commandsIgnored=27（其他设备命令，已正确过滤） commandPollFailed=0 lastErrorCode=""
```

> 适配器每个 2 s 轮询后端命令队列，正确忽略其他设备的命令（`commandsIgnored`），
> 只处理 `deviceId=esp32-sos && command=ACK && status=PENDING`。

## 6. 运维命令

```bash
DEPLOY=/opt/eldercare/deploy
COMPOSE="docker compose -p eldercare-public --env-file $DEPLOY/.env.deploy -f $DEPLOY/compose.public.yaml -f $DEPLOY/compose.wearable.yaml"
$COMPOSE ps
$COMPOSE logs --tail=200 -f wearable-mqtt
docker restart $(docker ps -qf name=wearable-mqtt)
docker exec $(docker ps -qf name=wearable-mqtt) node -e "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.adapter,null,2)))"
```

## 7. 日志短码

`BAD_CREDENTIALS` / `CONNECT_REJECTED`：M100 账号或 Client ID 不匹配
`KEEPALIVE_TIMEOUT`：设备网络中断
`DEVICE_STATUS_POST_FAILED`：后端不可达/INGEST_KEY 错
`COMMAND_POLL_FAILED` / `COMMAND_RESULT_POST_FAILED`：命令链路问题（会自动退避重试）
`MALFORMED_JSON`：M100 上行出现非 JSON 内容（偶发，多为设备串口噪声/配置回包，已忽略不致命）
