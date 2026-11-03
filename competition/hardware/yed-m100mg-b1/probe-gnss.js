#!/usr/bin/env node
'use strict';

const { SerialPort } = require('serialport');
const {
  GNSS_QUERY_COMMAND,
  GNSS_SETTINGS_QUERY_COMMAND,
  parseGnssLines,
  parseGnssSettingsLines,
  safeGnssSettingsText,
  safeGnssSummaryText
} = require('./gnss-probe-core');
const { sanitizeResponseLine } = require('./probe-core');

const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_LINES = 16;

function usage() {
  return [
    'Usage:',
    '  node probe-gnss.js --port COM7 [--baud 115200] [--timeout 5000]',
    '',
    'Queries GNSS once and prints only a privacy-safe fix summary.',
    'Coordinates and raw GNSS responses are never printed or written to a file.'
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
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--port') options.port = argv[++index];
    else if (argument === '--baud') options.baudRate = parseInteger(argv[++index], '--baud', 1200, 460800);
    else if (argument === '--timeout') options.timeoutMs = parseInteger(argv[++index], '--timeout', 500, 30000);
    else throw new Error('unknown argument');
  }
  if (options.help) return Object.freeze(options);
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

async function collectGnssResponse(port, command, timeoutMs) {
  if (command !== GNSS_SETTINGS_QUERY_COMMAND && command !== GNSS_QUERY_COMMAND) {
    throw new Error('GNSS_COMMAND_NOT_ALLOWED');
  }
  let pending = '';
  const lines = [];
  const accept = (value) => {
    if (lines.length >= MAX_RESPONSE_LINES) return;
    const sanitized = sanitizeResponseLine(value);
    if (!sanitized || sanitized === command) return;
    lines.push(sanitized);
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
    const settingsLines = await collectGnssResponse(port, GNSS_SETTINGS_QUERY_COMMAND, options.timeoutMs);
    const fixLines = await collectGnssResponse(port, GNSS_QUERY_COMMAND, options.timeoutMs);
    if (serialError) throw serialError;
    const settings = parseGnssSettingsLines(settingsLines);
    const summary = parseGnssLines(fixLines);
    console.log(`YED GNSS privacy-safe probe: ${options.port} @ ${options.baudRate} baud`);
    console.log('Raw GNSS response and coordinates are withheld and are not written to a file.');
    console.log(safeGnssSettingsText(settings));
    console.log(safeGnssSummaryText(summary));
    if (!settings.supported || !summary.supported) process.exitCode = 2;
  } finally {
    await closePort(port);
    port.off('error', onSerialError);
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
  await probe(options);
}

if (require.main === module) {
  main().catch((error) => {
    const code = error && typeof error.code === 'string' ? error.code : 'GNSS_PROBE_FAILED';
    console.error(`GNSS probe failed: ${code}`);
    process.exitCode = 1;
  });
}

module.exports = {
  collectGnssResponse,
  parseArgs,
  probe,
  usage
};
