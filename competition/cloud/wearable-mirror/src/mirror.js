'use strict';

/**
 * mirror.js — 编排层：数据源 → 状态机 → 注入通道 + 心跳 + 状态文件 + 单实例锁 + 优雅退出。
 *
 * 推送策略（契约要求）：
 *   - 状态变化：去抖后立即推送；
 *   - 无变化：每 heartbeatMs（默认 10000）推一次心跳，让 DAYU APP 认为设备仍在；
 *   - 重连 / 新客户端接入：通道自动补发**当前**状态一次（不重放历史，不会重复告警）；
 *   - 同一 alarmId 的状态行内容只随状态变化，APP 按 alarm.id 去重（不会记成多条）。
 * 绝不连接 bridge 的 9101 端口（那会经 MQTT→public-sync 回灌后端，形成环路）；
 * 只向 homemon 的 9001 注入 `relay <单行JSON>`。
 */

const fs = require('node:fs');
const path = require('node:path');

const { WearableMirrorModel } = require('./model');
const { RelayTransport, TcpStatusServer } = require('./transport');
const { MqttSource } = require('./source-mqtt');
const { ApiSource } = require('./source-api');
const { InstanceLock } = require('./lock');
const { describeConfig } = require('./config');

function noop() {}

class Mirror {
  constructor(options = {}) {
    this.config = options.config;
    const logSink = typeof options.log === 'function' ? options.log : noop;
    this.log = logSink;
    this.model = new WearableMirrorModel({ offlineAfterMs: this.config.offlineAfterMs });
    this.lock = new InstanceLock(this.config.lockFile);
    this.transports = [];
    this.source = null;
    this.sourceName = '';
    this.running = false;
    this.startedAt = 0;
    this.heartbeatTimer = null;
    this.emitTimer = null;
    this.lastEmitAt = 0;
    this.lastEmitKey = '';
    this.lastLine = '';
    this.emitCount = 0;
    this.changeEmitCount = 0;
    this.heartbeatEmitCount = 0;
    this.sourceSwitches = 0;
    this.fatalError = '';
    this.hasData = false;
  }

  async start() {
    this.lock.acquire();
    this.running = true;
    this.startedAt = Date.now();
    this.log(`[mirror] starting pid=${process.pid} source=${this.config.source} transport=${this.config.transport}`);
    this.log(`[mirror] ${JSON.stringify(describeConfig(this.config))}`);

    if (this.config.transport === 'relay' || this.config.transport === 'both') {
      const relay = new RelayTransport({
        host: this.config.relay.host,
        port: this.config.relay.port,
        log: this.log,
        onStatus: () => this.writeStatusFile()
      });
      this.transports.push(relay);
      relay.start();
    }
    if (this.config.transport === 'tcp' || this.config.transport === 'both') {
      const tcp = new TcpStatusServer({
        host: this.config.tcp.host,
        port: this.config.tcp.port,
        log: this.log,
        onStatus: () => this.writeStatusFile()
      });
      this.transports.push(tcp);
      await tcp.start();
    }

    this.startSource(this.config.source);
    this.heartbeatTimer = setInterval(() => this.tick(), 1000);
    this.writeStatusFile();
    return this;
  }

  startSource(name) {
    if (this.source !== null) {
      this.source.stop();
      this.source = null;
    }
    this.sourceName = name;
    if (name === 'mqtt') {
      this.model.source = 'mqtt';
      this.source = new MqttSource({
        config: this.config,
        model: this.model,
        log: this.log,
        onChanged: (result) => this.onSourceChanged(result),
        onAuthRejected: (info) => this.onMqttRejected(info)
      });
      this.source.start();
      return;
    }
    if (name === 'api') {
      this.model.source = 'api';
      this.source = new ApiSource({
        config: this.config,
        model: this.model,
        log: this.log,
        onChanged: (result) => this.onSourceChanged(result)
      });
      this.source.start();
      return;
    }
    throw new Error(`unknown source ${name}`);
  }

  onMqttRejected(info) {
    this.log(`[mirror] mqtt source rejected (${info.code} ${info.text})`);
    if (this.config.api.guardianId !== '' && this.config.api.password !== '') {
      this.log('[mirror] falling back to API source (read-only, same account as phone APP)');
      this.sourceSwitches += 1;
      this.startSource('api');
      this.writeStatusFile();
    } else {
      this.fatalError = `MQTT_REJECTED_${info.code}`;
      this.log('[mirror] mqtt rejected and no guardian credential for API fallback');
    }
  }

