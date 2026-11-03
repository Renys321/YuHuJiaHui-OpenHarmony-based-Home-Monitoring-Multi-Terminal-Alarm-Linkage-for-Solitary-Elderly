#!/usr/bin/env node
/**
 * tls-live-check.js — OneNET 8883 真实 TLS 校验（不需要设备密钥）
 *
 * 用 transport.js 完全相同的 TLS 选项（官方 CA + 固定叶证书指纹 + rejectUnauthorized=true）
 * 对 OneNET 产品专属 8883 入口做一次真实 TLS 握手。**不发送任何 MQTT 字节、不携带凭据、不修改云端状态。**
 *
 * 这条检查覆盖“真实凭据常驻运行”里唯一不需要密钥的那一半：链路、CA 验证与证书指纹固定
 * 在**当前**仍然对得上线上服务器。它**不能**替代带凭据的 MQTT CONNECT 验收。
 *
 * 用法：
 *   node tls-live-check.js [--host <host>] [--port 8883] [--timeout 15000]
 */
'use strict';

const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');

const { checkOneNetServerIdentity, ONENET_CERT_FINGERPRINT256 } = require('./transport');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PRODUCT_ID = process.env.ONENET_PRODUCT_ID || 'I19NBBq4xe';
const HOST = arg('host', `${PRODUCT_ID}.mqttstls.acc.cmcconenet.cn`);
const PORT = parseInt(arg('port', '8883'), 10);
const TIMEOUT = parseInt(arg('timeout', '15000'), 10);
const EXPECTED_FP = process.env.ONENET_CERT_FINGERPRINT256 || ONENET_CERT_FINGERPRINT256;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

console.log('='.repeat(66));
console.log('OneNET 8883 真实 TLS 校验（无凭据、无 MQTT 字节）');
console.log('='.repeat(66));
console.log(`PC time      : ${new Date().toISOString()}`);
console.log(`target       : ${HOST}:${PORT}`);
console.log(`expected pin : ${EXPECTED_FP}`);
console.log(`ca           : ${path.join(__dirname, 'certs', 'onenet-mqtt-ca.pem')}`);
console.log('');

const ca = fs.readFileSync(path.join(__dirname, 'certs', 'onenet-mqtt-ca.pem'));

const socket = tls.connect({
  host: HOST,
  port: PORT,
  servername: HOST,
  ca,
  rejectUnauthorized: true,
  checkServerIdentity: (host, certificate) => checkOneNetServerIdentity(host, certificate, EXPECTED_FP),
  timeout: TIMEOUT
});

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try { socket.destroy(); } catch { /* ignore */ }
  const passed = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`RESULT: ${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log('FAILED: ' + results.filter((r) => !r.ok).map((r) => r.name).join(' | '));
  }
  process.exit(code);
}

socket.on('secureConnect', () => {
  const cert = socket.getPeerCertificate();
  const protocol = socket.getProtocol();
  const cipher = socket.getCipher();

  check('TLS handshake completed with rejectUnauthorized=true', socket.authorized === true,
    `authorized=${socket.authorized}`);
  check('server certificate chain verified against the official CA',
    socket.authorizationError === undefined || socket.authorized === true,
    `authorizationError=${socket.authorizationError || 'none'}`);
  check('leaf certificate fingerprint matches the pinned SHA-256',
    String(cert.fingerprint256 || '').toUpperCase() === EXPECTED_FP,
    `actual=${cert.fingerprint256}`);
  check('leaf certificate CN is OneNET MQTTS', cert.subject && cert.subject.CN === 'OneNET MQTTS',
    `CN=${cert.subject && cert.subject.CN}`);
  check('TLS protocol is 1.2 or newer', /TLSv1\.[23]/.test(protocol || ''), `protocol=${protocol}`);
  check('a cipher suite was negotiated', Boolean(cipher && cipher.name), `cipher=${cipher && cipher.name}`);

  console.log('');
  console.log('  ---- peer certificate (public metadata only) ----');
  console.log(`  subject      : ${JSON.stringify(cert.subject)}`);
  console.log(`  issuer       : ${cert.issuer && cert.issuer.CN}`);
  console.log(`  valid_from   : ${cert.valid_from}`);
  console.log(`  valid_to     : ${cert.valid_to}`);
  console.log(`  fingerprint  : ${cert.fingerprint256}`);

  const allOk = results.every((r) => r.ok);
  finish(allOk ? 0 : 1);
});

socket.on('error', (error) => {
  check('TLS handshake completed', false, `${error.code || 'ERROR'}: ${error.message}`);
  finish(1);
});

socket.on('timeout', () => {
  check('TLS handshake completed', false, `timeout after ${TIMEOUT}ms`);
  finish(1);
});
