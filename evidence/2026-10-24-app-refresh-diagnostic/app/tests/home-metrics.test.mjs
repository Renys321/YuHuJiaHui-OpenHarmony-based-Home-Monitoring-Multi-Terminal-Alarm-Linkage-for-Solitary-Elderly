import assert from 'node:assert/strict';
import test from 'node:test';

import { HomeMetrics } from './build/view/HomeMetrics.js';
import { AlertView, DeviceView, OverviewView } from './build/view/Models.js';

function device(online, monitorOnline) {
  const d = new DeviceView();
  d.online = online;
  d.monitorOnline = monitorOnline;
  return d;
}

function alert(statusKey) {
  const a = new AlertView();
  a.statusKey = statusKey;
  return a;
}

test('overview unavailable falls back to the same real device list', () => {
  const overview = new OverviewView();
  overview.hasData = false;
  const devices = [device(true, 1), device(true, 0), device(false, -1)];
  assert.equal(HomeMetrics.hasDeviceData(overview, devices, 'partial'), true);
  assert.equal(HomeMetrics.deviceCount(overview, devices), 3);
  assert.equal(HomeMetrics.onlineCount(overview, devices), 2);
  assert.equal(HomeMetrics.monitorOfflineCount(overview, devices), 1);
  assert.equal(HomeMetrics.offlineCount(overview, devices), 1);
});

test('overview success keeps server counts and ranges', () => {
  const overview = new OverviewView();
  overview.hasData = true;
  overview.deviceCount = 5;
  overview.onlineCount = 3;
  overview.monitorOfflineCount = 0;
  const devices = [device(true, 1)];
  assert.equal(HomeMetrics.deviceCount(overview, devices), 5);
  assert.equal(HomeMetrics.onlineCount(overview, devices), 3);
  assert.equal(HomeMetrics.monitorOfflineCount(overview, devices), 0);
});

test('successful empty device response is a real zero, not a dash', () => {
  const overview = new OverviewView();
  overview.hasData = false;
  assert.equal(HomeMetrics.hasDeviceData(overview, [], 'ok'), true);
  assert.equal(HomeMetrics.deviceCount(overview, []), 0);
  assert.equal(HomeMetrics.onlineCount(overview, []), 0);
});

test('failed/unknown empty device data is not treated as zero', () => {
  const overview = new OverviewView();
  overview.hasData = false;
  assert.equal(HomeMetrics.hasDeviceData(overview, [], 'error'), false);
  assert.equal(HomeMetrics.hasDeviceData(overview, [], 'unknown'), false);
});

test('pending count uses alert statusKey, not waiting or device alarm state', () => {
  assert.equal(HomeMetrics.pendingAlertCount([
    alert('pending'), alert('pending'), alert('waiting'), alert('acked'), alert('unknown')
  ]), 2);
});

test('demo/real separation comes from separate AppStorage inputs', () => {
  const realOverview = new OverviewView();
  realOverview.hasData = true;
  realOverview.deviceCount = 5;
  realOverview.onlineCount = 3;
  const demoOverview = new OverviewView();
  demoOverview.hasData = true;
  demoOverview.deviceCount = 2;
  demoOverview.onlineCount = 2;
  assert.equal(HomeMetrics.deviceCount(realOverview, []), 5);
  assert.equal(HomeMetrics.deviceCount(demoOverview, []), 2);
});
