'use strict';

/**
 * source-mqtt.js — 直接订阅设备上行（契约主路径）。
 *
 * 连接公网 ECS Broker（47.76.70.118:1883）并订阅 UP_TOPIC：
 *   业务 JSON（sos/hb/ack/boot）与 M100 固定格式 GPS 共用同一主题，
 *   交给 WearableMirrorModel.onPayload 分流。
 *
 * 重要限制（已实测）：Broker 用 env MQTT_CLIENT_ID 做**严格白名单**，且同 id 新连接会踢掉设备。
 * 因此镜像必须使用**独立** clientId（默认 wearable-mirror-001），并要求运维在 ECS 的
 * MQTT_CLIENT_ID 里以逗号追加它；被拒绝时（CONNACK rc=5）本模块会触发 onAuthRejected，
 * 由上层决定是否 fallback 到 API 数据源 —— 绝不复用 wearable-sos-001 抢占设备身份。
 */

const { MqttClient } = require('./mqtt-client');

class MqttSource {
  constructor(options = {}) {
    this.config = options.config;
    this.model = options.model;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {};
    this.onAuthRejected = typeof options.onAuthRejected === 'function' ? options.onAuthRejected : () => {};
    this.onFatal = typeof options.onFatal === 'function' ? options.onFatal : () => {};
    this.client = null;
    this.connected = false;
    this.lastMessageAt = 0;
    this.counters = { messages: 0, json: 0, gps: 0, malformed: 0, connects: 0, authRejected: 0 };
  }

  start() {
    const mqtt = this.config.mqtt;
    this.client = new MqttClient({
      host: mqtt.host,
      port: mqtt.port,
      clientId: mqtt.clientId,
      username: mqtt.user,
      password: mqtt.pass,
      topics: [mqtt.upTopic],
      log: (line) => this.log(line),
      onConnect: () => {
        this.connected = true;
        this.counters.connects += 1;
        this.onChanged({ kind: 'mqtt-connect', changed: false });
      },
      onMessage: (topic, payload) => this.handleMessage(topic, payload),
      onAuthRejected: (code, text) => {
        this.connected = false;
        this.counters.authRejected += 1;
        this.log(`[source-mqtt] broker rejected mirror client id (rc=${code}: ${text})`);
        this.onAuthRejected({ code, text });
      },
      onError: (err) => {
        this.log(`[source-mqtt] mqtt error: ${err && (err.code || err.message)}`);
      },
      onDisconnect: () => {
        this.connected = false;
      }
    });
    this.client.start();
    return this;
  }

  handleMessage(topic, payload) {
    if (topic !== this.config.mqtt.upTopic) {
      this.log(`[source-mqtt] ignore unexpected topic ${topic}`);
      return;
    }
    this.counters.messages += 1;
    this.lastMessageAt = Date.now();
    const text = payload.trim();
    if (text.startsWith('{')) this.counters.json += 1;
    else this.counters.gps += 1;
    const result = this.model.onPayload(payload, Date.now());
    if (result.kind === 'malformed') this.counters.malformed += 1;
    this.onChanged(result);
  }

  stop() {
    if (this.client) this.client.stop();
    this.client = null;
    this.connected = false;
  }

  status() {
    return Object.assign({
      kind: 'mqtt',
      connected: this.connected,
      lastMessageAt: this.lastMessageAt,
      client: this.client === null ? null : this.client.status()
    }, this.counters);
  }
}

module.exports = Object.freeze({ MqttSource });
