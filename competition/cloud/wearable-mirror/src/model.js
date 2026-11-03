'use strict';

/**
 * model.js — 随身 SOS 的镜像状态机（纯逻辑、无 I/O，便于单测）。
 *
 * 契约（DESIGN-CONTRACT.md）在本模块的落点：
 *   - 设备只在**自己的真实回执** `t:"ack"` 且 alarm 与当前事件一致时才能进入 ACKED；
 *     hb 的 IDLE、超时、静音、APP 点击都**不能**推断 ACKED（只记诊断计数并保持 ALARM）。
 *   - 同一 alarmId 的重试包只保留一条事件（eventTs 固定为第一次收到的时间），
 *     不同 alarmId 才是新事件。
 *   - 位置：有 fix 才 valid:true；无 fix 时 valid:false 且经纬度 null，绝不用 0 冒充。
 *     本次事件未 ACK 前 gps 冻结为“求助时刻位置”，ACK 后才跟随最新位置。
 *   - 房间固定“随身求助”，deviceId 固定 esp32-sos；不含任何伪造的 PIR/门磁/温湿度。
 *
 * 数据源两种（--source）：
 *   mqtt —— 直接消费设备上行（sos/hb/ack/boot + M100 固定格式 GPS），最权威；
 *   api  —— 轮询公网 APP-API 的镜像（设备状态/告警/定位），ACKED 由后端在真实设备回执后置位。
 * 两者共用同一状态机与状态行格式，APP 侧无需区分。
 */

const { parseFixedFormat, normalizeEventGps } = require('./gps');

const ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const DEVICE_ID = 'esp32-sos';
const ROOM = '随身求助';
const ALARM_TYPE = 'MANUAL_SOS';
const KNOWN_ALARM_LIMIT = 200;
const INVALID_GPS = Object.freeze({ valid: false, latitude: null, longitude: null, fixTime: 0 });

function upper(value) {
  return typeof value === 'string' ? value.toUpperCase() : '';
}

class WearableMirrorModel {
  constructor(options = {}) {
    this.deviceId = DEVICE_ID;
    this.room = ROOM;
    this.alarmType = ALARM_TYPE;
    this.offlineAfterMs = Number.isFinite(options.offlineAfterMs) ? options.offlineAfterMs : 45000;
    this.knownAlarmLimit = Number.isFinite(options.knownAlarmLimit) ? options.knownAlarmLimit : KNOWN_ALARM_LIMIT;
    this.reset();
  }

  reset() {
    this.source = 'unknown';
    this.event = null;                 // 当前（最近）事件：{alarmId,eventTs,gps,gpsSource,acked,ackTs,ackedBy,seq,uptimeMs}
    this.latestGps = null;             // 最新位置（M100 固定格式 / 业务 JSON gps / 后端定位）
    this.latestGpsSource = 'none';
    this.lastDeviceMsgAt = 0;          // 用于“是否在线”判定的设备最近数据时间
    this.lastSeenPcMs = 0;             // PC 侧真正收到“新数据”的毫秒时间（对外 lastSeen 字段）
    this.apiDeviceState = '';          // API 数据源最近一次后端设备状态（ALARM/ACKED/NORMAL）
    this.lastSosAt = 0;
    this.bootAt = 0;
    this.firmware = '';
    this.csq = 0;
    this.apiOnline = null;
    this.knownAlarmIds = new Set();
    this.onlineState = false;
    this.counters = {
      payloads: 0, business: 0, sos: 0, sosRetransmit: 0, sosStale: 0,
      hb: 0, ack: 0, ackStale: 0, ackDuplicate: 0, boot: 0,
      gpsOk: 0, gpsReject: 0, malformed: 0, foreignDevice: 0,
      hbIdleWhileAlarm: 0, hbAlarmMismatch: 0, apiPolls: 0, apiSnapshots: 0
    };
    this.lastReject = null;            // 最近一次 GPS/解析失败：{kind,code,at}（只用于诊断）
  }

  touch(now) {
    const wasOnline = this.onlineState;
    this.lastDeviceMsgAt = now;
    this.lastSeenPcMs = now;
    this.onlineState = true;
    return wasOnline === false && this.counters.payloads > 0;
  }

