#!/usr/bin/env node
'use strict';

/**
 * Local acceptance: real backend + real protocol agent + DAYU HAP through HDC.
 * Secrets and the temporary persistent snapshot live only under os.tmpdir().
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApiServer } = require('../../cloud/backend/src/server');
const { PersistentStore } = require('../../cloud/backend/src/persistent-store');
const { createSessionToken } = require('../../cloud/backend/src/auth');
const { ownerRefFor } = require('../../cloud/backend/src/comms-core');
const { runOnce } = require('../../southbound/comms-agent');
const { createHdcPlayerRunner } = require('../../southbound/hdc-player');

const DEVICE_ID = 'dayu200-living';
const GUARDIAN_ID = 'acceptance-guardian';

function randomSecret() {
  return crypto.randomBytes(36).toString('base64url');
}

async function readJson(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return body;
}

async function main() {
  const hdcCommand = process.argv[2];
  if (typeof hdcCommand !== 'string' || hdcCommand === '') {
    throw new Error('usage: node dayu-comms-hdc.js <absolute-hdc-path>');
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayu-comms-hdc-'));
  const stateFile = path.join(tempDirectory, 'state.json');
  const tokenSecret = randomSecret();
  const ingestKey = randomSecret();
  const store = new PersistentStore({ filePath: stateFile });
  store.ingest({
    deviceId: DEVICE_ID,
    room: '客厅',
    state: 'NORMAL',
    ts: Date.now()
  });
  const { server } = createApiServer({
    store,
    tokenSecret,
    ingestKey,
    authorizeIdentity: (identity) => identity === GUARDIAN_ID,
    ownerRefForIdentity: (identity) => ownerRefFor(tokenSecret, identity)
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const bearer = createSessionToken(GUARDIAN_ID, tokenSecret);
    const clientMessageId = `accept-${Date.now()}`;

    const created = await readJson(await fetch(`${baseUrl}/api/v1/communications/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        clientMessageId,
        deviceId: DEVICE_ID,
        text: '妈妈，该吃药了',
        voiceId: 'MEDICINE_REMINDER',
        requestAck: true
      })
    }));
    const messageId = created.message.messageId;
    const initialState = created.message.status;

    const events = [];
    const summary = await runOnce({
      baseUrl,
      deviceId: DEVICE_ID,
      ingestKey,
      limit: 1,
      runPlayer: createHdcPlayerRunner({ hdcCommand }),
      log: (event, fields) => events.push({ event, messageId: fields.messageId || '' })
    });

    const fetched = await readJson(await fetch(
      `${baseUrl}/api/v1/communications/messages/${encodeURIComponent(messageId)}`,
      { headers: { authorization: `Bearer ${bearer}` } }
    ));
    const second = await runOnce({
      baseUrl,
      deviceId: DEVICE_ID,
      ingestKey,
      limit: 1,
      runPlayer: async () => { throw new Error('a PLAYED message must not replay'); },
      log: () => {}
    });

    const snapshot = fs.readFileSync(stateFile, 'utf8');
    const privateDataAbsent = !snapshot.includes(GUARDIAN_ID)
      && !snapshot.includes(ingestKey)
      && !snapshot.includes('openid');
    const result = {
      result: summary.played === 1 && summary.failed === 0 && fetched.message.status === 'PLAYED'
        && second.claimed === 0 && privateDataAbsent ? 'PASS' : 'FAIL',
      initialState,
      finalState: fetched.message.status,
      claimed: summary.claimed,
      delivered: summary.delivered,
      played: summary.played,
      failed: summary.failed,
      replayClaimed: second.claimed,
      privateDataAbsent,
      events: events.map((item) => item.event),
      failures: summary.failures
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.result !== 'PASS') process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`dayu comms acceptance failed: ${error && error.message ? error.message : 'error'}\n`);
  process.exitCode = 1;
});
