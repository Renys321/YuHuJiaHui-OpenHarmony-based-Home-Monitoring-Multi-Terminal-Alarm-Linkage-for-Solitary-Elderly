'use strict';

const crypto = require('crypto');

const CODE_RE = /^[A-Za-z0-9_-]{1,256}$/;
const APP_GUARDIAN_ID_RE = /^[A-Za-z0-9._-]{3,64}$/;

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function timingSafeSecretEqual(left, right) {
  const digest = (value) => crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function parseAppGuardianConfig(guardianId, password) {
  const id = typeof guardianId === 'string' ? guardianId.trim() : '';
  const secret = typeof password === 'string' ? password : '';
  if (!APP_GUARDIAN_ID_RE.test(id)) {
    throw new Error('APP_GUARDIAN_ID must be 3-64 characters of [A-Za-z0-9._-]');
  }
  if (secret.length < 32 || secret.length > 256) {
    throw new Error('APP_GUARDIAN_PASSWORD must be 32-256 characters');
  }
  return Object.freeze({ guardianId: id, password: secret, subject: `app:${id}` });
}

function authenticateAppGuardian(body, configured) {
  const guardianId = body && typeof body.guardianId === 'string' ? body.guardianId : '';
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!configured || !APP_GUARDIAN_ID_RE.test(guardianId) || password.length > 256) return null;
  const idMatches = timingSafeSecretEqual(guardianId, configured.guardianId);
  const passwordMatches = timingSafeSecretEqual(password, configured.password);
  return idMatches && passwordMatches ? configured.subject : null;
}

function createSessionToken(openid, secret, nowMs = Date.now(), ttlMs = 2 * 60 * 60 * 1000) {
  if (!openid || typeof openid !== 'string') throw new Error('openid is required');
  if (!secret || secret.length < 32) throw new Error('API_TOKEN_SECRET must be at least 32 characters');
  const payload = encodeJson({ sub: openid, iat: nowMs, exp: nowMs + ttlMs });
  return `${payload}.${sign(payload, secret)}`;
}

function verifySessionToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string' || !secret || secret.length < 32) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !timingSafeTextEqual(signature, sign(payload, secret))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.sub || !Number.isSafeInteger(parsed.exp) || parsed.exp <= nowMs) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

async function exchangeWechatCode(code, options = {}) {
  if (!CODE_RE.test(code || '')) throw new Error('invalid wx.login code');
  const appId = options.appId;
  const appSecret = options.appSecret;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!appId || !appSecret) throw new Error('WeChat server credentials are not configured');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', appId);
  url.searchParams.set('secret', appSecret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`WeChat login HTTP ${response.status}`);
  const result = await response.json();
  if (result.errcode || !result.openid) throw new Error(`WeChat login rejected (${result.errcode || 'missing openid'})`);
  return { openid: result.openid, unionid: result.unionid || null };
}

module.exports = {
  APP_GUARDIAN_ID_RE,
  authenticateAppGuardian,
  createSessionToken,
  exchangeWechatCode,
  parseAppGuardianConfig,
  timingSafeSecretEqual,
  timingSafeTextEqual,
  verifySessionToken
};

