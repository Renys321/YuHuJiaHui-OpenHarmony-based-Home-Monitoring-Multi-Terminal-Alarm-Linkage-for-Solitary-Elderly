#!/usr/bin/env node
/**
 * activity-accept-check.js — 活动报告本地真实验收核对（真实 HTTP + 真实持久化）。
 *
 * 前提：本机候选后端已启动，且 activity-feed-local.js 已把真实设备状态灌入；
 *       expected.json 由 feeder 输出（它独立按 countToday 正增量口径统计）。
 *
 * 账号口令/会话 token 只从环境变量读取（APP_GUARDIAN_ID / APP_GUARDIAN_PASSWORD），
 * 绝不写入命令行、日志或输出文件；token 只在内存中使用。
 *
 * 用法：
 *   node activity-accept-check.js --backend http://127.0.0.1:18080 \
 *     --expected expected.json --timezone Asia/Shanghai --out check.json [--label before-restart]
 *
 * 输出：JSON（无 token/口令），包含逐项断言 pass/fail 与关键响应摘要。
 */
'use strict';

const fs = require('node:fs');

function parseArgs(argv) {
  const args = { _: argv[2] };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

function requestJson(urlString, options) {
  return new Promise((resolve) => {
    const url = new URL(urlString);
    const http = url.protocol === 'https:' ? require('node:https') : require('node:http');
    const body = options && options.body ? Buffer.from(options.body, 'utf8') : null;
    const headers = Object.assign({ accept: 'application/json' }, (options && options.headers) || {});
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    }
    const req = http.request({
      method: (options && options.method) || 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      timeout: 8000
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 2 * 1024 * 1024) chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, textLength: text.length });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, error: 'TIMEOUT' }); });
    req.on('error', () => resolve({ status: 0, json: null, error: 'NETWORK' }));
    if (body) req.write(body);
    req.end();
  });
}

function todayInZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const pick = (type) => parts.find((p) => p.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function shiftDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map((v) => Number.parseInt(v, 10));
  const base = Date.UTC(y, m - 1, d) + days * 86400000;
  const date = new Date(base);
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function isSafeIntOrNull(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function main() {
  const args = parseArgs(process.argv);
  const backend = (args.backend || 'http://127.0.0.1:18080').replace(/\/$/, '');
  const expectedPath = args.expected;
  const timezone = args.timezone || 'Asia/Shanghai';
  const outPath = args.out;
  const label = args.label || 'check';
  const guardianId = process.env.APP_GUARDIAN_ID || '';
  const password = process.env.APP_GUARDIAN_PASSWORD || '';
  if (!guardianId || !password) {
    console.error('[check] FATAL code=GUARDIAN_ENV_REQUIRED');
    process.exit(2);
  }
  let expected = null;
  if (expectedPath) {
    try {
      expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
    } catch {
      console.error('[check] FATAL code=EXPECTED_UNREADABLE');
      process.exit(2);
    }
  }

  const checks = [];
  const check = (name, pass, detail) => {
    checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail });
  };

  (async () => {
    const startedAt = new Date().toISOString();
    const login = await requestJson(`${backend}/api/v1/auth/app`, {
      method: 'POST',
      body: JSON.stringify({ guardianId, password })
    });
    check('login_200', login.status === 200 && login.json && typeof login.json.sessionToken === 'string',
      { status: login.status });
    if (login.status !== 200 || !login.json || typeof login.json.sessionToken !== 'string') {
      finish(startedAt);
      return;
    }
    const token = login.json.sessionToken;

    const today = todayInZone(timezone);
    const yesterday = shiftDateKey(today, -1);
    const authHeaders = { authorization: `Bearer ${token}` };

    const day = await requestJson(`${backend}/api/v1/activity/report?scope=day&date=${today}`, { headers: authHeaders });
    check('day_200', day.status === 200 && day.json !== null, { status: day.status });
    const dayReport = day.json || {};

    // ---- 结构断言 ----
    check('day_timezone', dayReport.timezone === timezone, { got: dayReport.timezone, expected: timezone });
    check('day_selected_date', dayReport.selectedDate === today, { got: dayReport.selectedDate, expected: today });
    check('day_selected_hourly_len24', Array.isArray(dayReport.selected && dayReport.selected.hourly) &&
      dayReport.selected.hourly.length === 24, { len: dayReport.selected ? (dayReport.selected.hourly || []).length : null });
    check('day_range_7', dayReport.range && dayReport.range.days === 7, { range: dayReport.range });
    check('day_days_len7', Array.isArray(dayReport.days) && dayReport.days.length === 7, { len: (dayReport.days || []).length });
    check('day_previous', dayReport.previous && dayReport.previous.date === yesterday,
      { got: dayReport.previous ? dayReport.previous.date : null, expected: yesterday });
    check('day_count_is_int_or_null', dayReport.selected && isSafeIntOrNull(dayReport.selected.count),
      { count: dayReport.selected ? dayReport.selected.count : undefined });
    check('day_summary_total_int_or_null', dayReport.summary && isSafeIntOrNull(dayReport.summary.total),
      { total: dayReport.summary ? dayReport.summary.total : undefined });
    check('day_disclaimer_mentions_pir',
      typeof dayReport.disclaimer === 'string' && dayReport.disclaimer.indexOf('PIR') >= 0,
      { disclaimer: dayReport.disclaimer });

    // ---- 与 feeder 独立统计的一致性 ----
    let expectedTotal = 0;
    let expectedDevices = 0;
    if (expected && expected.byDevice) {
      for (const entry of Object.values(expected.byDevice)) {
        if (!entry || typeof entry !== 'object') continue;
        const hasMotion = entry.baselineCount !== null && (entry.totalDelta > 0 || entry.resets > 0);
        if (!hasMotion) continue;
        expectedDevices += 1;
        expectedTotal += entry.totalDelta;
      }
    }
    const selected = dayReport.selected || {};
    check('day_count_equals_expected_increment', selected.count === expectedTotal,
      { observed: selected.count, expected: expectedTotal, devices: expectedDevices });
    const hourlySum = Array.isArray(selected.hourly)
      ? selected.hourly.reduce((sum, value) => sum + (Number.isSafeInteger(value) ? value : 0), 0)
      : null;
    check('day_hourly_sum_equals_count', hourlySum === selected.count,
      { hourlySum, count: selected.count });

    // 无数据日：不用 0 冒充。count 为 null 时状态必须是 no_data/insufficient；
    // count 为 0 时必须是真实观测到的 0（status=ok/partial），不能是“无数据被填成 0”。
    const prev = dayReport.previous || {};
    check('yesterday_null_means_no_data',
      !(prev.count === null && prev.status !== 'no_data' && prev.status !== 'insufficient'),
      { previous: prev });
    check('yesterday_zero_must_be_observed',
      !(prev.count === 0 && prev.status !== 'ok' && prev.status !== 'partial'),
      { previous: prev });
    check('previous_missing_does_not_use_zero',
      !(prev.count === null && dayReport.comparison && dayReport.comparison.delta === 0),
      { previous: prev, comparison: dayReport.comparison });

    // ---- 周/月范围 ----
    const week = await requestJson(`${backend}/api/v1/activity/report?scope=week&date=${today}`, { headers: authHeaders });
    check('week_200', week.status === 200 && week.json !== null, { status: week.status });
    if (week.json) {
      check('week_range_7', week.json.range && week.json.range.days === 7, { range: week.json.range });
      check('week_days_len7', Array.isArray(week.json.days) && week.json.days.length === 7);
      check('week_summary_daysWithData', week.json.summary &&
        week.json.summary.daysWithData === week.json.days.filter((d) => typeof d.count === 'number').length,
        { summary: week.json.summary });
    }
    const month = await requestJson(`${backend}/api/v1/activity/report?scope=month&date=${today}`, { headers: authHeaders });
    check('month_200', month.status === 200 && month.json !== null, { status: month.status });
    if (month.json) {
      check('month_range_30', month.json.range && month.json.range.days === 30, { range: month.json.range });
      check('month_days_len30', Array.isArray(month.json.days) && month.json.days.length === 30);
    }

    // ---- 查询边界 ----
    const badScope = await requestJson(`${backend}/api/v1/activity/report?scope=year`, { headers: authHeaders });
    const badDate = await requestJson(`${backend}/api/v1/activity/report?date=2026-02-30`, { headers: authHeaders });
    const noAuth = await requestJson(`${backend}/api/v1/activity/report?scope=day`);
    check('bad_scope_400', badScope.status === 400, { status: badScope.status });
    check('bad_date_400', badDate.status === 400, { status: badDate.status });
    check('no_token_401', noAuth.status === 401, { status: noAuth.status });

    // ---- 历史不足必须如实标记（不得伪造一个月记录） ----
    const dataSince = dayReport.dataSince;
    check('dataSince_present', Number.isSafeInteger(dataSince) && dataSince > 0, { dataSince });
    if (month.json && month.json.summary) {
      const monthSummary = month.json.summary;
      check('month_not_fabricated_full_coverage',
        monthSummary.daysWithData >= 1 && monthSummary.daysWithData <= 2,
        { summary: monthSummary, note: '启用不足 2 天时 daysWithData 必须≤2，且不得伪造 30 天覆盖' });
      check('month_total_matches_observed_days',
        monthSummary.total === expectedTotal,
        { monthTotal: monthSummary.total, observedTodayTotal: expectedTotal,
          note: '当前只有今日有数据，月汇总次数应等于今日次数，而不是编造整月' });
    }

    const result = {
      label,
      startedAt,
      endedAt: new Date().toISOString(),
      backend,
      timezone,
      today,
      yesterday,
      expected: { devicesWithMotion: expectedDevices, totalIncrement: expectedTotal },
      observed: {
        selectedCount: selected.count,
        selectedStatus: selected.status,
        samples: selected.samples,
        coverageRatio: selected.coverageRatio,
        comparison: dayReport.comparison || null,
        trend: dayReport.trend || null,
        dataSince: dayReport.dataSince,
        weekRange: week.json ? week.json.range : null,
        monthSummary: month.json ? month.json.summary : null,
        devices: dayReport.devices || []
      },
      checks,
      pass: checks.every((item) => item.pass),
      notCovered: [
        '公网生产后端部署与手机 APP 真机/模拟器安装：需用户授权后另行验收',
        '跨多日真实历史（周/月）：当前 dataSince 之后不足多日，按“数据覆盖不足”如实标记'
      ]
    };
    finish(startedAt, result);
    function finish(ignored, payload) {
      const body = payload || { label, checks, pass: checks.every((i) => i.pass) };
      if (outPath) {
        try { fs.writeFileSync(outPath, `${JSON.stringify(body, null, 2)}\n`); } catch { /* ignore */ }
      }
      console.log(JSON.stringify({
        label: body.label,
        pass: body.pass,
        checks: body.checks ? body.checks.length : 0,
        failed: (body.checks || []).filter((i) => !i.pass).map((i) => i.name)
      }));
      process.exit(body.pass ? 0 : 1);
    }
  })().catch(() => {
    console.error('[check] FATAL code=CHECK_FAILED');
    process.exit(2);
  });
}

if (require.main === module) main();

module.exports = { shiftDateKey, todayInZone };
