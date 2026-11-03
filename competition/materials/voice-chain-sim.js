const net = require('net');
const fs = require('fs');
const wavPath = process.argv[2];
const nodeName = process.argv[3] || 's3-sim-test';
const roomName = process.argv[4] || '测试';
const alarmIdArg = process.argv[5] || '';
const reasonArg = process.argv[6] || 'cmd';
const buf = fs.readFileSync(wavPath);
let off = 12;
let dataOff = -1, dataLen = 0;
while (off + 8 <= buf.length) {
  const id = buf.toString('ascii', off, off + 4);
  const len = buf.readUInt32LE(off + 4);
  if (id === 'data') { dataOff = off + 8; dataLen = len; break; }
  off += 8 + len + (len % 2);
}
if (dataOff < 0) { console.error('no data chunk'); process.exit(2); }
const pcm = buf.subarray(dataOff, dataOff + dataLen);
const socket = net.connect(9303, '127.0.0.1');
let lineBuf = '';
socket.on('connect', () => {
  socket.write(JSON.stringify({ type: 'hello', role: 'mic', node: nodeName, room: roomName, alarmId: alarmIdArg, reason: reasonArg }) + '\n');
});
socket.on('data', (chunk) => {
  lineBuf += chunk.toString('utf8');
  let nl;
  while ((nl = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, nl); lineBuf = lineBuf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    console.log(msg.type, msg.text || msg.message || msg.code || '');
    if (msg.type === 'ready') {
      socket.write(JSON.stringify({ type: 'audio_start', rate: 16000, channels: 1, codec: 'pcm_s16le' }) + '\n');
      const chunkSize = 8000;
      for (let p = 0; p < pcm.length; p += chunkSize) {
        const part = pcm.subarray(p, Math.min(pcm.length, p + chunkSize));
        const hdr = Buffer.alloc(4); hdr.writeUInt32BE(part.length, 0);
        socket.write(Buffer.concat([hdr, part]));
      }
      socket.write(JSON.stringify({ type: 'audio_end' }) + '\n');
    }
    if (msg.type === 'elder_safe' || msg.type === 'error' || msg.type === 'tts_start') {
      if (msg.type === 'tts_start') { /* keep waiting for done/elder */ }
    }
  }
});
socket.on('error', (e) => { console.error('ERR', e.message); process.exit(1); });
setTimeout(() => { socket.destroy(); process.exit(0); }, 9000);
