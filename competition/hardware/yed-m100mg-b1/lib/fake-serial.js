'use strict';

/**
 * lib/fake-serial.js — 可注入的假串口（无硬件测试用）
 *
 * 提供两个东西：
 *   1. createFakeSerialSocket()  —— 一个最小 socket，事件与方法签名对齐 `serialport`
 *      （on/off/once/emit、isOpen、open、close、write、destroy）。
 *   2. createFakeSerialFactory() —— 返回 { createSerial, sockets }，注入给 SerialTransport。
 *
 * 刻意不做的事：不访问真实串口、不做异步定时、不读取环境变量。
 * 响应由测试显式调用 socket.expect(...) / socket.push(...) 注入，因此完全确定。
 */

const { EventEmitter } = require('node:events');

/** 创建一个假串口 socket。 */
function createFakeSerialSocket(options = {}) {
  const writeLog = [];
  const socket = new EventEmitter();
  socket.path = options.path || 'COM_TEST';
  socket.baudRate = options.baudRate || 115200;
  socket.isOpen = false;
  socket.openCalls = 0;
  socket.closeCalls = 0;
  socket.destroyCalls = 0;

  socket.open = function open() {
    socket.openCalls += 1;
    if (options.failOpenWith) {
      const error = options.failOpenWith;
      if (options.syncOpen === true) socket.emit('error', error);
      else setImmediate(() => socket.emit('error', error));
      return undefined;
    }
    if (options.deferOpen === true) return undefined;
    socket.isOpen = true;
    if (options.syncOpen === true) socket.emit('open');
    else setImmediate(() => socket.emit('open'));
    return undefined;
  };

  socket.close = function close(callback) {
    socket.closeCalls += 1;
    socket.isOpen = false;
    if (typeof callback === 'function') setImmediate(() => callback(null));
    return undefined;
  };

  socket.destroy = function destroy() {
    socket.destroyCalls += 1;
    socket.isOpen = false;
    return undefined;
  };

  socket.write = function write(data) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    writeLog.push(text);
    return true;
  };

  socket.getWritten = () => Object.freeze([...writeLog]);
  socket.getLastWritten = () => (writeLog.length === 0 ? null : writeLog[writeLog.length - 1]);

  /** 注入一段设备输出（模拟串口收到数据）。 */
  socket.push = function push(text) {
    const payload = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
    socket.emit('data', payload);
    return socket;
  };

  /**
   * 完成一次命令交互：可先发命令回显，再发响应。
   * @param {string} command 期望的命令（会先写成 `command\r\n` 回显）
   * @param {string[]} responseLines 响应行
   */
  socket.expect = function expect(command, responseLines = []) {
    const plain = String(command).replace(/[\r\n]+$/, '');
    const lines = [plain, ...responseLines].join('\r\n');
    socket.push(`${lines}\r\n`);
    return socket;
  };

  /** 异步返回一条命令的响应（用于验证命令串行化与重试）。 */
  socket.respondLater = function respondLater(command, responseLines = [], onWritten) {
    const plain = String(command).replace(/[\r\n]+$/, '');
    if (onWritten) writeLog.push(plain);
    setImmediate(() => socket.expect(plain, responseLines));
    return socket;
  };

  /** 模拟串口掉线：emit('error') + emit('close')。 */
  socket.dropConnection = function dropConnection(error) {
    socket.isOpen = false;
    if (error) socket.emit('error', error);
    socket.emit('close');
    return socket;
  };

  return socket;
}

/**
 * 创建注入工厂。
 * @param {object} options 传给 socket 的选项（failOpenWith / deferOpen）。
 * @returns {{createSerial: Function, sockets: Array, last: Function}}
 */
function createFakeSerialFactory(options = {}) {
  const sockets = [];
  const failures = Array.isArray(options.openFailures) ? [...options.openFailures] : [];
  const result = {
    sockets,
    last: () => sockets[sockets.length - 1] || null,
    createSerial(serialOptions = {}) {
      const failure = failures.length > 0 ? failures.shift() : null;
      const socket = createFakeSerialSocket({
        path: serialOptions.path,
        baudRate: serialOptions.baudRate,
        ...(failure ? { failOpenWith: failure } : {}),
        ...(options.socketOptions || {})
      });
      sockets.push(socket);
      return socket;
    }
  };
  return result;
}

module.exports = { createFakeSerialSocket, createFakeSerialFactory };
