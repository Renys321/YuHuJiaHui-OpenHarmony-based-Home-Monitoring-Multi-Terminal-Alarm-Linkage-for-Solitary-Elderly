'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ALARM_ID_RE, DEVICE_ID_RE, EVIDENCE_ID_RE } = require('./store');

const INDEX_SCHEMA_VERSION = 1;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function fail(message, code = 'EVIDENCE_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function atomicWrite(filePath, payload, encoding) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, payload, encoding ? { encoding } : undefined);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* 保留原始错误 */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* 临时文件可能还不存在 */ }
    throw error;
  }
}

function validateJpeg(payload) {
  if (!Buffer.isBuffer(payload)) fail('evidence body must be binary');
  if (payload.length < 5 || payload.length > MAX_JPEG_BYTES) fail('invalid evidence size');
  if (payload[0] !== 0xff || payload[1] !== 0xd8 || payload[2] !== 0xff ||
      payload[payload.length - 2] !== 0xff || payload[payload.length - 1] !== 0xd9) {
    fail('invalid JPEG');
  }
}

function publicMetadata(record) {
  if (!record) return null;
  return {
    available: Boolean(record.alarmId),
    evidenceId: record.evidenceId,
    deviceId: record.deviceId,
    alarmId: record.alarmId,
    contentType: 'image/jpeg',
    bytes: record.bytes,
    sha256: record.sha256,
    capturedAt: record.capturedAt,
    uploadedAt: record.uploadedAt
  };
}

