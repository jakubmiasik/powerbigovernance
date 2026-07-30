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

test('scheduler matches hourly schedules at the configured local minute', () => {
  const slotKey = scheduler._private.getScheduleSlotKey(
    { schedule_type: 'hourly', schedule_minute: 30 },
    { year: 2026, month: 7, day: 29, hour: 9, minute: 30, dayOfWeek: 3 }
  );
  assert.equal(slotKey, '2026-07-29T09:30');
});


test('scheduler matches daily schedules at the exact configured local time', () => {
  const schedule = { schedule_type: 'daily', schedule_hour: 9, schedule_minute: 45 };
  assert.equal(scheduler._private.isDueNow(schedule, { hour: 9, minute: 45, dayOfWeek: 3 }), true);
  assert.equal(scheduler._private.isDueNow(schedule, { hour: 9, minute: 46, dayOfWeek: 3 }), false);
  assert.equal(scheduler._private.isDueNow(schedule, { hour: 10, minute: 45, dayOfWeek: 3 }), false);
});

test('scheduler matches weekly schedules only on the configured day', () => {
  const schedule = { schedule_type: 'weekly', schedule_hour: 9, schedule_minute: 45, schedule_day: 'Wednesday' };
  assert.equal(scheduler._private.isDueNow(schedule, { hour: 9, minute: 45, dayOfWeek: 3 }), true);
  assert.equal(scheduler._private.isDueNow(schedule, { hour: 9, minute: 45, dayOfWeek: 4 }), false);
});

test('scheduler catches up on a due slot that was missed by a few minutes', () => {
  const schedule = { schedule_type: 'daily', schedule_hour: 9, schedule_minute: 45 };
  // 09:52 UTC, seven minutes after the schedule was due.
  const now = new Date(Date.UTC(2026, 6, 29, 9, 52, 30));
  const due = scheduler._private.findDueSlot(schedule, 'UTC', now, 20);
  assert.ok(due, 'expected the missed slot to be picked up');
  assert.equal(due.slotKey, '2026-07-29T09:45');
  assert.equal(due.minutesLate, 7);
  assert.equal(due.dueAt.toISOString(), '2026-07-29T09:45:00.000Z');
});

test('scheduler ignores a due slot older than the catch-up window', () => {
  const schedule = { schedule_type: 'daily', schedule_hour: 9, schedule_minute: 45 };
  const now = new Date(Date.UTC(2026, 6, 29, 10, 30, 0));
  assert.equal(scheduler._private.findDueSlot(schedule, 'UTC', now, 20), null);
});

test('scheduler resolves due slots in the schedule timezone', () => {
  const schedule = { schedule_type: 'daily', schedule_hour: 20, schedule_minute: 0 };
  // 20:00 in Warsaw during summer is 18:00 UTC.
  const due = scheduler._private.findDueSlot(schedule, 'Europe/Warsaw', new Date(Date.UTC(2026, 6, 29, 18, 0, 5)), 20);
  assert.ok(due);
  assert.equal(due.slotKey, '2026-07-29T20:00');
  assert.equal(due.minutesLate, 0);
});

const dbPrivate = require('../src/services/databaseService')._private;

test('analysis run insert includes sp_id so NOT NULL schemas accept it', () => {
  const specs = [
    { column: 'sp_name', param: { name: 'spName' } },
    { column: 'sp_id', param: { name: 'spId' } },
  ];
  assert.equal(
    dbPrivate.buildInsert('analysis_runs', specs, { output: 'INSERTED.id' }),
    'INSERT INTO analysis_runs (sp_name, sp_id) OUTPUT INSERTED.id VALUES (@spName, @spId)'
  );
});

test('schedule edits build a single update statement', () => {
  const specs = [
    { column: 'action', param: { name: 'action' } },
    { column: 'schedule_hour_utc', param: { name: 'hourUtc' } },
  ];
  assert.equal(
    dbPrivate.buildUpdate('capacity_schedules', specs, 'id=@id'),
    'UPDATE capacity_schedules SET action=@action, schedule_hour_utc=@hourUtc WHERE id=@id'
  );
});

test('unsupported columns are detected from missing-column and NOT NULL errors', () => {
  assert.deepEqual(
    dbPrivate.extractProblemColumns({ message: "Invalid column name 'schedule_hour_utc'." }),
    ['schedule_hour_utc']
  );
  assert.deepEqual(
    dbPrivate.extractProblemColumns({
      message: "Cannot insert the value NULL into column 'sp_id', table 'pbigovernance.dbo.analysis_runs'; column does not allow nulls. INSERT fails.",
    }),
    ['sp_id']
  );
  assert.deepEqual(
    dbPrivate.extractProblemColumns({
      message: 'Update failed',
      precedingErrors: [{ message: "Invalid column name 'timezone'." }],
    }),
    ['timezone']
  );
  assert.deepEqual(dbPrivate.extractProblemColumns({ message: 'Timeout expired' }), []);
});