  online(now) {
    if (this.apiOnline === false) return false;
    if (this.lastDeviceMsgAt <= 0) return false;
    return now - this.lastDeviceMsgAt <= this.offlineAfterMs;
  }

  phase() {
    if (this.event !== null) return this.event.acked ? 'ACKED' : 'ALARM';
    /* API 数据源：后端设备状态已经是 ALARM 但告警列表尚未同步到本机时，
       不把“异常中”降级成 NORMAL（宁可少一张卡，也不谎报一切正常）。 */
    if (this.source === 'api' && this.apiDeviceState === 'ALARM') return 'ALARM';
    return 'NORMAL';
  }

  /** 事件未 ACK：冻结求助时刻位置；ACK 后：跟随最新位置 */
  visibleGps() {
    if (this.event !== null && !this.event.acked && this.event.gps !== null) {
      return this.event.gps;
    }
    if (this.latestGps !== null) return this.latestGps;
    return INVALID_GPS;
  }

  rememberAlarm(alarmId) {
    this.knownAlarmIds.add(alarmId);
    while (this.knownAlarmIds.size > this.knownAlarmLimit) {
      const first = this.knownAlarmIds.values().next();
      if (first.done) break;
      this.knownAlarmIds.delete(first.value);
    }
  }

  /**
   * MQTT 上行 payload 入口：先按业务 JSON，再按 M100 GPS 固定格式。
   * @returns {{kind:string,changed:boolean,code?:string}}
   */
  onPayload(payload, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    this.counters.payloads += 1;
    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload === undefined || payload === null ? '' : payload);
    const trimmed = text.replace(/\u0000/g, '').trim();
    if (trimmed === '') {
      this.counters.malformed += 1;
      return { kind: 'empty', changed: false, code: 'EMPTY_PAYLOAD' };
    }
    if (trimmed.startsWith('{')) {
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        /* 契约 §5.4：M100 分帧可能把一行 JSON 拆成两条 MQTT 消息，其中一条必然解析失败。
           只计诊断，绝不猜测内容。 */
        this.counters.malformed += 1;
        this.lastReject = { kind: 'json', code: 'MALFORMED_JSON', at: now };
        return { kind: 'malformed', changed: false, code: 'MALFORMED_JSON' };
      }
      return this.onBusiness(obj, now);
    }
    if (trimmed.includes('{') || trimmed.includes('}')) {
      this.counters.malformed += 1;
      this.lastReject = { kind: 'json', code: 'JSON_FRAGMENT', at: now };
      return { kind: 'malformed', changed: false, code: 'JSON_FRAGMENT' };
    }
    return this.onGpsFixed(trimmed, now);
  }

  onBusiness(obj, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      this.counters.malformed += 1;
      return { kind: 'malformed', changed: false, code: 'NOT_OBJECT' };
    }
    const dev = typeof obj.dev === 'string' ? obj.dev : '';
    if (dev !== '' && dev !== this.deviceId) {
      this.counters.foreignDevice += 1;
      return { kind: 'foreign', changed: false, code: 'FOREIGN_DEVICE' };
    }
    this.counters.business += 1;
    const type = typeof obj.t === 'string' ? obj.t.toLowerCase() : '';
    if (type === 'sos') return this.onSos(obj, now);
    if (type === 'hb') return this.onHeartbeat(obj, now);
    if (type === 'ack') return this.onAck(obj, now);
    if (type === 'boot') return this.onBoot(obj, now);
    this.counters.malformed += 1;
    this.lastReject = { kind: 'business', code: 'UNKNOWN_TYPE', at: now };
    return { kind: 'unknown', changed: false, code: 'UNKNOWN_TYPE' };
  }

  onSos(obj, now) {
    const alarmId = typeof obj.alarm === 'string' ? obj.alarm : '';
    if (!ALARM_ID_RE.test(alarmId)) {
      this.counters.malformed += 1;
      this.lastReject = { kind: 'sos', code: 'INVALID_ALARM_ID', at: now };
      return { kind: 'sos-invalid', changed: false, code: 'INVALID_ALARM_ID' };
    }
    const wasOnline = this.touch(now);
    const deviceGps = normalizeEventGps(obj.gps, now);
    this.counters.sos += 1;
    this.lastSosAt = now;

    if (this.event !== null && this.event.alarmId === alarmId) {
      /* 同一 alarmId 重试：eventTs / gps 冻结；只有“首次没拿到设备定位、重试包带了有效定位”
         这一种情况允许补一次，并明确标注来源。 */
      this.counters.sosRetransmit += 1;
      let changed = wasOnline;
      if (!this.event.gps.valid && deviceGps.valid) {
        this.event.gps = Object.freeze(Object.assign({}, deviceGps, { source: 'device-sos-retransmit' }));
        this.event.gpsSource = 'device-sos-retransmit';
        changed = true;
      }
      return { kind: 'sos-retransmit', changed };
    }
    if (this.knownAlarmIds.has(alarmId)) {
      this.counters.sosStale += 1;
      return { kind: 'sos-stale', changed: wasOnline };
    }

    this.rememberAlarm(alarmId);
    let gps;
    let gpsSource;
    if (deviceGps.valid) {
      gps = Object.freeze(Object.assign({}, deviceGps, { source: 'device-sos' }));
      gpsSource = 'device-sos';
      this.latestGps = Object.freeze({
        valid: true,
        latitude: deviceGps.latitude,
        longitude: deviceGps.longitude,
        fixTime: deviceGps.fixTime
      });
      this.latestGpsSource = 'device-sos';
    } else if (this.latestGps !== null) {
      gps = Object.freeze(Object.assign({}, this.latestGps, { source: 'm100-latest' }));
      gpsSource = 'm100-latest';
    } else {
      gps = INVALID_GPS;
      gpsSource = 'none';
    }
    this.event = {
      alarmId,
      eventTs: now,
      gps,
      gpsSource,
      acked: false,
      ackTs: 0,
      ackedBy: '',
      seq: Number.isFinite(obj.seq) ? obj.seq : 0,
      uptimeMs: Number.isFinite(obj.uptimeMs) ? obj.uptimeMs : 0
    };
    return { kind: 'sos-new', changed: true };
  }

  onHeartbeat(obj, now) {
    const wasOnline = this.touch(now);
    this.counters.hb += 1;
    if (Number.isFinite(obj.csq)) this.csq = obj.csq;
    const reported = upper(obj.state);
    const hbAlarm = typeof obj.alarm === 'string' ? obj.alarm : '';
    let changed = wasOnline;
    if (hbAlarm !== '' && hbAlarm !== (this.event === null ? '' : this.event.alarmId)) {
      this.counters.hbAlarmMismatch += 1;
    }
    if (reported === 'IDLE' && this.event !== null && !this.event.acked) {
      /* 设备说 IDLE 但没有 t=ack：可能是设备重启丢失会话，也可能是它误判。
         契约要求“绝不代报确认”，因此保持待处理（ALARM）并留下诊断计数。 */
      this.counters.hbIdleWhileAlarm += 1;
    }
    return { kind: 'hb', changed };
  }

  onAck(obj, now) {
    const wasOnline = this.touch(now);
    this.counters.ack += 1;
    const alarmId = typeof obj.alarm === 'string' ? obj.alarm : '';
    if (!ALARM_ID_RE.test(alarmId)) {
      this.counters.ackStale += 1;
      return { kind: 'ack-stale', changed: wasOnline };
    }
    if (this.event === null || this.event.alarmId !== alarmId) {
      this.counters.ackStale += 1;
      return { kind: 'ack-stale', changed: wasOnline };
    }
    if (this.event.acked) {
      this.counters.ackDuplicate += 1;
      return { kind: 'ack-duplicate', changed: wasOnline };
    }
    const cmd = typeof obj.cmd === 'string' && /^[A-Za-z0-9._:-]{0,64}$/.test(obj.cmd) ? obj.cmd : '';
    this.event = Object.freeze(Object.assign({}, this.event, {
      acked: true,
      ackTs: now,
      ackedBy: 'device-ack',
      ackCmd: cmd
    }));
    return { kind: 'ack', changed: true };
  }

  onBoot(obj, now) {
    const wasOnline = this.touch(now);
    this.counters.boot += 1;
    this.bootAt = now;
    if (typeof obj.fw === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(obj.fw)) this.firmware = obj.fw;
    /* 契约 §6：设备重启后继续用原 alarmId 重试未确认事件 → 镜像不能因为 boot 清事件。 */
    return { kind: 'boot', changed: wasOnline };
  }

  onGpsFixed(text, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const parsed = parseFixedFormat(text);
    if (!parsed.ok) {
      this.counters.gpsReject += 1;
      this.lastReject = { kind: 'gps', code: parsed.code, at: now };
      return { kind: 'gps-reject', changed: false, code: parsed.code };
    }
    const visibleBefore = JSON.stringify(this.visibleGps());
    this.latestGps = Object.freeze({
      valid: true,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      fixTime: now
    });
    this.latestGpsSource = `m100-${parsed.format || 'fixed'}`;
    this.counters.gpsOk += 1;
    this.lastDeviceMsgAt = now;
    this.lastSeenPcMs = now;
    this.onlineState = true;
    const visibleAfter = JSON.stringify(this.visibleGps());
    return { kind: 'gps', changed: visibleBefore !== visibleAfter };
  }

  /**
   * 公网 APP-API 快照（source=api）：
   * @param {{online:boolean|undefined,lastSeenTs:number,gps:object|null,
   *          alarm:null|{id:string,type:string,state:string,createdAt:number,
   *                       acknowledgedAt:number,ackPending:boolean}}} snap
   */
  applyApiSnapshot(snap, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    this.source = 'api';
    this.counters.apiPolls += 1;
    this.counters.apiSnapshots += 1;
    let changed = false;

    if (typeof snap.state === 'string' && snap.state !== '') {
      this.apiDeviceState = upper(snap.state);
    }
    if (typeof snap.online === 'boolean') {
      if (this.apiOnline !== snap.online) {
        this.apiOnline = snap.online;
        changed = true;
      }
    }
    if (Number.isFinite(snap.lastSeenTs) && snap.lastSeenTs > 0) {
      if (snap.lastSeenTs > this.lastDeviceMsgAt) {
        this.lastDeviceMsgAt = snap.lastSeenTs;
        /* 设备数据在 PC 侧“新到”的时刻（不是后端 lastSeenTs 本身，避免把服务器时钟当成本机时钟） */
        this.lastSeenPcMs = now;
        changed = true;
      }
    }

    const gps = snap.gps;
    if (gps !== null && gps !== undefined && gps.valid === true &&
        typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
      const fixTime = Number.isFinite(gps.fixTime) && gps.fixTime > 0 ? gps.fixTime : now;
      const next = Object.freeze({ valid: true, latitude: gps.latitude, longitude: gps.longitude, fixTime });
      const prev = this.latestGps;
      if (prev === null || prev.valid !== next.valid || prev.latitude !== next.latitude ||
          prev.longitude !== next.longitude || prev.fixTime !== next.fixTime) {
        changed = true;
      }
      this.latestGps = next;
      this.latestGpsSource = 'api-location';
    }

    const alert = snap.alarm;
    if (alert !== null && alert !== undefined && typeof alert.id === 'string' && ALARM_ID_RE.test(alert.id)) {
      const ackedByBackend = upper(alert.state) === 'ACKED';
      const ackTs = Number.isFinite(alert.acknowledgedAt) && alert.acknowledgedAt > 0 ? alert.acknowledgedAt : 0;
      if (this.event !== null && this.event.alarmId === alert.id) {
        if (ackedByBackend && !this.event.acked) {
          /* 后端只有在收到设备真实回执后才会置 ACKED（契约 §5.3），镜像原样跟随。 */
          this.event = Object.freeze(Object.assign({}, this.event, {
            acked: true,
            ackTs: ackTs || now,
            ackedBy: 'device-ack-via-backend'
          }));
          changed = true;
        }
      } else if (!this.knownAlarmIds.has(alert.id)) {
        this.rememberAlarm(alert.id);
        const createdAt = Number.isFinite(alert.createdAt) && alert.createdAt > 0 ? alert.createdAt : now;
        const eventGps = this.latestGps !== null
          ? Object.freeze(Object.assign({}, this.latestGps, { source: 'api-location' }))
          : INVALID_GPS;
        this.event = {
          alarmId: alert.id,
          eventTs: createdAt,
          gps: eventGps,
          gpsSource: eventGps.valid ? 'api-location' : 'none',
          acked: ackedByBackend,
          ackTs: ackedByBackend ? (ackTs || now) : 0,
          ackedBy: ackedByBackend ? 'device-ack-via-backend' : '',
          seq: 0,
          uptimeMs: 0
        };
        changed = true;
      }
    }
    /* 后端报 State=NORMAL 且没有新告警时：未确认事件**保持**（绝不静默丢弃）；
       已确认事件保留为“最近事件”，直到下一个事件替换。 */
    const onlineNow = this.online(now);
    if (onlineNow !== this.onlineState) {
      this.onlineState = onlineNow;
      changed = true;
    }
    return { kind: 'api-snapshot', changed };
  }

  /**
   * 生成给 DAYU APP 的状态行（homemon relay / 本地 TCP 同一份）。
   * ts = PC 生成该行的毫秒时间；lastSeen = 最近一次设备数据的毫秒时间。
   */
  buildStatus(nowMs, extra = {}) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const gps = this.visibleGps();
    const event = this.event;
    const online = this.online(now);
    const status = {
      deviceId: this.deviceId,
      room: this.room,
      ts: now,
      state: this.phase(),
      online,
      lastSeen: this.lastSeenPcMs,
      alarm: event === null
        ? { id: '', type: '', countToday: 0 }
        : { id: event.alarmId, type: this.alarmType, countToday: 1 },
      eventTs: event === null ? 0 : event.eventTs,
      acked: event === null ? false : event.acked,
      ackTs: event === null ? 0 : event.ackTs,
      ackSource: event === null ? '' : event.ackedBy,
      gps: {
        valid: gps.valid === true,
        latitude: gps.valid === true ? gps.latitude : null,
        longitude: gps.valid === true ? gps.longitude : null,
        fixTime: gps.valid === true ? gps.fixTime : 0
      },
      sensors: {
        /* Lead 已批准的 homemon 字段契约：无 PIR 设备必须显式 supported=false/reported=false，
           绝不能让 DAYU 把“没有 PIR”当成“长时间无活动”。 */
        motion: { lastActiveTs: 0, countToday: 0, supported: false, reported: false, reason: 'not_configured' },
        door: { open: false, lastOpenTs: 0, supported: false },
        climate: { tempC: 0, rh: 0, ok: true, valid: false, supported: false },
        gas: { raw: 0, ok: true, valid: false, supported: false },
        smoke: { raw: 0, ok: true, valid: false, supported: false }
      },
      history: [0, 0, 0, 0, 0, 0, 0],
      slots: [0, 0, 0, 0],
      source: this.source,
      firmware: this.firmware,
      csq: this.csq,
      mirror: {
        source: this.source,
        gpsSource: this.latestGpsSource,
        eventGpsSource: event === null ? 'none' : event.gpsSource,
        lastRejectCode: this.lastReject === null ? '' : this.lastReject.code
      }
    };
    return Object.assign(status, extra);
  }

  /** 用于“状态变化才立即推送”的比较键（不含 ts/lastSeen 这类每帧变化的字段）。 */
  changeKey(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const gps = this.visibleGps();
    return JSON.stringify({
      phase: this.phase(),
      online: this.online(now),
      alarmId: this.event === null ? '' : this.event.alarmId,
      eventTs: this.event === null ? 0 : this.event.eventTs,
      acked: this.event === null ? false : this.event.acked,
      ackTs: this.event === null ? 0 : this.event.ackTs,
      gpsValid: gps.valid === true,
      latitude: gps.valid === true ? gps.latitude : null,
      longitude: gps.valid === true ? gps.longitude : null,
      fixTime: gps.valid === true ? gps.fixTime : 0
    });
  }
}

module.exports = Object.freeze({
  WearableMirrorModel,
  ALARM_ID_RE,
  DEVICE_ID,
  ROOM,
  ALARM_TYPE,
  INVALID_GPS
});
