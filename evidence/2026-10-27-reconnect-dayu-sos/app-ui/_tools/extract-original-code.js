// 从 ArkTS 编译器缓存（rollup 风格 msgpack）中提取 originalCode，恢复被编码损坏的 .ets 源文件。
// 只读取编译器缓存，不修改工程源码；输出到命令行指定路径。
const fs = require('fs');

function extract(file) {
  const b = fs.readFileSync(file);
  // 该缓存文件由 4 字节头部 + msgpack 数据组成；originalCode 的值为 bin/str。
  // 通过定位源文本开头，向前寻找合法的 msgpack str/bin 长度前缀。
  const marker = Buffer.from('/**\n', 'utf8');
  let start = b.indexOf(marker);
  if (start < 0) return null;
  // 尝试各种 msgpack 长度前缀：str8(d9)/str16(da)/str32(db)/bin8(c4)/bin16(c5)/bin32(c6)
  for (let back = 1; back <= 6; back++) {
    const p = start - back;
    if (p < 0) continue;
    const tag = b[p];
    let len = -1;
    let payload = -1;
    if (tag === 0xd9 && back === 2) { len = b[p + 1]; payload = p + 2; }
    else if (tag === 0xda && back === 3) { len = b.readUInt16BE(p + 1); payload = p + 3; }
    else if (tag === 0xdb && back === 5) { len = b.readUInt32BE(p + 1); payload = p + 5; }
    else if (tag === 0xc4 && back === 2) { len = b[p + 1]; payload = p + 2; }
    else if (tag === 0xc5 && back === 3) { len = b.readUInt16BE(p + 1); payload = p + 3; }
    else if (tag === 0xc6 && back === 5) { len = b.readUInt32BE(p + 1); payload = p + 5; }
    if (len < 0 || payload !== start) continue;
    // 长度合法且文本尾部能在合理范围结束
    if (len > 0 && payload + len <= b.length) {
      const text = b.slice(payload, payload + len).toString('utf8');
      if (text.indexOf('登录页') >= 0 || text.indexOf('我的') >= 0 || text.indexOf('import') >= 0) {
        return text;
      }
    }
  }
  return null;
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: node extract.js <cache.msgpack> <out.ets>');
  process.exit(2);
}
const text = extract(args[0]);
if (text === null) {
  console.error('NOT_FOUND');
  process.exit(1);
}
fs.writeFileSync(args[1], text, 'utf8');
console.log('OK bytes=' + Buffer.byteLength(text, 'utf8'));