class EvidenceStore {
  constructor(options = {}) {
    if (!isPlainObject(options)) fail('evidence options must be an object');
    if (typeof options.directory !== 'string' || !options.directory.trim()) {
      fail('evidence directory is required');
    }
    this.directory = path.resolve(options.directory);
    this.indexPath = path.join(this.directory, 'index.json');
    this.maxEvents = options.maxEvents === undefined ? DEFAULT_MAX_EVENTS : options.maxEvents;
    this.retentionMs = options.retentionMs === undefined ? DEFAULT_RETENTION_MS : options.retentionMs;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1 || this.maxEvents > 10000) {
      fail('evidence maxEvents must be an integer in [1, 10000]');
    }
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 60000) {
      fail('evidence retentionMs must be at least 60000');
    }
    fs.mkdirSync(this.directory, { recursive: true });
    this.records = new Map();
    this._load();
    this.prune(this.now());
  }

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.indexPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      fail('evidence store unreadable', 'EVIDENCE_STORAGE');
    }
    let document;
    try { document = JSON.parse(text); } catch { fail('evidence store corrupt: invalid JSON'); }
    if (!isPlainObject(document) || document.schemaVersion !== INDEX_SCHEMA_VERSION ||
        !Array.isArray(document.records)) {
      fail('evidence store corrupt: invalid index');
    }
    for (const raw of document.records) {
      const record = this._recordFromDocument(raw);
      if (this.records.has(record.evidenceId)) fail('evidence store corrupt: duplicate evidence id');
      this._readVerified(record, 'evidence store corrupt');
      this.records.set(record.evidenceId, record);
    }
  }

  _recordFromDocument(raw) {
    if (!isPlainObject(raw) || !EVIDENCE_ID_RE.test(raw.evidenceId || '') ||
        !DEVICE_ID_RE.test(raw.deviceId || '')) fail('evidence store corrupt: invalid record');
    if (raw.alarmId && !ALARM_ID_RE.test(raw.alarmId)) fail('evidence store corrupt: invalid alarm binding');
    if (!Number.isSafeInteger(raw.uploadedAt) || raw.uploadedAt < 0 ||
        !Number.isSafeInteger(raw.capturedAt) || raw.capturedAt < 0 ||
        !Number.isSafeInteger(raw.bytes) || raw.bytes < 5 || raw.bytes > MAX_JPEG_BYTES ||
        typeof raw.sha256 !== 'string' || !/^[A-F0-9]{64}$/.test(raw.sha256)) {
      fail('evidence store corrupt: invalid metadata');
    }
    return {
      evidenceId: raw.evidenceId,
      deviceId: raw.deviceId,
      alarmId: raw.alarmId || '',
      capturedAt: raw.capturedAt,
      uploadedAt: raw.uploadedAt,
      bytes: raw.bytes,
      sha256: raw.sha256
    };
  }

  _filePath(evidenceId) {
    if (!EVIDENCE_ID_RE.test(evidenceId || '')) fail('invalid evidence id');
    return path.join(this.directory, `${evidenceId}.jpg`);
  }

  _readVerified(record, prefix = 'evidence storage') {
    try {
      const filePath = this._filePath(record.evidenceId);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`${prefix}: invalid JPEG file`);
      const payload = fs.readFileSync(filePath);
      validateJpeg(payload);
      const sha256 = crypto.createHash('sha256').update(payload).digest('hex').toUpperCase();
      if (payload.length !== record.bytes || sha256 !== record.sha256) {
        fail(`${prefix}: JPEG integrity mismatch`);
      }
      return payload;
    } catch (error) {
      if (error && error.code === 'EVIDENCE_INVALID') {
        error.code = 'EVIDENCE_STORAGE';
        throw error;
      }
      if (error && !error.code) error.code = 'EVIDENCE_STORAGE';
      throw error;
    }
  }

  _document() {
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      savedAt: this.now(),
      records: [...this.records.values()]
    };
  }

  _flush() {
    try {
      atomicWrite(this.indexPath, `${JSON.stringify(this._document(), null, 2)}\n`, 'utf8');
    } catch (error) {
      if (!error.code) error.code = 'EVIDENCE_STORAGE';
      throw error;
    }
  }

  upload(evidenceId, deviceId, payload, expectedSha256 = '') {
    if (!EVIDENCE_ID_RE.test(evidenceId || '')) fail('invalid evidence id');
    if (!DEVICE_ID_RE.test(deviceId || '')) fail('invalid deviceId');
    this.prune(this.now());
    validateJpeg(payload);
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex').toUpperCase();
    if (expectedSha256 && (!/^[A-Fa-f0-9]{64}$/.test(expectedSha256) ||
        expectedSha256.toUpperCase() !== sha256)) fail('evidence SHA-256 mismatch');
    const existing = this.records.get(evidenceId);
    if (existing) {
      if (existing.deviceId !== deviceId || existing.sha256 !== sha256 || existing.bytes !== payload.length) {
        fail('evidence id content conflict', 'EVIDENCE_CONFLICT');
      }
      return { created: false, metadata: publicMetadata(existing) };
    }

    const capturedToken = evidenceId.split('-')[1];
    const capturedAt = Number(capturedToken);
    const record = {
      evidenceId,
      deviceId,
      alarmId: '',
      capturedAt: Number.isSafeInteger(capturedAt) ? capturedAt : 0,
      uploadedAt: this.now(),
      bytes: payload.length,
      sha256
    };
    const filePath = this._filePath(evidenceId);
    atomicWrite(filePath, payload);
    this.records.set(evidenceId, record);
    try {
      this._flush();
    } catch (error) {
      this.records.delete(evidenceId);
      try { fs.unlinkSync(filePath); } catch { /* 回滚尽力而为 */ }
      throw error;
    }
    /* 保留期清理是第二步、可重试的操作：即使它失败，重传这个幂等 ID
       也不会覆盖或错绑刚写入的 JPEG。 */
    this.prune(this.now());
    return { created: true, metadata: publicMetadata(record) };
  }

  bind(evidenceId, deviceId, alarmId) {
    this.checkBinding(evidenceId, deviceId, alarmId);
    const record = this.records.get(evidenceId);
    if (!record) return false;
    if (record.alarmId === alarmId) return true;
    record.alarmId = alarmId;
    try { this._flush(); } catch (error) { record.alarmId = ''; throw error; }
    return true;
  }

  checkBinding(evidenceId, deviceId, alarmId) {
    if (!EVIDENCE_ID_RE.test(evidenceId || '') || !DEVICE_ID_RE.test(deviceId || '') ||
        !ALARM_ID_RE.test(alarmId || '')) fail('invalid evidence binding');
    const record = this.records.get(evidenceId);
    if (!record) return false;
    if (record.deviceId !== deviceId) fail('evidence device binding mismatch', 'EVIDENCE_CONFLICT');
    if (record.alarmId && record.alarmId !== alarmId) {
      fail('evidence alarm binding conflict', 'EVIDENCE_CONFLICT');
    }
    return true;
  }

  forAlert(alert) {
    if (!alert || !alert.evidenceId) return null;
    const record = this.records.get(alert.evidenceId);
    if (!record || record.deviceId !== alert.deviceId || record.alarmId !== alert.alarmId) return null;
    if (this.now() - record.uploadedAt > this.retentionMs) return null;
    return publicMetadata(record);
  }

  readForAlert(alert) {
    const metadata = this.forAlert(alert);
    if (!metadata) return null;
    const record = this.records.get(metadata.evidenceId);
    return { metadata, payload: this._readVerified(record) };
  }

  prune(now = this.now(), flush = true) {
    const ordered = [...this.records.values()].sort((a, b) => a.uploadedAt - b.uploadedAt);
    const remove = [];
    for (const record of ordered) {
      if (now - record.uploadedAt > this.retentionMs) remove.push(record);
    }
    const retained = ordered.filter((record) => !remove.includes(record));
    while (retained.length > this.maxEvents) remove.push(retained.shift());
    if (remove.length === 0) {
      this._cleanupOrphans();
      return 0;
    }
    for (const record of remove) this.records.delete(record.evidenceId);
    if (flush) {
      try {
        this._flush();
      } catch (error) {
        for (const record of remove) this.records.set(record.evidenceId, record);
        throw error;
      }
    }
    for (const record of remove) {
      /* 以索引为准。unlink 失败只会留下无人引用的孤儿文件，不会变成可访问记录，
         也不会在保留期提交之后伪造出 API 失败。 */
      try { fs.unlinkSync(this._filePath(record.evidenceId)); } catch { /* 尽力而为 */ }
    }
    this._cleanupOrphans();
    return remove.length;
  }

  _cleanupOrphans() {
    // 只动本模块生成的 JPEG 文件名，顺便清掉崩溃残留和重试失败的 unlink；
    // 目录里的其它文件不碰。
    for (const name of fs.readdirSync(this.directory)) {
      if (!name.endsWith('.jpg')) continue;
      const evidenceId = name.slice(0, -4);
      if (!EVIDENCE_ID_RE.test(evidenceId) || this.records.has(evidenceId)) continue;
      try { fs.unlinkSync(this._filePath(evidenceId)); } catch (_) {
        console.error('[backend] EVIDENCE_ORPHAN_CLEANUP_FAILED');
      }
    }
  }
}

module.exports = {
  DEFAULT_MAX_EVENTS,
  DEFAULT_RETENTION_MS,
  EvidenceStore,
  INDEX_SCHEMA_VERSION,
  MAX_JPEG_BYTES,
  publicMetadata,
  validateJpeg
};
