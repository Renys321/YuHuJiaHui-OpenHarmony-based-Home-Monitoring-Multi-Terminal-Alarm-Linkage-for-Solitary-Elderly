'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PRODUCT_ID = 'I19NBBq4xe';
const outputPath = path.join(__dirname, 'thing-model.onenet-import.json');

function fail(message) {
  throw new Error(message);
}

function stringType(length) {
  return { type: 'string', specs: { length } };
}

function boolType(falseLabel, trueLabel) {
  return {
    type: 'bool',
    specs: { false: falseLabel, true: trueLabel }
  };
}

function numberType(type, min, max, step, unit = '') {
  return {
    type,
    specs: {
      min: String(min),
      max: String(max),
      step: String(step),
      unit
    }
  };
}

function field(identifier, name, dataType) {
  return { identifier, name, dataType };
}

function customProperty(identifier, name, accessMode, dataType, desc = '') {
  return {
    identifier,
    name,
    functionType: 'u',
    accessMode,
    desc,
    dataType,
    functionMode: 'property',
    required: false
  };
}

function structType(specs) {
  return { type: 'struct', specs };
}

const timestampType = () => numberType('int64', 0, 9007199254740991, 1, 'ms');

const gpsFields = () => [
  field('valid', '定位是否有效', boolType('无效', '有效')),
  field('latitude', '纬度', numberType('double', -90, 90, 0.000001, 'deg')),
  field('longitude', '经度', numberType('double', -180, 180, 0.000001, 'deg')),
  field('altitude', '海拔', numberType('float', -1000, 100000, 0.1, 'm')),
  field('fixTime', '定位时间', timestampType())
];

const customProperties = [
  customProperty('deviceId', '设备编号', 'r', stringType(64)),
  customProperty('room', '房间', 'r', stringType(64)),
  customProperty('online', '在线状态', 'r', boolType('离线', '在线')),
  customProperty(
    'state',
    '安全状态',
    'r',
    stringType(16),
    'NORMAL、WARN、ALARM、ACKED或OFFLINE'
  ),
  customProperty('motion', '人体活动', 'r', structType([
    field('lastActiveTs', '最后活动时间', timestampType()),
    field('countToday', '今日活动次数', numberType('int32', 0, 1000000000, 1))
  ])),
  customProperty('door', '门磁', 'r', structType([
    field('open', '是否开启', boolType('关闭', '开启')),
    field('lastOpenTs', '最后开启时间', timestampType())
  ])),
  customProperty('temperature', '温度', 'r', numberType('float', -50, 100, 0.1, 'C')),
  customProperty('humidity', '湿度', 'r', numberType('float', 0, 100, 0.1, '%RH')),
  customProperty('gas', '燃气', 'r', structType([
    field('ok', '是否正常', boolType('异常', '正常')),
    field('raw', '原始值', numberType('float', 0, 1000000000, 0.01))
  ])),
  customProperty('smoke', '烟雾', 'r', structType([
    field('ok', '是否正常', boolType('异常', '正常')),
    field('raw', '原始值', numberType('float', 0, 1000000000, 0.01))
  ])),
  customProperty('fall', '跌倒检测', 'r', structType([
    field('detected', '是否跌倒', boolType('未检测到', '检测到')),
    field('confidence', '置信度', numberType('float', 0, 1, 0.001)),
    field('detectedAt', '检测时间', timestampType())
  ])),
  customProperty('alarm', '当前告警', 'r', structType([
    field('id', '告警编号', stringType(96)),
    field('type', '告警类型', stringType(32)),
    field('countToday', '今日告警数', numberType('int32', 0, 1000000, 1)),
    field('detail', '告警说明', stringType(256))
  ])),
  customProperty('gps', '定位', 'r', structType(gpsFields())),
  customProperty('csq', '蜂窝信号质量', 'r', numberType('int32', 0, 99, 1)),
  customProperty(
    'control',
    '受限控制命令',
    'rw',
    structType([
      field('command', '命令', stringType(16)),
      field('alarmId', '告警编号', stringType(96)),
      field('action', '处置说明', stringType(120)),
      field('noMotionSec', '无活动告警秒数', numberType('int32', 30, 86400, 1, 's')),
      field('reportIntervalSec', '状态上报周期', numberType('int32', 1, 3600, 1, 's'))
    ]),
    '命令仅允许ACK、RESET或SET_CONFIG；设备端必须继续执行白名单校验'
  )
];

