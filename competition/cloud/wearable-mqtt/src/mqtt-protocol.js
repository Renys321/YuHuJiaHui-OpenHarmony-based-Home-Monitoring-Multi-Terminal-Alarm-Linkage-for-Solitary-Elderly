'use strict';

/**
 * mqtt-protocol.js — MQTT 3.1.1 最小报文编解码 + 主题匹配（零第三方依赖）。
 *
 * 只实现 wearable-mqtt 真正需要的子集：
 *   CONNECT / CONNACK / PUBLISH(QoS0/1) / PUBACK / PUBREC / PUBREL / PUBCOMP /
 *   SUBSCRIBE / SUBACK / UNSUBSCRIBE / UNSUBACK / PINGREQ / PINGRESP / DISCONNECT。
 *
 * 设计边界（不夸大）：
 *   - 会话不持久化（cleanSession 标志接受但 sessionPresent 永远为 0）；
 *   - 不支持 QoS2 的 exactly-once 语义：收到 QoS2 只做 PUBREC/PUBCOMP 握手，
 *     消息按“至少一次”投递，不提供跨进程去重；
 *   - retain 报文可接受，但服务器不保存 retained 消息（转发时 retain=false）；
 *   - 协议错误一律抛 `ProtocolError`，由 broker 断开连接并计数，绝不抛到进程顶层。
 */

const PACKET_TYPE = Object.freeze({
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  PUBREC: 5,
  PUBREL: 6,
  PUBCOMP: 7,
  SUBSCRIBE: 8,
  SUBACK: 9,
  UNSUBSCRIBE: 10,
  UNSUBACK: 11,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14
});

const TYPE_NAME = Object.freeze(Object.fromEntries(
  Object.entries(PACKET_TYPE).map(([name, value]) => [value, name])
));

/** MQTT 3.1.1 的最大 Remaining Length。超过即视为非法报文。 */
const MAX_REMAINING_LENGTH = 268435455;

class ProtocolError extends Error {
  /**
   * @param {string} code 安全短码（日志/诊断用，不含原始报文）
   * @param {number} [connackCode] 若是 CONNECT 阶段错误，CONNACK 返回码
   */
  constructor(code, connackCode) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
    this.connackCode = connackCode === undefined ? null : connackCode;
  }
}

/* --------------------------------------------------------------- 基础编码 */

/** Remaining Length 变长整数编码（1-4 字节）。 */
function encodeRemainingLength(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_REMAINING_LENGTH) {
    throw new ProtocolError('INVALID_REMAINING_LENGTH');
  }
  const bytes = [];
  let remaining = value;
  do {
    let digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) digit |= 0x80;
    bytes.push(digit);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

/**
 * 从 offset 处解码 Remaining Length。
 * @returns {{value:number, next:number}|null} null 表示报文还不完整（需要继续读 socket）
 */
function readRemainingLength(buffer, offset) {
  let multiplier = 1;
  let value = 0;
  let index = offset;
  for (let count = 0; count < 4; count += 1) {
    if (index >= buffer.length) return null;
    const byte = buffer[index];
    index += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      if (count > 0 && byte === 0) throw new ProtocolError('MALFORMED_REMAINING_LENGTH');
      return { value, next: index };
    }
    multiplier *= 128;
  }
  throw new ProtocolError('MALFORMED_REMAINING_LENGTH');
}

