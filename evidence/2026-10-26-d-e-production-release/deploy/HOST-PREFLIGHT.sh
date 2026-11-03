#!/usr/bin/env bash
# D/E 发布：生产主机只读预检（第 0 步）
# 本脚本只读：不 stop/restart/rm 任何容器，不写 /data，不打印 .env.deploy 内容，
# 不打印个人数据（只打印 schemaVersion 与条数）。
# 在主机上执行：  bash HOST-PREFLIGHT.sh 2>&1 | tee preflight-$(date +%Y%m%d-%H%M%S).txt
set -u
BASE="${1:-/root/OpenHarmony/competition}"
echo "===== 0. 时间/时区/主机 ====="
date -Is; timedatectl 2>/dev/null | sed -n '1,4p' || cat /etc/timezone 2>/dev/null
echo "BASE=$BASE"
echo "===== 1. 目录与部署文件存在性（不看内容） ====="
for f in deploy/compose.public.yaml deploy/Caddyfile deploy/.env.deploy; do
  if [ -e "$BASE/$f" ]; then
    stat -c '%n mode=%a owner=%U:%G size=%s' "$BASE/$f"
  else
    echo "$BASE/$f ABSENT"
  fi
done
echo "===== 2. docker 版本与容器 ====="
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' 2>&1
docker ps --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}'
echo "===== 3. 当前 backend 容器/镜像/卷 ====="
cd "$BASE" || { echo "CANNOT CD $BASE"; exit 1; }
BACKEND_CID=$(docker compose --env-file deploy/.env.deploy -f deploy/compose.public.yaml ps -q backend 2>/dev/null)
echo "backend_cid=${BACKEND_CID:-EMPTY}"
if [ -n "${BACKEND_CID:-}" ]; then
  docker inspect --format 'container={{.Name}} image_id={{.Image}} status={{.State.Status}} restart={{.RestartCount}}' "$BACKEND_CID"
  docker inspect --format '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{println}}{{end}}' "$BACKEND_CID"
  IMG=$(docker inspect --format '{{.Image}}' "$BACKEND_CID")
  docker image inspect "$IMG" --format 'image={{.Id}} created={{.Created}} size={{.Size}} tags={{.RepoTags}}'
  VOL=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$BACKEND_CID")
  echo "data_volume=${VOL:-EMPTY}"
  if [ -n "${VOL:-}" ]; then
    docker volume inspect "$VOL" --format 'vol={{.Name}} driver={{.Driver}} mountpoint={{.Mountpoint}}'
    echo "----- /data 列表（只读） -----"
    docker run --rm --user 0 --entrypoint sh -v "$VOL":/data:ro "$IMG" -c 'ls -la /data' 2>&1
    echo "----- 主快照结构（只打印 schemaVersion 与计数，不打印个人信息） -----"
    docker run --rm --user 0 --entrypoint sh -v "$VOL":/data:ro "$IMG" -c \
      'node -e "const fs=require(\"fs\");try{const d=JSON.parse(fs.readFileSync(\"/data/backend-state.json\",\"utf8\"));console.log(JSON.stringify({schemaVersion:d.schemaVersion,devices:Array.isArray(d.devices)?d.devices.length:typeof d.devices,alerts:Array.isArray(d.alerts)?d.alerts.length:typeof d.alerts,safetyLogs:Array.isArray(d.safetyLogs)?d.safetyLogs.length:typeof d.safetyLogs}))}catch(e){console.log(\"READ_ERR \"+e.message)}"' 2>&1
    echo "----- 活动文件（E） -----"
    docker run --rm --user 0 --entrypoint sh -v "$VOL":/data:ro "$IMG" -c \
      'if [ -f /data/activity-state.json ]; then stat -c "activity-file size=%s mode=%a owner=%U:%G" /data/activity-state.json; node -e "const a=require(\"/data/activity-state.json\");console.log(JSON.stringify({version:a.version,keys:Object.keys(a)}))"; else echo ACTIVITY_FILE_ABSENT; fi' 2>&1
  fi
fi
echo "===== 4. Caddy / 端口 ====="
docker ps --filter name=caddy --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}'
ss -lntp 2>/dev/null | grep -E ':(80|443|8080)\b' || netstat -lntp 2>/dev/null | grep -E ':(80|443|8080)\b'
echo "===== 5. 本地健康检查（从主机） ====="
for p in /healthz /readyz; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://api.luxunacc.xyz$p" || echo ERR)
  echo "$p -> $code"
done
echo "===== 6. 备份空间 ====="
df -h "$BASE" | sed -n '1,3p'
echo "===== 7. 其它卷 ====="
docker volume ls --format '{{.Name}}'
echo "===== PREFLIGHT DONE ====="
