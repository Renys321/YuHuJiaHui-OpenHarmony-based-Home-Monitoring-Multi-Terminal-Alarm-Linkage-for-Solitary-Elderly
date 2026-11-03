'use strict';
/*
 * COM11 被动只读监视（绝不发送任何字节）。
 * 目的：判断该 FTDI 串口是否为 YED M100 配置/透传口，是否有 M100 网络日志。
 * 安全设置：dtr:false / rts:false，避免误触发模块复位线；只 attach 'data'。
 * 多波特率：115200 / 9600 / 38400 / 57600，每个 4 秒。
 * 用法：node serial-passive.js COM11 <logs目录>
 */
const fs = require('fs');
const path = require('path');
const { SerialPort } = require('D:/OpenHarmony/competition/hardware/yed-m100mg-b1/node_modules/serialport');

const portName = process.argv[2] || 'COM11';
const outDir = process.argv[3] || path.join(__dirname, '..', 'logs');
const BAUDS = [115200, 9600, 38400, 57600];
const DWELL_MS = 4000;

function printable(buf) {
  return buf.toString('latin1').replace(/[^\x20-\x7e\r\n\t]/g, '.');
}

function probeBaud(baud) {
  return new Promise((resolve) => {
    const rec = { baud, opened: false, bytes: 0, ascii: '', hex: '', error: '' };
    let chunks = [];
    let port;
    try {
      port = new SerialPort({ path: portName, baudRate: baud, autoOpen: true, dtr: false, rts: false });
    } catch (e) {
      rec.error = String(e && e.message || e);
      return resolve(rec);
    }
    port.on('open', () => { rec.opened = true; });
    port.on('data', (d) => { chunks.push(d); });
    port.on('error', (e) => { rec.error = String(e && e.message || e); });
    const finish = () => {
      const buf = Buffer.concat(chunks);
      rec.bytes = buf.length;
      if (buf.length) {
        rec.hex = buf.toString('hex').slice(0, 2000);
        rec.ascii = printable(buf).slice(0, 2000);
      }
      try { port.close(() => resolve(rec)); } catch (_) { resolve(rec); }
    };
    setTimeout(finish, DWELL_MS);
  });
}

(async () => {
  const results = [];
  for (const baud of BAUDS) results.push(await probeBaud(baud));
  const record = {
    port: portName,
    mode: 'READ_ONLY_NO_WRITES',
    dtr: false,
    rts: false,
    probedAt: new Date().toISOString(),
    probedAtLocal: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' +08:00',
    results
  };
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `${stamp}-serial-passive-${portName}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ file, summary: results.map((r) => ({ baud: r.baud, opened: r.opened, bytes: r.bytes, error: r.error })), sample: results.map((r) => ({ baud: r.baud, ascii: r.ascii.slice(0, 400) })) }, null, 2));
})().catch((e) => { console.error('SERIAL_PROBE_FAILED', e && e.message); process.exit(1); });
