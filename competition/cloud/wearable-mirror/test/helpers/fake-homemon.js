'use strict';

/**
 * 测试夹具：假 homemon（TCP 服务器）。只做两件事：
 *   1) 记录客户端写入的每一行（验证 `relay <json>` 格式与内容）；
 *   2) 可主动踢掉连接 / 关闭再重启（验证 mirror 自动重连与重连补发）。
 */

const net = require('node:net');

class FakeHomemon {
  constructor(options = {}) {
    this.port = options.port || 0;
    this.server = null;
    this.sockets = new Set();
    this.lines = [];
    this.stats = { accepts: 0, disconnects: 0 };
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.sockets.add(socket);
        this.stats.accepts += 1;
        socket.setNoDelay(true);
        let buf = '';
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          let index;
          while ((index = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, index).replace(/\r$/, '');
            buf = buf.slice(index + 1);
            this.lines.push(line);
          }
        });
        socket.on('close', () => {
          this.sockets.delete(socket);
          this.stats.disconnects += 1;
        });
        socket.on('error', () => { /* ignore */ });
      });
      this.server = server;
      server.on('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        this.port = server.address().port;
        resolve(this);
      });
    });
  }

  /** 关闭监听并踢掉所有连接（模拟 homemon 重启/网络断开） */
  close() {
    return new Promise((resolve) => {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      if (this.server === null) return resolve();
      const server = this.server;
      this.server = null;
      server.close(() => resolve());
    });
  }

  relayLines() {
    return this.lines.filter((line) => line.startsWith('relay '));
  }

  relayJson() {
    return this.relayLines().map((line) => JSON.parse(line.slice('relay '.length)));
  }

  clear() {
    this.lines.length = 0;
  }
}

module.exports = Object.freeze({ FakeHomemon });
