# deploy/wearable/wearable-mqtt.Dockerfile
#
# ⚠ 默认部署**不使用**这个 Dockerfile（2026-10-27 Lead 决策）：
#   ECS 上已有 eldercare-cloud-backend:local（node:24-alpine 运行时），
#   compose.wearable.yaml 直接用该镜像 + entrypoint node /opt/wearable/server.js，
#   无需新建镜像/重新拉取，减少 Workbench 操作失败面。
#
# 保留本文件的目的：
#   1) 交付要求的基础镜像显式对齐（与 competition/cloud/backend/Dockerfile 的
#      `FROM node:24-alpine` 完全一致，任何情况下都不会拉取新的基础镜像标签）；
#   2) 若某天 ECS 上没有 backend 镜像，可手工构建独立镜像：
#        docker build -f deploy/wearable/wearable-mqtt.Dockerfile \
#          -t eldercare-wearable-mqtt:local competition/cloud/wearable-mqtt
#      （构建上下文 = cloud/wearable-mqtt；本目录的 Dockerfile 需能被该上下文引用时
#        建议先 `cp deploy/wearable/wearable-mqtt.Dockerfile competition/cloud/wearable-mqtt/Dockerfile`）
FROM node:24-alpine

WORKDIR /opt/wearable

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src

RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    DATA_DIR=/data \
    STATUS_HOST=127.0.0.1 \
    STATUS_PORT=8099

VOLUME ["/data"]
# 唯一对外端口：MQTT 3.1.1（用户名/密码鉴权）。
EXPOSE 1883

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.STATUS_PORT||8099)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