/** UTF-8 字符串编码（2 字节长度前缀）。 */
function encodeString(value) {
  if (typeof value !== 'string') throw new ProtocolError('INVALID_STRING');
  const body = Buffer.from(value, 'utf8');
  if (body.length > 65535) throw new ProtocolError('STRING_TOO_LONG');
  const out = Buffer.allocUnsafe(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

/**
 * 从 buffer.offset 读 UTF-8 字符串。
 * @returns {{value:string, next:number}|null}
 */
function decodeString(buffer, offset) {
  if (offset + 2 > buffer.length) return null;
  const length = buffer.readUInt16BE(offset);
  const start = offset + 2;
  const end = start + length;
  if (end > buffer.length) return null;
  return { value: buffer.toString('utf8', start, end), next: end };
}

function decodeUInt16(buffer, offset) {
  if (offset + 2 > buffer.length) return null;
  return { value: buffer.readUInt16BE(offset), next: offset + 2 };
}

/** 组装一个完整报文：固定头 + 变长 Remaining Length + body。 */
function encodePacket(type, flags, body) {
  if (!Number.isInteger(type) || type < 1 || type > 14) throw new ProtocolError('INVALID_PACKET_TYPE');
  const payload = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const header = Buffer.from([((type & 0x0f) << 4) | (flags & 0x0f)]);
  return Buffer.concat([header, encodeRemainingLength(payload.length), payload]);
}

/* ------------------------------------------------------------ 下行控制报文 */

function buildConnack(sessionPresent, returnCode) {
  const body = Buffer.from([sessionPresent ? 0x01 : 0x00, returnCode & 0xff]);
  return encodePacket(PACKET_TYPE.CONNACK, 0, body);
}

/** SUBACK 返回码：0/1 = 授予的 QoS，0x80 = 该订阅失败。 */
function buildSuback(packetId, returnCodes) {
  const body = Buffer.allocUnsafe(2 + returnCodes.length);
  body.writeUInt16BE(packetId, 0);
  returnCodes.forEach((code, index) => { body[2 + index] = code; });
  return encodePacket(PACKET_TYPE.SUBACK, 0, body);
}

function buildUnsuback(packetId) {
  const body = Buffer.allocUnsafe(2);
  body.writeUInt16BE(packetId, 0);
  return encodePacket(PACKET_TYPE.UNSUBACK, 0, body);
}

function buildAck(type, packetId) {
  const body = Buffer.allocUnsafe(2);
  body.writeUInt16BE(packetId, 0);
  return encodePacket(type, 0, body);
}

function buildPingresp() {
  return encodePacket(PACKET_TYPE.PINGRESP, 0, null);
}

/**
 * 构造 PUBLISH 报文。
 * @param {{topic:string, payload:Buffer, qos?:0|1, packetId?:number, retain?:boolean, dup?:boolean}} options
 */
function buildPublish(options) {
  const qos = options.qos === 1 ? 1 : 0;
  const retain = options.retain === true;
  const dup = options.dup === true;
  let flags = (qos << 1) | (retain ? 0x01 : 0) | (dup ? 0x08 : 0);
  const parts = [encodeString(options.topic)];
  if (qos > 0) {
    if (!Number.isInteger(options.packetId) || options.packetId < 1 || options.packetId > 65535) {
      throw new ProtocolError('INVALID_PACKET_ID');
    }
    const id = Buffer.allocUnsafe(2);
    id.writeUInt16BE(options.packetId, 0);
    parts.push(id);
  }
  const payload = Buffer.isBuffer(options.payload)
    ? options.payload
    : Buffer.from(String(options.payload === undefined ? '' : options.payload), 'utf8');
  parts.push(payload);
  return encodePacket(PACKET_TYPE.PUBLISH, flags, Buffer.concat(parts));
}

/* --------------------------------------------------------------- 报文解析 */

/** @returns {{protocolName:string, protocolLevel:number, cleanSession:boolean, keepAlive:number, clientId:string, username:string|null, password:string|null, will:object|null}} */
function parseConnect(body) {
  if (!Buffer.isBuffer(body)) throw new ProtocolError('INVALID_CONNECT');
  let offset = 0;

  const protocolName = decodeString(body, offset);
  if (!protocolName) throw new ProtocolError('INVALID_CONNECT');
  offset = protocolName.next;
  if (protocolName.value !== 'MQTT') {
    // 3.1 节协议名是 "MQIsdp"；本服务只支持 3.1.1。
    throw new ProtocolError('UNSUPPORTED_PROTOCOL_NAME', 1);
  }

  if (offset + 1 > body.length) throw new ProtocolError('INVALID_CONNECT');
  const protocolLevel = body[offset];
  offset += 1;
  if (protocolLevel !== 4) throw new ProtocolError('UNSUPPORTED_PROTOCOL_LEVEL', 1);

  if (offset + 1 > body.length) throw new ProtocolError('INVALID_CONNECT');
  const flags = body[offset];
  offset += 1;
  if ((flags & 0x01) !== 0) throw new ProtocolError('INVALID_CONNECT_FLAGS', 2);

  const cleanSession = (flags & 0x02) !== 0;
  const willFlag = (flags & 0x04) !== 0;
  const willQos = (flags >> 3) & 0x03;
  const willRetain = (flags & 0x20) !== 0;
  const passwordFlag = (flags & 0x40) !== 0;
  const usernameFlag = (flags & 0x80) !== 0;

  if (willQos === 3) throw new ProtocolError('INVALID_WILL_QOS', 2);
  if (!willFlag && (willQos !== 0 || willRetain)) throw new ProtocolError('INVALID_WILL_FLAGS', 2);
  if (!usernameFlag && passwordFlag) {
    // 3.1.1 允许 password without username? 规范要求 username 为 0 时 password 必须为 0。
    throw new ProtocolError('PASSWORD_WITHOUT_USERNAME', 2);
  }

  const keepAliveResult = decodeUInt16(body, offset);
  if (!keepAliveResult) throw new ProtocolError('INVALID_CONNECT');
  offset = keepAliveResult.next;

  const clientIdResult = decodeString(body, offset);
  if (!clientIdResult) throw new ProtocolError('INVALID_CONNECT');
  offset = clientIdResult.next;

  let will = null;
  if (willFlag) {
    const willTopic = decodeString(body, offset);
    if (!willTopic) throw new ProtocolError('INVALID_CONNECT');
    offset = willTopic.next;
    const willPayload = decodeString(body, offset);
    if (!willPayload) throw new ProtocolError('INVALID_CONNECT');
    offset = willPayload.next;
    will = Object.freeze({ topic: willTopic.value, payload: willPayload.value, qos: willQos, retain: willRetain });
  }

  let username = null;
  if (usernameFlag) {
    const parsed = decodeString(body, offset);
    if (!parsed) throw new ProtocolError('INVALID_CONNECT');
    offset = parsed.next;
    username = parsed.value;
  }

  let password = null;
  if (passwordFlag) {
    const parsed = decodeString(body, offset);
    if (!parsed) throw new ProtocolError('INVALID_CONNECT');
    offset = parsed.next;
    password = parsed.value;
  }

  if (offset !== body.length) throw new ProtocolError('CONNECT_TRAILING_BYTES', 2);

  return {
    protocolName: protocolName.value,
    protocolLevel,
    cleanSession,
    keepAlive: keepAliveResult.value,
    clientId: clientIdResult.value,
    username,
    password,
    will
  };
}

/**
 * 解析 PUBLISH 的可变头与载荷。
 * @returns {{topic:string, qos:0|1|2, retain:boolean, dup:boolean, packetId:number|null, payload:Buffer}}
 */
function parsePublish(flags, body) {
  const qos = (flags >> 1) & 0x03;
  if (qos === 3) throw new ProtocolError('INVALID_QOS');
  const retain = (flags & 0x01) !== 0;
  const dup = (flags & 0x08) !== 0;

  const topicResult = decodeString(body, 0);
  if (!topicResult) throw new ProtocolError('INVALID_PUBLISH_TOPIC');
  if (topicResult.value.length === 0) throw new ProtocolError('EMPTY_PUBLISH_TOPIC');

  let offset = topicResult.next;
  let packetId = null;
  if (qos > 0) {
    const parsed = decodeUInt16(body, offset);
    if (!parsed) throw new ProtocolError('MISSING_PACKET_ID');
    if (parsed.value === 0) throw new ProtocolError('INVALID_PACKET_ID');
    offset = parsed.next;
    packetId = parsed.value;
  }
  return {
    topic: topicResult.value,
    qos,
    retain,
    dup,
    packetId,
    payload: body.subarray(offset)
  };
}

/**
 * 解析 SUBSCRIBE / UNSUBSCRIBE。
 * @param {number} flags
 * @param {Buffer} body
 * @param {{withQos:boolean}} options
 * @returns {{packetId:number, filters:Array<{filter:string, qos:number}>}}
 */
function parseSubscribeLike(flags, body, options) {
  const expectedFlags = options.withQos ? 0x02 : 0x02;
  if ((flags & 0x0f) !== expectedFlags) throw new ProtocolError('INVALID_SUBSCRIBE_FLAGS');
  const idResult = decodeUInt16(body, 0);
  if (!idResult) throw new ProtocolError('MISSING_PACKET_ID');
  if (idResult.value === 0) throw new ProtocolError('INVALID_PACKET_ID');
  let offset = idResult.next;
  const filters = [];
  while (offset < body.length) {
    const topicResult = decodeString(body, offset);
    if (!topicResult) throw new ProtocolError('INVALID_SUBSCRIBE_TOPIC');
    offset = topicResult.next;
    let qos = 0;
    if (options.withQos) {
      if (offset >= body.length) throw new ProtocolError('MISSING_SUBSCRIBE_QOS');
      qos = body[offset];
      offset += 1;
      if (qos > 2) throw new ProtocolError('INVALID_SUBSCRIBE_QOS');
    }
    filters.push({ filter: topicResult.value, qos });
  }
  if (filters.length === 0) throw new ProtocolError('EMPTY_SUBSCRIBE');
  return { packetId: idResult.value, filters };
}

/* --------------------------------------------------------------- 主题规则 */

/** 发布主题名不能含通配符，且不能为空。 */
function isValidTopicName(topic) {
  return typeof topic === 'string' && topic.length > 0 && topic.length <= 65535 &&
    !/[\u0000#+]/.test(topic);
}

/** 订阅过滤器规则：`+` 必须独占一级，`#` 只能是最后一级。 */
function isValidTopicFilter(filter) {
  if (typeof filter !== 'string' || filter.length === 0 || filter.length > 65535) return false;
  if (filter.indexOf('\u0000') !== -1) return false;
  const levels = filter.split('/');
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    if (level.includes('#')) {
      if (level !== '#' || index !== levels.length - 1) return false;
    }
    if (level.includes('+') && level !== '+') return false;
  }
  return true;
}

/**
 * MQTT 3.1.1 主题匹配。
 * - `+` 匹配恰好一级（可以为空字符串级）；
 * - `#` 匹配剩余所有层级（包括父级本身，`a/#` 匹配 `a`）；
 * - 以 `$` 开头的主题不被首级通配符匹配。
 */
function topicMatches(filter, topic) {
  if (typeof filter !== 'string' || typeof topic !== 'string') return false;
  if (topic.length === 0) return false;
  const filterLevels = filter.split('/');
  const topicLevels = topic.split('/');
  if (filterLevels[0] === '+' || filterLevels[0] === '#') {
    if (topicLevels[0].startsWith('$')) return false;
  }
  let index = 0;
  for (; index < filterLevels.length; index += 1) {
    const level = filterLevels[index];
    if (level === '#') return true;
    if (index >= topicLevels.length) return false;
    if (level !== '+' && level !== topicLevels[index]) return false;
  }
  return index === topicLevels.length;
}

module.exports = Object.freeze({
  PACKET_TYPE,
  TYPE_NAME,
  MAX_REMAINING_LENGTH,
  ProtocolError,
  encodeRemainingLength,
  readRemainingLength,
  encodeString,
  decodeString,
  encodePacket,
  buildConnack,
  buildSuback,
  buildUnsuback,
  buildAck,
  buildPingresp,
  buildPublish,
  parseConnect,
  parsePublish,
  parseSubscribeLike,
  isValidTopicName,
  isValidTopicFilter,
  topicMatches
});
