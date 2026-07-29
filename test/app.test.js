const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-with-enough-length';
process.env.RUN_CACHE_TTL_MS = '1';

const app = require('../src/app');

function request(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

test('health endpoint responds without database access', async () => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const response = await request(server, '/health');
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'healthy');
    assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('security headers are applied', async () => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const response = await request(server, '/health');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

const { convertScheduleToUtc } = require('../src/services/scheduleTimeService');
const scheduler = require('../src/services/schedulerService');

test('hourly schedules expose UTC minute without an hour', () => {
  const utc = convertScheduleToUtc({ scheduleType: 'hourly', hour: 18, minute: 15, timezone: 'UTC' });
  assert.equal(utc.scheduleHourUtc, null);
  assert.equal(utc.scheduleMinuteUtc, 15);
});

test('scheduler resolves persisted UTC fields for hourly schedules', () => {
  const resolved = scheduler._private.resolveScheduleUtc({
    schedule_type: 'hourly',
    schedule_minute_utc: 30,
    schedule_hour_utc: null,
  });
  assert.deepEqual(resolved, { minuteUtc: 30, hourUtc: null, dayUtc: null });
});


test('scheduler normalizes calculated UTC fields before matching due slots', () => {
  const resolved = scheduler._private.resolveScheduleUtc({
    schedule_type: 'daily',
    schedule_hour: 9,
    schedule_minute: 45,
    timezone: 'UTC',
  });
  assert.deepEqual(resolved, { minuteUtc: 45, hourUtc: 9, dayUtc: resolved.dayUtc });
  const slotKey = scheduler._private.getCurrentUtcSlotKey(
    { schedule_type: 'daily' },
    { year: 2026, month: 7, day: 29, hour: 9, minute: 45, dayOfWeek: 3 },
    resolved
  );
  assert.equal(slotKey, '2026-07-29');
});

test('scheduler marks successful schedule results complete', () => {
  assert.equal(scheduler._private.isScheduleResultComplete({ status: 'success', message: 'done' }), true);
});

test('scheduler retries failed or transitional schedule results', () => {
  assert.equal(scheduler._private.isScheduleResultComplete({ status: 'error', message: 'API error' }), false);
  assert.equal(scheduler._private.isScheduleResultComplete({ status: 'skipped', message: 'Capacity in transitional state: Updating' }), false);
});

test('scheduler treats already-target-state skips as complete', () => {
  assert.equal(scheduler._private.isScheduleResultComplete({ status: 'skipped', message: 'Capacity already paused' }), true);
  assert.equal(scheduler._private.isScheduleResultComplete({ status: 'skipped', message: 'Capacity already active' }), true);
});
