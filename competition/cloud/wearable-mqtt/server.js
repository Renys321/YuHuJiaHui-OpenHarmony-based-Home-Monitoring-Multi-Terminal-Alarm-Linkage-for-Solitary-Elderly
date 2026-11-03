#!/usr/bin/env node
'use strict';

/**
 * server.js — 容器入口（零 npm 依赖）。
 *
 * 部署时整个 wearable-mqtt 目录只读挂载到 /opt/wearable，
 * compose entrypoint 直接执行 `node /opt/wearable/server.js`；
 * 本文件只负责把入口指向 src/main.js，便于：
 *   1) 复用 ECS 上已有的 eldercare-cloud-backend:local 镜像（无需新镜像/Dockerfile 构建）；
 *   2) 挂载点与源码目录解耦（/opt/wearable 只读，数据写 DATA_DIR=/data）。
 */

const { main } = require('./src/main');

main().catch((error) => {
  const code = error && typeof error.code === 'string' ? error.code : 'FATAL';
  process.stderr.write(`wearable-mqtt: fatal: ${code}\n`);
  process.exitCode = 1;
});
