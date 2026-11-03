'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { RelayTransport, TcpStatusServer } = require('../src/transport');
const { FakeHomemon } = require('./helpers/fake-homemon');
const { waitFor, sleep } = require('./helpers/wait');

test('relay 注入格式为单行 `relay <json>`', async (t) => {
  const homemon = await new FakeHomemon().start();
  t.after(() => homemon.close());
  const transport = new RelayTransport({ host: '127.0.0.1', port: homemon.port });
  t.after(() => transport.stop());
  transport.start();

  await waitFor(() => transport.connected, { label: 'relay connected' });
  const line = JSON.stringify({ deviceId: 'esp32-sos', state: 'ALARM' });
  transport.sendLine(line);

  await waitFor(() => homemon.lines.length >= 1, { label: 'relay line received' });
  assert.deepEqual(homemon.lines, [`relay ${line}`]);
  assert.equal(homemon.lines[0].includes('\n'), false);
});

test('relay 断线后自动重连并补发当前状态一次', async (t) => {
  const first = await new FakeHomemon().start();
  const port = first.port;
  const transport = new RelayTransport({ host: '127.0.0.1', port });
  const holder = { transport };
  t.after(() => holder.transport.stop());

  holder.transport.start();
  await waitFor(() => holder.transport.connected, { label: 'first connect' });
  holder.transport.sendLine('{"state":"ALARM","alarm":{"id":"sos-1-aa"}}');
  await waitFor(() => first.lines.length >= 1, { label: 'first line' });

  await first.close();
  await waitFor(() => holder.transport.connected === false, { label: 'disconnected' });

  const second = await new FakeHomemon({ port }).start();
  t.after(() => second.close());
  await waitFor(() => holder.transport.connected, { timeout: 8000, label: 'reconnect' });
  await waitFor(() => second.lines.length >= 1, { timeout: 8000, label: 'resend on reconnect' });
  assert.equal(second.lines[0], 'relay {"state":"ALARM","alarm":{"id":"sos-1-aa"}}');
  assert.ok(holder.transport.status().connects >= 2);
});

test('tcp 通道向客户端发状态行、忽略入站命令、统计连接数', async (t) => {
  const server = new TcpStatusServer({ host: '127.0.0.1', port: 0 });
  await server.start();
  const port = server.server.address().port;
  t.after(() => server.stop());
  t.after(() => {
    /* 确保测试结束不残留监听 */
    if (server.server) server.server.close();
  });

  const client = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => client.destroy());
  const received = [];
  client.on('data', (chunk) => received.push(chunk.toString('utf8')));
  await waitFor(() => server.status().clients === 1, { label: 'client accepted' });

  server.broadcast(JSON.stringify({ deviceId: 'esp32-sos', state: 'ALARM' }));
  await waitFor(() => received.join('').includes('"deviceId":"esp32-sos"'), { label: 'broadcast received' });

  /* APP 若下发 route/ack，镜像必须忽略（不代设备确认、不崩溃） */
  client.write('route esp32-sos ack sos-1-aa 已确认\n');
  await sleep(50);
  assert.equal(received.join('').includes('ACKED'), false);
  assert.equal(server.status().clients, 1);
});
