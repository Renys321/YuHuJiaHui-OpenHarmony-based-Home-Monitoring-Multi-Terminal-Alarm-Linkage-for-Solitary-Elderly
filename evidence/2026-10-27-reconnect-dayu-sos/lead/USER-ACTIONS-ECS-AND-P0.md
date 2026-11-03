# ECS 部署与 P0 重启 — Lead 给用户的操作清单（2026-10-27 23:05）

> 目标：① 升级 ECS 上的 wearable-mqtt 到 1.0.1（断连自愈）；② 重启 public-sync 让 ACK 设备白名单/有界熔断生效。
> 敏感信息：补丁包不含密钥；升级脚本默认复用 ECS 上 `/opt/eldercare/deploy/wearable.env`（600），不会回显密码。
> 回滚：命令见第 3 节。

## 1. ECS 部署（阿里云 Workbench，浏览器）

### 1.1 上传（本机 → ECS）
把本机文件：
```
<WORKSPACE>\competition\deploy\wearable\release\wearable-reconnect-fix-v1.0.1.tar.gz
```
（90,027 B；SHA-256 `D118A41A8A2ECA8F6317C926DCF6FC70B07A1325F47917ECCC2E69B173A68C8B`）
通过 Workbench 文件面板上传到 ECS 的 `/root/`。

### 1.2 解包 + 校验（Workbench 终端，复制粘贴）
```bash
cd /root
sha256sum wearable-reconnect-fix-v1.0.1.tar.gz
mkdir -p /root/wearable-src
rm -rf /root/wearable-src/cloud /root/wearable-src/deploy
tar -xzf /root/wearable-reconnect-fix-v1.0.1.tar.gz -C /root/wearable-src
ls -l /root/wearable-src/cloud/wearable-mqtt/server.js \
      /root/wearable-src/deploy/wearable/install-on-ecs.sh \
      /root/wearable-src/deploy/wearable/rollback-upgrade.sh
```
sha256sum 必须等于上面的值，否则停止并把输出发给 Lead。

### 1.3 升级
```bash
bash /root/wearable-src/deploy/wearable/install-on-ecs.sh --mqtt-user wearable-sos-001
```
成功标志（逐条出现）：
```
已备份线上源码: /opt/eldercare/deploy/backup/wearable-<时间戳>/wearable-src-before.tar.gz
容器健康状态: healthy
自检通过: /healthz 200
自检通过: 0.0.0.0:1883 可连接
自检通过: 端口映射仅 1883/tcp
自检通过: backend 仍在运行
自检通过: 回归测试全绿
wearable-mqtt 安装完成
```

### 1.4 升级后确认（把输出贴回 Lead，不含密钥）
```bash
docker exec $(docker ps -qf name=wearable-mqtt) node -e \
  "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log(JSON.stringify({version:j.version,link:j.adapter.link,device:j.adapter.device},null,2)))"
```
期望 `version=1.0.1`、`deviceAliveTimeoutMs=120000`。

## 2. 重启 P0（本机，可见窗口）

1) 找到现有标题为 `public-sync supervisor demo` 的窗口，按 **Ctrl+C** 或关闭它（只影响 P0，不影响 broker/bridge/DAYU）。
2) 双击 `<WORKSPACE>\competition\materials\start-demo-supervisor.cmd`。
3) 等预检通过，在隐藏提示 `Enter public backend INGEST_KEY ...` 输入一次 INGEST_KEY 并回车。
4) 保持窗口打开（可最小化）。
5) 成功标志：窗口出现 `[supervisor] HEALTHY`，本机日志出现三设备 `cloud-sync OK ... status=202`。

> 说明：新版本会先识别“state 写着 HEALTHY 但进程不在”的陈旧状态，并接管死 PID 留下的锁；homemon 哈希守卫已更新为 2026-10-27 修复版。

## 3. 回滚（万一）
```bash
# ECS：回到升级前版本（保留数据卷）
bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh \
  --backup /opt/eldercare/deploy/backup/wearable-<1.3打印的时间戳>
```
本机 P0：在 `public-sync supervisor demo` 窗口 Ctrl+C，再按旧入口启动即可（代码已备份 `.bak-20261027`）。