  onSourceChanged(result) {
    if (result === null || typeof result !== 'object') return;
    const firstData = !this.hasData && (this.model.lastDeviceMsgAt > 0 || this.model.lastSeenPcMs > 0);
    if (firstData) {
      this.hasData = true;
      this.log('[mirror] first device data received');
    }
    if (result.changed === true || firstData) this.scheduleEmit();
  }

  scheduleEmit() {
    if (this.emitTimer !== null) return;
    const delay = this.config.emitDebounceMs;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('change');
    }, delay);
  }

  tick() {
    if (!this.running) return;
    const now = Date.now();
    if (!this.hasData) {
      /* 数据源尚未拿到任何真实数据：绝不先推一条“一切正常”。 */
      return;
    }
    const key = this.model.changeKey(now);
    if (key !== this.lastEmitKey) {
      this.emit('change');
      return;
    }
    if (now - this.lastEmitAt >= this.config.heartbeatMs) {
      this.emit('heartbeat');
    }
  }

  emit(reason) {
    if (!this.running) return;
    const now = Date.now();
    const status = this.model.buildStatus(now);
    const line = JSON.stringify(status);
    this.lastEmitAt = now;
    this.lastEmitKey = this.model.changeKey(now);
    this.lastLine = line;
    this.emitCount += 1;
    if (reason === 'heartbeat') this.heartbeatEmitCount += 1;
    else this.changeEmitCount += 1;
    for (const transport of this.transports) {
      if (transport instanceof RelayTransport) transport.sendLine(line);
      else transport.broadcast(line);
    }
    if (reason !== 'heartbeat') {
      this.log(`[mirror] emit(${reason}) state=${status.state} online=${status.online} ` +
        `alarm=${status.alarm.id || '-'} gps=${status.gps.valid ? 'fix' : 'none'} ` +
        `eventTs=${status.eventTs || '-'} ackTs=${status.ackTs || '-'}`);
    }
    this.writeStatusFile();
  }

  writeStatusFile() {
    if (this.config.statusFile === '') return;
    const now = Date.now();
    const payload = {
      schemaVersion: 1,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: now,
      running: this.running,
      source: this.sourceName,
      modelSource: this.model.source,
      hasData: this.hasData,
      phase: this.model.phase(),
      online: this.model.online(now),
      lastEmitAt: this.lastEmitAt,
      emitCount: this.emitCount,
      changeEmitCount: this.changeEmitCount,
      heartbeatEmitCount: this.heartbeatEmitCount,
      sourceSwitches: this.sourceSwitches,
      fatalError: this.fatalError,
      config: describeConfig(this.config),
      model: {
        lastDeviceMsgAt: this.model.lastDeviceMsgAt,
        lastSeenPcMs: this.model.lastSeenPcMs,
        event: this.model.event === null ? null : {
          alarmId: this.model.event.alarmId,
          eventTs: this.model.event.eventTs,
          acked: this.model.event.acked,
          ackTs: this.model.event.ackTs,
          ackedBy: this.model.event.ackedBy,
          gpsSource: this.model.event.gpsSource
        },
        latestGps: this.model.latestGps,
        latestGpsSource: this.model.latestGpsSource,
        lastReject: this.model.lastReject,
        counters: this.model.counters
      },
      sourceStatus: this.source === null ? null : this.source.status(),
      transports: this.transports.map((transport) => transport.status())
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const tmp = `${this.config.statusFile}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.config.statusFile), { recursive: true });
      fs.writeFileSync(tmp, text, { encoding: 'utf8' });
      fs.renameSync(tmp, this.config.statusFile);
    } catch (err) {
      this.log(`[mirror] status file write failed: ${err.code || err.message}`);
    }
  }

  async stop(reason = 'shutdown') {
    if (!this.running) return;
    this.running = false;
    this.log(`[mirror] stopping (${reason})`);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    if (this.source !== null) {
      this.source.stop();
      this.source = null;
    }
    for (const transport of this.transports) transport.stop();
    this.transports = [];
    this.writeStatusFile();
    this.lock.release();
  }

  status() {
    const now = Date.now();
    return {
      running: this.running,
      source: this.sourceName,
      phase: this.model.phase(),
      online: this.model.online(now),
      counters: this.model.counters,
      transport: this.transports.map((transport) => transport.status())
    };
  }
}

module.exports = Object.freeze({ Mirror });
