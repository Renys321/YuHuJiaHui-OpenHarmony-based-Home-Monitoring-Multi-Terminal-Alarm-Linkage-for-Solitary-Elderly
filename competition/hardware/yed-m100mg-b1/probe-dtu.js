#!/usr/bin/env node
'use strict';

const { SerialPort } = require('serialport');
const {
  buildProbeCommands,
  redactSensitiveLine,
  sanitizeResponseLine,
  summarizeProbeLines
} = require('./probe-core');

const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_TIMEOUT_MS = 1800;

function usage() {
  return [
    'Usage:',
    '  node probe-dtu.js --list',
    '  node probe-dtu.js --listen --port COM11 [--baud 9600] [--timeout 3000]',
    '  node probe-dtu.js --quick --port COM11 [--baud 57600]',
    '  node probe-dtu.js --port COM11 [--baud 115200] [--timeout 1800]',
    '  node probe-dtu.js --port COM11 --include-identifiers',
    '',
    'The default probe never requests IMEI or ICCID and never writes a log file.'
  ].join('\n');
}

function parseInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value || '')) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be in [${minimum}, ${maximum}]`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    baudRate: DEFAULT_BAUD_RATE,
    includeIdentifiers: false,
    list: false,
    listen: false,
    quick: false,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--list') options.list = true;
    else if (argument === '--listen') options.listen = true;
    else if (argument === '--quick') options.quick = true;
    else if (argument === '--include-identifiers') options.includeIdentifiers = true;
    else if (argument === '--port') options.port = argv[++index];
    else if (argument === '--baud') options.baudRate = parseInteger(argv[++index], '--baud', 1200, 460800);
    else if (argument === '--timeout') options.timeoutMs = parseInteger(argv[++index], '--timeout', 200, 10000);
    else throw new Error('unknown argument');
  }
  if (options.list || options.help) return Object.freeze(options);
  if (typeof options.port !== 'string' || !/^(?:COM\d+|\/dev\/[A-Za-z0-9._/-]+)$/.test(options.port)) {
    throw new Error('--port must be a COM port or /dev serial path');
  }
  return Object.freeze(options);
}

function openPort(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      port.off('open', onOpen);
      reject(error);
    };
    const onOpen = () => {
      port.off('error', onError);
      resolve();
    };
    port.once('error', onError);
    port.once('open', onOpen);
    port.open();
  });
}

function closePort(port) {
  if (!port.isOpen) return Promise.resolve();
  return new Promise((resolve) => port.close(() => resolve()));
}

function flushPort(port) {
  return new Promise((resolve, reject) => port.flush((error) => error ? reject(error) : resolve()));
}

function writeAndDrain(port, text) {
  return new Promise((resolve, reject) => {
    port.write(text, (writeError) => {
      if (writeError) return reject(writeError);
      port.drain((drainError) => drainError ? reject(drainError) : resolve());
    });
  });
}

async function collectResponse(port, command, timeoutMs) {
  let pending = '';
  const lines = [];
  const accept = (value) => {
    const sanitized = sanitizeResponseLine(value);
    if (!sanitized || sanitized === command) return;
    const redacted = redactSensitiveLine(sanitized);
    if (redacted && !lines.includes(redacted)) lines.push(redacted);
  };
  const onData = (chunk) => {
    pending += chunk.toString('utf8');
    const parts = pending.split(/[\r\n]+/);
    pending = parts.pop() || '';
    for (const part of parts) accept(part);
    if (pending.length > 8192) {
      accept(pending);
      pending = '';
    }
  };

  port.on('data', onData);
  try {
    await flushPort(port);
    await writeAndDrain(port, `${command}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  } finally {
    port.off('data', onData);
  }
  accept(pending);
  return Object.freeze(lines);
}

async function collectPassive(port, timeoutMs) {
  let pending = '';
  const lines = [];
  const accept = (value) => {
    const sanitized = sanitizeResponseLine(value);
    if (!sanitized) return;
    const redacted = redactSensitiveLine(sanitized);
    if (redacted && !lines.includes(redacted)) lines.push(redacted);
  };
  const onData = (chunk) => {
    pending += chunk.toString('utf8');
    const parts = pending.split(/[\r\n]+/);
    pending = parts.pop() || '';
    for (const part of parts) accept(part);
    if (pending.length > 8192) {
      accept(pending);
      pending = '';
    }
  };
  port.on('data', onData);
  try {
    await flushPort(port);
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  } finally {
    port.off('data', onData);
  }
  accept(pending);
  return Object.freeze(lines);
}

async function listPorts() {
  const ports = await SerialPort.list();
  if (ports.length === 0) {
    console.log('No serial ports detected.');
    return;
  }
  for (const port of ports) {
    const fields = [
      port.path,
      port.manufacturer ? `manufacturer=${sanitizeResponseLine(port.manufacturer)}` : '',
      port.vendorId ? `vid=${sanitizeResponseLine(port.vendorId)}` : '',
      port.productId ? `pid=${sanitizeResponseLine(port.productId)}` : ''
    ].filter(Boolean);
    console.log(fields.join(' '));
  }
}

async function probe(options) {
  const port = new SerialPort({
    path: options.port,
    baudRate: options.baudRate,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    rtscts: false,
    xon: false,
    xoff: false,
    xany: false,
    hupcl: false,
    autoOpen: false
  });
  const allLines = [];
  let serialError = null;
  const onSerialError = (error) => {
    if (!serialError) serialError = error;
  };
  port.on('error', onSerialError);
  try {
    await openPort(port);
    await new Promise((resolve, reject) => {
      port.set({ dtr: false, rts: false }, (error) => error ? reject(error) : resolve());
    });
    console.log(`DTU serial probe: ${options.port} @ ${options.baudRate} baud`);
    console.log('Output is bounded and redacted. Nothing is written to a log file.');
    if (options.includeIdentifiers) {
      console.log('Identifier queries explicitly enabled; returned values remain redacted.');
    }

    if (options.listen) {
      console.log(`Passive listen only for ${options.timeoutMs} ms; no command will be sent.`);
      const lines = await collectPassive(port, options.timeoutMs);
      if (serialError) throw serialError;
      if (lines.length === 0) console.log('[no passive data]');
      for (const line of lines) {
        allLines.push(line);
        console.log(line);
      }
    } else {

      const commands = buildProbeCommands(options.includeIdentifiers);
      const selectedCommands = options.quick ? commands.slice(0, 1) : commands;
      for (const command of selectedCommands) {
        console.log(`\n> ${command}`);
        const lines = await collectResponse(port, command, options.timeoutMs);
        if (serialError) throw serialError;
        if (lines.length === 0) console.log('[no response]');
        for (const line of lines) {
          allLines.push(line);
          console.log(line);
        }
      }
    }
  } finally {
    await closePort(port);
    port.off('error', onSerialError);
  }

  const summary = summarizeProbeLines(allLines);
  console.log('\nSafe summary:');
  console.log(JSON.stringify(summary, null, 2));
  if (Object.keys(summary).length === 0) {
    process.exitCode = 2;
    console.error('No recognized DTU response. This port is not proven to be the YED module.');
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 64;
    return;
  }
  if (options.help) return console.log(usage());
  if (options.list) return listPorts();
  await probe(options);
}

if (require.main === module) {
  main().catch((error) => {
    const code = error && typeof error.code === 'string' ? error.code : 'SERIAL_PROBE_FAILED';
    console.error(`Serial probe failed: ${code}`);
    process.exitCode = 1;
  });
}

module.exports = {
  collectResponse,
  collectPassive,
  parseArgs,
  probe,
  usage
};
