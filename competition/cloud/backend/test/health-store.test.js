'use strict';

/**
 * health-store.test.js — 健康资料独立存储单元测试
 *
 * 覆盖：
 *   - 首次启动不创建文件、无资料返回 null；
 *   - put/get 往返、服务端 updatedAt、文件 version=1、快照无 sub/openid；
 *   - 写入失败回滚（内存回到写前状态，磁盘保持旧内容）；
 *   - 启动严格校验：非法 JSON / 未知顶层字段 / 版本不符 / savedAt 非法 /
 *     profiles 非对象 / ownerRef 键非法 / profile 非白名单或未规范化或越界 → 拒绝加载；
 *   - 跨实例重启持久化；
 *   - 非法 ownerRef / 非对象资料 → 抛错且错误信息不含资料值。
 *
 * 全部使用临时目录与临时密钥，不访问网络。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { HEALTH_FILE_VERSION, HealthStore } = require('../src/health-store');
const { PROFILE_FIELDS, healthOwnerRefFor } = require('../src/health-profile');

const SECRET = 'health-store-test-secret-at-least-32-characters';
const OWNER = healthOwnerRefFor(SECRET, 'openid-health-store-owner');
const OWNER_OTHER = healthOwnerRefFor(SECRET, 'openid-health-store-other');

function tempFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'health-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'health-state.json');
}

function readDocument(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validProfile() {
  return {
    age: 72,
    medicalHistory: ' 高血压 ',
    medications: '',
    heightCm: 165.4,
    weightKg: 62,
    restingBloodPressure: '135/82',
    fastingGlucose: '6.1',
    sleep: { hours: 7.5, difficulty: false, nightAwakenings: 0 },
    diet: { taste: 'light', restrictions: '少油' },
    exercise: { timesPerWeek: 0, types: '散步' },
    smoking: '不吸烟',
    vision: null
  };
}

test('health store starts empty without creating a file and returns null', (t) => {
  const filePath = tempFile(t);
  const store = new HealthStore({ filePath });
  assert.equal(fs.existsSync(filePath), false, 'constructor must not create the state file');
  assert.equal(store.get(OWNER), null);
  assert.equal(store.count(), 0);
  assert.equal(store.has(OWNER), false);
});

test('health store put/get round-trips a normalized profile with server updatedAt', (t) => {
  const filePath = tempFile(t);
  const clock = { value: 1790000000000 };
  const store = new HealthStore({ filePath, now: () => clock.value });

  const stored = store.put(OWNER, validProfile());
  assert.equal(stored.updatedAt, 1790000000000);
  assert.equal(stored.medicalHistory, '高血压', 'strings are trimmed');
  assert.equal('medications' in stored, false, 'empty string must never be persisted');
  assert.equal('vision' in stored, false, 'null is treated as unfilled');
  assert.equal(stored.sleep.nightAwakenings, 0, 'numeric 0 is a real value');
  assert.equal(stored.exercise.timesPerWeek, 0, 'numeric 0 is a real value');
  assert.equal(stored.diet.taste, 'light');

  const expectedKeys = [
    'age', 'medicalHistory', 'heightCm', 'weightKg', 'restingBloodPressure', 'fastingGlucose',
    'sleep', 'diet', 'exercise', 'smoking', 'updatedAt'
  ];
  assert.deepEqual(Object.keys(stored), expectedKeys);

  const loaded = store.get(OWNER);
  assert.deepEqual(loaded, stored);
  // get() returns a copy: mutating it must not change stored state.
  loaded.age = 1;
  assert.equal(store.get(OWNER).age, 72);

  const document = readDocument(filePath);
  assert.equal(document.version, HEALTH_FILE_VERSION);
  assert.equal(typeof document.savedAt, 'number');
  assert.deepEqual(Object.keys(document.profiles), [OWNER]);
  assert.equal(OWNER.startsWith('h1_'), true);
  const text = fs.readFileSync(filePath, 'utf8');
  assert.equal(text.includes('openid-health-store-owner'), false, 'snapshot must never contain sub/openid');
  assert.equal(text.includes('openid'), false);
  // 只写入白名单字段：不会出现空字符串占位。
  assert.equal(text.includes('""'), false);
});

test('health store always writes updatedAt from the server clock and ignores client attempts', (t) => {
  const filePath = tempFile(t);
  const clock = { value: 1790000000123 };
  const store = new HealthStore({ filePath, now: () => clock.value });
  const stored = store.put(OWNER, { age: 72, updatedAt: 1 });
  assert.equal(stored.updatedAt, 1790000000123);
  assert.equal(stored.age, 72);

  clock.value = 1790000000999;
  const next = store.put(OWNER, { age: 73 });
  assert.equal(next.updatedAt, 1790000000999, 'every save refreshes the server timestamp');
  assert.equal(store.get(OWNER).age, 73);
});

test('health store rolls back the in-memory state when the atomic write fails', (t) => {
  const filePath = tempFile(t);
  const state = { fail: false };
  const atomicWriter = (target, text) => {
    if (state.fail) {
      const error = new Error('disk on fire');
      error.code = 'EIO';
      throw error;
    }
    fs.writeFileSync(target, text);
  };
  const store = new HealthStore({ filePath, now: () => 1790000000000, atomicWriter });
  const first = store.put(OWNER, { age: 72, medicalHistory: '高血压' });
  const beforeText = fs.readFileSync(filePath, 'utf8');

  state.fail = true;
  assert.throws(
    () => store.put(OWNER, { age: 73, medicalHistory: 'SENSITIVE-MARKER' }),
    (error) => error.code === 'EIO' && !error.message.includes('SENSITIVE-MARKER')
  );
  assert.deepEqual(store.get(OWNER), first, 'memory must roll back to the previous profile');
  assert.equal(store.count(), 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), beforeText, 'disk must keep the previous content');
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('SENSITIVE-MARKER'), false);

  // 恢复后可继续正常保存。
  state.fail = false;
  const next = store.put(OWNER, { age: 74 });
  assert.equal(next.age, 74);
  assert.deepEqual(store.get(OWNER), next);
});

test('health store keeps owners isolated', (t) => {
  const filePath = tempFile(t);
  const store = new HealthStore({ filePath });
  store.put(OWNER, { age: 72, medicalHistory: '高血压' });
  assert.equal(store.get(OWNER_OTHER), null);
  store.put(OWNER_OTHER, { age: 66, mood: '平稳' });
  assert.equal(store.get(OWNER).age, 72);
  assert.equal(store.get(OWNER_OTHER).age, 66);
  const document = readDocument(filePath);
  assert.deepEqual(Object.keys(document.profiles).sort(), [OWNER, OWNER_OTHER].sort());
  assert.notEqual(OWNER, OWNER_OTHER);
});

test('health store reloads persisted profiles across instances (restart)', (t) => {
  const filePath = tempFile(t);
  const first = new HealthStore({ filePath, now: () => 1790000000000 });
  const stored = first.put(OWNER, validProfile());

  const second = new HealthStore({ filePath });
  assert.deepEqual(second.get(OWNER), stored, 'restart must restore exactly what was saved');
  assert.equal(second.count(), 1);
});

test('health store rejects invalid owner refs and non-object profiles', (t) => {
  const filePath = tempFile(t);
  const store = new HealthStore({ filePath });
  for (const bad of ['', 'r1_' + 'A'.repeat(43), 'h1_short', 'openid-owner', null, undefined, 123]) {
    assert.equal(store.get(bad), null);
    assert.throws(
      () => store.put(bad, { age: 72 }),
      (error) => error.code === 'HEALTH_PROFILE_INVALID'
    );
  }
  assert.throws(
    () => store.put(OWNER, 'not-an-object'),
    (error) => error.code === 'HEALTH_PROFILE_INVALID' && !error.message.includes('not-an-object')
  );
  assert.throws(
    () => store.put(OWNER, { idCard: '110101199001011234', age: 72 }),
    (error) => error.code === 'HEALTH_PROFILE_INVALID' && !error.message.includes('110101')
  );
});

function writeRaw(filePath, value) {
  fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value));
}

function documentWith(profile) {
  return { version: HEALTH_FILE_VERSION, savedAt: 1790000000000, profiles: { [OWNER]: profile } };
}

test('health store fails closed on corrupt or non-whitelisted files', (t) => {
  const cases = [
    { name: 'invalid JSON', content: '{not json', pattern: /health store corrupt: invalid JSON/ },
    { name: 'root not object', content: '[]', pattern: /root must be an object/ },
    {
      name: 'unknown top-level field',
      content: { version: 1, savedAt: 1, profiles: {}, extra: true },
      pattern: /unknown top-level field/
    },
    {
      name: 'unsupported version',
      content: { version: 2, savedAt: 1, profiles: {} },
      pattern: /unsupported version/
    },
    {
      name: 'invalid savedAt',
      content: { version: 1, savedAt: -1, profiles: {} },
      pattern: /savedAt must be a non-negative safe integer/
    },
    {
      name: 'profiles not object',
      content: { version: 1, savedAt: 1, profiles: [] },
      pattern: /profiles must be an object/
    },
    {
      name: 'invalid owner ref key',
      content: { version: 1, savedAt: 1, profiles: { 'openid-leaky': { age: 72, updatedAt: 1 } } },
      pattern: /invalid owner ref key/
    },
    {
      name: 'unknown profile field',
      content: documentWith({ age: 72, idCard: '110101199001011234', updatedAt: 1 }),
      pattern: /invalid profile/
    },
    {
      name: 'missing updatedAt',
      content: documentWith({ age: 72 }),
      pattern: /invalid profile/
    },
    {
      name: 'out of range age',
      content: documentWith({ age: 999, updatedAt: 1 }),
      pattern: /invalid profile/
    },
    {
      name: 'not normalized text',
      content: documentWith({ age: 72, medicalHistory: ' 高血压 ', updatedAt: 1 }),
      pattern: /not normalized/
    },
    {
      name: 'empty string stored',
      content: documentWith({ age: 72, medicalHistory: '', updatedAt: 1 }),
      pattern: /invalid profile|not normalized/
    }
  ];
  for (const item of cases) {
    const filePath = tempFile(t);
    writeRaw(filePath, item.content);
    assert.throws(
      () => new HealthStore({ filePath }),
      (error) => item.pattern.test(error.message),
      `expected load to fail for case: ${item.name}`
    );
    // 加载失败不得回显资料值/键值。
    try {
      new HealthStore({ filePath });
    } catch (error) {
      assert.equal(error.message.includes('110101199001011234'), false, item.name);
      assert.equal(error.message.includes('openid-leaky'), false, item.name);
      assert.equal(error.message.includes('高血压'), false, item.name);
    }
  }
});

test('health store fails closed when the file contains too many owner refs', (t) => {
  const filePath = tempFile(t);
  const profiles = {};
  for (let index = 0; index < 1025; index += 1) {
    profiles[healthOwnerRefFor(SECRET, `openid-flood-${index}`)] = { age: 72, updatedAt: 1 };
  }
  writeRaw(filePath, { version: HEALTH_FILE_VERSION, savedAt: 1, profiles });
  assert.throws(() => new HealthStore({ filePath }), /too many profiles/);
});

test('health store reports unreadable paths with the fs error code only', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'health-store-dir-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // 把目录当文件读：EISDIR/EPERM 等平台相关错误，消息里只允许出现错误码。
  assert.throws(
    () => new HealthStore({ filePath: directory }),
    (error) => /health store unreadable: [A-Z]+/.test(error.message) &&
      error.message.includes(directory) === false
  );
});
