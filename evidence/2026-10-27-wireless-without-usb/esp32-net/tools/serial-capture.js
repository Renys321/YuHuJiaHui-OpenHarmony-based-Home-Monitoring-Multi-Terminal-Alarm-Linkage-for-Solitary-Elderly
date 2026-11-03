// 只读串口采集：打开指定 COM 口收 115200 文本，给每行加 ISO 时间戳，不发送任何字节。
// 打开后立即把 DTR/RTS 置为 false，尽量避免触发 CH340 自动复位电路。
const fs = require('fs');
const { SerialPort } = require('D:/OpenHarmony/competition/hardware/yed-m100mg-b1/node_modules/serialport');

const portName = process.argv[2] || 'COM4';
const ms = Number(process.argv[3] || 15000);
const outFile = process.argv[4] || null;

const lines = [];
function emit(s) { console.log(s); lines.push(s); }

(async () => {
  let info = [];
  try {
    const all = await SerialPort.list();
    info = all.filter(x => x.path === portName);
    emit(`[usb] ${portName} ` + JSON.stringify(info));
  } catch (e) {
    emit('[usb] list failed: ' + e.message);
  }

  const p = new SerialPort({ path: portName, baudRate: 115200, autoOpen: false });
  let buf = '';
  p.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      emit(`[${new Date().toISOString()}] ${line}`);
    }
    if (buf.length > 8192) { emit(`[${new Date().toISOString()}] ${buf}`); buf = ''; }
  });
  p.on('error', (e) => emit('[error] ' + e.message));

  p.open((err) => {
    if (err) { emit('[open-error] ' + err.message); finish(); return; }
    emit(`[open] ${portName} @115200 at ${new Date().toISOString()}`);
    // 立即释放 DTR/RTS，减少对板子的扰动
    try { p.set({ dtr: false, rts: false }, () => { }); } catch (e) { }
  });

  function finish() {
    if (buf.length) { emit(`[${new Date().toISOString()}] ${buf}`); buf = ''; }
    emit(`[done] ${new Date().toISOString()}`);
    if (outFile) { try { fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8'); } catch (e) { } }
    try { p.close(() => process.exit(0)); } catch (e) { process.exit(0); }
  }

  setTimeout(finish, ms);
})();
