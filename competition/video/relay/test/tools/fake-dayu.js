'use strict';

/**
 * fake DAYU200 VideoStreamServer（契约 §1 的测试替身，仅测试用）。
 *
 * 行为与契约一致：
 *   - 只接受单客户端；已有客户端时新连接收到 {"type":"busy"} 后关闭；
 *   - 连接后发 hello，收到 start 回 started 并开始按间隔发帧；
 *   - 收到 stop 回 stopped 并停止；客户端断开也停止；
 *   - 记录 starts/stops/framesSent，供测试断言“最后一个 viewer 关闭后 ≤5s 收到 stop”
 *     以及“断线重启后恢复”。
 *
 * 帧是合成 JPEG（test/tools/jpeg.js 生成，带 FAKE-DAYU 标记），不是真实摄像头画面。
 */

const net = require('net');
const { makeDayuFrame } = require('./jpeg');

class FakeDayuServer {
  constructor(options = {}) {
    this.port = options.port || 0;
    this.frameIntervalMs = options.frameIntervalMs || 50;
    this.device = options.device || 'dayu200-living';
    this.camera = options.camera || '640x480';
    this.helloDelayMs = options.helloDelayMs || 10;
    this.startDelayMs = options.startDelayMs || 0;

    this.server = null;
    this.client = null;
    this.frameTimer = null;
    this.frameIndex = 0;

    this.connections = 0;
    this.busyCount = 0;
    this.starts = 0;
    this.stops = 0;
    this.framesSent = 0;
    this.stopEvents = [];
    this.startEvents = [];
    this._lineBuffers = new WeakMap();
    this._helloTimers = new Set();
    this._lastFrameAt = 0;
  }

  get listenPort() {
    return this.port;
  }

  start(port = this.port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._onConnection(socket));
      this.server = server;
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.port = server.address().port;
        server.removeListener('error', reject);
        server.on('error', () => {});
        resolve(this.port);
      });
    });
  }

  async stop() {
    this._stopFrames();
    for (const timer of this._helloTimers) clearTimeout(timer);
    this._helloTimers.clear();
    if (this.client) {
      this.client.removeAllListeners();
      this.client.on('error', () => {});
      this.client.destroy();
      this.client = null;
    }
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch (_) {
          resolve();
        }
      });
    }
  }

  /** 同一端口重启（模拟 DAYU 服务重启/HDC 恢复）。 */
  async restart() {
    const port = this.port;
    await this.stop();
    return this.start(port);
  }

  /** 只踢掉当前客户端，服务保持监听（模拟 hdc 断线）。 */
  kickClient() {
    if (!this.client) return;
    const socket = this.client;
    this.client = null;
    this._stopFrames();
    socket.removeAllListeners();
    socket.on('error', () => {});
    socket.destroy();
  }

  _onConnection(socket) {
    if (this.client) {
      this.busyCount += 1;
      try {
        socket.write('{"type":"busy"}\n');
      } catch (_) {
        // ignore
      }
      socket.destroy();
      return;
    }
    this.connections += 1;
    this.client = socket;
    this._lineBuffers.set(socket, Buffer.alloc(0));
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(socket, chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.client !== socket) return;
      this.client = null;
      this._stopFrames();
    });
    const helloTimer = setTimeout(() => {
      this._helloTimers.delete(helloTimer);
      if (this.client !== socket) return;
      try {
        socket.write(`${JSON.stringify({
          type: 'hello',
          proto: 1,
          device: this.device,
          camera: this.camera,
          cameraActive: true
        })}\n`);
      } catch (_) {
        // ignore
      }
    }, this.helloDelayMs);
    this._helloTimers.add(helloTimer);
  }

  _onData(socket, chunk) {
    const previous = this._lineBuffers.get(socket) || Buffer.alloc(0);
    let buffer = Buffer.concat([previous, chunk]);
    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      buffer = buffer.subarray(newline + 1);
      if (line) this._onControlLine(socket, line);
    }
    this._lineBuffers.set(socket, buffer);
  }

  _onControlLine(socket, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (message.type === 'start') {
      this.starts += 1;
      this.startEvents.push({ viewer: message.viewer || '', at: Date.now() });
      if (this.startDelayMs > 0) {
        setTimeout(() => {
          if (this.client !== socket) return;
          try {
            socket.write('{"type":"started","proto":1}\n');
          } catch (_) {
            // ignore
          }
          this._startFrames();
        }, this.startDelayMs);
      } else {
        try {
          socket.write('{"type":"started","proto":1}\n');
        } catch (_) {
          // ignore
        }
        this._startFrames();
      }
      return;
    }
    if (message.type === 'stop') {
      this.stops += 1;
      this.stopEvents.push(Date.now());
      this._stopFrames();
      if (this.client === socket) {
        try {
          socket.write('{"type":"stopped"}\n');
        } catch (_) {
          // ignore
        }
      }
    }
  }

  _startFrames() {
    this._stopFrames();
    this.frameTimer = setInterval(() => {
      if (!this.client) return;
      const frame = makeDayuFrame(this.frameIndex);
      this.frameIndex += 1;
      this.framesSent += 1;
      this._lastFrameAt = Date.now();
      try {
        this.client.write(frame);
      } catch (_) {
        // ignore
      }
    }, this.frameIntervalMs);
    if (typeof this.frameTimer.unref === 'function') this.frameTimer.unref();
  }

  _stopFrames() {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }
}

module.exports = { FakeDayuServer };
