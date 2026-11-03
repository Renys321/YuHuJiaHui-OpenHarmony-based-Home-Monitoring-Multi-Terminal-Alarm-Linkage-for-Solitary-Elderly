'use strict';

/* 隔离测试：把网关固定端口整体偏移，避免与现场运行的实例冲突。
 * 9302 -> 19302（板端）、9303 -> 19303（采音）、9102 -> 19102（音箱）。 */
const net = require('net');

const map = new Map([
  [9302, 19302],
  [9303, 19303],
  [9102, 19102]
]);
const original = net.Server.prototype.listen;

net.Server.prototype.listen = function listen(...args) {
  if (typeof args[0] === 'number' && map.has(args[0])) args[0] = map.get(args[0]);
  return original.apply(this, args);
};
