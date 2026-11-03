# 可部署补丁包 — 一页纸（Lead / 用户 Workbench 执行）

**版本**：wearable-mqtt `1.0.1`（断连自愈修复）
**包**：`competition/deploy/wearable/release/wearable-reconnect-fix-v1.0.1.tar.gz`
**SHA-256**：`D118A41A8A2ECA8F6317C926DCF6FC70B07A1325F47917ECCC2E69B173A68C8B`
**大小**：90,027 B；37 个 tar 条目；解包副本 `npm test` = 49/49 通过（已本地验证）

> 本包不新建镜像、不改 backend/caddy、不重新部署公网后端；只升级 `wearable-mqtt` 一个服务的源码
> （源码只读 bind mount 到容器 `/opt/wearable`）+ 部署脚本。

---

## 0. 上传前自检（本机）

```powershell
Get-FileHash <WORKSPACE>\competition\deploy\wearable\release\wearable-reconnect-fix-v1.0.1.tar.gz -Algorithm SHA256
# 期望 D118A41A8A2ECA8F6317C926DCF6FC70B07A1325F47917ECCC2E69B173A68C8B
```

## 1. 上传（Workbench 文件面板）

把 `wearable-reconnect-fix-v1.0.1.tar.gz` 上传到 ECS 的 `/root/`。

## 2. 解包 + 校验（ECS，只读检查）

```bash
cd /root
sha256sum wearable-reconnect-fix-v1.0.1.tar.gz        # 必须与上面一致
mkdir -p /root/wearable-src
rm -rf /root/wearable-src/cloud /root/wearable-src/deploy
tar -xzf /root/wearable-reconnect-fix-v1.0.1.tar.gz -C /root/wearable-src
ls -l /root/wearable-src/cloud/wearable-mqtt/server.js \
      /root/wearable-src/cloud/wearable-mqtt/test/reconnect-recovery.test.js \
      /root/wearable-src/deploy/wearable/install-on-ecs.sh \
      /root/wearable-src/deploy/wearable/rollback-upgrade.sh
```

## 3. 升级（一条命令）

```bash
bash /root/wearable-src/deploy/wearable/install-on-ecs.sh --mqtt-user wearable-sos-001
# MQTT_PASS 默认从 /opt/eldercare/deploy/wearable.env 复用（600，不打印、不回显）
```

脚本会：备份 compose/env/**线上源码** → 同步新源码 → `up -d --force-recreate` → 健康检查 →
**容器内 `node --test` 回归测试 49 项全绿** → 打印 `version` 与断连自愈计数。

### 成功标志（逐条都要出现）

```
已备份线上源码: /opt/eldercare/deploy/backup/wearable-<时间戳>/wearable-src-before.tar.gz
容器健康状态: healthy
自检通过: /healthz 200
自检通过: 0.0.0.0:1883 可连接
自检通过: 端口映射仅 1883/tcp
自检通过: backend 仍在运行（同网络服务名 backend 可解析）
自检通过: 回归测试全绿（断连自愈 / 不代报 ACK / 不重复告警 / 离线语义）
wearable-mqtt 安装完成（只新增 1 个服务，未改动 backend/caddy）
```

> 回归测试是“强警告不中止”：若出现“回归测试未全绿（强警告…）”并打印最后 40 行，
> 安装仍会完成（容器已 healthy），但**不得直接演示**——先人工复核输出，必要时按 §4-A 回滚。
> 脚本最终汇总里会再打印一次 `容器内回归自检结果: PASS/FAIL`。

### 升级后确认（贴回给 Lead）

```bash
docker exec $(docker ps -qf name=wearable-mqtt) node -e \
  "fetch('http://127.0.0.1:8099/status').then(r=>r.json()).then(j=>console.log(JSON.stringify({version:j.version,link:j.adapter.link,device:j.adapter.device,counters:{offline:j.adapter.counters.deviceOfflineReports,parkedRecovery:j.adapter.counters.parkedRecoveryTriggers,resultOk:j.adapter.counters.commandResultOk}},null,2)))"
```

期望：`version=1.0.1`、`link.deviceAliveTimeoutMs=120000`、`device.online=true`（设备已上电时）。

## 4. 回滚（两条路，按需选）

```bash
# A) 升级回滚（回到 1.0.0，服务继续运行；推荐）
bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh \
  --backup /opt/eldercare/deploy/backup/wearable-<升级时打印的时间戳>

# 先演练不改动：
bash /root/wearable-src/deploy/wearable/rollback-upgrade.sh \
  --backup /opt/eldercare/deploy/backup/wearable-<时间戳> --dry-run

# B) 首次安装回滚（移除 wearable-mqtt 整个服务，回到“未安装”）
bash /opt/eldercare/deploy/rollback-wearable.sh \
  --backup /opt/eldercare/deploy/backup/wearable-<时间戳>
```

- 回滚保留数据卷 `eldercare-public_wearable-data`（seq/命令游标/最后已知设备状态）。
- 老版本代码会忽略新增的可选 `device` 字段，可安全回滚。
- 回滚后校验：`/healthz` 200、1883 可连、`version=1.0.0`（升级前版本）。

## 5. 需要用户/Lead 注意

- 升级会重建容器 → M100 MQTT 连接短暂断开并自动重连；**建议在没有未确认告警时升级**。
- 升级命令不要手输密码到 shell history（脚本默认复用 `wearable.env`）。
- 升级完成后才能做真实 4G 断连重启验收（见 `ACCEPTANCE-4G-CHECKLIST.md`）。
