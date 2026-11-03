# 公网部署（ECS）操作卡 —— wearable-mqtt

> 目标：在阿里云 ECS（47.76.70.118，与 api.luxunacc.xyz 同机）新增**一个** `wearable-mqtt` 容器，
> 提供带账号密码的 MQTT Broker + 转发适配器。**不重建 backend/caddy，不改既有 D/E、门磁、健康评估部署。**

## 0. 前置（一次性）

1. 阿里云控制台 → ECS → 安全组 → 入方向 → 添加：
   - 协议：自定义 TCP；端口：`1883/1883`；授权对象：`0.0.0.0/0`；描述 `wearable-mqtt`
   - 只放行 1883；**不要**放行 8080/9000/9001/9100/9101。
2. 本机部署包：`competition/evidence/2026-10-27-wearable-4g-gps-map/deploy/wearable-deploy.tgz`
   （SHA-256 `49D6C1EA3A37B27EE0395ABEAE1E34B1EA5B32537F2099533D6AAD0DCAABC4DC`，55,960 B）。

## 1. 上传并解压（Workbench）

使用 Workbench 文件面板把 `wearable-deploy.tgz` 上传到 `/root/`，然后执行：

```bash
mkdir -p /root/wearable-src
tar -xzf /root/wearable-deploy.tgz -C /root/wearable-src
ls /root/wearable-src/cloud/wearable-mqtt/server.js   # 必须存在
```

## 2. 一条命令安装

```bash
WEARABLE_MQTT_PASS='<强随机密码，见 competition/.secrets/wearable-mqtt.env>' \
  bash /root/wearable-src/deploy/wearable/install-on-ecs.sh --mqtt-user wearable-sos-001
```

脚本会：备份 `/opt/eldercare/deploy`（compose + `.env.deploy` + 容器/端口状态，700/600）→
探测 `public-edge` 网络真实名 → 从 `.env.deploy` 抽取 `INGEST_KEY` → 生成
`/opt/eldercare/deploy/wearable.env`（600）→ 同步源码到 `/opt/eldercare/wearable`（只读挂载）→
`docker compose -f compose.public.yaml -f compose.wearable.yaml up -d wearable-mqtt` →
自检 healthy / 1883 / `/healthz` / 端口边界 / backend 未动。

**成功标志**：输出包含 `容器健康状态: healthy`、`自检通过: /healthz 200`、
`自检通过: 0.0.0.0:1883 可连接`、`自检通过: 端口映射仅 1883/tcp`、`自检通过: backend 仍在运行`。

## 3. 手工复核（可选）

```bash
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep wearable-mqtt
# 期望：Up ... (healthy)，Ports 只有 0.0.0.0:1883->1883/tcp

docker exec $(docker ps -qf name=wearable-mqtt) node -e \
  "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log(JSON.stringify({broker:j.broker.clients,device:j.adapter.device},null,2)))"
```

## 4. M100 配置切换（由执行 AI 用串口命令完成，用户无需操作）

切换目标（写入后 `config,get,netchaninfo,1` 可核对）：

```
config,set,mqtt,1,uart,60,47.76.70.118,1883,wearable-sos-001,wearable-sos-001,<密码>,1,1,0,0,0,eldercare/wearable/sos-001/down,eldercare/wearable/sos-001/up,0,0,0,,,0,,0,0
```

- 通道1：MQTT 3.1.1、不加密、清理会话、QoS 0、心跳 60s
- 上行 `eldercare/wearable/sos-001/up`，下行 `eldercare/wearable/sos-001/down`
- 保存后**断电重启 M100，等 20~30 秒**（NET 约 1000ms 慢闪 + RDY 常亮）再进行下行测试
  （实测 M100 重启后需约 20~30s 才完成订阅）

## 5. 失败与回滚

```bash
bash /opt/eldercare/deploy/rollback-wearable.sh     # 只移除 wearable-mqtt，保留数据卷
# 或使用安装包内脚本
bash /root/wearable-src/deploy/wearable/rollback.sh
```

排障：

```bash
DEPLOY=/opt/eldercare/deploy
COMPOSE="docker compose -p eldercare-public --env-file $DEPLOY/.env.deploy -f $DEPLOY/compose.public.yaml -f $DEPLOY/compose.wearable.yaml"
$COMPOSE logs --tail=200 -f wearable-mqtt
```

日志短码：`BAD_CREDENTIALS`/`CONNECT_REJECTED`（M100 账号或 Client ID 不匹配）、
`KEEPALIVE_TIMEOUT`（网络中断）、`DEVICE_STATUS_POST_FAILED`（后端不可达/INGEST_KEY 错）、
`COMMAND_POLL_FAILED`、`COMMAND_RESULT_POST_FAILED`。

## 6. 演示期间注意

- **不要启动旧家庭网关** `cloud/onenet/public-sync` / `gateway`：其 command-sync 会抢领
  `esp32-sos` 的 ACK 命令（不做 deviceId 过滤），可能导致 30s 后回写 FAILED。
- 1883 为明文 MQTT（竞赛演示允许），仅暴露该端口 + 强随机密码；不放入生产长期使用。
