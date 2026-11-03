'use strict';

/**
 * ws 模块解析器。
 *
 * 开发机可以 `npm install ws`，此时优先用 node_modules 里的版本；
 * ECS 部署为了"不新建镜像、不在服务器上 npm install"复用了
 * eldercare-cloud-backend:local（只含 node 运行时），所以把 ws@8.22.0
 * 原样放在 vendor/ws（MIT，见 vendor/ws/LICENSE）作为兜底。
 *
 * 两条路径加载的是同一份 ws 8.22.0，行为一致。
 */
let WebSocket;
try {
  // eslint-disable-next-line global-require
  WebSocket = require('ws');
} catch (_) {
  // eslint-disable-next-line global-require
  WebSocket = require('../vendor/ws');
}

const WebSocketServer = WebSocket.WebSocketServer || WebSocket.Server;

module.exports = WebSocket;
module.exports.WebSocket = WebSocket;
module.exports.WebSocketServer = WebSocketServer;