const customEvents = [
  {
    identifier: 'safetyAlarm',
    name: '安全告警事件',
    functionType: 'u',
    eventType: 'alert',
    desc: '无活动、紧急按钮、环境、燃气、烟雾或跌倒告警',
    outputData: [
      field('deviceId', '设备编号', stringType(64)),
      field('room', '房间', stringType(64)),
      field('alarmId', '告警编号', stringType(96)),
      field('type', '告警类型', stringType(32)),
      field('countToday', '今日告警数', numberType('int32', 0, 1000000, 1)),
      field('detail', '告警说明', stringType(256)),
      field('gps', '定位', structType(gpsFields()))
    ],
    functionMode: 'event',
    required: false
  }
];

function validateDataType(dataType, insideStruct = false) {
  const allowed = new Set([
    'int32', 'int64', 'float', 'double', 'string', 'struct', 'date',
    'bitMap', 'enum', 'bool', 'array', 'buffer'
  ]);
  if (!dataType || !allowed.has(dataType.type)) {
    fail(`unsupported data type: ${dataType && dataType.type}`);
  }
  if (dataType.type === 'struct') {
    if (insideStruct) fail('OneNET does not allow nested struct fields');
    if (!Array.isArray(dataType.specs) || dataType.specs.length === 0) {
      fail('struct must contain fields');
    }
    const identifiers = new Set();
    for (const item of dataType.specs) {
      if (identifiers.has(item.identifier)) fail(`duplicate struct field: ${item.identifier}`);
      identifiers.add(item.identifier);
      validateDataType(item.dataType, true);
    }
  }
}

function validateModel(model) {
  if (model.version !== '1.0') fail('unexpected model version');
  if (!model.profile || model.profile.productId !== PRODUCT_ID) {
    fail('official export does not match the expected OneNET product');
  }

  const allFunctions = [
    ...model.properties,
    ...model.events,
    ...model.services
  ];
  if (allFunctions.length > 200) fail('OneNET supports at most 200 function points');

  const identifiers = new Set();
  for (const item of allFunctions) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(item.identifier)) {
      fail(`invalid function identifier: ${item.identifier}`);
    }
    if (identifiers.has(item.identifier)) fail(`duplicate function identifier: ${item.identifier}`);
    identifiers.add(item.identifier);
    if (!['s', 'u', 'st'].includes(item.functionType)) {
      fail(`invalid functionType for ${item.identifier}`);
    }
  }

  for (const property of model.properties) {
    if (!['r', 'rw'].includes(property.accessMode)) {
      fail(`invalid accessMode for ${property.identifier}`);
    }
    validateDataType(property.dataType);
  }
  for (const event of model.events) {
    for (const output of event.outputData) validateDataType(output.dataType);
  }
  for (const service of model.services) {
    for (const input of service.input) validateDataType(input.dataType);
    for (const output of service.output) validateDataType(output.dataType);
  }
}

function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    fail('usage: node build-import-model.js <official-export.json>');
  }

  const official = JSON.parse(fs.readFileSync(path.resolve(sourcePath), 'utf8'));
  const model = {
    ...official,
    properties: [...official.properties, ...customProperties],
    events: [...official.events, ...customEvents],
    services: [...official.services],
    combs: Array.isArray(official.combs) ? official.combs : []
  };

  validateModel(model);
  fs.writeFileSync(outputPath, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  process.stdout.write(JSON.stringify({
    outputPath,
    productId: model.profile.productId,
    properties: model.properties.length,
    events: model.events.length,
    services: model.services.length,
    total: model.properties.length + model.events.length + model.services.length
  }));
}

main();
