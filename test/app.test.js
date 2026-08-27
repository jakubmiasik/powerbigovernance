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

function postJson(server, path, payload) {
  const { port } = server.address();
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); } catch (err) { reject(new Error('Non-JSON response: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end(body);
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

test('scheduler catches up on a slot missed by hours while the worker was idle', () => {
  const schedule = { schedule_type: 'daily', schedule_hour: 16, schedule_minute: 21 };
  // 19:00 UTC, 159 minutes after the schedule was due — previously dropped entirely.
  const now = new Date(Date.UTC(2026, 6, 29, 19, 0, 0));
  const due = scheduler._private.findDueSlot(schedule, 'UTC', now, 240);
  assert.ok(due, 'expected the long-missed slot to be picked up');
  assert.equal(due.slotKey, '2026-07-29T16:21');
  assert.equal(due.minutesLate, 159);
});

test('scheduler exposes a status snapshot for diagnostics', () => {
  const status = scheduler.getSchedulerStatus();
  assert.equal(typeof status.tickCount, 'number');
  assert.equal(typeof status.started, 'boolean');
  // Default catch-up must survive a recycled/idle App Service worker.
  assert.ok(status.catchUpWindowMinutes >= 240, 'catch-up window should be at least 4 hours');
  assert.equal(status.tickIntervalMs, 60000);
});

const runMetrics = require('../src/services/runMetricsService');

const workspaceDeletion = require('../src/services/workspaceDeletionService');
const dbService = require('../src/services/databaseService');

function stubDeletionDb() {
  const calls = { marked: [], runs: [] };
  const originalMark = dbService.markWorkspaceDeleted;
  const originalRuns = dbService.markWorkspaceDeletedInRuns;
  dbService.markWorkspaceDeleted = async (args) => { calls.marked.push(args); };
  dbService.markWorkspaceDeletedInRuns = async (id) => { calls.runs.push(id); return 1; };
  calls.restore = () => {
    dbService.markWorkspaceDeleted = originalMark;
    dbService.markWorkspaceDeletedInRuns = originalRuns;
  };
  return calls;
}

test('deleting a workspace records deleted state instead of removing the row', async () => {
  const calls = stubDeletionDb();
  try {
    const pbi = { deleteWorkspace: async () => ({}) };
    const result = await workspaceDeletion.deleteWorkspace(pbi, { id: 'ws-1', name: 'Finance', runId: 7 });
    assert.equal(result.success, true);
    assert.equal(calls.marked.length, 1);
    assert.equal(calls.marked[0].workspaceId, 'ws-1');
    assert.deepEqual(calls.runs, ['ws-1']);
  } finally {
    calls.restore();
  }
});

test('a failed API delete is not recorded as deleted', async () => {
  const calls = stubDeletionDb();
  try {
    const pbi = { deleteWorkspace: async () => { throw new Error('API error (403): Forbidden'); } };
    const result = await workspaceDeletion.deleteWorkspace(pbi, { id: 'ws-2', name: 'Sales' });
    assert.equal(result.success, false);
    assert.match(result.message, /403/);
    assert.equal(calls.marked.length, 0, 'state must not be recorded when the API call failed');
  } finally {
    calls.restore();
  }
});

test('batch deletion reports per-workspace outcomes and keeps going after a failure', async () => {
  const calls = stubDeletionDb();
  try {
    const pbi = {
      deleteWorkspace: async (id) => {
        if (id === 'bad') throw new Error('API error (404): Not found');
        return {};
      },
    };
    const summary = await workspaceDeletion.deleteWorkspaces(pbi, [
      { id: 'ws-1', name: 'One' }, { id: 'bad', name: 'Broken' }, { id: 'ws-3', name: 'Three' },
    ]);
    assert.equal(summary.deletedCount, 2);
    assert.equal(summary.failedCount, 1);
    assert.equal(summary.results.length, 3);
    assert.equal(summary.results[1].success, false);
  } finally {
    calls.restore();
  }
});

test('bookkeeping failure after a successful delete still reports success', async () => {
  const calls = stubDeletionDb();
  dbService.markWorkspaceDeleted = async () => { throw new Error('Invalid object name'); };
  try {
    const pbi = { deleteWorkspace: async () => ({}) };
    const result = await workspaceDeletion.deleteWorkspace(pbi, { id: 'ws-9', name: 'Nine' });
    assert.equal(result.success, true, 'the workspace is gone; do not ask the user to retry');
    assert.equal(result.stateRecorded, false);
    assert.match(result.message, /could not be recorded/);
  } finally {
    calls.restore();
  }
});

function sampleRun(overrides) {
  return Object.assign({
    summary: {
      totalWorkspaces: 2, totalItems: 3, totalReports: 2, totalDatasets: 1,
      totalUsers: 2, totalStorageSize: 1024, capacities: [{ id: 'c1' }],
      workspacesOnCapacity: 1, workspacesOnSharedCapacity: 1,
    },
    workspaces: [
      {
        id: 'ws-1', name: 'Finance', state: 'Active', totalItems: 2, reportCount: 2,
        capacitySku: 'F64', licenseType: 'Fabric', capacityId: 'cap-a',
        items: [
          { id: 'i1', name: 'Report A', type: 'Report', creator: { name: 'Ann', upn: 'ann@x.com' } },
          { id: 'i2', name: 'Report B', type: 'Report' },
        ],
        users: [{ name: 'Ann', email: 'ann@x.com', role: 'Admin' }],
      },
      {
        id: 'ws-2', name: 'Sales', state: 'Active', totalItems: 1, datasetCount: 1,
        licenseType: 'Pro',
        items: [{ id: 'i3', name: 'Model', type: 'SemanticModel' }],
        users: [{ name: 'Bob', email: 'bob@x.com', role: 'Viewer' }],
      },
    ],
  }, overrides);
}

test('run totals capture the governance overview numbers', () => {
  const totals = runMetrics.computeRunTotals(sampleRun());
  assert.equal(totals.totalWorkspaces, 2);
  assert.equal(totals.totalReports, 2);
  assert.equal(totals.capacityCount, 1);
  assert.equal(totals.totalStorageSize, 1024);
  // Ann created an item, Bob only has access.
  assert.equal(totals.creatorCount, 1);
  assert.equal(totals.explorerCount, 1);
});

test('summary comparison reports deltas and flags unchanged metrics', () => {
  const before = runMetrics.computeRunTotals(sampleRun());
  const after = runMetrics.computeRunTotals(sampleRun({
    summary: { totalWorkspaces: 3, totalItems: 3, totalReports: 4, capacities: [{ id: 'c1' }] },
  }));
  const rows = runMetrics.diffTotals(before, after);
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));

  assert.equal(byKey.totalWorkspaces.delta, 1);
  assert.equal(byKey.totalWorkspaces.percent, 50);
  assert.equal(byKey.totalReports.delta, 2);
  assert.equal(byKey.totalItems.changed, false);
  assert.equal(byKey.capacityCount.delta, 0);
});

test('detailed diff finds workspace, capacity, access and item churn', () => {
  const from = sampleRun();
  const to = sampleRun();
  // Sales disappears, Marketing appears, Finance loses a report and moves SKU.
  to.workspaces = [
    Object.assign({}, from.workspaces[0], {
      totalItems: 1,
      reportCount: 1,
      capacitySku: 'F128',
      items: [from.workspaces[0].items[0]],
      users: [
        { name: 'Ann', email: 'ann@x.com', role: 'Member' },
        { name: 'Cleo', email: 'cleo@x.com', role: 'Viewer' },
      ],
    }),
    { id: 'ws-3', name: 'Marketing', state: 'Active', totalItems: 1, licenseType: 'Pro', items: [{ id: 'i9', name: 'New', type: 'Report' }], users: [] },
  ];

  const details = runMetrics.diffRunDetails(from, to);

  assert.deepEqual(details.workspaces.added.map(w => w.name), ['Marketing']);
  assert.deepEqual(details.workspaces.removed.map(w => w.name), ['Sales']);
  assert.deepEqual(details.workspaces.changed.map(w => w.name), ['Finance']);
  assert.deepEqual(details.capacityMoves.map(m => [m.fromSku, m.toSku]), [['F64', 'F128']]);

  const financeAccess = details.accessChanges.find(a => a.name === 'Finance');
  assert.deepEqual(financeAccess.added.map(u => u.name), ['Cleo']);
  assert.deepEqual(financeAccess.roleChanged.map(u => [u.from, u.to]), [['Admin', 'Member']]);

  // Report B removed from Finance plus Sales' model; Marketing's item added.
  assert.equal(details.items.removedCount, 2);
  assert.equal(details.items.addedCount, 1);
});

function tenantRun(settings) {
  return { summary: {}, workspaces: [], tenantSettings: settings };
}

test('run totals capture tenant settings and mark whether they were collected', () => {
  const captured = runMetrics.computeRunTotals(tenantRun([
    { settingName: 'A', enabled: true, enabledSecurityGroups: [{ name: 'G1' }] },
    { settingName: 'B', enabled: false, delegateToWorkspace: true },
  ]));
  assert.equal(captured.tenantSettingsCaptured, 1);
  assert.equal(captured.tenantSettingsTotal, 2);
  assert.equal(captured.tenantSettingsEnabled, 1);
  assert.equal(captured.tenantSettingsDisabled, 1);
  assert.equal(captured.tenantSettingsGroupScoped, 1);
  assert.equal(captured.tenantSettingsDelegated, 1);

  // A run from before capture existed must be distinguishable from a tenant with
  // genuinely zero settings.
  const notCaptured = runMetrics.computeRunTotals({ summary: {}, workspaces: [] });
  assert.equal(notCaptured.tenantSettingsCaptured, 0);
  assert.equal(notCaptured.tenantSettingsTotal, 0);
});

test('tenant settings metrics can be excluded from the summary comparison', () => {
  const before = runMetrics.computeRunTotals({ summary: {}, workspaces: [] });
  const after = runMetrics.computeRunTotals(tenantRun([{ settingName: 'A', enabled: true }]));

  const withThem = runMetrics.diffTotals(before, after);
  assert.ok(withThem.some(r => r.key === 'tenantSettingsTotal'));

  const withoutThem = runMetrics.diffTotals(before, after, { skipGroups: ['tenantSettings'] });
  assert.ok(!withoutThem.some(r => r.key === 'tenantSettingsTotal'));
  // The hidden capture flag is never a comparison row either way.
  assert.ok(!withThem.some(r => r.key === 'tenantSettingsCaptured'));
});

test('tenant settings diff reports toggles, scope changes, and additions', () => {
  const from = tenantRun([
    { settingName: 'ExportToExcel', title: 'Export to Excel', enabled: true, tenantSettingGroup: 'Export' },
    { settingName: 'UseFabricAPIs', title: 'Service principals can use Fabric APIs', enabled: true, tenantSettingGroup: 'Developer', enabledSecurityGroups: [{ name: 'PBI-SPs' }] },
    { settingName: 'Retired', title: 'Retired setting', enabled: false, tenantSettingGroup: 'Export' },
  ]);
  const to = tenantRun([
    { settingName: 'ExportToExcel', title: 'Export to Excel', enabled: false, tenantSettingGroup: 'Export' },
    { settingName: 'UseFabricAPIs', title: 'Service principals can use Fabric APIs', enabled: true, tenantSettingGroup: 'Developer', enabledSecurityGroups: [{ name: 'PBI-SPs' }, { name: 'Platform-Team' }] },
    { settingName: 'NewToggle', title: 'A brand new setting', enabled: true, tenantSettingGroup: 'Developer' },
  ]);

  const diff = runMetrics.diffTenantSettings(from, to);
  assert.equal(diff.available, true);
  assert.deepEqual(diff.enabledChanged.map(s => [s.name, s.from, s.to]), [['ExportToExcel', true, false]]);
  assert.deepEqual(diff.scopeChanged.map(s => s.name), ['UseFabricAPIs']);
  assert.match(diff.scopeChanged[0].to, /Platform-Team/);
  assert.deepEqual(diff.added.map(s => s.name), ['NewToggle']);
  assert.deepEqual(diff.removed.map(s => s.name), ['Retired']);
});

test('tenant settings diff refuses runs that never captured settings', () => {
  const captured = tenantRun([{ settingName: 'A', enabled: true }]);
  const uncaptured = { summary: {}, workspaces: [] };

  const diff = runMetrics.diffTenantSettings(uncaptured, captured);
  assert.equal(diff.available, false);
  assert.match(diff.reason, /baseline/);
  // Crucially, the captured run's settings are not reported as additions.
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);

  const both = runMetrics.diffTenantSettings(captured, uncaptured);
  assert.equal(both.available, false);
  assert.deepEqual(both.removed, []);
});

test('detailed diff includes the tenant settings section', () => {
  const details = runMetrics.diffRunDetails(
    tenantRun([{ settingName: 'A', enabled: true }]),
    tenantRun([{ settingName: 'A', enabled: false }])
  );
  assert.equal(details.tenantSettings.available, true);
  assert.equal(details.tenantSettings.enabledChanged.length, 1);
});

test('detailed diff caps item samples but keeps counts exact', () => {
  const from = { summary: {}, workspaces: [{ id: 'ws-1', name: 'Big', items: [], users: [] }] };
  const to = {
    summary: {},
    workspaces: [{
      id: 'ws-1',
      name: 'Big',
      items: Array.from({ length: 10 }, (_, i) => ({ id: 'item-' + i, name: 'Item ' + i, type: 'Report' })),
      users: [],
    }],
  };
  const details = runMetrics.diffRunDetails(from, to, { itemSampleLimit: 3 });
  assert.equal(details.items.addedCount, 10);
  assert.equal(details.items.added.length, 3);
  assert.equal(details.items.truncated, true);
});

const pbi = require('../src/services/powerbiService');

function httpError(status, headers) {
  const err = new Error('HTTP ' + status);
  err.response = { status, headers: headers || {}, data: { error: { message: 'boom' } } };
  return err;
}

test('retry delay honours Retry-After but caps how long one wait can block', () => {
  const { getRetryDelay, MAX_RETRY_DELAY_MS } = pbi._private;
  assert.equal(getRetryDelay(httpError(429, { 'retry-after': '30' }), 0), 30000);
  // A tenant asking for an hour must not freeze the run for an hour.
  assert.equal(getRetryDelay(httpError(429, { 'retry-after': '3600' }), 0), MAX_RETRY_DELAY_MS);
  // Non-retryable statuses opt out entirely.
  assert.equal(getRetryDelay(httpError(403), 0), null);
  assert.equal(getRetryDelay(httpError(404), 0), null);
});

test('throttling is reported to the caller instead of failing silently', async () => {
  const events = [];
  let attempts = 0;
  await pbi.runWithApiReporter(evt => events.push(evt), async () => {
    await pbi._private.withRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw httpError(429, { 'retry-after': '0' });
      return 'ok';
    }, { url: 'https://api.powerbi.com/v1.0/myorg/admin/groups' });
  });

  const throttled = events.find(e => e.type === 'throttled');
  assert.ok(throttled, 'expected a throttled event');
  assert.equal(throttled.status, 429);
  assert.equal(throttled.path, '/v1.0/myorg/admin/groups');
  assert.ok(events.some(e => e.type === 'request'), 'expected the eventual success to be reported');
});

test('a request that exhausts its retries reports a failure event', async () => {
  const events = [];
  await pbi.runWithApiReporter(evt => events.push(evt), async () => {
    await assert.rejects(() => pbi._private.withRetry(
      async () => { throw httpError(500, { 'retry-after': '0' }); },
      { url: 'https://api.fabric.microsoft.com/v1/admin/workspaces' }
    ));
  });

  const failure = events.find(e => e.type === 'failure');
  assert.ok(failure, 'expected a failure event');
  assert.equal(failure.status, 500);
  assert.equal(failure.path, '/v1/admin/workspaces');
  assert.equal(events.filter(e => e.type === 'retry').length, 2, 'two retries before giving up');
});

const itemDetails = require('../src/services/itemDetailsService');

function stubPbi(overrides) {
  return Object.assign({
    getItemDetail: async () => ({ id: 'i1', displayName: 'Sales LH', type: 'Lakehouse', description: 'Curated sales', workspaceId: 'w1' }),
    getLakehouseTables: async () => [{ name: 'dim_date', type: 'Managed', format: 'Delta', location: 'Tables/dim_date' }],
    getSqlEndpointInfo: async () => ({ connectionString: 'abc.datawarehouse.fabric.microsoft.com', database: 'Sales LH', provisioningStatus: 'Success' }),
    getSqlEndpointSchema: async () => ([
      { schema: 'dbo', name: 'dim_date', type: 'BASE TABLE', columns: [{ name: 'DateKey', dataType: 'int', nullable: false }] },
    ]),
    getOneLakeBreakdown: async () => ({ totalFiles: 3, totalSize: 900, folders: [{ folder: 'Tables/dim_date', area: 'Tables', files: 3, size: 900 }] }),
    getDatasetDatasources: async () => [],
    getDatasetParameters: async () => [],
    getDatasetRefreshHistory: async () => [],
    getDashboardTiles: async () => [],
  }, overrides);
}

test('lakehouse details include tables, sql endpoint schema and onelake content', async () => {
  const result = await itemDetails.buildItemDetails(stubPbi(), {
    workspaceId: 'w1', itemId: 'i1', itemType: 'Lakehouse', itemName: 'Sales LH', workspaceName: 'Finance',
  });

  const keys = result.sections.map(s => s.key);
  assert.deepEqual(keys, ['metadata', 'tables', 'sqlendpoint', 'onelake']);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.item.name, 'Sales LH');

  // The schema is a hierarchy: one collapsible group per table, columns beneath.
  const sql = result.sections.find(s => s.key === 'sqlendpoint');
  assert.equal(sql.kind, 'tree');
  assert.deepEqual(sql.columns, ['Column', 'Data type', 'Nullable']);
  assert.equal(sql.groups.length, 1);
  assert.equal(sql.groups[0].label, 'dbo.dim_date');
  assert.equal(sql.groups[0].meta, '1 column');
  assert.deepEqual(sql.groups[0].rows, [['DateKey', 'int', 'No']]);
  // The table name is not repeated on every column row.
  assert.ok(!sql.groups[0].rows.some(row => row.includes('dbo.dim_date')));

  // Metadata leads with the name and workspace, not the ids.
  const metadata = result.sections.find(s => s.key === 'metadata');
  assert.deepEqual(metadata.rows[0], { label: 'Name', value: 'Sales LH' });
  assert.equal(metadata.rows[2].value, 'Finance');
});

test('a failing section is reported without losing the others', async () => {
  const result = await itemDetails.buildItemDetails(stubPbi({
    getLakehouseTables: async () => { throw new Error('403 Forbidden'); },
  }), { workspaceId: 'w1', itemId: 'i1', itemType: 'Lakehouse', itemName: 'Sales LH' });

  assert.ok(!result.sections.some(s => s.key === 'tables'), 'the failing section is omitted');
  assert.ok(result.sections.some(s => s.key === 'sqlendpoint'), 'later sections still run');
  assert.match(result.warnings[0], /Tables: 403 Forbidden/);
});

test('an unprovisioned sql endpoint is reported as not ready, not queried', async () => {
  let queried = false;
  const result = await itemDetails.buildItemDetails(stubPbi({
    getSqlEndpointInfo: async () => ({ connectionString: 'x', database: 'y', provisioningStatus: 'InProgress' }),
    getSqlEndpointSchema: async () => { queried = true; return []; },
  }), { workspaceId: 'w1', itemId: 'i1', itemType: 'Lakehouse', itemName: 'Sales LH' });

  const sql = result.sections.find(s => s.key === 'sqlendpoint');
  assert.equal(sql.kind, 'note');
  assert.match(sql.note, /not ready yet/);
  assert.equal(queried, false, 'an endpoint still provisioning must not be queried');
});

test('dashboard tiles resolve report and model ids to names', async () => {
  const names = new Map([['rep-1', 'Exec Report'], ['ds-1', 'Sales Model']]);
  const result = await itemDetails.buildItemDetails(stubPbi({
    getItemDetail: async () => ({ id: 'd1', displayName: 'Exec Dashboard', type: 'Dashboard' }),
    getDashboardTiles: async () => [{ title: 'Revenue', reportId: 'rep-1', datasetId: 'ds-1' }, { title: 'Orphan', reportId: 'rep-missing' }],
  }), {
    workspaceId: 'w1', itemId: 'd1', itemType: 'Dashboard', itemName: 'Exec Dashboard',
    resolveName: id => names.get(id) || null,
  });

  const tiles = result.sections.find(s => s.key === 'tiles');
  assert.deepEqual(tiles.rows[0], ['Revenue', 'Exec Report', 'Sales Model']);
  // Unknown ids fall back to the id rather than showing nothing.
  assert.deepEqual(tiles.rows[1], ['Orphan', 'rep-missing', '-']);
});

test('onelake content can be skipped when the run already measured it', async () => {
  let called = false;
  const result = await itemDetails.buildItemDetails(stubPbi({
    getOneLakeBreakdown: async () => { called = true; return { totalFiles: 0, folders: [] }; },
  }), { workspaceId: 'w1', itemId: 'i1', itemType: 'Lakehouse', itemName: 'Sales LH', includeOneLake: false });

  assert.equal(called, false);
  assert.ok(!result.sections.some(s => s.key === 'onelake'));
});

test('sql endpoint failures are classified rather than passed through raw', () => {
  // Mirrors describeSqlEndpointError in the workspaces route.
  const endpoint = { database: 'Sales LH', connectionString: 'abc.datawarehouse.fabric.microsoft.com' };
  const describe = (message) => {
    const text = String(message || '');
    if (/Cannot open database/i.test(text)) return 'database';
    if (/Login failed|not associated with a trusted|principal/i.test(text)) return 'access';
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|connection failed/i.test(text)) return 'network';
    return 'other';
  };

  assert.equal(describe('Cannot open database "Sales LH" requested by the login.'), 'database');
  assert.equal(describe('Login failed for user \'<token-identified principal>\'.'), 'access');
  assert.equal(describe('SQL endpoint connection failed: ETIMEDOUT'), 'network');
  assert.equal(describe('Something else entirely'), 'other');
  assert.ok(endpoint.database);
});

test('lineage endpoints keep a workspace-qualified name instead of a bare id', () => {
  // Mirrors what the lineage route builds before rendering: a resolved endpoint
  // shows "Workspace: Name", an unresolved one falls back to the id and says so.
  const runIndex = new Map([
    ['ds-1', { name: 'Sales Model', type: 'SemanticModel', workspaceName: 'Finance', workspaceId: 'ws-1' }],
  ]);
  const enrich = (endpoint, fallbackId) => {
    const base = endpoint || { id: fallbackId, name: null, type: null, workspaceId: null, workspaceName: null };
    const known = runIndex.get(base.id);
    return {
      id: base.id,
      name: base.name || (known && known.name) || base.id,
      type: base.type || (known && known.type) || '',
      workspaceName: base.workspaceName || (known && known.workspaceName) || null,
      resolved: !!(base.name || (known && known.name)),
    };
  };

  const resolved = enrich(null, 'ds-1');
  assert.equal(resolved.name, 'Sales Model');
  assert.equal(resolved.workspaceName, 'Finance');
  assert.equal(resolved.resolved, true);

  const unknown = enrich(null, 'ds-missing');
  assert.equal(unknown.name, 'ds-missing');
  assert.equal(unknown.resolved, false);
});

test('api reporting stays silent when no reporter is active', async () => {
  // Requests made outside a run must not throw for lack of a reporter.
  const result = await pbi._private.withRetry(async () => 'fine', { url: 'https://example.com/x' });
  assert.equal(result, 'fine');
});

const insights = require('../src/services/workspaceInsightsService');

const SCAN_DATE = '2026-07-30T00:00:00Z';

function ws(overrides) {
  return Object.assign({
    id: 'ws-' + Math.random().toString(36).slice(2, 8),
    name: 'Workspace',
    state: 'Active',
    items: [{ id: 'i1', name: 'Report', type: 'Report', lastUpdated: '2026-07-29T00:00:00Z' }],
    users: [{ name: 'Ann', email: 'ann@x.com', role: 'Admin', type: 'User' }],
  }, overrides);
}

function findingKeys(result, workspaceName) {
  const match = result.workspaces.find(w => w.name === workspaceName);
  return match ? match.findings.map(f => f.key) : null;
}

test('triage flags workspaces with no admin and with only non-user admins', () => {
  const result = insights.computeWorkspaceInsights({
    workspaces: [
      ws({ name: 'NoAdmin', users: [{ name: 'Bob', email: 'bob@x.com', role: 'Viewer', type: 'User' }] }),
      ws({ name: 'RobotOnly', users: [{ name: 'sp-etl', role: 'Admin', type: 'App' }] }),
      ws({ name: 'Healthy', users: [
        { name: 'Ann', email: 'ann@x.com', role: 'Admin', type: 'User' },
        { name: 'Cleo', email: 'cleo@x.com', role: 'Admin', type: 'User' },
      ] }),
    ],
  }, { referenceDate: SCAN_DATE });

  assert.ok(findingKeys(result, 'NoAdmin').includes('ownerless'));
  assert.ok(findingKeys(result, 'RobotOnly').includes('orphanedAdmin'));
  assert.deepEqual(findingKeys(result, 'Healthy'), []);
  // Worst-first ordering puts the ownerless workspace above the robot-owned one.
  assert.equal(result.workspaces[0].name, 'NoAdmin');
  assert.equal(result.healthyCount, 1);
});

test('triage flags a single human admin but not two', () => {
  const result = insights.computeWorkspaceInsights({
    workspaces: [
      ws({ name: 'Solo' }),
      ws({ name: 'Pair', users: [
        { name: 'Ann', email: 'ann@x.com', role: 'Admin', type: 'User' },
        { name: 'Bob', email: 'bob@x.com', role: 'Admin', type: 'User' },
      ] }),
    ],
  }, { referenceDate: SCAN_DATE });

  assert.ok(findingKeys(result, 'Solo').includes('singleAdmin'));
  assert.ok(!findingKeys(result, 'Pair').includes('singleAdmin'));
});

test('staleness is measured against the scan date, not today', () => {
  const stale = ws({ name: 'Old', items: [{ id: 'i1', type: 'Report', lastUpdated: '2026-01-01T00:00:00Z' }] });
  const result = insights.computeWorkspaceInsights({ workspaces: [stale] }, {
    referenceDate: SCAN_DATE,
    staleDays: 90,
  });
  const finding = result.workspaces[0].findings.find(f => f.key === 'staleContent');
  assert.ok(finding, 'expected the stale finding');
  assert.equal(finding.days, 210);

  // Same data, a threshold longer than the gap: no longer stale.
  const relaxed = insights.computeWorkspaceInsights({ workspaces: [stale] }, {
    referenceDate: SCAN_DATE,
    staleDays: 365,
  });
  assert.ok(!findingKeys(relaxed, 'Old').includes('staleContent'));
});

test('empty workspaces are flagged only when someone still has access', () => {
  const result = insights.computeWorkspaceInsights({
    workspaces: [
      ws({ name: 'EmptyShared', items: [] }),
      ws({ name: 'EmptyAndUnused', items: [], users: [] }),
    ],
  }, { referenceDate: SCAN_DATE });

  assert.ok(findingKeys(result, 'EmptyShared').includes('emptyWorkspace'));
  assert.deepEqual(findingKeys(result, 'EmptyAndUnused'), []);
});

test('orphaned content is detected only when the scan captured users', () => {
  const workspaces = [
    ws({
      name: 'HasOrphans',
      items: [
        { id: 'i1', name: 'Old Report', type: 'Report', lastUpdated: SCAN_DATE, creator: { name: 'Gone', upn: 'gone@x.com' } },
        { id: 'i2', name: 'Live Report', type: 'Report', lastUpdated: SCAN_DATE, creator: { name: 'Ann', upn: 'ann@x.com' } },
      ],
    }),
  ];
  const withUsers = insights.computeWorkspaceInsights({ workspaces }, { referenceDate: SCAN_DATE });
  const orphan = withUsers.workspaces[0].findings.find(f => f.key === 'orphanedContent');
  assert.ok(orphan, 'expected orphaned content');
  assert.equal(orphan.count, 1);
  assert.match(orphan.detail, /gone@x\.com/);

  // No user data anywhere would make every creator look orphaned, so it is skipped.
  const noUsers = insights.computeWorkspaceInsights({
    workspaces: workspaces.map(w => Object.assign({}, w, { users: [] })),
  }, { referenceDate: SCAN_DATE });
  assert.equal(noUsers.orphanDetectionAvailable, false);
  assert.ok(!findingKeys(noUsers, 'HasOrphans').includes('orphanedContent'));
});

test('fabric-only items off dedicated capacity are flagged', () => {
  const result = insights.computeWorkspaceInsights({
    workspaces: [
      ws({ name: 'Shared', capacityId: '00000000-0000-0000-0000-000000000000', items: [{ id: 'i1', type: 'Lakehouse', lastUpdated: SCAN_DATE }] }),
      ws({ name: 'Dedicated', capacityId: 'cap-1', items: [{ id: 'i1', type: 'Lakehouse', lastUpdated: SCAN_DATE }] }),
    ],
  }, { referenceDate: SCAN_DATE });

  assert.ok(findingKeys(result, 'Shared').includes('capacityRisk'));
  assert.ok(!findingKeys(result, 'Dedicated').includes('capacityRisk'));
});

test('over-sharing respects the configured threshold', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: 'U' + i, email: 'u' + i + '@x.com', role: i === 0 ? 'Admin' : 'Viewer', type: 'User' }));
  const workspaces = [ws({ name: 'Wide', users: many })];

  const strict = insights.computeWorkspaceInsights({ workspaces }, { referenceDate: SCAN_DATE, overSharedUsers: 10 });
  assert.ok(findingKeys(strict, 'Wide').includes('overShared'));

  const lenient = insights.computeWorkspaceInsights({ workspaces }, { referenceDate: SCAN_DATE, overSharedUsers: 50 });
  assert.ok(!findingKeys(lenient, 'Wide').includes('overShared'));
  assert.equal(lenient.thresholds.overSharedUsers, 50);
});

test('workspaces the scan could not read are not reported as access problems', () => {
  const result = insights.computeWorkspaceInsights({
    workspaces: [ws({ name: 'Unreadable', users: [] })],
  }, { referenceDate: SCAN_DATE });
  const keys = findingKeys(result, 'Unreadable');
  assert.ok(!keys.includes('ownerless'));
  assert.ok(!keys.includes('singleAdmin'));
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

test('sql schema groups tables and views separately by kind', async () => {
  const result = await itemDetails.buildItemDetails(stubPbi({
    getSqlEndpointSchema: async () => ([
      { schema: 'dbo', name: 'fact_sales', type: 'BASE TABLE', columns: [{ name: 'Amount', dataType: 'decimal(18,2)', nullable: true }] },
      { schema: 'dbo', name: 'v_summary', type: 'VIEW', columns: [] },
    ]),
  }), { workspaceId: 'w1', itemId: 'i1', itemType: 'Warehouse', itemName: 'DW' });

  const sql = result.sections.find(s => s.key === 'sqlendpoint');
  assert.deepEqual(sql.groups.map(g => [g.label, g.badges[0].text]), [
    ['dbo.fact_sales', 'Table'],
    ['dbo.v_summary', 'View'],
  ]);
  // A view with no columns still gets a group, with its own empty message.
  assert.deepEqual(sql.groups[1].rows, []);
  assert.ok(sql.groups[1].emptyText);
  assert.match(sql.summary, /2 table\(s\), 1 column\(s\)/);
});

test('onelake content is grouped by area with folders underneath', async () => {
  const result = await itemDetails.buildItemDetails(stubPbi({
    getOneLakeBreakdown: async () => ({
      totalFiles: 5, totalSize: 1500,
      folders: [
        { folder: 'Tables/dim_date', area: 'Tables', files: 3, size: 900 },
        { folder: 'Files/raw', area: 'Files', files: 2, size: 600 },
      ],
    }),
  }), { workspaceId: 'w1', itemId: 'i1', itemType: 'Lakehouse', itemName: 'Sales LH' });

  const onelake = result.sections.find(s => s.key === 'onelake');
  assert.equal(onelake.kind, 'tree');
  assert.deepEqual(onelake.groups.map(g => g.label), ['Files', 'Tables']);
  assert.equal(onelake.groups[1].sizeBytes, 900);
  assert.deepEqual(onelake.groups[1].rows, [['Tables/dim_date', 3, 900]]);
});

// ── Stored service principal secret encryption ──
test('secretCryptoService round-trips a secret', () => {
  process.env.SECRET_ENCRYPTION_KEY = 'unit-test-encryption-key-value-01';
  delete require.cache[require.resolve('../src/services/secretCryptoService')];
  const crypto = require('../src/services/secretCryptoService');
  const cipher = crypto.encryptSecret('super-secret-value');
  assert.ok(crypto.isEncrypted(cipher));
  assert.ok(!cipher.includes('super-secret-value'));
  assert.equal(crypto.decryptSecret(cipher), 'super-secret-value');
});

test('secretCryptoService passes legacy plaintext through unchanged', () => {
  process.env.SECRET_ENCRYPTION_KEY = 'unit-test-encryption-key-value-01';
  delete require.cache[require.resolve('../src/services/secretCryptoService')];
  const crypto = require('../src/services/secretCryptoService');
  assert.equal(crypto.decryptSecret('legacy-plaintext'), 'legacy-plaintext');
});

test('secretCryptoService refuses to encrypt without a configured key', () => {
  const saved = process.env.SECRET_ENCRYPTION_KEY;
  delete process.env.SECRET_ENCRYPTION_KEY;
  delete process.env.SECRET_ENCRYPTION_KEY_BASE64;
  delete require.cache[require.resolve('../src/services/secretCryptoService')];
  const crypto = require('../src/services/secretCryptoService');
  assert.equal(crypto.isEncryptionConfigured(), false);
  assert.throws(() => crypto.encryptSecret('nope'));
  if (saved) process.env.SECRET_ENCRYPTION_KEY = saved;
  delete require.cache[require.resolve('../src/services/secretCryptoService')];
});

test('resolveClientSecret falls back to the stored secret when Key Vault is unset', async () => {
  process.env.SECRET_ENCRYPTION_KEY = 'unit-test-encryption-key-value-01';
  delete require.cache[require.resolve('../src/services/secretCryptoService')];
  delete require.cache[require.resolve('../src/services/authService')];
  const crypto = require('../src/services/secretCryptoService');
  const auth = require('../src/services/authService');
  const stored = crypto.encryptSecret('fallback-secret');
  const value = await auth._private.resolveClientSecret({ name: 'sp', client_id: 'abc', client_secret: stored });
  assert.equal(value, 'fallback-secret');
});

test('resolveClientSecret throws when no credential is available', async () => {
  delete require.cache[require.resolve('../src/services/authService')];
  const auth = require('../src/services/authService');
  await assert.rejects(
    () => auth._private.resolveClientSecret({ name: 'sp', client_id: 'abc' }),
    /no credential/i
  );
});

// ── Workspace deletion: elevate to workspace Admin on 403 ──
test('a 403 triggers a workspace Admin grant and one retry', async () => {
  const stub = stubDeletionDb();
  try {
    const granted = [];
    let attempts = 0;
    const pbi = {
      deleteWorkspace: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('API error (403): Insufficient privileges');
      },
    };
    const result = await workspaceDeletion.deleteWorkspace(pbi, {
      id: 'ws-1',
      name: 'Finance',
      elevate: async (id) => { granted.push(id); },
    });
    assert.equal(result.success, true);
    assert.equal(result.elevated, true);
    assert.equal(attempts, 2);
    assert.deepEqual(granted, ['ws-1']);
    assert.deepEqual(stub.runs, ['ws-1']);
  } finally {
    stub.restore();
  }
});

test('a 403 without an elevate callback is reported as a permission problem', async () => {
  const stub = stubDeletionDb();
  try {
    const pbi = { deleteWorkspace: async () => { throw new Error('API error (403): Forbidden'); } };
    const result = await workspaceDeletion.deleteWorkspace(pbi, { id: 'ws-2' });
    assert.equal(result.success, false);
    assert.equal(result.permissionDenied, true);
    assert.equal(stub.runs.length, 0);
  } finally {
    stub.restore();
  }
});

test('a failed grant does not retry and explains why', async () => {
  const stub = stubDeletionDb();
  try {
    let attempts = 0;
    const pbi = {
      deleteWorkspace: async () => { attempts += 1; throw new Error('API error (403): Forbidden'); },
    };
    const result = await workspaceDeletion.deleteWorkspace(pbi, {
      id: 'ws-3',
      elevate: async () => { throw new Error('Tenant.ReadWrite.All required'); },
    });
    assert.equal(result.success, false);
    assert.equal(attempts, 1);
    assert.match(result.message, /could not be granted/i);
  } finally {
    stub.restore();
  }
});

test('non-permission failures are never elevated', async () => {
  const stub = stubDeletionDb();
  try {
    let elevateCalls = 0;
    const pbi = { deleteWorkspace: async () => { throw new Error('API error (500): Server error'); } };
    const result = await workspaceDeletion.deleteWorkspace(pbi, {
      id: 'ws-4',
      elevate: async () => { elevateCalls += 1; },
    });
    assert.equal(result.success, false);
    assert.equal(elevateCalls, 0);
    assert.equal(result.permissionDenied, false);
  } finally {
    stub.restore();
  }
});

// ── HTTP error explanations ──
const httpErrors = require('../src/services/httpErrorService');

test('known status codes are explained in plain language', () => {
  const bad = httpErrors.explainStatus(400);
  assert.equal(bad.title, 'Bad Request');
  assert.match(bad.explanation, /could not understand the request/i);
  assert.ok(bad.hint);

  const forbidden = httpErrors.explainStatus(403);
  assert.match(forbidden.explanation, /not allowed/i);
  assert.match(forbidden.hint, /Admin role/i);
});

test('status codes are recovered from error text and axios errors', () => {
  assert.equal(httpErrors.extractStatus('API error (429): rate limited'), 429);
  assert.equal(httpErrors.extractStatus({ response: { status: 503 } }), 503);
  assert.equal(httpErrors.extractStatus(new Error('API error (404): missing')), 404);
  assert.equal(httpErrors.extractStatus('no code here'), null);
});

test('unknown codes fall back to a class-level explanation', () => {
  const client = httpErrors.explainStatus(418);
  assert.equal(client.status, 418);
  assert.match(client.explanation, /4xx/);

  const server = httpErrors.explainStatus(599);
  assert.match(server.explanation, /5xx/);
  assert.equal(httpErrors.explainStatus(null), null);
});

test('describeError produces a one-line summary', () => {
  assert.match(httpErrors.describeError('API error (401): nope'), /^401 Unauthorized — /);
  assert.equal(httpErrors.describeError('nothing to explain'), null);
});

test('deletion failures carry an explanation of the status code', async () => {
  const stub = stubDeletionDb();
  try {
    const pbi = { deleteWorkspace: async () => { throw new Error('API error (404): Workspace not found'); } };
    const result = await workspaceDeletion.deleteWorkspace(pbi, { id: 'ws-9', name: 'Gone' });
    assert.equal(result.success, false);
    assert.equal(result.status, 404);
    assert.equal(result.statusTitle, 'Not Found');
    assert.match(result.explanation, /does not exist/i);
    assert.ok(result.hint);
  } finally {
    stub.restore();
  }
});

// ── Deployment pipelines ──
const pipelineService = require('../src/services/deploymentPipelineService');
const { requireAuth } = require('../src/middleware/auth');

test('pipeline stages map to workspace assignments with stage names', () => {
  const pipelines = [{
    id: 'p1', name: 'Sales',
    stages: [
      { order: 0, workspaceId: 'WS-A', workspaceName: 'Sales Dev' },
      { order: 2, workspaceId: 'ws-b', workspaceName: 'Sales Prod' },
      { order: 1, workspaceId: null, workspaceName: null },
    ],
  }];
  const assignments = pipelineService.buildWorkspaceAssignments(pipelines);
  assert.equal(Object.keys(assignments).length, 2);

  // Workspace IDs are matched case-insensitively.
  const dev = pipelineService.lookupAssignment(assignments, 'ws-a');
  assert.equal(dev.pipelineName, 'Sales');
  assert.equal(dev.stageName, 'Development');
  assert.equal(pipelineService.lookupAssignment(assignments, 'WS-B').stageName, 'Production');
  assert.equal(pipelineService.lookupAssignment(assignments, 'missing'), null);
  assert.equal(pipelineService.stageName(7), 'Stage 8');
});

test('service principal access is detected only for a matching App principal', () => {
  const users = [
    { identifier: 'jane@contoso.com', accessRight: 'Admin', principalType: 'User' },
    { identifier: 'ABC-123', accessRight: 'Admin', principalType: 'App' },
  ];
  assert.equal(pipelineService.hasPrincipalAccess(users, 'abc-123'), true);
  assert.equal(pipelineService.hasPrincipalAccess(users, 'jane@contoso.com'), false);
  assert.equal(pipelineService.hasPrincipalAccess(users, null), false);
  assert.equal(pipelineService.principalIdentifier({ client_id: 'c', enterprise_app_object_id: 'e' }), 'e');
  assert.equal(pipelineService.principalIdentifier({ client_id: 'c' }), null);
});

test('listing pipelines reports access per pipeline and survives a probe failure', async () => {
  const pbi = {
    getDeploymentPipelines: async () => ([
      { id: 'p1', name: 'A', stages: [{ order: 0, workspaceId: 'w1', workspaceName: 'W1' }] },
      { id: 'p2', name: 'B', stages: [] },
    ]),
    getDeploymentPipelineUsers: async (id) => {
      if (id === 'p2') throw Object.assign(new Error('API error (403): forbidden'), { status: 403 });
      return [{ identifier: 'sp-obj', accessRight: 'Admin', principalType: 'App' }];
    },
  };
  const { pipelines } = await pipelineService.listPipelinesWithAccess(pbi, { enterprise_app_object_id: 'sp-obj' });
  assert.equal(pipelines[0].access, 'granted');
  assert.equal(pipelines[0].workspaceCount, 1);
  assert.equal(pipelines[0].stages[0].stageName, 'Development');
  // A failed probe must not be reported as "no access" — the UI would then offer
  // a grant button for a pipeline whose state is genuinely unknown.
  assert.equal(pipelines[1].access, 'unknown');
  assert.equal(pipelines[1].accessStatus, 403);
});

test('pipeline deletion reports per-pipeline failures with explanations', async () => {
  const pbi = {
    deleteDeploymentPipeline: async (id) => {
      if (id === 'bad') throw Object.assign(new Error('API error (403): no access'), { status: 403 });
      return {};
    },
  };
  const outcome = await pipelineService.deletePipelines(pbi, [
    { id: 'ok', name: 'Good' }, { id: 'bad', name: 'Bad' },
  ]);
  assert.equal(outcome.deleted, 1);
  assert.equal(outcome.failed, 1);
  const failed = outcome.results.find((r) => !r.success);
  assert.equal(failed.status, 403);
  assert.match(failed.explanation, /not allowed/i);
});

test('requireAuth redirects anonymous page requests and 401s API calls', () => {
  const previous = process.env.REQUIRE_AUTH;
  process.env.REQUIRE_AUTH = 'true';
  try {
    let redirectedTo = null;
    requireAuth({ user: null, path: '/workspaces', originalUrl: '/workspaces?a=1', get: () => '' },
      { redirect: (url) => { redirectedTo = url; } }, () => { throw new Error('should not pass'); });
    assert.match(redirectedTo, /^\/\.auth\/login\/aad\?post_login_redirect_uri=/);

    let status = null; let payload = null;
    requireAuth({ user: null, path: '/api/user', originalUrl: '/api/user', get: () => '' },
      { status: (s) => { status = s; return { json: (b) => { payload = b; } }; } },
      () => { throw new Error('should not pass'); });
    assert.equal(status, 401);
    assert.equal(payload.error, 'Not authenticated');

    // The health probe and the auth endpoints themselves must stay open.
    let passed = 0;
    requireAuth({ user: null, path: '/health', get: () => '' }, {}, () => { passed += 1; });
    requireAuth({ user: null, path: '/.auth/login/aad', get: () => '' }, {}, () => { passed += 1; });
    requireAuth({ user: { name: 'x' }, path: '/workspaces', get: () => '' }, {}, () => { passed += 1; });
    assert.equal(passed, 3);
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_AUTH;
    else process.env.REQUIRE_AUTH = previous;
  }
});

test('governance tenant settings read the snapshot stored with the selected run', async () => {
  // The Governance page is evidence for a point in time, so it must never fall
  // back to the live admin API.
  const db = require('../src/services/databaseService');
  const originalGet = db.getAnalysisRunById;

  const express = require('express');
  const app = express();
  let run = {
    id: 7,
    completed_at: '2024-05-01T10:00:00.000Z',
    results_json: JSON.stringify({
      tenantSettings: [{ settingName: 'A', title: 'A', enabled: true, tenantSettingGroup: 'G' }],
    }),
  };
  db.getAnalysisRunById = async () => run;

  app.use((req, res, next) => { res.locals.globalRun = { id: 7, sp_id: 1 }; next(); });
  app.use('/governance', require('../src/routes/governance'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  const fetchData = () => new Promise((resolve, reject) => {
    require('node:http').get({
      host: '127.0.0.1', port: server.address().port, path: '/governance/tenant-settings/data',
      headers: { host: '127.0.0.1' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });

  try {
    const captured = await fetchData();
    assert.strictEqual(captured.success, true);
    assert.strictEqual(captured.total, 1);
    assert.strictEqual(captured.runId, 7);
    assert.strictEqual(captured.capturedAt, '2024-05-01T10:00:00.000Z');

    // A run recorded before tenant settings were captured must say so rather than
    // reporting zero settings, which would read as "everything is disabled".
    run = { id: 8, results_json: JSON.stringify({ workspaces: [] }) };
    const missing = await fetchData();
    assert.strictEqual(missing.success, false);
    assert.match(missing.message, /did not capture tenant settings/);
  } finally {
    server.close();
    db.getAnalysisRunById = originalGet;
  }
});

test('the pipeline grant redirect resolves the async auth URL', async () => {
  // getDelegatedAuthUrl is a promise-returning MSAL call. Redirecting to it
  // without awaiting sends the browser to "/pipelines/[object Promise]".
  const authService = require('../src/services/authService');
  const original = authService.getDelegatedAuthUrl;
  authService.getDelegatedAuthUrl = async (redirectUri, state) =>
    'https://login.microsoftonline.com/authorize?state=' + state;

  // The route captures the function at require time, so it must be re-required
  // after the stub is installed.
  delete require.cache[require.resolve('../src/routes/pipelines')];
  const express = require('express');
  const app = express();
  app.use('/pipelines', require('../src/routes/pipelines'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const location = await new Promise((resolve, reject) => {
      require('node:http').get({
        host: '127.0.0.1', port: server.address().port, path: '/pipelines/grant-auth',
        headers: { host: '127.0.0.1' },
      }, (res) => { res.resume(); resolve(res.headers.location); }).on('error', reject);
    });
    assert.match(location, /^https:\/\/login\.microsoftonline\.com\//);
    assert.match(location, /state=grant-sp-pipelines/);
    assert.ok(!location.includes('Promise'));
  } finally {
    server.close();
    authService.getDelegatedAuthUrl = original;
    delete require.cache[require.resolve('../src/routes/pipelines')];
  }
});

// ── Data reconciliation engine ──
const recon = require('../src/services/reconciliationService');

const INVOICE_RULE = {
  keyFieldA: 'InvoiceNumber',
  keyFieldB: 'Invoice_No',
  priority: 'medium',
  compareFields: [
    { label: 'Customer', fieldA: 'Customer', fieldB: 'CustomerName', type: 'string' },
    { label: 'Net amount', fieldA: 'NetAmount', fieldB: 'Net', type: 'number' },
  ],
};

test('reconciliation matches records that agree in both systems', () => {
  const result = recon.reconcile({
    rowsA: [{ InvoiceNumber: 'INV-1', Customer: 'Acme', NetAmount: 100 }],
    rowsB: [{ Invoice_No: 'INV-1', CustomerName: 'Acme', Net: 100 }],
    rule: INVOICE_RULE,
  });
  assert.equal(result.summary.matched, 1);
  assert.equal(result.summary.exceptions, 0);
  assert.equal(result.summary.passed, true);
  assert.deepEqual(result.exceptions, []);
});

test('reconciliation reports which system a record is missing from', () => {
  const result = recon.reconcile({
    rowsA: [{ InvoiceNumber: 'INV-1', Customer: 'Acme', NetAmount: 100 }],
    rowsB: [{ Invoice_No: 'INV-2', CustomerName: 'Beta', Net: 50 }],
    rule: INVOICE_RULE,
  });
  const byOutcome = Object.fromEntries(result.exceptions.map(e => [e.businessKey, e.outcome]));
  assert.equal(byOutcome['INV-1'], recon.OUTCOME.MISSING_FROM_B);
  assert.equal(byOutcome['INV-2'], recon.OUTCOME.MISSING_FROM_A);
  assert.equal(result.summary.matched, 0);
  assert.equal(result.summary.passed, false);
});

test('reconciliation reports the specific values that differ', () => {
  const result = recon.reconcile({
    rowsA: [{ InvoiceNumber: 'INV-1', Customer: 'Acme', NetAmount: 100 }],
    rowsB: [{ Invoice_No: 'INV-1', CustomerName: 'Acme Corp', Net: 120 }],
    rule: INVOICE_RULE,
  });
  assert.equal(result.exceptions.length, 1);
  const exception = result.exceptions[0];
  assert.equal(exception.outcome, recon.OUTCOME.VALUE_MISMATCH);
  assert.deepEqual(exception.differences.map(d => d.field), ['Customer', 'Net amount']);
  // The amount difference is quantified, not just flagged.
  assert.equal(exception.differences[1].difference, 20);
  assert.deepEqual(exception.valuesA, { Customer: 'Acme', 'Net amount': 100 });
});

test('reconciliation accepts differences inside an agreed tolerance', () => {
  const rule = {
    ...INVOICE_RULE,
    compareFields: [
      { label: 'Tax', fieldA: 'Tax', fieldB: 'TaxAmount', type: 'number', tolerance: { type: 'absolute', value: 0.02 } },
    ],
  };
  const within = recon.reconcile({
    rowsA: [{ InvoiceNumber: 'INV-1', Tax: 19.99 }],
    rowsB: [{ Invoice_No: 'INV-1', TaxAmount: 20.00 }],
    rule,
  });
  assert.equal(within.summary.matched, 1, 'a one-cent rounding difference is immaterial');

  const outside = recon.reconcile({
    rowsA: [{ InvoiceNumber: 'INV-1', Tax: 19.00 }],
    rowsB: [{ Invoice_No: 'INV-1', TaxAmount: 20.00 }],
    rule,
  });
  assert.equal(outside.summary.exceptions, 1, 'a whole unit is not');
});

test('percentage tolerance scales with the value being compared', () => {
  const field = { fieldA: 'a', fieldB: 'b', type: 'number', tolerance: { type: 'percent', value: 1 } };
  assert.equal(recon.compareValues(1000, 1005, field).equal, true);
  assert.equal(recon.compareValues(1000, 1050, field).equal, false);
  // A percentage of zero has no meaning, so it falls back to an exact comparison.
  assert.equal(recon.compareValues(0, 5, field).equal, false);
});

test('reconciliation flags duplicate business keys instead of guessing', () => {
  const rows = {
    rowsA: [
      { InvoiceNumber: 'INV-1', Customer: 'Acme', NetAmount: 100 },
      { InvoiceNumber: 'INV-1', Customer: 'Acme', NetAmount: 100 },
    ],
    rowsB: [{ Invoice_No: 'INV-1', CustomerName: 'Acme', Net: 100 }],
  };
  const flagged = recon.reconcile({ ...rows, rule: INVOICE_RULE });
  assert.equal(flagged.exceptions[0].outcome, recon.OUTCOME.DUPLICATE);
  assert.equal(flagged.exceptions[0].countA, 2);

  // A rule may instead accept the first record when duplicates are expected.
  const tolerated = recon.reconcile({ ...rows, rule: { ...INVOICE_RULE, duplicateHandling: 'first' } });
  assert.equal(tolerated.summary.matched, 1);
  assert.equal(tolerated.summary.exceptions, 0);
});

test('records with a blank business key are reported, never matched together', () => {
  const result = recon.reconcile({
    rowsA: [{ InvoiceNumber: '', Customer: 'Acme', NetAmount: 100 }],
    rowsB: [{ Invoice_No: '   ', CustomerName: 'Beta', Net: 50 }],
    rule: INVOICE_RULE,
  });
  assert.equal(result.exceptions.length, 2);
  assert.ok(result.exceptions.every(e => e.outcome === recon.OUTCOME.INVALID_KEY));
  // Two blank keys must not be treated as the same business item.
  assert.equal(result.summary.matched, 0);

  const ignored = recon.reconcile({
    rowsA: [{ InvoiceNumber: '', Customer: 'Acme' }],
    rowsB: [{ Invoice_No: '', CustomerName: 'Beta' }],
    rule: { ...INVOICE_RULE, incompleteKeyHandling: 'ignore' },
  });
  assert.equal(ignored.summary.exceptions, 0);
});

test('business keys match regardless of case and surrounding spaces', () => {
  const result = recon.reconcile({
    rowsA: [{ InvoiceNumber: ' inv-1 ', Customer: 'Acme', NetAmount: 100 }],
    rowsB: [{ Invoice_No: 'INV-1', CustomerName: 'Acme', Net: 100 }],
    rule: INVOICE_RULE,
  });
  assert.equal(result.summary.matched, 1);
});

test('a high-priority rule raises the severity of what it finds', () => {
  const normal = recon.reconcile({
    rowsA: [{ InvoiceNumber: 'INV-1', Customer: 'Acme', NetAmount: 100 }],
    rowsB: [{ Invoice_No: 'INV-1', CustomerName: 'Other', Net: 100 }],
    rule: INVOICE_RULE,
  });
  assert.equal(normal.exceptions[0].severity, 'medium');

  const critical = recon.reconcile({
    rowsA: [{ InvoiceNumber: 'INV-1', Customer: 'Acme', NetAmount: 100 }],
    rowsB: [{ Invoice_No: 'INV-1', CustomerName: 'Other', Net: 100 }],
    rule: { ...INVOICE_RULE, priority: 'high' },
  });
  assert.equal(critical.exceptions[0].severity, 'high');
});

test('date comparison tolerates a configured number of days', () => {
  const field = { fieldA: 'a', fieldB: 'b', type: 'date', tolerance: { type: 'days', value: 1 } };
  assert.equal(recon.compareValues('2026-07-01', '2026-07-02', field).equal, true);
  assert.equal(recon.compareValues('2026-07-01', '2026-07-05', field).equal, false);
  assert.equal(recon.compareValues('2026-07-01', 'not a date', field).equal, false);
});

test('the exception lifecycle only allows supported transitions', () => {
  assert.equal(recon.isStatusTransitionAllowed('open', 'acknowledged'), true);
  assert.equal(recon.isStatusTransitionAllowed('acknowledged', 'investigating'), true);
  assert.equal(recon.isStatusTransitionAllowed('investigating', 'resolved'), true);
  // A closed exception can only be reopened, not moved sideways.
  assert.equal(recon.isStatusTransitionAllowed('resolved', 'open'), true);
  assert.equal(recon.isStatusTransitionAllowed('resolved', 'investigating'), false);
  assert.equal(recon.isStatusTransitionAllowed('open', 'open'), false);
});

test('the same unresolved item keeps one identity across runs', () => {
  const first = recon.reconcile({
    rowsA: [{ InvoiceNumber: 'INV-9', Customer: 'Acme', NetAmount: 100 }],
    rowsB: [],
    rule: INVOICE_RULE,
  });
  const second = recon.reconcile({
    rowsA: [{ InvoiceNumber: 'inv-9', Customer: 'Acme', NetAmount: 100 }],
    rowsB: [],
    rule: INVOICE_RULE,
  });
  assert.equal(
    recon.exceptionFingerprint(7, first.exceptions[0]),
    recon.exceptionFingerprint(7, second.exceptions[0]),
    'the same business item must not be raised as a new exception each run'
  );
  // A different rule checking the same key is a different control.
  assert.notEqual(
    recon.exceptionFingerprint(7, first.exceptions[0]),
    recon.exceptionFingerprint(8, first.exceptions[0])
  );
});

test('a rule without a business key is refused rather than matching everything', () => {
  assert.throws(
    () => recon.reconcile({ rowsA: [{ a: 1 }], rowsB: [{ b: 2 }], rule: { compareFields: [] } }),
    /business key/i
  );
});

// ── Comparison operands: fields, SQL expressions and fixed values ──

test('a rule can compare a column against a fixed value', () => {
  const rule = {
    keyFieldA: 'InvoiceNumber', keyFieldB: 'Invoice_No',
    compareFields: [{ label: 'Currency', a: { kind: 'field', value: 'Currency' }, b: { kind: 'constant', value: 'EUR' }, type: 'string' }],
  };
  const plan = recon.planRule(rule);
  // A constant is never selected from the source.
  assert.deepEqual(plan.selectionsB.map(s => s.alias), [recon.KEY_ALIAS]);
  assert.equal(plan.engineRule.compareFields[0].constantB, 'EUR');

  const result = recon.reconcile({
    rowsA: [
      { [recon.KEY_ALIAS]: 'INV-1', recon_c0a: 'EUR' },
      { [recon.KEY_ALIAS]: 'INV-2', recon_c0a: 'USD' },
    ],
    rowsB: [{ [recon.KEY_ALIAS]: 'INV-1' }, { [recon.KEY_ALIAS]: 'INV-2' }],
    rule: plan.engineRule,
  });
  assert.equal(result.summary.matched, 1);
  assert.equal(result.exceptions.length, 1);
  assert.equal(result.exceptions[0].businessKey, 'INV-2');
  assert.deepEqual(result.exceptions[0].valuesB, { Currency: 'EUR' });
});

test('a SQL expression becomes an aliased selection on its own side', () => {
  const plan = recon.planRule({
    keyFieldA: 'Id', keyFieldB: 'Id',
    compareFields: [{
      label: 'Customer',
      a: { kind: 'expression', value: 'TRIM(Customer)' },
      b: { kind: 'field', value: 'CustomerName' },
      type: 'string',
    }],
  });
  const expression = plan.selectionsA.find(s => s.kind === 'expression');
  assert.equal(expression.value, 'TRIM(Customer)');
  assert.equal(expression.alias, plan.engineRule.compareFields[0].fieldA);
  // Source B still selects a plain column.
  assert.equal(plan.selectionsB[1].kind, 'field');
  assert.equal(plan.selectionsB[1].value, 'CustomerName');
});

test('expressions are checked for anything beyond a read-only expression', () => {
  assert.equal(recon.validateSqlExpression('TRIM(Customer)'), null);
  assert.equal(recon.validateSqlExpression("CASE WHEN Status = 1 THEN 'Posted' ELSE 'Draft' END"), null);
  assert.equal(recon.validateSqlExpression('CAST(Amount AS decimal(18,2))'), null);

  assert.match(recon.validateSqlExpression('Amount; DROP TABLE Invoices'), /statement separators/);
  assert.match(recon.validateSqlExpression('Amount -- comment'), /comments/);
  assert.match(recon.validateSqlExpression('Amount /* x */'), /comments/);
  assert.match(recon.validateSqlExpression('(SELECT 1 FROM t WHERE 1=1'), /parentheses/);
  assert.match(recon.validateSqlExpression("(SELECT x FROM y) + (DELETE FROM z)"), /read-only/);
  assert.match(recon.validateSqlExpression('   '), /empty/);
});

test('rule validation reports every operand problem at once', () => {
  const problems = recon.validateCompareFields([
    { label: 'Bad expression', a: { kind: 'expression', value: 'Amount;' }, b: { kind: 'field', value: 'Net' } },
    { label: 'Empty field', a: { kind: 'field', value: '' }, b: { kind: 'field', value: 'Net' } },
    { label: 'Two constants', a: { kind: 'constant', value: '1' }, b: { kind: 'constant', value: '1' } },
  ]);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /Bad expression.*source A/i);
  assert.match(problems[1], /Empty field.*source A/i);
  assert.match(problems[2], /both sides are constants/i);
});

test('rules written before operands existed still plan and run', () => {
  // Legacy shape: plain fieldA/fieldB with no operand descriptors.
  const plan = recon.planRule({
    keyFieldA: 'InvoiceNumber', keyFieldB: 'Invoice_No',
    compareFields: [{ label: 'Net', fieldA: 'NetAmount', fieldB: 'Net', type: 'number' }],
  });
  assert.equal(plan.selectionsA[1].kind, 'field');
  assert.equal(plan.selectionsA[1].value, 'NetAmount');
  assert.equal(plan.selectionsB[1].value, 'Net');

  const result = recon.reconcile({
    rowsA: [{ [recon.KEY_ALIAS]: 'INV-1', recon_c0a: 100 }],
    rowsB: [{ [recon.KEY_ALIAS]: 'INV-1', recon_c0b: 100 }],
    rule: plan.engineRule,
  });
  assert.equal(result.summary.matched, 1);
});

test('a constant on the missing side is still reported in the exception values', () => {
  const plan = recon.planRule({
    keyFieldA: 'Id', keyFieldB: 'Id',
    compareFields: [{ label: 'Expected status', a: { kind: 'field', value: 'Status' }, b: { kind: 'constant', value: 'Posted' }, type: 'string' }],
  });
  const result = recon.reconcile({
    rowsA: [{ [recon.KEY_ALIAS]: 'INV-9', recon_c0a: 'Draft' }],
    rowsB: [],
    rule: plan.engineRule,
  });
  assert.equal(result.exceptions[0].outcome, recon.OUTCOME.MISSING_FROM_B);
  assert.deepEqual(result.exceptions[0].valuesA, { 'Expected status': 'Draft' });
});

// ── Analysis run progress ──
const runProgress = require('../src/services/runProgressService');

// Drives a progress state through the phases a real run goes through, up to the
// point named by `stopAfter`.
function progressThrough(stopAfter, { startedAt = 0 } = {}) {
  const state = runProgress.createProgress({ runId: 7, startedAt });
  const steps = [
    ['workspaces', 12],
    ['items', 400],
    ['capacities', 3],
    ['pipelines', 1],
    ['workspaceDetails', 12],
    ['access', 12],
    ['storage', 90],
    ['details', 300],
    ['tenantSettings', 200],
    ['save', 1],
  ];
  for (const [key, total] of steps) {
    runProgress.beginPhase(state, key, { total, now: startedAt });
    runProgress.advancePhase(state, key, { done: total, now: startedAt });
    runProgress.completePhase(state, key, { now: startedAt });
    if (key === stopAfter) break;
  }
  return state;
}

test('progress is weighted by phase, so finishing a cheap phase is not most of the run', () => {
  const early = progressThrough('capacities');
  const late = progressThrough('storage');
  assert.ok(runProgress.overallPercent(early) < 15,
    'three list calls should not read as a large share of the run');
  assert.ok(runProgress.overallPercent(late) > 55);
  assert.ok(runProgress.overallPercent(late) < runProgress.overallPercent(progressThrough('details')));
});

test('a run still going never reports 100 percent', () => {
  // Regression: storage used to drive the bar to 100 while artifact details — the
  // second-longest phase — had not started, so "nearly done" and "done" looked alike.
  const state = progressThrough('storage');
  runProgress.beginPhase(state, 'details', { total: 300 });
  runProgress.advancePhase(state, 'details', { done: 300 });
  runProgress.completePhase(state, 'details');
  runProgress.completePhase(state, 'tenantSettings');
  runProgress.completePhase(state, 'save');
  assert.equal(runProgress.overallPercent(state), 99);

  state.status = 'completed';
  assert.equal(runProgress.overallPercent(state), 100);
});

test('the storage phase moves the bar item by item, not workspace by workspace', () => {
  const state = progressThrough('access');
  const before = runProgress.overallPercent(state);
  runProgress.beginPhase(state, 'storage', { total: 200 });
  runProgress.advancePhase(state, 'storage', { done: 100 });
  const half = runProgress.overallPercent(state);
  runProgress.advancePhase(state, 'storage', { done: 200 });
  assert.ok(half > before, 'half of the storage items should show as progress');
  assert.ok(runProgress.overallPercent(state) > half);
});

test('work done and work remaining are counted from the sized phases', () => {
  const state = runProgress.createProgress({ runId: 1 });
  runProgress.beginPhase(state, 'workspaces', { total: 10 });
  runProgress.completePhase(state, 'workspaces');
  runProgress.beginPhase(state, 'storage', { total: 40 });
  runProgress.advancePhase(state, 'storage', { done: 15 });

  const units = runProgress.unitTotals(state);
  assert.equal(units.total, 50);
  assert.equal(units.done, 25);
  assert.equal(units.remaining, 25);
});

test('a phase left active is closed when the next one starts', () => {
  // Phases that end in a swallowed error never call completePhase; without this the
  // run would look permanently stuck on whichever one failed.
  const state = runProgress.createProgress({ runId: 1 });
  runProgress.beginPhase(state, 'pipelines', { total: 1 });
  runProgress.beginPhase(state, 'storage', { total: 5 });
  assert.equal(runProgress.findPhase(state, 'pipelines').state, 'done');
  assert.equal(runProgress.findPhase(state, 'workspaces').state, 'skipped');
});

test('remaining time is withheld until the estimate means something', () => {
  const startedAt = 1000000;
  const state = progressThrough('access', { startedAt });
  // Ten seconds in, an extrapolation from a couple of list calls is noise.
  assert.equal(runProgress.estimateRemainingSeconds(state, startedAt + 10000), null);

  const eta = runProgress.estimateRemainingSeconds(state, startedAt + 120000);
  assert.ok(typeof eta === 'number' && eta > 0);
});

test('throttling is reported as waiting, not as a stall', () => {
  const now = 5000000;
  const state = runProgress.createProgress({ runId: 3, startedAt: now - 600000 });
  state.updatedAt = now - 300000;
  state.throttledUntil = now + 45000;

  const summary = runProgress.summarize(state, { now, stallSeconds: 90 });
  assert.equal(summary.stalled, false);
  assert.equal(summary.throttleRemainingSeconds, 45);

  state.throttledUntil = null;
  assert.equal(runProgress.summarize(state, { now, stallSeconds: 90 }).stalled, true);
});

test('a stored snapshot rebuilds the phase counts for another worker to read', () => {
  const state = progressThrough('access');
  runProgress.beginPhase(state, 'storage', { total: 120 });
  runProgress.advancePhase(state, 'storage', { done: 30, detail: 'Finance → Sales lakehouse' });

  const now = state.updatedAt + 1000;
  const summary = runProgress.fromSnapshot(runProgress.toSnapshot(state), { now });
  assert.equal(summary.status, 'running');
  assert.equal(summary.fromSnapshot, true);
  assert.equal(summary.phaseDone, 30);
  assert.equal(summary.phaseTotal, 120);
  assert.equal(summary.detail, 'Finance → Sales lakehouse');
  assert.equal(summary.progress, runProgress.overallPercent(state));
});

test('a snapshot that stopped being written is reported as interrupted', () => {
  // The worker that owned the run is gone. Reporting it as still running would
  // leave the user watching a run that will never move again.
  const state = progressThrough('access');
  const snapshot = runProgress.toSnapshot(state);
  const now = snapshot.updatedAt + 3600000;

  const summary = runProgress.fromSnapshot(snapshot, { now, staleSeconds: 900 });
  assert.equal(summary.status, 'interrupted');
  assert.equal(summary.live, false);
  assert.match(summary.message, /stopped reporting progress/i);

  const fresh = runProgress.fromSnapshot(snapshot, { now: snapshot.updatedAt + 5000, staleSeconds: 900 });
  assert.equal(fresh.status, 'running');
  assert.equal(fresh.live, true);
});

test('a finished snapshot is left alone however old it is', () => {
  const state = progressThrough('save');
  state.status = 'completed';
  const snapshot = runProgress.toSnapshot(state);
  const summary = runProgress.fromSnapshot(snapshot, { now: snapshot.updatedAt + 86400000 });
  assert.equal(summary.status, 'completed');
  assert.equal(summary.progress, 100);
});

test('checking a backgrounded run answers from the stored snapshot', async () => {
  // No in-memory run: this stands in for a different worker, or the same one after
  // a restart — the case the in-memory-only version could not answer at all.
  const state = progressThrough('access');
  runProgress.beginPhase(state, 'storage', { total: 60 });
  runProgress.advancePhase(state, 'storage', { done: 20 });
  const snapshot = runProgress.toSnapshot(state);
  snapshot.updatedAt = Date.now() - 2000;

  const original = dbService.getRunProgress;
  dbService.getRunProgress = async runId => (runId === 42 ? { ...snapshot, runId } : null);

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const response = await request(server, '/analysis/progress/42');
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'running');
    assert.equal(body.live, true);
    assert.equal(body.fromSnapshot, true);
    assert.equal(body.phaseTotal, 60);
    assert.equal(body.phaseDone, 20);
    assert.ok(body.unitsRemaining > 0);
  } finally {
    dbService.getRunProgress = original;
    await new Promise(resolve => server.close(resolve));
  }
});

test('a run whose worker died is reported as interrupted, not as running forever', async () => {
  const snapshot = runProgress.toSnapshot(progressThrough('items'));
  snapshot.updatedAt = Date.now() - 3600000;

  const original = dbService.getRunProgress;
  dbService.getRunProgress = async () => snapshot;

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = JSON.parse((await request(server, '/analysis/progress/99')).body);
    assert.equal(body.status, 'interrupted');
    assert.equal(body.live, false);
  } finally {
    dbService.getRunProgress = original;
    await new Promise(resolve => server.close(resolve));
  }
});

test('the runs table can read every in-flight run in one call', async () => {
  const first = runProgress.toSnapshot(progressThrough('access'));
  first.runId = 11;
  first.updatedAt = Date.now() - 1000;
  const second = runProgress.toSnapshot(progressThrough('items'));
  second.runId = 12;
  second.updatedAt = Date.now() - 1000;

  const original = dbService.getLiveRunProgress;
  dbService.getLiveRunProgress = async () => [first, second];

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = JSON.parse((await request(server, '/analysis/progress')).body);
    assert.deepEqual(body.runs.map(run => run.runId).sort(), [11, 12]);
    assert.ok(body.runs.every(run => run.live));
  } finally {
    dbService.getLiveRunProgress = original;
    await new Promise(resolve => server.close(resolve));
  }
});

// ── Reconciliation: shared SQL projection ──
test('both kinds of source read the same projection for a planned rule', () => {
  // A Fabric endpoint and a registered database must return identically shaped rows,
  // or the two sides of a comparison would not line up.
  const plan = recon.planRule({
    keyFieldA: 'InvoiceNumber', keyFieldB: 'Invoice_No',
    compareFields: [
      { label: 'Net', a: { kind: 'expression', value: 'ROUND(NetAmount, 2)' }, b: { kind: 'field', value: 'Net' }, type: 'number' },
      { label: 'Currency', a: { kind: 'field', value: 'Ccy' }, b: { kind: 'constant', value: 'EUR' }, type: 'string' },
    ],
  });

  const sqlA = recon.buildSelectSql({ dataset: 'dbo.Invoices', selections: plan.selectionsA, rowLimit: 500 });
  assert.match(sqlA, /^SELECT TOP \(500\) /);
  assert.match(sqlA, /\[InvoiceNumber\] AS \[recon_key\]/);
  assert.match(sqlA, /\(ROUND\(NetAmount, 2\)\) AS \[recon_c0a\]/);
  assert.match(sqlA, /FROM \[dbo\]\.\[Invoices\]$/);

  // The constant is never selected from either source.
  const sqlB = recon.buildSelectSql({ dataset: 'Sales', selections: plan.selectionsB });
  assert.ok(!/EUR/.test(sqlB), 'a fixed value must not be read from the source');
  assert.match(sqlB, /\[Net\] AS \[recon_c0b\]/);
});

test('an identifier that is not a plain name is refused rather than concatenated', () => {
  assert.throws(
    () => recon.buildSelectSql({ dataset: 'Invoices; DROP TABLE x', selections: [{ alias: 'a', kind: 'field', value: 'Id' }] }),
    /Unsupported identifier/
  );
});

// ── Reconciliation: external database sources ──
const sqlSource = require('../src/services/sqlSourceService');

test('external source schema is reshaped into datasets and fields', () => {
  const datasets = sqlSource.shapeSchemaRows([
    { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Invoices', TABLE_TYPE: 'BASE TABLE', COLUMN_NAME: 'Id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
    { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Invoices', TABLE_TYPE: 'BASE TABLE', COLUMN_NAME: 'Customer', DATA_TYPE: 'nvarchar', IS_NULLABLE: 'YES', CHARACTER_MAXIMUM_LENGTH: 200 },
    { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'InvoiceView', TABLE_TYPE: 'VIEW', COLUMN_NAME: 'Total', DATA_TYPE: 'decimal', NUMERIC_PRECISION: 18, NUMERIC_SCALE: 2 },
    // A table with no columns readable by this identity still appears, so an
    // access problem does not look like a missing table.
    { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Locked', TABLE_TYPE: 'BASE TABLE', COLUMN_NAME: null },
  ]);

  assert.equal(datasets.length, 3);
  assert.deepEqual(datasets[0].fields.map(f => f.name), ['Id', 'Customer']);
  assert.equal(datasets[0].fields[1].dataType, 'nvarchar(200)');
  assert.equal(datasets[0].fields[1].nullable, true);
  assert.equal(datasets[1].kind, 'View');
  assert.equal(datasets[1].fields[0].dataType, 'decimal(18,2)');
  assert.equal(datasets[2].fields.length, 0);
});

test('a SQL login source builds a password connection, an Entra one builds a token connection', () => {
  const { connectionConfig } = sqlSource._private;

  const entra = connectionConfig({ connection_string: 'srv.database.windows.net', database_name: 'ERP', auth_mode: 'entra' }, 'a-token');
  assert.equal(entra.server, 'srv.database.windows.net');
  assert.equal(entra.authentication.type, 'azure-active-directory-access-token');
  assert.equal(entra.authentication.options.token, 'a-token');
  assert.equal(entra.options.encrypt, true);

  const sql = connectionConfig({
    connection_string: 'onprem', database_name: 'ERP', auth_mode: 'sql',
    sql_username: 'svc', sql_password: 'plaintext-legacy', sql_port: '1444',
  }, null);
  assert.equal(sql.authentication.type, 'default');
  assert.equal(sql.authentication.options.userName, 'svc');
  assert.equal(sql.options.port, 1444);
});

test('a SQL login with no stored password is refused rather than attempted anonymously', () => {
  assert.throws(
    () => sqlSource._private.connectionConfig({ connection_string: 's', auth_mode: 'sql', sql_username: 'svc' }, null),
    /no username or password is stored/
  );
});

test('connection failures are explained rather than passed through raw', () => {
  const source = { connection_string: 'srv.database.windows.net', database_name: 'ERP', auth_mode: 'entra' };
  assert.match(sqlSource.explainSqlFailure(new Error('getaddrinfo ENOTFOUND srv'), source), /Cannot resolve/);
  assert.match(sqlSource.explainSqlFailure(new Error('Login failed for user'), source), /Grant it read access/);
  assert.match(
    sqlSource.explainSqlFailure(new Error('Login failed for user'), { ...source, auth_mode: 'sql' }),
    /username and password/
  );
  assert.match(sqlSource.explainSqlFailure(new Error('Cannot open database "ERP"'), source), /not available to this identity/);
});

// ── Reconciliation: comparing runs ──
const reconCompare = require('../src/services/reconciliationComparisonService');

const RUN_A = { id: 1, rule_id: 9, rule_version: 1, started_at: '2026-08-01T10:00:00Z', records_a: 100, records_b: 98, keys_compared: 100, matched: 90, exception_count: 10 };
const RUN_B = { id: 2, rule_id: 9, rule_version: 1, started_at: '2026-08-10T10:00:00Z', records_a: 120, records_b: 120, keys_compared: 120, matched: 114, exception_count: 6 };

function finding(fingerprint, key, outcome, severity = 'medium') {
  return { fingerprint, business_key: key, outcome, severity, exception_id: null };
}

test('run comparison reports which items were fixed, which are new and which persist', () => {
  const comparison = reconCompare.compareRuns({
    fromRun: RUN_A, toRun: RUN_B,
    findingsFrom: [finding('f1', 'INV-1', 'value_mismatch'), finding('f2', 'INV-2', 'missing_from_b'), finding('f3', 'INV-3', 'duplicate')],
    findingsTo: [finding('f2', 'INV-2', 'missing_from_b'), finding('f4', 'INV-4', 'duplicate')],
  });

  assert.equal(comparison.findings.resolved.total, 2);
  assert.equal(comparison.findings.introduced.total, 1);
  assert.equal(comparison.findings.persisting.total, 1);
  assert.equal(comparison.summary.verdict, 'churn');
  assert.deepEqual(comparison.findings.introduced.sample[0].businessKey, 'INV-4');
});

test('an item that starts failing for a different reason is reported as changed, not as fixed and new', () => {
  const comparison = reconCompare.compareRuns({
    fromRun: RUN_A, toRun: RUN_B,
    findingsFrom: [finding('f1', 'INV-1', 'value_mismatch')],
    findingsTo: [finding('f1', 'INV-1', 'missing_from_b')],
  });
  assert.equal(comparison.findings.changed.total, 1);
  assert.equal(comparison.findings.resolved.total, 0);
  assert.equal(comparison.findings.introduced.total, 0);
  assert.equal(comparison.findings.changed.sample[0].fromOutcomeLabel, 'Value mismatch');
});

test('equal exception counts are not reported as no change when the items moved', () => {
  // The reason this works from findings rather than totals: ten before and ten after
  // can mean nothing happened, or that ten were fixed and ten new ones appeared.
  const comparison = reconCompare.compareRuns({
    fromRun: { ...RUN_A, exception_count: 2 }, toRun: { ...RUN_B, exception_count: 2 },
    findingsFrom: [finding('f1', 'A', 'duplicate'), finding('f2', 'B', 'duplicate')],
    findingsTo: [finding('f3', 'C', 'duplicate'), finding('f4', 'D', 'duplicate')],
  });
  assert.equal(comparison.summary.verdict, 'churn');
  assert.equal(comparison.summary.netChange, 0);
  assert.equal(comparison.findings.persisting.total, 0);
});

test('runs given in the wrong order are compared by date, not by argument position', () => {
  const comparison = reconCompare.compareRuns({
    fromRun: RUN_B, toRun: RUN_A,
    findingsFrom: [finding('f2', 'INV-2', 'duplicate')],
    findingsTo: [finding('f1', 'INV-1', 'duplicate')],
  });
  assert.equal(comparison.earlier.id, RUN_A.id);
  assert.equal(comparison.later.id, RUN_B.id);
  assert.equal(comparison.reversed, true);
  assert.equal(comparison.findings.introduced.sample[0].businessKey, 'INV-2');
});

test('runs of different rules are refused', () => {
  assert.throws(
    () => reconCompare.compareRuns({ fromRun: RUN_A, toRun: { ...RUN_B, rule_id: 42 }, findingsFrom: [], findingsTo: [] }),
    /same rule/
  );
  assert.throws(
    () => reconCompare.compareRuns({ fromRun: RUN_A, toRun: RUN_A, findingsFrom: [], findingsTo: [] }),
    /two different runs/
  );
});

test('a rule redefined between runs is flagged, because movement may not be the data', () => {
  const comparison = reconCompare.compareRuns({
    fromRun: RUN_A, toRun: { ...RUN_B, rule_version: 3 }, findingsFrom: [], findingsTo: [],
  });
  assert.equal(comparison.versionChanged, true);
  assert.equal(comparison.summary.verdict, 'clean');
});

test('metric deltas know which direction is an improvement', () => {
  const metrics = reconCompare.diffRunMetrics(RUN_A, RUN_B);
  const byKey = Object.fromEntries(metrics.map(metric => [metric.key, metric]));
  assert.equal(byKey.matched.direction, 'improved');
  assert.equal(byKey.exception_count.direction, 'improved');
  assert.equal(byKey.exception_count.delta, -4);
  assert.equal(byKey.records_a.direction, 'changed');

  const worse = reconCompare.diffRunMetrics(RUN_B, RUN_A);
  assert.equal(worse.find(m => m.key === 'exception_count').direction, 'worsened');
});

test('item lists are capped but their counts stay exact', () => {
  const many = Array.from({ length: 250 }, (_, i) => finding('f' + i, 'KEY-' + i, 'duplicate'));
  const diff = reconCompare.diffFindings([], many, { sampleLimit: 10 });
  assert.equal(diff.introduced.total, 250);
  assert.equal(diff.introduced.sample.length, 10);
});

// ── Reconciliation: the dashboard's connection discipline ──
const reconRepo = require('../src/services/reconciliationRepository');

/**
 * Stands in for a tedious connection, which carries exactly one request at a time.
 * A second request issued while the first is in flight is rejected — the real
 * driver's behaviour, and the fault that left the dashboard panels empty.
 */
function fakeSqlPrimitives(rowsFor) {
  let inFlight = false;
  const executed = [];
  return {
    executed,
    getConnection: async () => ({ close() {} }),
    execSql: async (conn, sql, params) => {
      if (inFlight) throw new Error('Requests can only be made in the LoggedIn state, not the SentClientRequest state');
      inFlight = true;
      executed.push({ sql, params });
      await new Promise(resolve => setImmediate(resolve));
      inFlight = false;
      return rowsFor(sql);
    },
  };
}

async function withFakeSql(rowsFor, fn) {
  const real = { getConnection: dbService._sql.getConnection, execSql: dbService._sql.execSql };
  const fake = fakeSqlPrimitives(rowsFor);
  dbService._sql.getConnection = fake.getConnection;
  dbService._sql.execSql = fake.execSql;
  try {
    return { result: await fn(), executed: fake.executed };
  } finally {
    Object.assign(dbService._sql, real);
  }
}

test('every dashboard panel is populated, not just the first one', async () => {
  // Regression: the queries used to be issued together on one connection, so the
  // first answered and the rest were rejected. The errors were swallowed, so the
  // panels rendered empty and looked like data that had not refreshed after a run.
  const { result, executed } = await withFakeSql(sql => {
    if (/FROM recon_rules/.test(sql)) return [{ status: 'active', total: 3 }];
    if (/GROUP BY status/.test(sql)) return [{ status: 'open', total: 7 }];
    if (/GROUP BY outcome/.test(sql)) return [{ outcome: 'duplicate', total: 2 }];
    if (/GROUP BY severity/.test(sql)) return [{ severity: 'high', total: 1 }];
    if (/GROUP BY rule_id/.test(sql)) return [{ rule_id: 9, rule_name: 'R', open_count: 4 }];
    if (/FROM recon_runs/.test(sql)) return [{ id: 3 }];
    if (/GROUP BY owner/.test(sql)) return [{ owner: 'Ann', total: 5 }];
    if (/DATEDIFF/.test(sql)) return [{ week1: 1, month1: 2, older: 3 }];
    return [];
  }, () => reconRepo.getDashboardData());

  assert.deepEqual(result.problems, [], 'no panel should fail');
  assert.equal(result.rules[0].total, 3);
  assert.equal(result.exceptionsByStatus[0].total, 7);
  assert.equal(result.exceptionsByOutcome[0].total, 2);
  assert.equal(result.byOwner[0].owner, 'Ann');
  assert.equal(result.byRule[0].open_count, 4);
  assert.equal(result.recentRuns.length, 1);
  assert.equal(result.ageing.older, 3);
  assert.ok(executed.length >= 8);
});

test('scoping the dashboard to one run asks what that run found', async () => {
  const { result, executed } = await withFakeSql(sql => {
    if (/FROM recon_run_findings/.test(sql) && /GROUP BY outcome/.test(sql)) return [{ outcome: 'value_mismatch', total: 4 }];
    if (/WHERE id=@run/.test(sql)) return [{ id: 12, rule_id: 9, matched: 80 }];
    return [];
  }, () => reconRepo.getDashboardData({ runId: 12 }));

  assert.equal(result.scoped, true);
  assert.equal(result.scopedRun.id, 12);
  assert.equal(result.exceptionsByOutcome[0].total, 4);
  assert.ok(executed.some(entry => /recon_run_findings/.test(entry.sql)),
    'a scoped dashboard must read the run\'s findings, not the standing exception list');
  assert.deepEqual(result.problems, []);
});

test('one unreadable panel is reported rather than silently blanking the page', async () => {
  const { result } = await withFakeSql(sql => {
    if (/GROUP BY owner/.test(sql)) throw new Error("Invalid object name 'recon_exceptions'");
    return [];
  }, () => reconRepo.getDashboardData());

  assert.deepEqual(result.byOwner, []);
  assert.ok(result.problems.length, 'a failed panel must be named so it cannot hide');
});

test('a batch rule change writes each rule separately and keeps going after a failure', async () => {
  const { result, executed } = await withFakeSql(sql => {
    if (/UPDATE recon_rules/.test(sql) && /@id/.test(sql)) return [];
    if (/SELECT version/.test(sql)) return [{ version: 4 }];
    if (/SELECT \* FROM recon_rules/.test(sql)) return [{ id: 1, name: 'R' }];
    return [];
  }, () => reconRepo.batchUpdateRules([1, 2, 3], { status: 'retired' }, 'tester'));

  assert.equal(result.length, 3);
  assert.ok(result.every(entry => entry.success));
  // Each rule gets its own version row: a batch is a convenience for the operator,
  // not a reason for the audit trail to lose track of what happened to each control.
  const versionWrites = executed.filter(entry => /INSERT INTO recon_rule_versions/.test(entry.sql));
  assert.equal(versionWrites.length, 3);
});

test('a batch that changes nothing is refused before it touches the database', async () => {
  const { executed } = await withFakeSql(() => [], () => reconRepo.batchUpdateRules([1], {}, 'tester'));
  assert.equal(executed.length, 0);
});

test('a batch activation moves the valid rules and names the ones it could not activate', async () => {
  // An incomplete control must never be presented to operators as active, but one
  // bad rule in a selection should not block the rest.
  const complete = {
    id: 1, name: 'Complete', status: 'draft', source_a_id: 1, source_b_id: 2,
    dataset_a: 'A', dataset_b: 'B', key_field_a: 'Id', key_field_b: 'Id',
    compareFields: [{ label: 'Net', a: { kind: 'field', value: 'Net' }, b: { kind: 'field', value: 'Net' }, type: 'number' }],
  };
  const incomplete = { id: 2, name: 'No key yet', status: 'draft', source_a_id: 1, source_b_id: 2, dataset_a: 'A', dataset_b: 'B', compareFields: [] };

  const original = {
    listRules: reconRepo.listRules, getRuleById: reconRepo.getRuleById, batchUpdateRules: reconRepo.batchUpdateRules,
  };
  reconRepo.listRules = async () => [complete, incomplete];
  reconRepo.getRuleById = async id => (Number(id) === 1 ? complete : incomplete);
  let applied = null;
  reconRepo.batchUpdateRules = async (ids, change) => { applied = { ids, change }; return ids.map(id => ({ id, success: true })); };

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = await postJson(server, '/reconciliation/rules/batch', {
      ruleIds: [1, 2], status: 'active', assignOwner: true, owner: 'Ann',
    });
    assert.equal(body.success, true);
    assert.equal(body.updated, 1);
    assert.deepEqual(applied.ids, [1]);
    assert.equal(applied.change.owner, 'Ann');
    assert.equal(body.skipped.length, 1);
    assert.equal(body.skipped[0].name, 'No key yet');
    assert.match(body.skipped[0].message, /business key/i);
  } finally {
    Object.assign(reconRepo, original);
    await new Promise(resolve => server.close(resolve));
  }
});

// ── Reconciliation: comparing every rule at once ──
test('the per-rule overview pairs each rule\'s two most recent runs', () => {
  const runs = [
    { id: 1, rule_id: 9, rule_name: 'Invoices', status: 'completed', started_at: '2026-08-01T10:00:00Z', exception_count: 4 },
    { id: 2, rule_id: 9, rule_name: 'Invoices', status: 'completed', started_at: '2026-08-10T10:00:00Z', exception_count: 2 },
    { id: 3, rule_id: 9, rule_name: 'Invoices', status: 'completed', started_at: '2026-07-01T10:00:00Z', exception_count: 9 },
    { id: 4, rule_id: 10, rule_name: 'Ledger', status: 'completed', started_at: '2026-08-05T10:00:00Z', exception_count: 1 },
    { id: 5, rule_id: 10, rule_name: 'Ledger', status: 'failed', started_at: '2026-08-09T10:00:00Z' },
  ];
  const pairs = reconCompare.latestPairsByRule(runs);
  const invoices = pairs.find(pair => pair.ruleId === 9);
  assert.equal(invoices.later.id, 2, 'the newest run is the later side');
  assert.equal(invoices.earlier.id, 1, 'the one before it is the earlier side, not the oldest');

  // A failed run is not a result to compare against.
  const ledger = pairs.find(pair => pair.ruleId === 10);
  assert.equal(ledger.later.id, 4);
  assert.equal(ledger.earlier, null);
});

test('a rule that has only ever run once is listed rather than omitted', () => {
  // A control nobody has re-run is exactly the one worth noticing.
  const overview = reconCompare.compareAcrossRules({
    runs: [{ id: 7, rule_id: 11, rule_name: 'New control', status: 'completed', started_at: '2026-08-01T10:00:00Z', exception_count: 3 }],
    findings: [
      { run_id: 7, rule_id: 11, fingerprint: 'a', business_key: 'K1', outcome: 'duplicate', severity: 'high' },
      { run_id: 7, rule_id: 11, fingerprint: 'b', business_key: 'K2', outcome: 'duplicate', severity: 'low' },
    ],
  });
  assert.equal(overview.length, 1);
  assert.equal(overview[0].comparable, false);
  assert.equal(overview[0].comparison, null);
  assert.equal(overview[0].exceptionCount, 3);
  assert.deepEqual(overview[0].severity, { high: 1, medium: 0, low: 1 });
});

test('the overview reports each rule\'s movement and keeps rules independent', () => {
  const runs = [
    { id: 1, rule_id: 9, rule_name: 'Improving', status: 'completed', started_at: '2026-08-01T10:00:00Z', exception_count: 2 },
    { id: 2, rule_id: 9, rule_name: 'Improving', status: 'completed', started_at: '2026-08-10T10:00:00Z', exception_count: 0 },
    { id: 3, rule_id: 10, rule_name: 'Worsening', status: 'completed', started_at: '2026-08-02T10:00:00Z', exception_count: 0 },
    { id: 4, rule_id: 10, rule_name: 'Worsening', status: 'completed', started_at: '2026-08-11T10:00:00Z', exception_count: 2 },
  ];
  const findings = [
    { run_id: 1, rule_id: 9, fingerprint: 'a', business_key: 'A', outcome: 'duplicate', severity: 'medium' },
    { run_id: 1, rule_id: 9, fingerprint: 'b', business_key: 'B', outcome: 'duplicate', severity: 'medium' },
    { run_id: 4, rule_id: 10, fingerprint: 'c', business_key: 'C', outcome: 'missing_from_b', severity: 'high' },
    { run_id: 4, rule_id: 10, fingerprint: 'd', business_key: 'D', outcome: 'missing_from_b', severity: 'high' },
  ];
  const overview = reconCompare.compareAcrossRules({ runs, findings });
  const byName = Object.fromEntries(overview.map(row => [row.ruleName, row]));

  assert.equal(byName.Improving.summary.verdict, 'better');
  assert.equal(byName.Improving.summary.resolved, 2);
  assert.equal(byName.Worsening.summary.verdict, 'worse');
  assert.equal(byName.Worsening.summary.introduced, 2);
  // Findings are grouped by run, so one rule's items never leak into another's.
  assert.equal(byName.Improving.summary.introduced, 0);
});

test('a rule the overview cannot compare does not take the other rules down with it', () => {
  const overview = reconCompare.compareAcrossRules({
    runs: [
      // Same rule id but the same run twice — compareRuns refuses this pair.
      { id: 1, rule_id: 9, rule_name: 'Broken', status: 'completed', started_at: '2026-08-01T10:00:00Z' },
      { id: 1, rule_id: 9, rule_name: 'Broken', status: 'completed', started_at: '2026-08-02T10:00:00Z' },
      { id: 3, rule_id: 10, rule_name: 'Fine', status: 'completed', started_at: '2026-08-01T10:00:00Z' },
      { id: 4, rule_id: 10, rule_name: 'Fine', status: 'completed', started_at: '2026-08-02T10:00:00Z' },
    ],
    findings: [],
  });
  const broken = overview.find(row => row.ruleName === 'Broken');
  const fine = overview.find(row => row.ruleName === 'Fine');
  assert.ok(broken.error, 'the unusable pair reports its problem');
  assert.equal(fine.summary.verdict, 'clean');
});

// ── Reconciliation: bulk decisions on exceptions ──
test('a bulk decision records owner, severity and status as separate history entries', async () => {
  const { result, executed } = await withFakeSql(() => [], () => reconRepo.batchUpdateExceptions(
    [{ id: 1, status: 'open', severity: 'medium', owner: null }],
    { assignOwner: true, owner: 'Ann', severity: 'high', toStatus: 'investigating', actor: 'tester' }
  ));

  assert.equal(result[0].success, true);
  assert.equal(result[0].changed, true);

  // The three entries are written in one multi-row statement now, so the property
  // to assert is that all three exist — not how many statements carried them.
  const eventWrites = executed.filter(entry => /INSERT INTO recon_exception_events/.test(entry.sql));
  assert.equal(eventWrites.length, 1, 'history is written in one batch');
  const actions = eventWrites[0].params.filter(param => /^a\d+$/.test(param.name)).map(param => param.value);
  assert.deepEqual(actions.sort(), ['assigned', 'severity-change', 'status-change'],
    'assignment, severity change and status change are each auditable');

  const update = executed.find(entry => /UPDATE recon_exceptions/.test(entry.sql));
  assert.match(update.sql, /owner=@owner/);
  assert.match(update.sql, /severity=@severity/);
  assert.match(update.sql, /status=@status/);
  assert.match(update.sql, /WHERE id IN \(@i0\)/, 'the update targets a bound id set');
});

test('a bulk decision that matches what an exception already says writes nothing', async () => {
  const { result, executed } = await withFakeSql(() => [], () => reconRepo.batchUpdateExceptions(
    [{ id: 1, status: 'open', severity: 'high', owner: 'Ann' }],
    { assignOwner: true, owner: 'Ann', severity: 'high', toStatus: 'open', actor: 'tester' }
  ));
  assert.equal(result[0].changed, false);
  assert.equal(executed.length, 0, 'no update and no history entry for a no-op');
});

test('closing in bulk stamps the reason and the resolution date', async () => {
  const { executed } = await withFakeSql(() => [], () => reconRepo.batchUpdateExceptions(
    [{ id: 1, status: 'investigating', severity: 'high', owner: 'Ann' }],
    { toStatus: 'resolved', reason: 'Source system corrected', actor: 'tester' }
  ));
  const update = executed.find(entry => /UPDATE recon_exceptions/.test(entry.sql));
  assert.match(update.sql, /resolved_at=SYSUTCDATETIME\(\)/);
  assert.match(update.sql, /resolution_reason=@reason/);
});

test('reopening clears the resolution date rather than leaving a stale one', async () => {
  const { executed } = await withFakeSql(() => [], () => reconRepo.batchUpdateExceptions(
    [{ id: 1, status: 'resolved', severity: 'high' }],
    { toStatus: 'open', actor: 'tester' }
  ));
  const update = executed.find(entry => /UPDATE recon_exceptions/.test(entry.sql));
  assert.match(update.sql, /resolved_at=NULL/);
});

test('exception ids are parameterised, never interpolated into the statement', async () => {
  const { executed } = await withFakeSql(() => [], () => reconRepo.getExceptionsByIds([4, 9, 'nonsense']));
  const select = executed[0];
  assert.match(select.sql, /WHERE id IN \(@e0, @e1\)/);
  assert.deepEqual(select.params.map(p => p.value), [4, 9]);
});

test('a bulk status change moves what it can and names what it cannot', async () => {
  // A selection routinely mixes statuses. The open one can be resolved; the one
  // already accepted cannot, and forcing it would put the audit trail at odds with
  // the process it evidences.
  const rows = [
    { id: 1, business_key: 'INV-1', status: 'open', severity: 'medium' },
    { id: 2, business_key: 'INV-2', status: 'accepted', severity: 'low' },
  ];
  const original = { getExceptionsByIds: reconRepo.getExceptionsByIds, batchUpdateExceptions: reconRepo.batchUpdateExceptions };
  reconRepo.getExceptionsByIds = async () => rows;
  let applied = null;
  reconRepo.batchUpdateExceptions = async (exceptions, change) => {
    applied = { ids: exceptions.map(e => e.id), change };
    return exceptions.map(e => ({ id: e.id, success: true, changed: true }));
  };

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = await postJson(server, '/reconciliation/exceptions/batch', {
      ids: [1, 2], status: 'resolved', reason: 'Corrected at source', assignOwner: true, owner: 'Ann', severity: 'high',
    });
    assert.equal(body.success, true);
    assert.deepEqual(applied.ids, [1]);
    assert.equal(applied.change.severity, 'high');
    assert.equal(applied.change.owner, 'Ann');
    assert.equal(body.skipped.length, 1);
    assert.equal(body.skipped[0].key, 'INV-2');
    assert.match(body.skipped[0].message, /Cannot move from "accepted"/);
  } finally {
    Object.assign(reconRepo, original);
    await new Promise(resolve => server.close(resolve));
  }
});

test('closing exceptions in bulk still requires a recorded reason', async () => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = await postJson(server, '/reconciliation/exceptions/batch', { ids: [1, 2], status: 'resolved' });
    assert.equal(body.success, false);
    assert.match(body.message, /Record why/);

    const empty = await postJson(server, '/reconciliation/exceptions/batch', { ids: [1] });
    assert.equal(empty.success, false);
    assert.match(empty.message, /owner, a severity, a status/);

    const bad = await postJson(server, '/reconciliation/exceptions/batch', { ids: [1], severity: 'catastrophic' });
    assert.equal(bad.success, false);
    assert.match(bad.message, /Unknown severity/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ── Master data: standardisation ──
const mdm = require('../src/services/mdmService');

test('standardisation removes meaningless differences and treats absence markers as absent', () => {
  const rules = ['trim', 'collapse_whitespace', 'strip_punctuation', 'strip_diacritics', 'lower'];
  assert.equal(mdm.standardiseValue('  ACME,  Ltd. ', { rules }), 'acme ltd');
  assert.equal(mdm.standardiseValue('Müller', { rules }), 'muller');

  // Two records both saying "N/A" are not two records that agree — treating them as
  // data is a classic false merge.
  for (const absent of ['N/A', '  ', 'unknown', '-', 'NULL']) {
    assert.equal(mdm.standardiseValue(absent, { rules }), null, absent + ' should read as absent');
  }
  assert.equal(mdm.standardiseValue(0, { rules }), '0', 'zero is a value, not an absence');
});

test('abbreviation expansion makes address variants comparable', () => {
  const rules = ['trim', 'strip_punctuation', 'lower', 'expand_abbreviations'];
  assert.equal(mdm.standardiseValue('12 Main St.', { rules }), '12 main street');
  assert.equal(mdm.standardiseValue('12 Main Street', { rules }), '12 main street');
  assert.equal(mdm.standardiseValue('Acme Ltd', { rules }), 'acme limited');
});

test('digit-only standardisation makes separator differences comparable, and no more', () => {
  const rules = ['digits_only'];
  assert.equal(mdm.standardiseValue('44-20-7946-0958', { rules }), '442079460958');
  assert.equal(mdm.standardiseValue('44 (20) 7946 0958', { rules }), '442079460958');

  // A trunk zero is a digit, so international and national forms of the same number
  // do not become equal. Standardisation removes formatting, not domain knowledge —
  // a field like this wants an edit-distance comparator rather than exact equality.
  const national = mdm.standardiseValue('+44 (0)20 7946 0958', { rules });
  assert.equal(national, '4402079460958');
  assert.equal(mdm.compareValues(national, '442079460958', { comparator: 'exact' }), 0);
  assert.ok(mdm.compareValues(national, '442079460958', { comparator: 'edit' }) > 0.9);
});

// ── Master data: comparators ──
test('each comparator suits the error its field actually suffers from', () => {
  // Transposition in a keyed reference.
  assert.ok(mdm.editSimilarity('INV-10432', 'INV-14032') > 0.75);
  // Names agree at the start; Jaro-Winkler rewards that.
  assert.ok(mdm.jaroWinkler('robert', 'roberto') > mdm.editSimilarity('robert', 'roberto'));
  // Word order and extra tokens in company names.
  assert.equal(mdm.tokenSetSimilarity('acme limited', 'limited acme'), 1);
  assert.ok(mdm.tokenSetSimilarity('acme limited london', 'acme limited') > 0.6);
  // Sounds alike.
  assert.equal(mdm.soundex('Smith'), mdm.soundex('Smyth'));
  assert.notEqual(mdm.soundex('Smith'), mdm.soundex('Jones'));
});

test('numeric comparison degrades past its tolerance instead of falling off a cliff', () => {
  const field = { comparator: 'numeric', tolerance: 1 };
  assert.equal(mdm.compareValues('100', '100.5', field), 1);
  const near = mdm.compareValues('100', '102', field);
  const far = mdm.compareValues('100', '120', field);
  assert.ok(near > 0 && near < 1);
  assert.ok(far < near);
});

// ── Master data: scoring ──
const PERSON_FIELDS = [
  { key: 'name', column: 'Name', standardisers: ['trim', 'lower'], comparator: 'jaro_winkler', weight: 3 },
  { key: 'email', column: 'Email', standardisers: ['trim', 'lower'], comparator: 'exact', weight: 3 },
  { key: 'city', column: 'City', standardisers: ['trim', 'lower'], comparator: 'exact', weight: 1 },
];

function personRecord(raw, fields = PERSON_FIELDS) {
  return { raw, sourceId: raw.Id, sourceSystem: raw.SourceSystem, standardised: mdm.standardiseRecord(raw, fields) };
}

test('weights are shared among the fields that could actually be compared', () => {
  // Without this, a sparse pair never reaches the threshold — and sparse records are
  // exactly the ones most in need of mastering.
  const a = personRecord({ Id: 1, Name: 'Jane Smith', Email: 'jane@x.com', City: null });
  const b = personRecord({ Id: 2, Name: 'Jane Smith', Email: 'jane@x.com', City: 'London' });
  const result = mdm.scorePair(a, b, PERSON_FIELDS, {});
  assert.equal(result.score, 1, 'the missing city must not drag a perfect match down');
  assert.equal(result.comparedFields, 2);
  assert.equal(result.decision, 'match');
});

test('a missing value can be counted as disagreement where the field is mandatory', () => {
  const fields = PERSON_FIELDS.map(field => (field.key === 'city' ? { ...field, nullPolicy: 'disagree' } : field));
  const a = personRecord({ Id: 1, Name: 'Jane Smith', Email: 'jane@x.com', City: null }, fields);
  const b = personRecord({ Id: 2, Name: 'Jane Smith', Email: 'jane@x.com', City: 'London' }, fields);
  assert.ok(mdm.scorePair(a, b, fields, {}).score < 1);
});

test('a required field that disagrees rejects the pair however well everything else matches', () => {
  const fields = PERSON_FIELDS.map(field => (field.key === 'email' ? { ...field, required: true } : field));
  const a = personRecord({ Id: 1, Name: 'Jane Smith', Email: 'jane@x.com', City: 'London' }, fields);
  const b = personRecord({ Id: 2, Name: 'Jane Smith', Email: 'other@x.com', City: 'London' }, fields);
  const result = mdm.scorePair(a, b, fields, {});
  assert.equal(result.decision, 'no_match');
  assert.equal(result.rejectedBy.field, 'email');
});

test('a blocker field stops two similar records in different countries from merging', () => {
  const fields = [
    { key: 'name', column: 'Name', standardisers: ['lower'], comparator: 'jaro_winkler', weight: 3 },
    { key: 'country', column: 'Country', standardisers: ['lower'], comparator: 'exact', weight: 1, blocker: true },
  ];
  const a = personRecord({ Id: 1, Name: 'Acme Ltd', Country: 'GB' }, fields);
  const b = personRecord({ Id: 2, Name: 'Acme Ltd', Country: 'US' }, fields);
  assert.equal(mdm.scorePair(a, b, fields, {}).decision, 'no_match');

  // Absent is not the same as conflicting: a blocker only rejects disagreement.
  const c = personRecord({ Id: 3, Name: 'Acme Ltd', Country: null }, fields);
  assert.equal(mdm.scorePair(a, c, fields, {}).decision, 'match');
});

test('the middle band goes to a steward rather than being decided either way', () => {
  const a = personRecord({ Id: 1, Name: 'Jonathan Smith', Email: 'j.smith@x.com', City: 'London' });
  const b = personRecord({ Id: 2, Name: 'Jon Smith', Email: 'jsmith@x.com', City: 'London' });
  const result = mdm.scorePair(a, b, PERSON_FIELDS, { autoMatchThreshold: 0.95, reviewThreshold: 0.5 });
  assert.equal(result.decision, 'review');
});

// ── Master data: blocking ──
test('blocking cuts the comparisons and reports what it cost', () => {
  const records = Array.from({ length: 200 }, (_, i) =>
    personRecord({ Id: i, Name: 'Person ' + (i % 50), Email: 'p' + i + '@x.com', City: 'London' }));
  const blocked = mdm.generateCandidatePairs(records, [{ field: 'name', strategy: 'exact' }]);

  const everything = records.length * (records.length - 1) / 2;
  assert.ok(blocked.pairs.length < everything / 10, 'blocking must remove most comparisons');
  assert.equal(blocked.largestBlock, 4);
  assert.ok(blocked.blocksExamined >= 50);
});

test('several blocking keys widen the net rather than narrowing it', () => {
  const records = [
    personRecord({ Id: 1, Name: 'Smith', Email: 'a@x.com', City: 'London' }),
    personRecord({ Id: 2, Name: 'Smyth', Email: 'a@x.com', City: 'Leeds' }),
  ];
  // Neither name nor city agrees exactly, so an exact block finds nothing.
  assert.equal(mdm.generateCandidatePairs(records, [{ field: 'name', strategy: 'exact' }]).pairs.length, 0);
  // Sounds-alike on the name, or exact on the email, each catch it.
  assert.equal(mdm.generateCandidatePairs(records, [
    { field: 'name', strategy: 'phonetic' }, { field: 'city', strategy: 'exact' },
  ]).pairs.length, 1);
});

test('candidate generation stops at its limit and says so', () => {
  const records = Array.from({ length: 60 }, (_, i) => personRecord({ Id: i, Name: 'Same', Email: 'e@x.com', City: 'London' }));
  const result = mdm.generateCandidatePairs(records, [{ field: 'name', strategy: 'exact' }], { maxPairs: 100 });
  assert.equal(result.truncated, true);
  assert.ok(result.pairs.length <= 100);
});

// ── Master data: clustering ──
test('matches are transitive by default, which is how master data over-merges', () => {
  // A~B and B~C, but A and C were never compared favourably. Union-find puts all
  // three together, and this is exactly the behaviour strict mode exists to refuse.
  const loose = mdm.clusterRecords(3, [[0, 1], [1, 2]], { strict: false });
  assert.deepEqual(loose, [[0, 1, 2]]);

  const strict = mdm.clusterRecords(3, [[0, 1], [1, 2]], { strict: true });
  assert.equal(strict.length, 3, 'a chain of weak links must not become one entity');
});

test('strict grouping still merges a group where every pair matched', () => {
  const strict = mdm.clusterRecords(3, [[0, 1], [1, 2], [0, 2]], { strict: true });
  assert.deepEqual(strict, [[0, 1, 2]]);
});

// ── Master data: survivorship ──
const SURVIVOR_MODEL = {
  sourceField: 'SourceSystem',
  timestampField: 'UpdatedAt',
  sourcePriority: ['SAP', 'CRM'],
};

function survivorRecords(fields) {
  return [
    { Id: 'c-1', SourceSystem: 'CRM', UpdatedAt: '2026-08-10', Name: 'Jonathan Smith', Phone: null, Credit: 5000 },
    { Id: 's-1', SourceSystem: 'SAP', UpdatedAt: '2026-01-05', Name: 'J Smith', Phone: '0200000', Credit: 3000 },
    { Id: 'l-1', SourceSystem: 'Legacy', UpdatedAt: '2026-08-20', Name: 'Jonathan Smith', Phone: '0200000', Credit: 4000 },
  ].map(raw => ({ raw, sourceId: raw.Id, sourceSystem: raw.SourceSystem, standardised: mdm.standardiseRecord(raw, fields) }));
}

test('each survivorship rule picks the value it claims to', () => {
  const base = { column: 'Name', standardisers: ['trim'] };
  const members = survivorRecords([{ key: 'name', ...base }]);

  const trusted = mdm.pickSurvivor(members, { key: 'name', ...base, survivorship: 'source_priority' }, SURVIVOR_MODEL);
  assert.equal(trusted.value, 'J Smith', 'SAP outranks CRM and Legacy');

  const recent = mdm.pickSurvivor(members, { key: 'name', ...base, survivorship: 'most_recent' }, SURVIVOR_MODEL);
  assert.equal(recent.value, 'Jonathan Smith');

  const longest = mdm.pickSurvivor(members, { key: 'name', ...base, survivorship: 'longest' }, SURVIVOR_MODEL);
  assert.equal(longest.value, 'Jonathan Smith');

  const frequent = mdm.pickSurvivor(members, { key: 'name', ...base, survivorship: 'most_frequent' }, SURVIVOR_MODEL);
  assert.equal(frequent.value, 'Jonathan Smith');
  assert.match(frequent.reason, /2 of 3 sources agree/);
});

test('a source not on the trust list ranks last rather than first', () => {
  // An unexpected new system must never silently outrank the book of record.
  const base = { key: 'name', column: 'Name', standardisers: ['trim'], survivorship: 'source_priority' };
  const members = survivorRecords([base]);
  assert.equal(mdm.pickSurvivor(members, base, SURVIVOR_MODEL).sourceSystem, undefined);
  const winner = mdm.pickSurvivor(members, base, SURVIVOR_MODEL);
  assert.equal(winner.from.sourceSystem, 'SAP');
});

test('the first non-empty value skips a source that carries nothing', () => {
  const base = { key: 'phone', column: 'Phone', standardisers: ['trim'], survivorship: 'most_complete' };
  const members = survivorRecords([base]);
  // CRM ranks above Legacy but has no phone, so the value comes from SAP.
  const survivor = mdm.pickSurvivor(members, base, SURVIVOR_MODEL);
  assert.equal(survivor.value, '0200000');
  assert.equal(survivor.from.sourceSystem, 'SAP');
});

test('numeric survivorship handles the aggregate rules', () => {
  const base = { key: 'credit', column: 'Credit', standardisers: [] };
  const members = survivorRecords([base]);
  assert.equal(mdm.pickSurvivor(members, { ...base, survivorship: 'max' }, SURVIVOR_MODEL).value, 5000);
  assert.equal(mdm.pickSurvivor(members, { ...base, survivorship: 'min' }, SURVIVOR_MODEL).value, 3000);
  assert.equal(mdm.pickSurvivor(members, { ...base, survivorship: 'sum' }, SURVIVOR_MODEL).value, 12000);
});

test('most-recent falls back to trust rather than guessing when no dates exist', () => {
  const base = { key: 'name', column: 'Name', standardisers: ['trim'], survivorship: 'most_recent' };
  const members = survivorRecords([base]).map(record => ({ ...record, raw: { ...record.raw, UpdatedAt: null } }));
  const survivor = mdm.pickSurvivor(members, base, SURVIVOR_MODEL);
  assert.match(survivor.reason, /no timestamps available/);
  assert.equal(survivor.from.sourceSystem, 'SAP');
});

test('a golden record records where every value came from', () => {
  // A golden record whose values cannot be traced back cannot be defended, and
  // disagreement is the normal case in master data.
  const fields = [
    { key: 'name', column: 'Name', standardisers: ['trim'], survivorship: 'longest' },
    { key: 'credit', column: 'Credit', standardisers: [], survivorship: 'max' },
  ];
  const golden = mdm.buildGoldenRecord(survivorRecords(fields), fields, SURVIVOR_MODEL, 0);

  assert.equal(golden.goldenId, 'MDM-000001');
  assert.equal(golden.memberCount, 3);
  assert.deepEqual(golden.sourceRecordIds, ['c-1', 's-1', 'l-1']);
  assert.equal(golden.provenance.name.strategy, 'longest');
  assert.equal(golden.provenance.credit.sourceSystem, 'CRM');
  assert.equal(golden.conflicts, 2, 'both fields disagreed across the sources');
});

test('a field reserved for a steward is left empty and flags the record', () => {
  const fields = [{ key: 'name', column: 'Name', standardisers: ['trim'], survivorship: 'manual' }];
  const golden = mdm.buildGoldenRecord(survivorRecords(fields), fields, SURVIVOR_MODEL, 0);
  assert.equal(golden.values.name, null);
  assert.equal(golden.needsSteward, true);
});

// ── Master data: the whole pipeline ──
const CUSTOMER_MODEL = {
  sourceIdField: 'Id',
  sourceField: 'SourceSystem',
  timestampField: 'UpdatedAt',
  sourcePriority: ['SAP', 'CRM', 'Legacy'],
  autoMatchThreshold: 0.9,
  reviewThreshold: 0.7,
  blocks: [{ field: 'name', strategy: 'phonetic' }, { field: 'email', strategy: 'exact' }],
  fields: [
    { key: 'name', column: 'Name', standardisers: ['trim', 'collapse_whitespace', 'strip_punctuation', 'lower'], comparator: 'jaro_winkler', weight: 3, survivorship: 'longest' },
    { key: 'email', column: 'Email', standardisers: ['trim', 'lower'], comparator: 'exact', weight: 4, survivorship: 'most_recent' },
    { key: 'city', column: 'City', standardisers: ['trim', 'lower'], comparator: 'exact', weight: 1, survivorship: 'source_priority' },
  ],
};

const RAW_CUSTOMERS = [
  { Id: 'sap-1', SourceSystem: 'SAP', UpdatedAt: '2026-01-01', Name: 'ACME Ltd.', Email: 'ops@acme.com', City: 'London' },
  { Id: 'crm-1', SourceSystem: 'CRM', UpdatedAt: '2026-08-01', Name: 'Acme Limited', Email: 'ops@acme.com', City: 'London' },
  { Id: 'leg-1', SourceSystem: 'Legacy', UpdatedAt: '2026-03-01', Name: 'ACME  LTD', Email: 'ops@acme.com', City: null },
  { Id: 'sap-2', SourceSystem: 'SAP', UpdatedAt: '2026-02-01', Name: 'Globex Corporation', Email: 'hi@globex.com', City: 'Leeds' },
];

test('the pipeline turns raw records from several systems into golden records', () => {
  const result = mdm.buildMasterData(RAW_CUSTOMERS, CUSTOMER_MODEL);

  assert.equal(result.stats.rawRecords, 4);
  assert.equal(result.stats.goldenRecords, 2, 'the three Acme rows become one');
  assert.equal(result.stats.duplicatesRemoved, 2);
  assert.equal(result.stats.mergedClusters, 1);

  const acme = result.golden.find(record => record.memberCount === 3);
  assert.deepEqual(acme.sourceSystems.sort(), ['CRM', 'Legacy', 'SAP']);
  assert.equal(acme.values.name, 'Acme Limited', 'the longest name survives');
  assert.equal(acme.values.city, 'London');
  assert.equal(acme.provenance.city.sourceSystem, 'SAP', 'city came from the most trusted source carrying one');

  // The crosswalk maps every source record to exactly one golden record.
  assert.equal(result.crosswalk.length, 4);
  assert.equal(new Set(result.crosswalk.map(entry => entry.sourceId)).size, 4);
});

test('the pipeline reports the blocking cost, which is what makes a model scale or not', () => {
  const result = mdm.buildMasterData(RAW_CUSTOMERS, CUSTOMER_MODEL);
  assert.ok(result.stats.pairsCompared > 0);
  assert.ok(result.stats.blocksExamined > 0);
  assert.ok(result.stats.largestBlock >= 3);
  assert.equal(result.stats.pairsTruncated, false);
});

test('an over-large group is flagged rather than left to be discovered downstream', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    Id: 'r-' + i, SourceSystem: 'SAP', UpdatedAt: '2026-01-01',
    Name: 'Same Name', Email: 'same@x.com', City: 'London',
  }));
  const result = mdm.buildMasterData(rows, CUSTOMER_MODEL);
  assert.equal(result.stats.largestCluster, 40);
  assert.equal(result.stats.overMergeSuspected, true);
});

test('a model with no fields is refused rather than producing one record per row', () => {
  assert.throws(() => mdm.buildMasterData(RAW_CUSTOMERS, { fields: [] }), /no fields/);
});

test('golden ids can be the most trusted record\'s own identifier', () => {
  const result = mdm.buildMasterData(RAW_CUSTOMERS, { ...CUSTOMER_MODEL, goldenIdStrategy: 'primary_source_id' });
  const acme = result.golden.find(record => record.memberCount === 3);
  assert.equal(acme.goldenId, 'sap-1', 'the SAP record ranks highest, so its id becomes the master id');
});

// ── Master data: publishing to a destination ──
test('a lakehouse endpoint is refused as a destination before a run reaches the write', () => {
  // A lakehouse SQL analytics endpoint is read-only however the permissions are set,
  // so this has to be said at the point of choosing rather than discovered at the end
  // of a long run.
  const lakehouse = sqlSource.describeWritability({ kind: 'fabric-sql', item_type: 'Lakehouse' });
  assert.equal(lakehouse.writable, false);
  assert.match(lakehouse.reason, /read-only/);

  assert.equal(sqlSource.describeWritability({ kind: 'fabric-sql', item_type: 'Warehouse' }).writable, true);
  assert.equal(sqlSource.describeWritability({ kind: 'external-sql' }).writable, true);
});

test('golden records are written as bound parameters, never as statement text', () => {
  const statements = sqlSource.buildInsertStatements('dbo.CustomerMaster', ['golden_id', 'name'], [
    { golden_id: 'MDM-000001', name: "O'Brien & Sons; DROP TABLE x" },
    { golden_id: 'MDM-000002', name: null },
  ]);

  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /INSERT INTO \[dbo\]\.\[CustomerMaster\] \(\[golden_id\], \[name\]\) VALUES \(@p0_0, @p0_1\), \(@p1_0, @p1_1\)/);
  assert.ok(!/DROP TABLE/.test(statements[0].sql), 'a value must never appear in the statement');
  assert.equal(statements[0].params.length, 4);
  assert.equal(statements[0].params[1].value, "O'Brien & Sons; DROP TABLE x");
  assert.equal(statements[0].params[3].value, null);
});

test('large writes are split into batches SQL Server will accept', () => {
  // SQL Server caps a request at 2100 parameters, so the batch size has to follow
  // the column count rather than being a fixed number of rows.
  const columns = Array.from({ length: 10 }, (_, i) => 'c' + i);
  const rows = Array.from({ length: 500 }, (_, i) => Object.fromEntries(columns.map(c => [c, c + i])));
  const statements = sqlSource.buildInsertStatements('dbo.Target', columns, rows);

  assert.ok(statements.length > 1);
  for (const statement of statements) {
    assert.ok(statement.params.length <= 2000, 'no batch may exceed the parameter cap');
  }
  const written = statements.reduce((total, statement) => total + statement.params.length / columns.length, 0);
  assert.equal(written, 500, 'every row is written exactly once');
});

test('a destination table name that is not a plain identifier is refused', () => {
  assert.throws(
    () => sqlSource.buildInsertStatements('Target; DROP TABLE x', ['a'], [{ a: 1 }]),
    /Unsupported identifier/
  );
});

test('the create-if-missing statement is guarded so an existing table is left alone', () => {
  const sql = sqlSource.buildCreateTableSql('dbo.CustomerMaster', ['golden_id', 'name']);
  assert.match(sql, /IF OBJECT_ID\(N'dbo\.CustomerMaster', 'U'\) IS NULL/);
  assert.match(sql, /CREATE TABLE \[dbo\]\.\[CustomerMaster\]/);
  assert.match(sql, /\[golden_id\] NVARCHAR\(4000\) NULL/);
});

// ── Relational view of an analysis run ──
const analysisModel = require('../src/services/analysisModelRepository');

const SCAN_RESULT = {
  summary: { totalWorkspaces: 2 },
  workspaces: [
    {
      id: 'ws-1', name: 'Finance', type: 'Workspace', state: 'Active',
      capacityId: 'cap-1', capacityName: 'F64', capacitySku: 'F64', isOnDedicatedCapacity: true,
      storageSize: 1024, storageFiles: 8,
      items: [
        { id: 'i-1', name: 'Sales', type: 'Lakehouse', storageSize: 900 },
        { id: 'i-2', name: 'Finance DW', type: 'Warehouse' },
        { id: 'i-3', name: 'Monthly', type: 'Report', lastUpdate: '2026-07-01T00:00:00Z' },
      ],
      users: [
        { identifier: 'u1', displayName: 'Ann', emailAddress: 'ann@x.com', groupUserAccessRight: 'Admin', principalType: 'User' },
        { identifier: 'sp1', displayName: 'Scanner', groupUserAccessRight: 'Admin', principalType: 'App' },
      ],
    },
    // A workspace whose access list could not be read is not a workspace with no
    // users, and the two must stay distinguishable.
    { id: 'ws-2', name: 'Marketing', items: [], users: [], usersReadable: false },
  ],
};

test('a scan result is flattened into workspaces, items and access grants', () => {
  const shaped = analysisModel.shapeRun(7, SCAN_RESULT);

  assert.equal(shaped.workspaces.length, 2);
  assert.equal(shaped.items.length, 3);
  assert.equal(shaped.users.length, 2);

  const finance = shaped.workspaces.find(w => w.workspaceId === 'ws-1');
  assert.equal(finance.runId, 7);
  assert.equal(finance.itemCount, 3);
  assert.equal(finance.userCount, 2);
  assert.equal(finance.capacitySku, 'F64');
  assert.equal(finance.usersReadable, true);

  const lakehouse = shaped.items.find(item => item.itemId === 'i-1');
  assert.equal(lakehouse.type, 'Lakehouse');
  assert.equal(lakehouse.workspaceId, 'ws-1');
  assert.equal(lakehouse.storageSize, 900);
  assert.equal(shaped.items.find(item => item.itemId === 'i-3').modifiedAt, '2026-07-01T00:00:00Z');

  const ann = shaped.users.find(user => user.email === 'ann@x.com');
  assert.equal(ann.accessRight, 'Admin');
  assert.equal(ann.principalType, 'User');
});

test('an unreadable access list is recorded as unreadable, not as no users', () => {
  const shaped = analysisModel.shapeRun(7, SCAN_RESULT);
  const marketing = shaped.workspaces.find(w => w.workspaceId === 'ws-2');
  assert.equal(marketing.usersReadable, false);
  assert.equal(marketing.userCount, 0);
});

test('an empty or malformed scan flattens to nothing rather than throwing', () => {
  for (const input of [null, {}, { workspaces: null }, { workspaces: [{ id: 'a' }] }]) {
    const shaped = analysisModel.shapeRun(1, input);
    assert.ok(Array.isArray(shaped.workspaces));
    assert.ok(Array.isArray(shaped.items));
    assert.ok(Array.isArray(shaped.users));
  }
});

test('rebuilding a run replaces its rows instead of duplicating them', async () => {
  // A scan that updates its storage figures rewrites the model, and a backfill can
  // be run twice; both must converge.
  const { executed } = await withFakeSql(() => [], () => analysisModel.saveRunModel(7, SCAN_RESULT));

  const deletes = executed.filter(entry => /^DELETE FROM analysis_/.test(entry.sql.trim()));
  assert.equal(deletes.length, 4, 'the three fact tables and the state row are cleared before rewriting');
  assert.ok(executed.some(entry => /INSERT INTO analysis_workspaces/.test(entry.sql)));
  assert.ok(executed.some(entry => /INSERT INTO analysis_items/.test(entry.sql)));
  assert.ok(executed.some(entry => /INSERT INTO analysis_workspace_users/.test(entry.sql)));
  assert.ok(executed.some(entry => /INSERT INTO analysis_run_model_state/.test(entry.sql)));
});

test('items are looked up by type with bound parameters, not an interpolated list', async () => {
  const { executed } = await withFakeSql(() => [], () => analysisModel.listRunItemsByType(7, ['Lakehouse', 'Warehouse']));
  const select = executed[0];
  assert.match(select.sql, /LOWER\(i\.type\) IN \(@t0, @t1\)/);
  assert.deepEqual(select.params.map(p => p.value), [7, 'lakehouse', 'warehouse']);
  assert.match(select.sql, /LEFT JOIN analysis_workspaces/, 'the workspace name comes from the join, not a second pass');
});

test('an empty type list reads nothing rather than everything', async () => {
  const { executed } = await withFakeSql(() => [], () => analysisModel.listRunItemsByType(7, []));
  assert.equal(executed.length, 0);
});

// ── Exception filtering: list, count and bulk action must agree ──
test('the list reads only the columns it renders', async () => {
  // The values and differences are large JSON documents the list never shows, and
  // reading them for every row made the page pay for data it discarded.
  const { executed } = await withFakeSql(() => [], () => reconRepo.listExceptions({ ruleId: 9 }));
  assert.ok(!/SELECT TOP \(\d+\) \* FROM recon_exceptions/.test(executed[0].sql));
  assert.ok(!/values_a/.test(executed[0].sql));
  assert.match(executed[0].sql, /business_key/);
});

test('counting and acting on a filter build the same predicate as listing it', async () => {
  const filters = { ruleId: 9, severity: 'high', openOnly: true };
  const listed = await withFakeSql(() => [], () => reconRepo.listExceptions(filters));
  const counted = await withFakeSql(() => [{ total: 42 }], () => reconRepo.countExceptions(filters));
  const acted = await withFakeSql(() => [], () => reconRepo.listExceptionsForAction(filters));

  // The action pages by id, so its statement carries an extra keyset predicate on
  // top of the filter. The filter itself must still be identical.
  const clauseOf = sql => sql
    .slice(sql.indexOf(' WHERE '), sql.indexOf(' ORDER BY ') === -1 ? undefined : sql.indexOf(' ORDER BY '))
    .replace(/ AND id > @after$/, '');
  assert.equal(clauseOf(listed.executed[0].sql), clauseOf(acted.executed[0].sql));
  assert.equal(clauseOf(listed.executed[0].sql), clauseOf(counted.executed[0].sql));
  assert.equal(counted.result, 42);
});

test('acting on a whole filter reports when the set was larger than one action covers', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, status: 'open', severity: 'high' }));
  const { result } = await withFakeSql(() => rows, () => reconRepo.listExceptionsForAction({ ruleId: 9 }, { max: 10 }));
  assert.equal(result.exceptions.length, 10);
  assert.equal(result.truncated, true);
});

test('a whole-filter bulk action covers the rule with no size limit, reporting progress', async () => {
  // The list is capped and the old action stopped at 5,000. It now pages through
  // the whole set as a job, so the size of the rule is not a limit on the decision.
  const total = 12000;
  const original = {
    countExceptions: reconRepo.countExceptions,
    listExceptionPage: reconRepo.listExceptionPage,
    batchUpdateExceptions: reconRepo.batchUpdateExceptions,
  };
  reconRepo.countExceptions = async () => total;

  let served = 0;
  const seenFilters = [];
  reconRepo.listExceptionPage = async (filters, { limit }) => {
    seenFilters.push(filters);
    const size = Math.min(limit, total - served);
    const exceptions = Array.from({ length: size }, (_, i) => ({
      id: served + i + 1, business_key: 'INV-' + (served + i), status: 'open', severity: 'medium', owner: null,
    }));
    served += size;
    return { exceptions, nextAfter: served, done: served >= total };
  };
  let updated = 0;
  reconRepo.batchUpdateExceptions = async exceptions => {
    updated += exceptions.length;
    return exceptions.map(e => ({ id: e.id, success: true, changed: true }));
  };

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const started = await postJson(server, '/reconciliation/exceptions/batch', {
      scope: 'filter', ids: [1, 2], filters: { ruleId: 9, all: '' },
      assignOwner: true, owner: 'Ann',
    });
    assert.equal(started.success, true);
    assert.ok(started.jobId, 'a whole-set change runs as a job');
    assert.equal(started.total, total);

    // Follow it the way the page does.
    let job;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      job = await request(server, '/reconciliation/jobs/' + started.jobId).then(r => JSON.parse(r.body));
      if (!job.live) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.equal(job.status, 'completed');
    assert.equal(job.total, total);
    assert.equal(job.done, total, 'every exception the filter covers was processed');
    assert.equal(job.counters.updated, total);
    assert.equal(updated, total);
    assert.equal(seenFilters[0].ruleId, 9);
    assert.equal(seenFilters[0].openOnly, true);
  } finally {
    Object.assign(reconRepo, original);
    await new Promise(resolve => server.close(resolve));
  }
});

test('a whole-filter action with no narrowing filter is refused', async () => {
  // Acting on every exception in the system is almost never intended and cannot be
  // undone.
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = await postJson(server, '/reconciliation/exceptions/batch', {
      scope: 'filter', filters: {}, assignOwner: true, owner: 'Ann',
    });
    assert.equal(body.success, false);
    assert.match(body.message, /Narrow the list/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('closing in bulk succeeds once a reason is supplied', async () => {
  // The reported failure was the reason never reaching the server, not the server
  // rejecting a good one. This pins the accepting side.
  const original = { getExceptionsByIds: reconRepo.getExceptionsByIds, batchUpdateExceptions: reconRepo.batchUpdateExceptions };
  reconRepo.getExceptionsByIds = async () => ([{ id: 1, business_key: 'INV-1', status: 'open', severity: 'medium' }]);
  let applied = null;
  reconRepo.batchUpdateExceptions = async (exceptions, change) => {
    applied = change;
    return exceptions.map(e => ({ id: e.id, success: true, changed: true }));
  };

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    for (const status of ['resolved', 'accepted']) {
      const body = await postJson(server, '/reconciliation/exceptions/batch', {
        ids: [1], status, reason: 'Corrected at source',
      });
      assert.equal(body.success, true, status + ' with a reason must be accepted');
      assert.equal(applied.reason, 'Corrected at source');
      assert.equal(applied.toStatus, status);
    }
  } finally {
    Object.assign(reconRepo, original);
    await new Promise(resolve => server.close(resolve));
  }
});

// ── Quality section: guidance content and routing ──
const guide = require('../src/services/qualityGuideService');

test('every help topic is complete enough to render', () => {
  // The partial walks these structures directly, so a topic missing a section would
  // render a broken modal rather than fail loudly.
  assert.ok(guide.HELP_TOPICS.length >= 2);
  for (const topic of guide.HELP_TOPICS) {
    assert.ok(topic.key && topic.title && topic.summary, topic.key + ' needs an identity');
    assert.ok(topic.steps.length >= 3, topic.key + ' needs steps');
    assert.ok(topic.steps.every(step => step.title && step.body));
    assert.ok(topic.outcomes.length >= 3, topic.key + ' needs outcomes');
    assert.ok(topic.outcomes.every(row => row.length === 2));
    assert.ok(topic.sample.title && topic.sample.lines.length && topic.sample.reading,
      topic.key + ' needs a worked example');
  }
  assert.deepEqual(guide.HELP_TOPICS.map(t => t.key).sort(), ['mdm', 'reconciliation']);
  assert.equal(guide.HELP_BY_KEY.get('mdm').title, guide.MDM_HELP.title);
});

test('prerequisites are grouped by where the permission is granted', () => {
  const keys = guide.PREREQUISITES.map(group => group.key);
  // Each group is one administrator and one portal, which is how someone actually
  // goes about obtaining them.
  for (const expected of ['entra', 'fabric-tenant', 'fabric-admin', 'capacity', 'sql', 'hosting']) {
    assert.ok(keys.includes(expected), 'missing the ' + expected + ' group');
  }
  for (const group of guide.PREREQUISITES) {
    assert.ok(group.title && group.icon, group.key + ' needs a title and icon');
    assert.ok(group.items.length, group.key + ' needs items');
    assert.ok(group.items.every(item => typeof item.text === 'string' && typeof item.required === 'boolean'));
    assert.ok(group.items.some(item => item.required), group.key + ' should say what is actually required');
  }
});

test('the prerequisites name the permissions whose absence is hardest to diagnose', () => {
  const text = guide.PREREQUISITES
    .flatMap(group => group.items.map(item => item.text))
    .join(' ')
    .toLowerCase();

  // Each of these fails silently or misleadingly, which is why they are stated.
  assert.match(text, /contributor role on each fabric or power bi embedded capacity/);
  assert.match(text, /tenant\.read\.all/);
  assert.match(text, /admin consent/);
  assert.match(text, /service principals can use fabric apis/);
  assert.match(text, /workspace member/);
  assert.match(text, /lakehouse sql endpoint is read-only/);
  assert.match(text, /always on/);

  const required = guide.requiredPrerequisites();
  assert.ok(required.length >= 10);
  assert.ok(required.every(entry => entry.group && entry.text));
});

test('source registration moved to Quality and the old links still resolve', async () => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    // Reconciliation and master data read the same registered systems, so
    // registration belongs to neither of them.
    const moved = await request(server, '/reconciliation/sources');
    assert.equal(moved.statusCode, 301);
    assert.equal(moved.headers.location, '/quality/sources');

    assert.equal((await request(server, '/quality')).statusCode, 200);
    assert.equal((await request(server, '/quality/sources')).statusCode, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the Quality landing page offers both guides and the shared registration', async () => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = (await request(server, '/quality')).body;
    assert.match(body, /helpModal-reconciliation/);
    assert.match(body, /helpModal-mdm/);
    assert.match(body, /\/quality\/sources/);
    // The guides' worked examples reach the page, not just their titles.
    assert.match(body, /Business key: ERP\.InvoiceNumber/);
    assert.match(body, /Trust order: SAP, CRM, Legacy/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the home page states the prerequisites rather than only linking to them', async () => {
  // `/` serves the sign-in landing page to an anonymous request, so the signed-in
  // view is rendered directly with the locals its route supplies.
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/home.ejs', {
    title: 'Home', user: { name: 'tester' }, currentUser: { name: 'tester' },
    authEnabled: false, pagePath: '/', breadcrumb: [],
    availableRuns: [], currentRun: null, hideRunSelector: true,
    prerequisites: guide.PREREQUISITES,
  }, {});

  assert.match(html, /prerequisitesModal/);
  assert.match(html, /Contributor role on each Fabric or Power BI Embedded capacity/);
  assert.match(html, /Service principals can use Fabric APIs/);
  // Required and optional are distinguished, so the list is a checklist rather than
  // an undifferentiated wall of advice.
  assert.match(html, /badge bg-danger">required/);
  assert.match(html, /badge bg-secondary">optional/);
});

// ── Reconciliation in third normal form ──
test('a rule\'s compare fields are written as rows, not one JSON column', async () => {
  const rule = {
    name: 'Invoices', sourceAId: 1, sourceBId: 2, datasetA: 'A', datasetB: 'B',
    keyFieldA: 'Id', keyFieldB: 'Id',
    compareFields: [
      { label: 'Net', a: { kind: 'field', value: 'NetAmount' }, b: { kind: 'field', value: 'Net' }, type: 'number', tolerance: 0.01 },
      { label: 'Currency', a: { kind: 'field', value: 'Ccy' }, b: { kind: 'constant', value: 'EUR' }, type: 'string' },
    ],
  };
  const { executed } = await withFakeSql(sql => (/OUTPUT INSERTED.id/.test(sql) ? [{ id: 7 }] : []),
    () => reconRepo.createRule(rule, 'tester'));

  const insert = executed.find(entry => /INSERT INTO recon_rules/.test(entry.sql));
  assert.ok(!/compare_fields/.test(insert.sql), 'the rule row no longer carries a JSON field list');

  const fieldWrite = executed.find(entry => /INSERT INTO recon_rule_fields/.test(entry.sql));
  assert.ok(fieldWrite, 'the fields are written to their own table');
  assert.match(fieldWrite.sql, /VALUES \(.*\), \(.*\)/, 'both fields go in one statement');
  const values = fieldWrite.params.map(param => param.value);
  assert.ok(values.includes('NetAmount') && values.includes('EUR'));
  assert.ok(values.includes('constant'), 'the operand kind is a column, not buried in a document');
});

test('a rule version snapshot still carries the fields the row no longer holds', async () => {
  const { executed } = await withFakeSql(sql => {
    if (/OUTPUT INSERTED.id/.test(sql)) return [{ id: 7 }];
    if (/SELECT \* FROM recon_rules/.test(sql)) return [{ id: 7, name: 'Invoices', fields_normalized: 1 }];
    if (/FROM recon_rule_fields/.test(sql)) {
      return [{ rule_id: 7, ordinal: 0, label: 'Net', value_type: 'number', a_kind: 'field', a_value: 'NetAmount', b_kind: 'field', b_value: 'Net' }];
    }
    return [];
  }, () => reconRepo.createRule({ name: 'Invoices', compareFields: [{ label: 'Net' }] }, 'tester'));

  const version = executed.find(entry => /INSERT INTO recon_rule_versions/.test(entry.sql));
  const snapshot = JSON.parse(version.params.find(param => param.name === 'snapshot').value);
  assert.equal(snapshot.compareFields.length, 1, 'the audit snapshot must not lose the definition');
  assert.equal(snapshot.compareFields[0].a.value, 'NetAmount');
});

test('a legacy rule still reads its fields from the JSON it was written with', async () => {
  const { result } = await withFakeSql(sql => {
    if (/FROM recon_rule_fields/.test(sql)) return [];
    return [{
      id: 3, name: 'Legacy', fields_normalized: 0,
      compare_fields: JSON.stringify([{ label: 'Net', fieldA: 'NetAmount', fieldB: 'Net' }]),
    }];
  }, () => reconRepo.getRuleById(3));

  assert.equal(result.compareFields.length, 1);
  assert.equal(result.compareFields[0].fieldA, 'NetAmount');
});

test('exception values and differences are written as rows, in batches', async () => {
  const exceptions = Array.from({ length: 30 }, (_, i) => ({
    businessKey: 'INV-' + i, outcome: 'value_mismatch', severity: 'medium',
    valuesA: { Net: 100 + i, Currency: 'EUR' },
    valuesB: { Net: 101 + i, Currency: 'EUR' },
    differences: [{ field: 'Net', reason: 'differs by 1', difference: 1 }],
  }));

  const { executed } = await withFakeSql(sql => (/OUTPUT INSERTED.id/.test(sql) ? [{ id: 42 }] : []),
    () => reconRepo.recordExceptions(5, { id: 9, name: 'R' }, exceptions));

  const exceptionInsert = executed.find(entry => /INSERT INTO recon_exceptions/.test(entry.sql));
  assert.ok(!/values_a/.test(exceptionInsert.sql), 'the exception row no longer carries JSON documents');
  assert.match(exceptionInsert.sql, /values_normalized/);

  // 30 exceptions × 4 values and 30 differences, written in a handful of statements
  // rather than one each.
  const valueWrites = executed.filter(entry => /INSERT INTO recon_exception_values/.test(entry.sql));
  const differenceWrites = executed.filter(entry => /INSERT INTO recon_exception_differences/.test(entry.sql));
  assert.equal(valueWrites.length, 1);
  assert.equal(differenceWrites.length, 1);
  assert.equal(valueWrites[0].params.length, 30 * 4 * 4, 'four values per exception, four parameters each');

  const findingWrites = executed.filter(entry => /INSERT INTO recon_run_findings/.test(entry.sql));
  assert.equal(findingWrites.length, 1, 'findings are batched too');
});

test('an exception detail read assembles values from rows', async () => {
  const { result } = await withFakeSql(sql => {
    if (/FROM recon_exception_values/.test(sql)) {
      return [
        { exception_id: 1, side: 'a', field_label: 'Net', value: '100' },
        { exception_id: 1, side: 'b', field_label: 'Net', value: '101' },
      ];
    }
    if (/FROM recon_exception_differences/.test(sql)) {
      return [{ exception_id: 1, field_label: 'Net', reason: 'differs by 1', delta: 1 }];
    }
    return [{ id: 1, business_key: 'INV-1', status: 'open', severity: 'medium', values_normalized: 1 }];
  }, () => reconRepo.getExceptionById(1));

  assert.deepEqual(result.valuesA, { Net: '100' });
  assert.deepEqual(result.valuesB, { Net: '101' });
  assert.equal(result.differences[0].field, 'Net');
  assert.equal(result.differences[0].difference, 1);
});

test('an exception written before the tables existed still reads its stored JSON', async () => {
  const { result } = await withFakeSql(sql => {
    if (/FROM recon_exception_values|FROM recon_exception_differences/.test(sql)) return [];
    return [{
      id: 2, business_key: 'INV-2', status: 'open', values_normalized: 0,
      values_a: JSON.stringify({ Net: 100 }), values_b: JSON.stringify({ Net: 105 }),
      differences: JSON.stringify([{ field: 'Net', difference: 5 }]),
    }];
  }, () => reconRepo.getExceptionById(2));

  assert.deepEqual(result.valuesA, { Net: 100 });
  assert.equal(result.differences[0].difference, 5);
});

test('run outcome counts are rows, with the stored document as the fallback', async () => {
  const fromRows = await withFakeSql(sql => (/FROM recon_run_outcome_counts/.test(sql)
    ? [{ outcome: 'value_mismatch', total: 4 }, { outcome: 'duplicate', total: 1 }]
    : []), () => reconRepo.getRunOutcomeCounts(5));
  assert.deepEqual(fromRows.result, { value_mismatch: 4, duplicate: 1 });

  const fromDocument = await withFakeSql(sql => (/FROM recon_run_outcome_counts/.test(sql)
    ? []
    : [{ counts_json: JSON.stringify({ duplicate: 2 }) }]), () => reconRepo.getRunOutcomeCounts(6));
  assert.deepEqual(fromDocument.result, { duplicate: 2 });
});

// ── The bulk update is set-based ──
test('a bulk change costs a handful of statements however many exceptions it covers', async () => {
  // This is what the refactor is for. Fifty exceptions used to cost about a hundred
  // round trips — one update and one history insert each.
  const exceptions = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1, business_key: 'INV-' + i, status: 'open', severity: 'medium', owner: null,
  }));
  const { result, executed } = await withFakeSql(() => [], () => reconRepo.batchUpdateExceptions(
    exceptions, { assignOwner: true, owner: 'Ann', toStatus: 'acknowledged', actor: 'tester' }
  ));

  assert.equal(result.length, 50);
  assert.ok(result.every(entry => entry.success && entry.changed));
  assert.ok(executed.length <= 5, 'expected a handful of statements, got ' + executed.length);

  const updates = executed.filter(entry => /UPDATE recon_exceptions/.test(entry.sql));
  assert.equal(updates.length, 1, 'one update covers every exception needing the same change');
  assert.match(updates[0].sql, /WHERE id IN \(@i0, @i1/);
  assert.equal(updates[0].params.filter(param => /^i\d+$/.test(param.name)).length, 50);

  const events = executed.filter(entry => /INSERT INTO recon_exception_events/.test(entry.sql));
  assert.equal(events.length, 1, 'and one statement writes all the history');
  assert.equal(events[0].params.filter(param => /^e\d+$/.test(param.name)).length, 100,
    'two events per exception — the owner and the status — all still recorded');
});

test('exceptions needing different parts of the same change are grouped, not looped', async () => {
  // Some already have the owner, some already have the severity. Each distinct
  // combination becomes one statement.
  const exceptions = [
    { id: 1, status: 'open', severity: 'low', owner: null },
    { id: 2, status: 'open', severity: 'high', owner: null },
    { id: 3, status: 'open', severity: 'low', owner: 'Ann' },
    { id: 4, status: 'open', severity: 'high', owner: 'Ann' },
  ];
  const { result, executed } = await withFakeSql(() => [], () => reconRepo.batchUpdateExceptions(
    exceptions, { assignOwner: true, owner: 'Ann', severity: 'high', actor: 'tester' }
  ));

  const updates = executed.filter(entry => /UPDATE recon_exceptions/.test(entry.sql));
  assert.equal(updates.length, 3, 'owner+severity, owner only, severity only');
  // The one already matching in both respects is reported as unchanged rather than
  // rewritten.
  assert.equal(result.find(entry => entry.id === 4).changed, false);
  assert.ok(result.every(entry => entry.success));
});

test('a large selection is chunked so it stays under the parameter cap', async () => {
  const exceptions = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, status: 'open', severity: 'low' }));
  const { executed } = await withFakeSql(() => [], () => reconRepo.batchUpdateExceptions(
    exceptions, { severity: 'high', actor: 'tester' }
  ));

  for (const entry of executed) {
    assert.ok(entry.params.length <= 2001, 'no statement may exceed the parameter cap');
  }
  const updates = executed.filter(entry => /UPDATE recon_exceptions/.test(entry.sql));
  assert.ok(updates.length > 1 && updates.length < 10, 'chunked, not one per row');
});

test('planning a change decides per exception what actually moves', () => {
  const { planExceptionChange } = reconRepo._private;
  const change = { assignOwner: true, owner: 'Ann', severity: 'high', toStatus: 'resolved', actor: 'tester' };

  const moves = planExceptionChange({ id: 1, owner: null, severity: 'low', status: 'open' }, change);
  assert.deepEqual(moves.parts.sort(), ['close', 'owner', 'severity']);
  assert.equal(moves.events.length, 3);

  const settled = planExceptionChange({ id: 2, owner: 'Ann', severity: 'high', status: 'resolved' }, change);
  assert.deepEqual(settled.parts, []);
  assert.equal(settled.changed, false, 'a change that matches what is already there does nothing');

  // A comment with no other change is still worth recording.
  const commented = planExceptionChange({ id: 3, owner: 'Ann', severity: 'high', status: 'resolved' },
    { ...change, comment: 'checked again' });
  assert.equal(commented.events.length, 1);
  assert.equal(commented.events[0].action, 'comment');
});

test('closing sets the resolution date and reopening clears it', () => {
  const { exceptionUpdateFor } = reconRepo._private;
  const closing = exceptionUpdateFor(['close'], { toStatus: 'resolved', reason: 'Corrected' });
  assert.ok(closing.assignments.includes('resolved_at=SYSUTCDATETIME()'));
  assert.ok(closing.assignments.includes('resolution_reason=@reason'));

  const reopening = exceptionUpdateFor(['reopen'], { toStatus: 'open' });
  assert.ok(reopening.assignments.includes('resolved_at=NULL'));
  assert.ok(!reopening.assignments.some(a => a.startsWith('resolution_reason')));
});

test('a bulk action reads only the columns it needs, not the whole exception', async () => {
  const { executed } = await withFakeSql(() => [], () => reconRepo.getExceptionsByIds([1, 2, 3]));
  assert.ok(!/SELECT \* FROM recon_exceptions/.test(executed[0].sql),
    'a bulk decision never looks at the captured values, so it must not read them');
  assert.match(executed[0].sql, /WHERE id IN \(@e0, @e1, @e2\)/);
});

// ── Filtering to one run ──
test('filtering to a run asks what that run found, not what it last touched', async () => {
  // `last_run_id` means "the most recent run that saw this exception". For the
  // newest run that is everything it touched, so the filter looked like it worked;
  // for any earlier run it silently answered a different question.
  const { executed } = await withFakeSql(() => [], () => reconRepo.listExceptions({ runId: 3 }));
  const sql = executed[0].sql;

  assert.match(sql, /id IN \(SELECT f\.exception_id FROM recon_run_findings f WHERE f\.run_id=@run\)/);
  // Runs recorded before findings were kept have none, so they keep the old meaning
  // rather than showing an empty list.
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM recon_run_findings f2 WHERE f2\.run_id=@run\)/);
  assert.equal(executed[0].params.find(param => param.name === 'run').value, 3);
});

test('a run page and its count agree on which exceptions belong to the run', async () => {
  const listed = await withFakeSql(() => [], () => reconRepo.listExceptionPage({ runId: 3 }, { after: 0 }));
  const counted = await withFakeSql(() => [{ total: 9 }], () => reconRepo.countExceptions({ runId: 3 }));
  assert.match(listed.executed[0].sql, /recon_run_findings/);
  assert.match(counted.executed[0].sql, /recon_run_findings/);
  assert.equal(counted.result, 9);
});

test('paging walks the set by id rather than by offset', async () => {
  // Keyset paging costs the same at page five hundred as at page one, and is not
  // disturbed by the rows the action is itself updating.
  const full = await withFakeSql(
    () => [{ id: 41 }, { id: 42 }],
    () => reconRepo.listExceptionPage({ ruleId: 9 }, { after: 40, limit: 2 })
  );
  assert.match(full.executed[0].sql, /AND id > @after ORDER BY id/);
  assert.ok(!/OFFSET/.test(full.executed[0].sql));
  assert.equal(full.executed[0].params.find(param => param.name === 'after').value, 40);
  assert.equal(full.result.nextAfter, 42, 'the next page continues from the last id seen');
  assert.equal(full.result.done, false, 'a full page could still have more behind it');

  // Only a short page proves the end of the set.
  const short = await withFakeSql(
    () => [{ id: 43 }],
    () => reconRepo.listExceptionPage({ ruleId: 9 }, { after: 42, limit: 2 })
  );
  assert.equal(short.result.done, true);
});

// ── Job progress ──
const jobProgress = require('../src/services/jobProgressService');

test('a job reports how far it has got and what is left', () => {
  const job = jobProgress.createJob({ kind: 'test', total: 100 });
  job.startedAt = Date.now() - 10000;

  jobProgress.advanceJob(job, 25, 'quarter done');
  const quarter = jobProgress.summarize(job);
  assert.equal(quarter.percent, 25);
  assert.equal(quarter.done, 25);
  assert.equal(quarter.live, true);
  assert.equal(quarter.message, 'quarter done');
  assert.ok(quarter.etaSeconds > 0, 'an estimate once there is enough behind us');

  jobProgress.finishJob(job, { status: 'completed', result: { updated: 100 } });
  const finished = jobProgress.summarize(job);
  assert.equal(finished.live, false);
  assert.equal(finished.etaSeconds, null, 'nothing left to estimate');
  assert.deepEqual(finished.result, { updated: 100 });
});

test('a job with no known size reports what it has done rather than inventing a percentage', () => {
  const job = jobProgress.createJob({ kind: 'test' });
  jobProgress.advanceJob(job, 7);
  const summary = jobProgress.summarize(job);
  assert.equal(summary.total, null);
  assert.equal(summary.percent, null);
  assert.equal(summary.done, 7);
});

test('a job whose worker died is reported as interrupted, not as still running', () => {
  const job = jobProgress.createJob({ kind: 'test', total: 10 });
  const now = Date.now() + jobProgress.STALE_MS + 1000;
  const summary = jobProgress.summarize(job, now);
  assert.equal(summary.status, 'interrupted');
  assert.equal(summary.live, false);
  assert.match(summary.message, /stopped reporting progress/);
});

test('work that throws marks its job failed rather than becoming an unhandled rejection', async () => {
  const job = jobProgress.runJob({ kind: 'test', total: 1 }, async () => {
    throw new Error('the source went away');
  });
  await new Promise(resolve => setImmediate(resolve));
  const summary = jobProgress.summarize(jobProgress.getJob(job.id));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.message, 'the source went away');
});

test('a finished job is dropped once nobody could still be polling it', () => {
  const job = jobProgress.createJob({ kind: 'test' });
  jobProgress.finishJob(job, { status: 'completed' });
  job.finishedAt = Date.now() - jobProgress.RETAIN_MS - 1000;

  jobProgress._private.sweep();
  assert.equal(jobProgress.getJob(job.id), null);
});

test('progress for a job this process never had is reported honestly', async () => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = JSON.parse((await request(server, '/reconciliation/jobs/nope-123')).body);
    assert.equal(body.success, false);
    assert.equal(body.status, 'unknown');
    assert.match(body.message, /No progress is being reported/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a run\'s exception list is served a page at a time so it can be loaded with progress', async () => {
  const original = reconRepo.listExceptionPage;
  reconRepo.listExceptionPage = async (filters, { after, limit }) => {
    assert.equal(filters.runId, 7);
    assert.equal(Number(limit), 500);
    return { exceptions: [{ id: Number(after) + 1, business_key: 'K' }], nextAfter: Number(after) + 1, done: true };
  };

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = JSON.parse((await request(server, '/reconciliation/runs/7/exceptions?after=40&limit=500')).body);
    assert.equal(body.success, true);
    assert.equal(body.exceptions[0].id, 41);
    assert.equal(body.done, true);
  } finally {
    reconRepo.listExceptionPage = original;
    await new Promise(resolve => server.close(resolve));
  }
});

// ── Deleting a reconciliation run ──
test('deleting a run removes only the exceptions no other run ever saw', async () => {
  // An exception is a standing item keyed by fingerprint, seen by one or more runs.
  // Deleting a run must not take with it the items other runs still evidence.
  const { executed } = await withFakeSql(sql => {
    if (/HAVING NOT EXISTS/.test(sql)) return [{ exception_id: 11 }, { exception_id: 12 }];
    if (/SELECT DISTINCT f\.exception_id/.test(sql)) return [{ exception_id: 20 }];
    if (/COUNT\(\*\) AS total FROM recon_run_findings/.test(sql)) return [{ total: 3 }];
    return [];
  }, () => reconRepo.deleteRun(5));

  const deletedExceptions = executed.find(entry => /DELETE FROM recon_exceptions WHERE id IN/.test(entry.sql));
  assert.deepEqual(deletedExceptions.params.map(param => param.value), [11, 12],
    'only the solitary exceptions go');

  // Their detail and history go with them; leaving those behind would orphan rows.
  for (const table of ['recon_exception_values', 'recon_exception_differences', 'recon_exception_events']) {
    assert.ok(executed.some(entry => new RegExp('DELETE FROM ' + table + ' WHERE exception_id IN').test(entry.sql)),
      table + ' should be cleared for the deleted exceptions');
  }

  // The shared one is kept and repointed, not deleted.
  assert.ok(!deletedExceptions.params.some(param => param.value === 20));
  const repair = executed.find(entry => /UPDATE e SET/.test(entry.sql));
  assert.match(repair.sql, /MIN\(run_id\) AS first_run, MAX\(run_id\) AS last_run, COUNT\(\*\) AS sightings/);
  assert.deepEqual(repair.params.map(param => param.value), [20]);
});

test('a run\'s own rows go before the survivors are recomputed', async () => {
  // The recomputation must see only the sightings that remain, or it would count
  // the run being deleted.
  const { executed } = await withFakeSql(sql => {
    if (/HAVING NOT EXISTS/.test(sql)) return [];
    if (/SELECT DISTINCT f\.exception_id/.test(sql)) return [{ exception_id: 20 }];
    return [];
  }, () => reconRepo.deleteRun(5));

  const sqlOrder = executed.map(entry => entry.sql);
  const findingsDeleted = sqlOrder.findIndex(sql => /DELETE FROM recon_run_findings WHERE run_id=@run/.test(sql));
  const repaired = sqlOrder.findIndex(sql => /UPDATE e SET/.test(sql));
  assert.ok(findingsDeleted !== -1 && repaired !== -1);
  assert.ok(findingsDeleted < repaired, 'findings are removed first');

  assert.ok(sqlOrder.some(sql => /DELETE FROM recon_run_outcome_counts WHERE run_id=@run/.test(sql)));
  assert.ok(sqlOrder.some(sql => /DELETE FROM recon_runs WHERE id=@run/.test(sql)));
});

test('an exception still pointing at the deleted run is detached, not left dangling', async () => {
  const { executed } = await withFakeSql(() => [], () => reconRepo.deleteRun(5));
  assert.ok(executed.some(entry => /UPDATE recon_exceptions SET last_run_id=NULL WHERE last_run_id=@run/.test(entry.sql)));
  assert.ok(executed.some(entry => /UPDATE recon_exceptions SET first_run_id=NULL WHERE first_run_id=@run/.test(entry.sql)));
});

test('deletion reports its effect before it happens', async () => {
  const { result } = await withFakeSql(sql => {
    if (/FROM \(\s*SELECT f\.exception_id/.test(sql)) return [{ total: 2 }];
    if (/COUNT\(DISTINCT f\.exception_id\)/.test(sql)) return [{ total: 1 }];
    return [{ total: 3 }];
  }, () => reconRepo.getRunDeletionImpact(5));

  assert.equal(result.findings, 3);
  assert.equal(result.exceptionsToDelete, 2);
  assert.equal(result.exceptionsToKeep, 1);
  assert.equal(result.attributable, true);
});

test('a run recorded before findings existed reports that nothing can be attributed to it', async () => {
  const { result } = await withFakeSql(() => [{ total: 0 }], () => reconRepo.getRunDeletionImpact(5));
  assert.equal(result.attributable, false, 'its exceptions must be left alone rather than guessed at');
  assert.equal(result.exceptionsToDelete, 0);
});

test('deleting a run runs as a job and reports what it removed', async () => {
  const original = { getRunById: reconRepo.getRunById, getRunDeletionImpact: reconRepo.getRunDeletionImpact, deleteRun: reconRepo.deleteRun };
  reconRepo.getRunById = async () => ({ id: 5, rule_name: 'Invoices', started_at: new Date() });
  reconRepo.getRunDeletionImpact = async () => ({ findings: 40, exceptionsToDelete: 30, exceptionsToKeep: 10, attributable: true });
  reconRepo.deleteRun = async (runId, { onProgress }) => {
    onProgress({ stage: 'planned', orphans: 30, shared: 10 });
    onProgress({ stage: 'exceptions', done: 30, total: 30 });
    onProgress({ stage: 'findings', done: 40 });
    onProgress({ stage: 'repaired', done: 10, total: 10 });
    return { findings: 40, exceptions: 30, repaired: 10 };
  };

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const started = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: '/reconciliation/runs/5', method: 'DELETE',
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve(JSON.parse(text)));
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(started.success, true);
    assert.ok(started.jobId);
    assert.equal(started.impact.exceptionsToDelete, 30);

    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = JSON.parse((await request(server, '/reconciliation/jobs/' + started.jobId)).body);
      if (!job.live) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.status, 'completed');
    assert.equal(job.counters.exceptions, 30);
    assert.equal(job.counters.repaired, 10);
  } finally {
    Object.assign(reconRepo, original);
    await new Promise(resolve => server.close(resolve));
  }
});

test('deleting every run of every rule needs an explicit confirmation', async () => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    // Clearing the whole history is not something to do by accident.
    const refused = await postJson(server, '/reconciliation/runs/delete-all', {});
    assert.equal(refused.success, false);
    assert.match(refused.message, /explicit confirmation/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('deleting all runs of a rule keeps going when one will not delete', async () => {
  const original = { listRunIds: reconRepo.listRunIds, deleteRun: reconRepo.deleteRun };
  reconRepo.listRunIds = async ({ ruleId }) => {
    assert.equal(ruleId, 9);
    return [1, 2, 3];
  };
  reconRepo.deleteRun = async runId => {
    if (runId === 2) throw new Error('still referenced');
    return { findings: 5, exceptions: 4, repaired: 1 };
  };

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const started = await postJson(server, '/reconciliation/runs/delete-all', { ruleId: 9 });
    assert.equal(started.total, 3);

    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = JSON.parse((await request(server, '/reconciliation/jobs/' + started.jobId)).body);
      if (!job.live) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.status, 'completed');
    assert.equal(job.counters.runs, 3, 'every run was attempted');
    assert.equal(job.counters.exceptions, 8, 'the two that worked did their work');
    assert.equal(job.problems.length, 1);
    assert.match(job.problems[0].key, /Run #2/);
  } finally {
    Object.assign(reconRepo, original);
    await new Promise(resolve => server.close(resolve));
  }
});

// ── Exceptions left behind by a deleted run ──
test('an exception with no run behind it is recognised as a leftover', async () => {
  // Deleting a run only ever considered exceptions its findings pointed at, so
  // anything recorded before per-run findings existed outlived its own run and kept
  // appearing in the current state.
  const { executed, result } = await withFakeSql(() => [{ total: 7 }], () => reconRepo.countOrphanedExceptions());
  const sql = executed[0].sql;
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM recon_run_findings f WHERE f\.exception_id = e\.id\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM recon_runs r WHERE r\.id = e\.last_run_id\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM recon_runs r2 WHERE r2\.id = e\.first_run_id\)/);
  assert.equal(result, 7);
});

test('an exception whose run still exists is not treated as a leftover', async () => {
  // The predicate requires all three: no findings, and neither run reference alive.
  const { executed } = await withFakeSql(() => [], () => reconRepo.countOrphanedExceptions());
  const sql = executed[0].sql.replace(/\s+/g, ' ');
  assert.ok(sql.includes('AND NOT EXISTS'), 'the conditions are combined, not alternatives');
  assert.equal((sql.match(/AND NOT EXISTS/g) || []).length, 2);
});

test('purging leftovers removes their detail and history too', async () => {
  let served = false;
  const { executed, result } = await withFakeSql(sql => {
    if (/SELECT TOP \(\d+\) e\.id FROM recon_exceptions/.test(sql)) {
      if (served) return [];
      served = true;
      return [{ id: 1 }, { id: 2 }];
    }
    return [];
  }, () => reconRepo.deleteOrphanedExceptions());

  assert.equal(result, 2);
  for (const table of ['recon_exception_values', 'recon_exception_differences', 'recon_exception_events']) {
    assert.ok(executed.some(entry => new RegExp('DELETE FROM ' + table + ' WHERE exception_id IN').test(entry.sql)));
  }
  assert.ok(executed.some(entry => /DELETE FROM recon_exceptions WHERE id IN/.test(entry.sql)));
});

test('deleting a run sweeps what it leaves without evidence', async () => {
  let orphansServed = false;
  const { executed } = await withFakeSql(sql => {
    if (/SELECT TOP \(5000\) e\.id FROM recon_exceptions/.test(sql)) {
      if (orphansServed) return [];
      orphansServed = true;
      return [{ id: 99 }];
    }
    return [];
  }, () => reconRepo.deleteRun(5));

  // The sweep happens after the run row goes, so the "no live run" test is true.
  const order = executed.map(entry => entry.sql);
  const runDeleted = order.findIndex(sql => /DELETE FROM recon_runs WHERE id=@run/.test(sql));
  const orphanScan = order.findIndex(sql => /SELECT TOP \(5000\) e\.id FROM recon_exceptions/.test(sql));
  assert.ok(runDeleted !== -1 && orphanScan > runDeleted, 'the sweep must run after the run is gone');

  const orphanDelete = executed.filter(entry => /DELETE FROM recon_exceptions WHERE id IN/.test(entry.sql));
  assert.ok(orphanDelete.some(entry => entry.params.some(param => param.value === 99)));
});

test('leftovers can be purged from the dashboard for an install already in that state', async () => {
  const original = reconRepo.deleteOrphanedExceptions;
  reconRepo.deleteOrphanedExceptions = async () => 12;
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = await postJson(server, '/reconciliation/exceptions/purge-orphans', {});
    assert.equal(body.success, true);
    assert.equal(body.removed, 12);
  } finally {
    reconRepo.deleteOrphanedExceptions = original;
    await new Promise(resolve => server.close(resolve));
  }
});

// ── Rules Overview ──
test('the rules overview breaks each rule down by the runs behind it', async () => {
  const { result, executed } = await withFakeSql(sql => {
    if (/FROM recon_run_findings f/.test(sql)) {
      return [
        { rule_id: 9, run_id: 5, total: 8, started_at: '2026-08-10T10:00:00Z', rule_version: 2 },
        { rule_id: 9, run_id: 3, total: 6, started_at: '2026-08-01T10:00:00Z', rule_version: 1 },
      ];
    }
    return [{
      rule_id: 9, rule_name: 'Invoices', business_area: 'Finance', total: 12,
      high: 3, medium: 8, low: 1, worst_recurrence: 4, last_seen: '2026-08-10T10:00:00Z',
    }];
  }, () => reconRepo.getRulesOverview());

  assert.equal(result.length, 1);
  assert.equal(result[0].total, 12);
  assert.equal(result[0].runs.length, 2);
  assert.equal(result[0].runs[0].runId, 5);
  assert.equal(result[0].runs[0].total, 8);

  // The two reads are one per level, not one per rule.
  assert.equal(executed.length, 2);
});

test('exceptions no run accounts for are reported rather than quietly missing', async () => {
  // 12 standing, 8 attributable — the hierarchy must add up or say why it does not.
  const { result } = await withFakeSql(sql => {
    if (/FROM recon_run_findings f/.test(sql)) {
      return [{ rule_id: 9, run_id: 5, total: 8, started_at: '2026-08-10T10:00:00Z', rule_version: 1 }];
    }
    return [{ rule_id: 9, rule_name: 'Invoices', total: 12, high: 0, medium: 12, low: 0, worst_recurrence: 1 }];
  }, () => reconRepo.getRulesOverview());

  assert.equal(result[0].unattributed, 4);
});

test('a run whose row is gone still shows its contribution, labelled as deleted', async () => {
  const { result } = await withFakeSql(sql => {
    if (/FROM recon_run_findings f/.test(sql)) {
      return [{ rule_id: 9, run_id: 3, total: 6, started_at: null, rule_version: null }];
    }
    return [{ rule_id: 9, rule_name: 'Invoices', total: 6, high: 0, medium: 6, low: 0, worst_recurrence: 1 }];
  }, () => reconRepo.getRulesOverview());

  assert.equal(result[0].runs[0].deleted, true);
  assert.equal(result[0].runs[0].total, 6);
  assert.equal(result[0].unattributed, 0);
});

test('the overview filters to one status, applying it at both levels', async () => {
  const { executed } = await withFakeSql(() => [], () => reconRepo.getRulesOverview({ status: 'acknowledged' }));
  assert.equal(executed.length, 2);
  for (const entry of executed) {
    assert.match(entry.sql, /e\.status=@status/, 'both levels must agree on the filter');
    assert.equal(entry.params[0].value, 'acknowledged');
  }
});

test('without a status the overview means everything still open', async () => {
  const { executed } = await withFakeSql(() => [], () => reconRepo.getRulesOverview());
  for (const entry of executed) {
    assert.match(entry.sql, /e\.status NOT IN \('resolved','accepted'\)/);
    assert.equal(entry.params.length, 0);
  }
});

test('the dashboard offers the rule hierarchy only when it is not scoped to a run', async () => {
  const original = { getRulesOverview: reconRepo.getRulesOverview, getDashboardData: reconRepo.getDashboardData, listRuns: reconRepo.listRuns, countOrphanedExceptions: reconRepo.countOrphanedExceptions };
  let overviewCalls = 0;
  reconRepo.getRulesOverview = async () => { overviewCalls += 1; return []; };
  reconRepo.getDashboardData = async () => ({ rules: [], exceptionsByStatus: [], exceptionsByOutcome: [], exceptionsBySeverity: [], byRule: [], recentRuns: [], byOwner: [], ageing: {}, problems: [], scoped: false });
  reconRepo.listRuns = async () => [];
  reconRepo.countOrphanedExceptions = async () => 0;

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const unscoped = await request(server, '/reconciliation');
    assert.match(unscoped.body, /Rules Overview/);
    assert.equal(overviewCalls, 1);

    // Scoped to a run, the breakdown would be a single row per rule, so it is not built.
    await request(server, '/reconciliation?runId=5');
    assert.equal(overviewCalls, 1, 'the hierarchy is not built for a run-scoped page');
  } finally {
    Object.assign(reconRepo, original);
    await new Promise(resolve => server.close(resolve));
  }
});

// ── Aggregation in Values to Compare ──
//
// The two systems often hold the same fact at different grains — an analytical
// ledger with one row per posting against a synthetic balance with one row per
// account. Without aggregation the control has to compare postings to a balance,
// which is meaningless; with it, the source database does the adding up.

test('an aggregate operand groups the side by everything it does not aggregate', () => {
  const sql = recon.buildSelectSql({
    dataset: 'dbo.Postings',
    selections: [
      { alias: 'recon_key', kind: 'field', value: 'Account' },
      { alias: 'recon_c0a', kind: 'aggregate', fn: 'sum', valueKind: 'field', value: 'Amount' },
    ],
  });
  assert.equal(sql, 'SELECT [Account] AS [recon_key], SUM([Amount]) AS [recon_c0a] FROM [dbo].[Postings] GROUP BY [Account]');
});

test('a side with no aggregate is not grouped at all', () => {
  const sql = recon.buildSelectSql({
    dataset: 'dbo.Balances',
    selections: [
      { alias: 'recon_key', kind: 'field', value: 'Account' },
      { alias: 'recon_c0b', kind: 'field', value: 'Amount' },
    ],
  });
  assert.doesNotMatch(sql, /GROUP BY/, 'grouping a side that does not aggregate would change its grain');
});

test('the aggregate function comes from a fixed list, never from the rule text', () => {
  assert.throws(
    () => recon.aggregateSql({ fn: 'sum(1) FROM sys.tables --', value: 'Amount', valueKind: 'field' }),
    /Unsupported aggregate function/);
});

test('count distinct and bare count each render the SQL they mean', () => {
  assert.equal(recon.aggregateSql({ fn: 'count_distinct', valueKind: 'field', value: 'InvoiceNo' }), 'COUNT(DISTINCT [InvoiceNo])');
  // Counting nothing in particular is counting the rows in the group.
  assert.equal(recon.aggregateSql({ fn: 'count', value: '' }), 'COUNT(*)');
  // Everything else needs something to aggregate, and says so.
  assert.throws(() => recon.aggregateSql({ fn: 'sum', value: '' }), /needs a field or expression/);
});

test('an aggregate can wrap an expression as well as a column', () => {
  assert.equal(
    recon.aggregateSql({ fn: 'sum', valueKind: 'expression', value: 'CASE WHEN Reversed = 0 THEN Amount ELSE 0 END' }),
    'SUM((CASE WHEN Reversed = 0 THEN Amount ELSE 0 END))');
});

test('an aggregated expression is still held to the read-only expression rules', () => {
  const problems = recon.validateCompareFields([{
    label: 'Amount',
    a: { kind: 'aggregate', fn: 'sum', valueKind: 'expression', value: 'Amount; DROP TABLE Ledger' },
    b: { kind: 'field', value: 'Amount' },
  }]);
  assert.ok(problems.some(p => /statement separators/.test(p)), problems.join(' | '));
});

test('mixing an aggregate with a plain column on one side is refused, with the reason', () => {
  const problems = recon.validateCompareFields([
    { label: 'Amount', a: { kind: 'aggregate', fn: 'sum', valueKind: 'field', value: 'Amount' }, b: { kind: 'field', value: 'Amount' } },
    { label: 'Currency', a: { kind: 'field', value: 'Currency' }, b: { kind: 'field', value: 'Currency' } },
  ]);
  // Left unchecked, Currency would join source A's GROUP BY and split one account
  // into several rows — duplicates that exist only because of how the rule is written.
  const problem = problems.find(p => /Source A is grouped/.test(p));
  assert.ok(problem, problems.join(' | '));
  assert.match(problem, /Currency/);
  // Source B aggregates nothing at all, so it has nothing to answer for.
  assert.ok(!problems.some(p => /Source B is grouped/.test(p)), problems.join(' | '));
});

test('a fixed value alongside an aggregate is fine — it is never selected', () => {
  const problems = recon.validateCompareFields([
    { label: 'Amount', a: { kind: 'aggregate', fn: 'sum', valueKind: 'field', value: 'Amount' }, b: { kind: 'field', value: 'Amount' } },
    { label: 'Ledger', a: { kind: 'constant', value: 'GL' }, b: { kind: 'field', value: 'Ledger' } },
  ]);
  assert.deepEqual(problems, []);
});

test('every value aggregating on one side is allowed', () => {
  const problems = recon.validateCompareFields([
    { label: 'Amount', a: { kind: 'aggregate', fn: 'sum', valueKind: 'field', value: 'Amount' }, b: { kind: 'field', value: 'Amount' } },
    { label: 'Last posting', type: 'date', a: { kind: 'aggregate', fn: 'max', valueKind: 'field', value: 'PostedOn' }, b: { kind: 'field', value: 'PostedOn' } },
  ]);
  assert.deepEqual(problems, []);
});

test("planning the user's case: sum on the left, plain amount on the right", () => {
  const plan = recon.planRule({
    keyFieldA: 'Account', keyFieldB: 'Account',
    compareFields: [{
      label: 'Amount', type: 'number',
      a: { kind: 'aggregate', fn: 'sum', valueKind: 'field', value: 'Amount' },
      b: { kind: 'field', value: 'Amount' },
    }],
  });

  assert.equal(plan.aggregatedA, true);
  assert.equal(plan.aggregatedB, false);
  assert.match(recon.buildSelectSql({ dataset: 'dbo.Analytics', selections: plan.selectionsA }), /GROUP BY \[Account\]$/);
  assert.doesNotMatch(recon.buildSelectSql({ dataset: 'dbo.Synthetic', selections: plan.selectionsB }), /GROUP BY/);
  // The engine still reads plain aliases; the grouping is entirely the source's job.
  assert.equal(plan.engineRule.compareFields[0].fieldA, 'recon_c0a');
  assert.match(plan.engineRule.compareFields[0].describeA, /sum\(Amount\) per business key/);
});

test('an aggregated side is reconciled by key like any other', () => {
  // What the database would hand back after grouping: one row per account.
  const result = recon.reconcile({
    rowsA: [{ recon_key: 'A-1', recon_c0a: 300 }, { recon_key: 'A-2', recon_c0a: 50 }],
    rowsB: [{ recon_key: 'A-1', recon_c0b: 300 }, { recon_key: 'A-2', recon_c0b: 75 }],
    rule: {
      keyFieldA: 'recon_key', keyFieldB: 'recon_key',
      compareFields: [{ label: 'Amount', type: 'number', fieldA: 'recon_c0a', fieldB: 'recon_c0b' }],
    },
  });
  assert.equal(result.summary.matched, 1);
  assert.equal(result.exceptions.length, 1);
  assert.equal(result.exceptions[0].businessKey, 'A-2');
  assert.equal(result.exceptions[0].differences[0].difference, 25);
});

// ── Groups of rules ──

test('an unrecognised group falls back to ungrouped rather than being stored raw', () => {
  assert.equal(recon.normalizeRuleGroup('Left-To-Right'), 'ungrouped');
  assert.equal(recon.normalizeRuleGroup('left_to_right'), 'left_to_right');
  assert.equal(recon.normalizeRuleGroup('  END_TO_END '), 'end_to_end');
  assert.equal(recon.normalizeRuleGroup(null), 'ungrouped');
  assert.equal(recon.ruleGroupLabel('start_to_end'), 'Start-to-End');
  assert.equal(recon.ruleGroupLabel('nonsense'), 'Ungrouped');
});

test('every group definition carries a label and an explanation', () => {
  for (const def of recon.RULE_GROUP_DEFS) {
    assert.ok(def.key && def.label && def.description, JSON.stringify(def));
  }
  const keys = recon.RULE_GROUP_DEFS.map(def => def.key);
  assert.equal(new Set(keys).size, keys.length, 'group keys must be unique');
  assert.ok(keys.includes('ungrouped'), 'the fallback must itself be a real group');
});

test('the exception filter narrows to one group', async () => {
  const { executed } = await withFakeSql(() => [{ total: 0 }],
    () => reconRepo.countExceptions({ ruleGroup: 'left_to_right', openOnly: true }));
  assert.match(executed[0].sql, /rule_group=@group/);
  assert.equal(executed[0].params.find(p => p.name === 'group').value, 'left_to_right');
});

test('the rules overview applies a group filter at both of its levels', async () => {
  const { executed } = await withFakeSql(() => [],
    () => reconRepo.getRulesOverview({ status: 'open', ruleGroup: 'end_to_end' }));
  assert.equal(executed.length, 2);
  for (const entry of executed) {
    assert.match(entry.sql, /e\.rule_group=@group/, 'both levels must read the same population');
    assert.equal(entry.params.find(p => p.name === 'group').value, 'end_to_end');
  }
});

test('a rule stores its group, and an unknown one is normalised before it reaches SQL', async () => {
  const { executed } = await withFakeSql(sql => (/OUTPUT INSERTED\.id/.test(sql) ? [{ id: 7 }] : []),
    () => reconRepo.createRule({ name: 'R', ruleGroup: 'not-a-group', compareFields: [] }, 'tester'));
  const insert = executed.find(entry => /INSERT INTO recon_rules/.test(entry.sql));
  assert.match(insert.sql, /rule_group/);
  assert.equal(insert.params.find(p => p.name === 'group').value, 'ungrouped');
});

test('a rule field round-trips its aggregate function and what the function wraps', () => {
  const params = reconRepo._private.ruleFieldParams(3, {
    label: 'Amount', type: 'number',
    a: { kind: 'aggregate', fn: 'sum', valueKind: 'expression', value: 'Amount * -1' },
    b: { kind: 'field', value: 'Amount' },
  }, 0);
  const value = name => params.find(p => p.name === name).value;
  assert.equal(value('ak0'), 'aggregate');
  assert.equal(value('af0'), 'sum');
  assert.equal(value('avk0'), 'expression');
  assert.equal(value('av0'), 'Amount * -1');
  // A plain field carries no function, so an edit cannot leave a stale one behind.
  assert.equal(value('bf0'), null);
  assert.equal(value('bvk0'), null);

  const mapped = reconRepo._private.mapRuleField({
    label: 'Amount', value_type: 'number', tolerance: null, tolerance_days: null,
    a_kind: 'aggregate', a_value: 'Amount * -1', a_fn: 'sum', a_value_kind: 'expression',
    b_kind: 'field', b_value: 'Amount', b_fn: null, b_value_kind: null,
  });
  assert.deepEqual(mapped.a, { kind: 'aggregate', value: 'Amount * -1', fn: 'sum', valueKind: 'expression' });
  assert.deepEqual(mapped.b, { kind: 'field', value: 'Amount' });
});

test('the rule-field insert binds one parameter per column, in column order', async () => {
  const { executed } = await withFakeSql(() => [], () => reconRepo._private.writeRuleFields(
    { close() {} },
    3,
    [{ label: 'Amount', a: { kind: 'aggregate', fn: 'sum', valueKind: 'field', value: 'Amount' }, b: { kind: 'field', value: 'Amount' } }]));
  const insert = executed.find(entry => /INSERT INTO recon_rule_fields/.test(entry.sql));
  const columns = insert.sql.match(/\(([^)]+)\) VALUES/)[1].split(',').length;
  assert.equal(insert.params.length, columns, 'a column list and its bindings must not drift apart');
});

// ── Every reconciliation page still renders ──
//
// These templates are only reached through a live database, so a local that a
// route stopped passing — or a column a view started reading — showed up as a
// blank page in a browser and nowhere else. Rendering each one with the shape its
// route hands it turns that into a failing test.
test('every reconciliation view renders with the locals its route supplies', async () => {
  const ejs = require('ejs');
  const { RECONCILIATION_HELP } = require('../src/services/qualityGuideService');
  const { VERDICT_DEFS, SEVERITY_LEVELS } = require('../src/services/reconciliationComparisonService');

  const when = '2026-08-01T09:00:00Z';
  const base = {
    user: { name: 'T' }, currentUser: { name: 'T', email: 't@example.com' },
    currentPath: '/reconciliation', breadcrumb: [], availableRuns: [], globalRun: null,
    hideRunSelector: true, title: 'x', error: null,
    ruleGroupDefs: recon.RULE_GROUP_DEFS, ruleGroupLabel: recon.ruleGroupLabel,
    aggregateDefs: recon.AGGREGATE_DEFS, operandKinds: recon.OPERAND_KINDS,
    outcomeDefs: recon.OUTCOME_DEFS, statusDefs: recon.STATUS_DEFS,
    severityLevels: SEVERITY_LEVELS, verdictDefs: VERDICT_DEFS,
  };

  const rule = {
    id: 1, name: 'Ledger vs Balances', rule_group: 'aggregate_to_detail', business_area: 'Finance',
    owner: 'o@example.com', priority: 'high', status: 'active', version: 2, description: 'd',
    source_a_id: 1, source_b_id: 2, dataset_a: 'dbo.Postings', dataset_b: 'dbo.Balances',
    key_field_a: 'Account', key_field_b: 'Account',
    compareFields: [{
      label: 'Amount', type: 'number',
      a: { kind: 'aggregate', fn: 'sum', valueKind: 'field', value: 'Amount' },
      b: { kind: 'field', value: 'Amount' },
    }],
  };
  const exception = {
    id: 5, rule_id: 1, rule_name: rule.name, rule_group: 'aggregate_to_detail', business_area: 'Finance',
    business_key: 'A-1', outcome: 'value_mismatch', severity: 'high', status: 'open', owner: null,
    occurrence_count: 2, first_seen_at: when, last_seen_at: when, values: { a: {}, b: {} }, differences: [],
  };
  const run = {
    id: 9, rule_id: 1, rule_name: rule.name, rule_group: 'aggregate_to_detail', rule_version: 2,
    status: 'completed', started_at: when, completed_at: when, run_by: 'me',
    records_a: 5, records_b: 5, keys_compared: 5, matched: 4, exception_count: 1,
  };
  const dashboardData = {
    rules: [], exceptionsByStatus: [], exceptionsByOutcome: [], exceptionsBySeverity: [],
    byRule: [{ rule_id: 1, rule_name: rule.name, rule_group: 'aggregate_to_detail', business_area: null, open_count: 3, worst_recurrence: 1, last_seen: when }],
    byGroup: [{ rule_group: 'aggregate_to_detail', total: 3, high: 1 }],
    rulesByGroup: [{ rule_group: 'aggregate_to_detail', total: 2, active: 1 }],
    byOwner: [], recentRuns: [run], ageing: { week1: 0, month1: 0, older: 0 }, problems: [],
  };
  const overviewRow = {
    ruleId: 1, ruleName: rule.name, ruleGroup: 'aggregate_to_detail', businessArea: 'Finance',
    total: 3, high: 1, medium: 1, low: 1, worstRecurrence: 3, lastSeen: when,
    runs: [{ runId: 9, total: 3, startedAt: when, ruleVersion: 2, deleted: false }], unattributed: 0,
  };

  const pages = [
    ['reconciliation/dashboard', {
      ...base, selectedRunId: null, ruleStatus: null, ruleGroup: null, helpTopic: RECONCILIATION_HELP,
      data: { ...dashboardData, scoped: false, scopedRun: null }, runs: [run],
      rulesOverview: [overviewRow], orphanedExceptions: 0,
    }],
    // Scoped to one run the panels answer a different question, through different branches.
    ['reconciliation/dashboard', {
      ...base, selectedRunId: 9, ruleStatus: null, ruleGroup: null, helpTopic: RECONCILIATION_HELP,
      data: { ...dashboardData, scoped: true, scopedRun: run }, runs: [run],
      rulesOverview: [], orphanedExceptions: 0,
    }],
    ['reconciliation/rules', { ...base, rules: [rule], owners: ['o@example.com'] }],
    ['reconciliation/rule-form', { ...base, rule, sources: [{ id: 1, name: 'ERP', system_label: 'SAP' }], versions: [] }],
    ['reconciliation/rule-form', { ...base, rule: null, sources: [], versions: [] }],
    ['reconciliation/exceptions', {
      ...base, exceptions: [exception], rules: [rule], owners: [],
      filters: { status: null, severity: null, outcome: null, ruleId: null, ruleGroup: null, all: false },
    }],
    ['reconciliation/exception-detail', { ...base, exception, events: [], allowedNext: ['resolved'] }],
    ['reconciliation/runs', { ...base, runs: [run], rules: [rule] }],
    ['reconciliation/run-detail', { ...base, run, outcomeCounts: [], exceptionTotal: 1 }],
    ['reconciliation/compare', {
      ...base, runs: [run], comparison: null, fromId: null, toId: null, notice: null,
      overview: [{
        ruleId: 1, ruleName: rule.name, ruleGroup: 'aggregate_to_detail', later: run, earlier: null,
        runCount: 1, severity: { high: 1, medium: 0, low: 0 }, exceptionCount: 1,
        comparable: false, comparison: null, summary: null, error: null,
      }],
    }],
  ];

  for (const [page, locals] of pages) {
    const html = await ejs.renderFile('src/views/' + page + '.ejs', locals);
    assert.ok(html.length > 500, page + ' rendered almost nothing');
  }
});

test('the rule form offers a group, an aggregate operand and a dataset filter', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/reconciliation/rule-form.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/reconciliation/rules/new',
    breadcrumb: [], availableRuns: [], globalRun: null, hideRunSelector: true,
    title: 'New', rule: null, sources: [], versions: [], error: null,
    operandKinds: recon.OPERAND_KINDS, aggregateDefs: recon.AGGREGATE_DEFS, ruleGroupDefs: recon.RULE_GROUP_DEFS,
  });
  assert.match(html, /Group of rules/);
  assert.match(html, /Start-to-Start/);
  assert.match(html, /Aggregate \(group by key\)/);
  assert.match(html, /id="datasetFilterA"/);
  assert.match(html, /id="datasetFilterB"/);
});

test('the sidebar names the quality configuration page for what it is', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/quality', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'x',
  });
  assert.match(html, /<span>Quality Configuration<\/span>/);
});

test('the master data form filters its raw-table list too', async () => {
  const ejs = require('ejs');
  const mdm = require('../src/services/mdmService');
  const html = await ejs.renderFile('src/views/mdm/model-form.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/mdm/models/new',
    breadcrumb: [], availableRuns: [], globalRun: null, hideRunSelector: true,
    title: 'New', model: null, sources: [], versions: [], error: null,
    catalogue: {
      standardisers: mdm.STANDARDISER_DEFS, blocking: mdm.BLOCKING_DEFS,
      comparators: mdm.COMPARATOR_DEFS, nullPolicies: mdm.NULL_POLICY_DEFS,
      survivorship: mdm.SURVIVORSHIP_DEFS,
    },
  });
  assert.match(html, /id="datasetFilter"/);
});

// ── Workspace access ──
//
// A workspace detail page answers "who is in this workspace". The question
// governance gets asked is the other way round — what can this person reach, and
// which workspaces has nobody responsible for — and neither can be answered one
// workspace at a time.

const workspaceAccess = require('../src/services/workspaceAccessService');
const analysisScope = require('../src/services/analysisScopeService');
const scheduleDue = require('../src/services/scheduleDueService');

const ACCESS_FIXTURE = {
  workspaces: [
    { workspace_id: 'ws-1', name: 'Finance', state: 'Active', capacity_name: 'F64', item_count: 12, users_readable: 1 },
    // Readable, and nobody can administer it.
    { workspace_id: 'ws-2', name: 'Orphan', state: 'Active', item_count: 1, users_readable: 1 },
    // The scan could not read this one's access list at all.
    { workspace_id: 'ws-3', name: 'Marketing', state: 'Active', item_count: 3, users_readable: 0 },
  ],
  grants: [
    { workspace_id: 'ws-1', principal_id: 'u1', principal_type: 'User', display_name: 'Ann', email: 'Ann@X.com', access_right: 'Admin' },
    { workspace_id: 'ws-1', principal_id: 'sp1', principal_type: 'App', display_name: 'Scanner', email: null, access_right: 'Member' },
    { workspace_id: 'ws-2', principal_id: 'u1', principal_type: 'User', display_name: 'Ann', email: 'ann@x.com', access_right: 'Viewer' },
  ],
};

test('access grants roll up by workspace and by principal from one pass', () => {
  const overview = workspaceAccess.buildAccessOverview(ACCESS_FIXTURE);

  assert.equal(overview.workspaces.length, 3);
  assert.equal(overview.grants.length, 3);

  const finance = overview.workspaces.find(w => w.workspaceId === 'ws-1');
  assert.equal(finance.counts.admin, 1);
  assert.equal(finance.counts.member, 1);

  // Ann holds Admin on one workspace and Viewer on another: one principal, two grants.
  const ann = overview.principals.find(p => p.email === 'Ann@X.com' || p.email === 'ann@x.com');
  assert.equal(ann.workspaces.length, 2);
  assert.equal(ann.counts.admin, 1);
  assert.equal(ann.counts.viewer, 1);
  assert.equal(ann.strongest, 'admin', 'the strongest access anywhere is what a review looks at first');
});

test('one principal is not split in two by the case of their email', () => {
  const overview = workspaceAccess.buildAccessOverview(ACCESS_FIXTURE);
  assert.equal(overview.principals.length, 2, 'Ann@X.com and ann@x.com are the same person');
});

test('a principal with no email is identified by object id, not by display name', () => {
  // Two service principals can share a display name; their object ids cannot.
  const overview = workspaceAccess.buildAccessOverview({
    workspaces: [{ workspace_id: 'w', name: 'W', users_readable: 1 }],
    grants: [
      { workspace_id: 'w', principal_id: 'sp-a', principal_type: 'App', display_name: 'Scanner', access_right: 'Admin' },
      { workspace_id: 'w', principal_id: 'sp-b', principal_type: 'App', display_name: 'Scanner', access_right: 'Member' },
    ],
  });
  assert.equal(overview.principals.length, 2);
});

test('an unreadable access list is not counted as a workspace nobody administers', () => {
  const totals = workspaceAccess.buildAccessOverview(ACCESS_FIXTURE).totals;
  // Orphan has a viewer and no admin — a finding. Marketing was simply not read.
  assert.equal(totals.withoutAdmin, 1);
  assert.equal(totals.unreadable, 1);
  assert.equal(totals.singleAdmin, 1);
  assert.equal(totals.principals, 2);
  assert.equal(totals.servicePrincipals, 1);
  assert.equal(totals.adminPeople, 1);
});

test('a grant against a workspace the run did not record still counts', () => {
  // Dropping it would understate what a principal can reach, which is the one
  // direction this page must not be wrong in.
  const overview = workspaceAccess.buildAccessOverview({
    workspaces: [],
    grants: [{ workspace_id: 'ghost', workspace_name: 'Ghost', principal_id: 'u1', email: 'a@b.c', access_right: 'Admin' }],
  });
  assert.equal(overview.grants.length, 1);
  assert.equal(overview.principals[0].workspaces.length, 1);
  assert.equal(overview.workspaces[0].name, 'Ghost');
});

test('an unrecognised role is shown as unknown rather than silently ranked', () => {
  assert.equal(workspaceAccess.normalizeAccess('Admin'), 'admin');
  assert.equal(workspaceAccess.normalizeAccess('  MEMBER '), 'member');
  assert.equal(workspaceAccess.normalizeAccess('Wizard'), 'unknown');
  assert.equal(workspaceAccess.accessLevel('Wizard').rank, 0);
  assert.ok(workspaceAccess.accessLevel('admin').rank > workspaceAccess.accessLevel('viewer').rank);
});

test('the two names the APIs use for a service principal mean the same thing', () => {
  assert.equal(workspaceAccess.normalizePrincipalType('App'), 'app');
  assert.equal(workspaceAccess.normalizePrincipalType('ServicePrincipal'), 'app');
  assert.equal(workspaceAccess.principalTypeLabel('Group'), 'Group');
  assert.equal(workspaceAccess.principalTypeLabel(null), 'Unspecified');
});

test('the grant list says which workspaces already have the service principal', () => {
  const overview = workspaceAccess.buildAccessOverview(ACCESS_FIXTURE);
  const marked = workspaceAccess.markServicePrincipalAccess(overview, 'SP1');

  const finance = marked.find(w => w.workspaceId === 'ws-1');
  assert.equal(finance.hasAccess, true, 'matching the object id must not be case-sensitive');
  assert.equal(finance.accessRight, 'member');
  assert.equal(marked.filter(w => !w.hasAccess).length, 2);
});

test('with no object id known, nothing is claimed to already have access', () => {
  const overview = workspaceAccess.buildAccessOverview(ACCESS_FIXTURE);
  const marked = workspaceAccess.markServicePrincipalAccess(overview, '');
  assert.ok(marked.every(w => w.hasAccess === false));
});

test('an empty or malformed run reshapes to nothing rather than throwing', () => {
  for (const input of [undefined, {}, { workspaces: null, grants: null }, { grants: [{}] }]) {
    const overview = workspaceAccess.buildAccessOverview(input);
    assert.ok(Array.isArray(overview.workspaces));
    assert.ok(Array.isArray(overview.principals));
    assert.ok(Array.isArray(overview.grants));
  }
});

test('a scan\'s compacted user shape is indexed with its identity, not as nulls', () => {
  // The scan compacts each user to {name, email, role, type} before storing the
  // run. Reading only the admin API's own names wrote every access row with nulls
  // for the identity: the grant count was right and nobody in it could be named.
  const shaped = analysisModel.shapeRun(4, {
    workspaces: [{
      id: 'ws-1', name: 'Finance', items: [],
      users: [{ name: 'Ann', email: 'ann@x.com', role: 'Admin', type: 'User' }],
    }],
  });
  assert.equal(shaped.users.length, 1);
  assert.deepEqual(shaped.users[0], {
    runId: 4, workspaceId: 'ws-1', principalId: null, principalType: 'User',
    displayName: 'Ann', email: 'ann@x.com', accessRight: 'Admin',
  });
});

test('the admin API\'s own user shape still indexes the same way', () => {
  const shaped = analysisModel.shapeRun(4, {
    workspaces: [{
      id: 'ws-1', name: 'Finance', items: [],
      users: [{ identifier: 'u1', displayName: 'Ann', emailAddress: 'ann@x.com', groupUserAccessRight: 'Admin', principalType: 'User' }],
    }],
  });
  assert.equal(shaped.users[0].principalId, 'u1');
  assert.equal(shaped.users[0].accessRight, 'Admin');
});

test('every access grant in a run is read in one query, not one per workspace', async () => {
  const { executed } = await withFakeSql(() => [], () => analysisModel.listRunAccess(11));
  assert.equal(executed.length, 1);
  assert.match(executed[0].sql, /FROM analysis_workspace_users u/);
  assert.match(executed[0].sql, /LEFT JOIN analysis_workspaces w/);
  assert.equal(executed[0].params[0].value, 11);
});

test('the Grant Access page renders with and without a scan behind it', async () => {
  const ejs = require('ejs');
  const overview = workspaceAccess.buildAccessOverview(ACCESS_FIXTURE);
  const base = {
    user: { name: 'T' }, currentUser: { name: 'T', email: 't@example.com' },
    currentPath: '/settings/access', breadcrumb: [], availableRuns: [], globalRun: null,
    hideRunSelector: true, title: 'Grant Access',
    accessLevels: workspaceAccess.ACCESS_LEVELS, principalTypes: workspaceAccess.PRINCIPAL_TYPES,
    accessLevel: workspaceAccess.accessLevel, principalTypeLabel: workspaceAccess.principalTypeLabel,
    describeScope: analysisScope.describeScope, scopeFromRow: analysisScope.scopeFromRow,
    partialScope: false,
  };

  const populated = await ejs.renderFile('src/views/access/index.ejs', {
    ...base, overview, indexed: true, error: null, grantAuth: false,
    runs: [{ id: 9, started_at: '2026-08-01T00:00:00Z' }, { id: 8, started_at: '2026-07-01T00:00:00Z' }],
    run: { id: 9, started_at: '2026-08-01T00:00:00Z' },
    servicePrincipals: [{ id: 1, name: 'SP', tenant_id: 'tid', enterprise_app_object_id: 'sp1' }],
  });
  assert.match(populated, /Who Has Access to What/);
  assert.match(populated, /Grant Service Principal Access/);
  assert.match(populated, /no admin/, 'a workspace nobody administers must be called out');
  assert.match(populated, /not readable/, 'an unreadable access list must stay distinguishable');

  // Nothing scanned yet: the page must explain that rather than showing an empty tenant.
  const empty = await ejs.renderFile('src/views/access/index.ejs', {
    ...base, overview: workspaceAccess.buildAccessOverview({}), indexed: false,
    error: null, grantAuth: true, runs: [], run: null, servicePrincipals: [],
  });
  assert.match(empty, /No completed scan yet/);
  assert.match(empty, /No service principal configured/);
});

test('the sidebar offers Grant Access under Settings', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/settings/access', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'x',
  });
  assert.match(html, /href="\/settings\/access"[^>]*active/, 'the new page highlights itself');
  assert.match(html, /<span>Grant Access<\/span>/);
});

test('the analysis page hands the grant flow over rather than keeping its own', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/analysis/index.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/analysis',
    breadcrumb: [], availableRuns: [], globalRun: null, title: 'Run Analysis',
    servicePrincipals: [{ id: 1, name: 'SP', tenant_id: 't', enterprise_app_object_id: 'e' }],
    runs: [], error: null, schedules: [], scheduleTypes: scheduleDue.SCHEDULE_TYPES,
  });
  assert.doesNotMatch(html, /Grant SP Access to Workspaces/);
  assert.doesNotMatch(html, /grantAccessModal/);
  assert.match(html, /\/settings\/access/, 'and points at where it went');
});

// ── Scoped analysis scans ──
//
// A scan used to mean the whole tenant, always. On a large tenant that is hours of
// API calls to answer a question about three workspaces. A scoped scan is a
// smaller, faster answer — as long as nothing downstream mistakes it for the full
// picture, which is what most of these tests are about.

const analysisLauncher = require('../src/services/analysisLauncher');
const analysisScheduleService = require('../src/services/analysisScheduleService');

test('a scope with no workspaces selected falls back to the whole tenant', () => {
  // A scan of nothing is never what anyone meant, and would look identical to a
  // scan that found an empty tenant.
  assert.equal(analysisScope.normalizeScope({ kind: 'workspaces', workspaceIds: [] }).kind, 'tenant');
  assert.equal(analysisScope.normalizeScope(null).kind, 'tenant');
  assert.equal(analysisScope.normalizeScope({ kind: 'nonsense', workspaceIds: ['a'] }).kind, 'tenant');
});

test('but asking for workspace scope is remembered even when nothing was selected', () => {
  // Otherwise "selected workspaces, none ticked" is accepted as a nightly scan of
  // the entire tenant — the exact surprise scoping exists to avoid.
  assert.equal(analysisScope.requestedWorkspaceScope({ kind: 'workspaces', workspaceIds: [] }), true);
  assert.equal(analysisScope.requestedWorkspaceScope({ scope: 'tenant' }), false);
});

test('a scope de-duplicates workspaces and keeps the names given', () => {
  const scope = analysisScope.normalizeScope({
    kind: 'workspaces',
    workspaceIds: [{ id: 'ws-1', name: 'Finance' }, { id: 'WS-1' }, { id: 'ws-2', name: 'Sales' }, { id: '' }],
  });
  assert.equal(scope.workspaces.length, 2);
  assert.deepEqual(scope.workspaces.map(w => w.id), ['ws-1', 'ws-2']);
  assert.equal(scope.workspaces[0].name, 'Finance');
});

test('a scope survives a round trip through the columns it is stored in', () => {
  const scope = analysisScope.normalizeScope({ kind: 'workspaces', workspaceIds: [{ id: 'ws-1', name: 'Finance' }] });
  const row = analysisScope.scopeToRow(scope);
  assert.equal(row.scopeKind, 'workspaces');
  assert.deepEqual(analysisScope.scopeFromRow({ scope_kind: row.scopeKind, scope_workspaces: row.scopeWorkspaces }), scope);

  // A tenant scan stores no list at all rather than an empty one.
  assert.equal(analysisScope.scopeToRow({ kind: 'tenant' }).scopeWorkspaces, null);
  // Corrupt JSON must not throw on a page that only wants a label.
  assert.equal(analysisScope.scopeFromRow({ scope_kind: 'workspaces', scope_workspaces: '{oops' }).kind, 'tenant');
});

test('applying a scope names the workspaces it could not find', () => {
  // A scheduled scoped run whose workspace was deleted would otherwise keep
  // succeeding while quietly covering less every week.
  const result = analysisScope.applyScope(
    [{ id: 'ws-1', displayName: 'Finance' }, { id: 'ws-3', displayName: 'Other' }],
    { kind: 'workspaces', workspaceIds: [{ id: 'ws-1', name: 'Finance' }, { id: 'ws-2', name: 'Gone' }] }
  );
  assert.deepEqual(result.selected.map(w => w.id), ['ws-1']);
  assert.deepEqual(result.missing.map(w => w.name), ['Gone']);
});

test('a tenant scope selects everything and misses nothing', () => {
  const all = [{ id: 'a' }, { id: 'b' }];
  const result = analysisScope.applyScope(all, { kind: 'tenant' });
  assert.equal(result.selected.length, 2);
  assert.equal(result.missing.length, 0);
});

test('items are narrowed to the scope, so the totals describe what was scanned', () => {
  // A scoped run reporting the tenant's item count would be worse than not scoping.
  const items = [{ workspaceId: 'ws-1' }, { workspaceId: 'WS-1' }, { workspaceId: 'ws-9' }];
  assert.equal(analysisScope.filterItemsToScope(items, [{ id: 'ws-1' }]).length, 2);
  assert.equal(analysisScope.filterItemsToScope(items, []).length, 0);
});

test('a scope describes itself without ever being ambiguous about coverage', () => {
  assert.equal(analysisScope.describeScope({ kind: 'tenant' }), 'Whole tenant');
  assert.equal(
    analysisScope.describeScope({ kind: 'workspaces', workspaceIds: [{ id: '1', name: 'Finance' }] }),
    '1 workspace: Finance');
  assert.match(
    analysisScope.describeScope({
      kind: 'workspaces',
      workspaceIds: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }, { id: '4', name: 'D' }],
    }),
    /4 workspaces: A, B, C and 1 more/);
});

test('anything tenant-wide picks the last tenant-wide run, not just the last run', () => {
  const runs = [
    { id: 12, status: 'completed', scope_kind: 'workspaces', scope_workspaces: '[{"id":"a"}]' },
    { id: 11, status: 'running', scope_kind: 'tenant' },
    { id: 10, status: 'completed', scope_kind: 'tenant' },
  ];
  assert.equal(analysisScope.pickTenantWideRun(runs).id, 10);
  // Runs recorded before scopes existed have no column, and were tenant-wide.
  assert.equal(analysisScope.pickTenantWideRun([{ id: 3, status: 'completed' }]).id, 3);
  assert.equal(analysisScope.pickTenantWideRun([{ id: 1, status: 'completed', scope_kind: 'workspaces', scope_workspaces: '[{"id":"a"}]' }]), null);
});

// ── When a schedule is due ──

const DUE_DAILY = { schedule_type: 'daily', schedule_hour: 7, schedule_minute: 30, timezone: 'UTC' };

test('a daily schedule is due only at its own minute', () => {
  const at = (hour, minute) => scheduleDue.isDueNow(DUE_DAILY, { hour, minute, dayOfWeek: 3, year: 2026, month: 8, day: 26 });
  assert.equal(at(7, 30), true);
  assert.equal(at(7, 31), false);
  assert.equal(at(8, 30), false);
});

test('hourly ignores the hour, weekdays exclude the weekend, weekly picks its day', () => {
  const local = (dayOfWeek, hour, minute) => ({ dayOfWeek, hour, minute, year: 2026, month: 8, day: 26 });
  assert.equal(scheduleDue.isDueNow({ schedule_type: 'hourly', schedule_minute: 15 }, local(3, 23, 15)), true);
  assert.equal(scheduleDue.isDueNow({ schedule_type: 'weekdays', schedule_hour: 7, schedule_minute: 0 }, local(6, 7, 0)), false);
  assert.equal(scheduleDue.isDueNow({ schedule_type: 'weekdays', schedule_hour: 7, schedule_minute: 0 }, local(5, 7, 0)), true);
  assert.equal(scheduleDue.isDueNow({ schedule_type: 'weekly', schedule_day: 'Tuesday', schedule_hour: 7, schedule_minute: 0 }, local(2, 7, 0)), true);
  assert.equal(scheduleDue.isDueNow({ schedule_type: 'weekly', schedule_day: 'Tuesday', schedule_hour: 7, schedule_minute: 0 }, local(3, 7, 0)), false);
});

test('the catch-up window finds a slot the worker slept through, and says how late', () => {
  // App Service recycles workers, and a schedule that fires at exactly one minute
  // would otherwise be lost for the whole day.
  const now = new Date('2026-08-26T07:45:00Z');
  const due = scheduleDue.findDueSlot(DUE_DAILY, 'UTC', now, 60);
  assert.ok(due, 'a schedule due 15 minutes ago is still within a 60 minute window');
  assert.equal(due.minutesLate, 15);
  assert.equal(due.slotKey, '2026-08-26T07:30');

  // Outside the window it is not due, rather than being replayed from yesterday.
  assert.equal(scheduleDue.findDueSlot(DUE_DAILY, 'UTC', now, 5), null);
});

test('a schedule reads back the way it was set, in its own timezone', () => {
  assert.equal(scheduleDue.describeSchedule({ schedule_type: 'daily', schedule_hour: 2, schedule_minute: 5, timezone: 'Europe/Warsaw' }),
    'Every day at 02:05 Europe/Warsaw');
  assert.equal(scheduleDue.describeSchedule({ schedule_type: 'hourly', schedule_minute: 0, timezone: 'UTC' }),
    'Every hour at :00 (UTC)');
  assert.equal(scheduleDue.describeSchedule({ schedule_type: 'weekly', schedule_day: 'Sunday', schedule_hour: 23, schedule_minute: 0, timezone: 'UTC' }),
    'Every Sunday at 23:00 UTC');
  assert.equal(scheduleDue.describeSchedule({ schedule_type: 'weekdays', schedule_hour: 6, schedule_minute: 0, timezone: 'UTC' }),
    'Weekdays at 06:00 UTC');
});

// ── Analysis schedules ──

test('a schedule is refused with the reason, one problem at a time', () => {
  const base = { name: 'Nightly', scheduleType: 'daily', hour: 2, minute: 0, scope: { kind: 'tenant' } };
  assert.equal(analysisScheduleService.validateSchedule({ ...base }), null);
  assert.match(analysisScheduleService.validateSchedule({ ...base, name: '  ' }), /needs a name/);
  assert.match(analysisScheduleService.validateSchedule({ ...base, scheduleType: 'yearly' }), /how often/);
  assert.match(analysisScheduleService.validateSchedule({ ...base, minute: 77 }), /minute must be/);
  assert.match(analysisScheduleService.validateSchedule({ ...base, hour: 25 }), /hour must be/);
  assert.match(analysisScheduleService.validateSchedule({ ...base, scheduleType: 'weekly', day: null }), /day of the week/);
  // Hourly has no hour to be wrong about.
  assert.equal(analysisScheduleService.validateSchedule({ ...base, scheduleType: 'hourly', hour: null }), null);
});

test('choosing workspace scope and selecting none is refused, not run tenant-wide', () => {
  const problem = analysisScheduleService.validateSchedule({
    name: 'Nightly', scheduleType: 'daily', hour: 2, minute: 0,
    scope: { kind: 'workspaces', workspaceIds: [] },
  });
  assert.match(problem, /at least one workspace/);
});

test('a stored schedule drops the fields its frequency does not use', () => {
  const hourly = analysisScheduleService.toStoredSchedule({
    name: ' Hourly ', scheduleType: 'hourly', hour: 9, minute: 15, day: 'Monday',
    timezone: 'Europe/Warsaw', scope: { kind: 'tenant' },
  });
  assert.equal(hourly.name, 'Hourly');
  assert.equal(hourly.hour, null, 'an hourly schedule has no hour to store');
  assert.equal(hourly.day, null, 'only a weekly schedule has a day');
  assert.equal(hourly.scopeKind, 'tenant');
  assert.equal(hourly.scopeWorkspaces, null);

  const weekly = analysisScheduleService.toStoredSchedule({
    name: 'W', scheduleType: 'weekly', hour: 3, minute: 0, day: 'Friday', timezone: 'UTC',
    scope: { kind: 'workspaces', workspaceIds: [{ id: 'ws-1', name: 'Finance' }] },
  });
  assert.equal(weekly.day, 'Friday');
  assert.deepEqual(JSON.parse(weekly.scopeWorkspaces), [{ id: 'ws-1', name: 'Finance' }]);
});

test('a schedule will not stack a scan on one of its own that is still running', async () => {
  // Two scans of the same scope at once is double the API load for an answer
  // neither of them is.
  const runs = [
    { id: 5, status: 'running', schedule_id: 2 },
    { id: 4, status: 'completed', schedule_id: 2 },
  ];
  assert.equal(analysisScheduleService.findRunningRun(runs, 2).id, 5);
  // A different schedule's run is not in the way: scoped schedules are meant to
  // be able to run alongside each other.
  assert.equal(analysisScheduleService.findRunningRun(runs, 3), null);
  assert.equal(analysisScheduleService.findRunningRun([{ id: 1, status: 'completed', schedule_id: 2 }], 2), null);
});

test('a due schedule starts a scan through the launcher and records what it did', async () => {
  const original = {
    getServicePrincipals: dbService.getServicePrincipals,
    getAnalysisRuns: dbService.getAnalysisRuns,
    logAnalysisScheduleRun: dbService.logAnalysisScheduleRun,
  };
  const logged = [];
  const started = [];
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't' }, { id: 2, name: 'Other', tenant_id: 'u' }];
  dbService.getAnalysisRuns = async () => [];
  dbService.logAnalysisScheduleRun = async (...args) => { logged.push(args); };
  analysisLauncher.register(async options => { started.push(options); return { runId: 77 }; });

  try {
    const result = await analysisScheduleService.executeSchedule({
      id: 2, name: 'Nightly finance', sp_id: 2,
      scope_kind: 'workspaces', scope_workspaces: '[{"id":"ws-1","name":"Finance"}]',
    });
    assert.equal(result.status, 'started');
    assert.equal(result.runId, 77);
    assert.equal(started.length, 1);
    assert.equal(started[0].sp.id, 2, 'the schedule names its own service principal');
    assert.equal(started[0].scheduleId, 2, 'the run records which schedule started it');
    assert.equal(started[0].scope.workspaces[0].id, 'ws-1');
    assert.match(started[0].runBy, /Nightly finance/);
    assert.equal(logged[0][2], 'started');
  } finally {
    Object.assign(dbService, original);
    analysisLauncher._reset();
  }
});

test('with a scan of its own still running, the schedule records a skip', async () => {
  const original = {
    getServicePrincipals: dbService.getServicePrincipals,
    getAnalysisRuns: dbService.getAnalysisRuns,
    logAnalysisScheduleRun: dbService.logAnalysisScheduleRun,
  };
  const logged = [];
  let launched = 0;
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP' }];
  dbService.getAnalysisRuns = async () => [{ id: 9, status: 'running', schedule_id: 2 }];
  dbService.logAnalysisScheduleRun = async (...args) => { logged.push(args); };
  analysisLauncher.register(async () => { launched += 1; return { runId: 1 }; });

  try {
    const result = await analysisScheduleService.executeSchedule({ id: 2, name: 'Nightly', scope_kind: 'tenant' });
    assert.equal(result.status, 'skipped');
    assert.equal(launched, 0, 'a skip must not also start a scan');
    assert.equal(logged[0][2], 'skipped');
    assert.match(logged[0][3], /#9/, 'the skip names the run that is in the way');
  } finally {
    Object.assign(dbService, original);
    analysisLauncher._reset();
  }
});

test('with no runner registered the schedule fails loudly rather than silently', async () => {
  const original = {
    getServicePrincipals: dbService.getServicePrincipals,
    getAnalysisRuns: dbService.getAnalysisRuns,
    logAnalysisScheduleRun: dbService.logAnalysisScheduleRun,
  };
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP' }];
  dbService.getAnalysisRuns = async () => [];
  dbService.logAnalysisScheduleRun = async () => {};
  analysisLauncher._reset();

  try {
    const result = await analysisScheduleService.executeSchedule({ id: 2, name: 'N', scope_kind: 'tenant' });
    assert.equal(result.status, 'error');
    assert.match(result.message, /No analysis runner/);
  } finally {
    Object.assign(dbService, original);
  }
});

test('a run without a service principal is an error, not a scan under the wrong one', async () => {
  const original = {
    getServicePrincipals: dbService.getServicePrincipals,
    logAnalysisScheduleRun: dbService.logAnalysisScheduleRun,
  };
  dbService.getServicePrincipals = async () => [];
  dbService.logAnalysisScheduleRun = async () => {};
  try {
    const result = await analysisScheduleService.executeSchedule({ id: 1, name: 'N', scope_kind: 'tenant' });
    assert.equal(result.status, 'error');
    assert.match(result.message, /No service principal/);
  } finally {
    Object.assign(dbService, original);
  }
});

test('the launcher refuses rather than pretending a scan started', async () => {
  analysisLauncher._reset();
  try {
    assert.equal(analysisLauncher.isRegistered(), false);
    await assert.rejects(() => analysisLauncher.start({}), /No analysis runner is registered/);
  } finally {
    // The analysis route registered the real runner when it loaded; leaving the
    // module empty would break any later test that starts a scan.
    delete require.cache[require.resolve('../src/routes/analysis')];
    require('../src/routes/analysis');
  }
  assert.equal(analysisLauncher.isRegistered(), true);
});

test('the analysis page offers a scope picker and its schedules', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/analysis/index.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/analysis',
    breadcrumb: [], availableRuns: [], globalRun: null, title: 'Run Analysis',
    servicePrincipals: [{ id: 1, name: 'SP', tenant_id: 't', enterprise_app_object_id: 'e' }],
    liveProgress: {}, error: null,
    scheduleTypes: scheduleDue.SCHEDULE_TYPES,
    runs: [{
      id: 4, sp_name: 'SP', status: 'completed', started_at: '2026-08-01T00:00:00Z', schedule_id: 3,
      total_workspaces: 2, scope: { kind: 'workspaces', workspaces: [{ id: 'a', name: 'Finance' }] },
      scopeLabel: '1 workspace: Finance',
    }],
    schedules: [analysisScheduleService.describeStoredSchedule({
      id: 3, name: 'Nightly finance', sp_id: 1, enabled: true,
      scope_kind: 'workspaces', scope_workspaces: '[{"id":"a","name":"Finance"}]',
      schedule_type: 'daily', schedule_hour: 2, schedule_minute: 0, timezone: 'Europe/Warsaw',
    })],
  });
  // The choice is made in a dialog now, not inline above the button — pressing Run
  // Analysis without having read it is how a whole-tenant scan starts by accident.
  assert.match(html, /id="scopeModal"/);
  assert.match(html, /Selected workspaces only/);
  assert.match(html, /id="scopeWorkspaceList"/);
  assert.match(html, /onclick="startAnalysis\(\)"/);
  // The schedule form opens the same dialog rather than carrying its own copy.
  assert.match(html, /onclick="chooseScheduleScope\(\)"/);
  assert.match(html, /id="schedScopeSummary"/);
  assert.doesNotMatch(html, /id="schedWorkspaceList"/, 'the schedule form must not keep a second picker');

  assert.match(html, /Scheduled Scans \(1\)/);
  assert.match(html, /Nightly finance/);
  assert.match(html, /Every day at 02:00 Europe\/Warsaw/);
  // A run's coverage reads under the tenant name, where the row already says who
  // ran it — a column of its own was a column of mostly "Whole tenant".
  assert.match(html, /Scoped · 1 workspace/);
  // The runs table no longer carries a Scope column of its own. (The schedules
  // table still does — there the scope is the point of the row.)
  assert.match(html, /<th>ID<\/th>\s*<th>Tenant<\/th>\s*<th>Status<\/th>/);
});

test('the Grant Access page says so when the scan behind it was scoped', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/access/index.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/settings/access',
    breadcrumb: [], availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Grant Access',
    accessLevels: workspaceAccess.ACCESS_LEVELS, principalTypes: workspaceAccess.PRINCIPAL_TYPES,
    accessLevel: workspaceAccess.accessLevel, principalTypeLabel: workspaceAccess.principalTypeLabel,
    describeScope: analysisScope.describeScope, scopeFromRow: analysisScope.scopeFromRow,
    overview: workspaceAccess.buildAccessOverview(ACCESS_FIXTURE), indexed: true, error: null, grantAuth: false,
    runs: [], servicePrincipals: [],
    run: { id: 12, started_at: '2026-08-01T00:00:00Z', scope_kind: 'workspaces', scope_workspaces: '[{"id":"a","name":"Finance"}]' },
    partialScope: true,
  });
  // Every figure on that page is about the tenant. A scoped scan is not wrong
  // about the workspaces it covered — it is wrong about everything else.
  assert.match(html, /not the\s+whole tenant/);
  assert.match(html, /1 workspace: Finance/);
});

test('the scan scope dialog is one dialog, opened from both places', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/analysis/index.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/analysis',
    breadcrumb: [], availableRuns: [], globalRun: null, title: 'Run Analysis',
    servicePrincipals: [{ id: 1, name: 'SP', tenant_id: 't', enterprise_app_object_id: 'e' }],
    liveProgress: {}, error: null, runs: [], schedules: [], scheduleTypes: scheduleDue.SCHEDULE_TYPES,
  });

  // One picker, one list, one filter. Two copies meant two places for the
  // behaviour to drift and two places to fix a bug in.
  assert.equal((html.match(/id="scopeWorkspaceList"/g) || []).length, 1);
  assert.equal((html.match(/id="scopeFilter"/g) || []).length, 1);

  // The dialog says what each choice costs, because the difference between them
  // on a large tenant is hours.
  assert.match(html, /hours of API calls/);
  assert.match(html, /whole-tenant scan rather than this one/);

  // Reading the list live is offered but is not the default — the stored list is
  // free and the live one is an API call.
  assert.match(html, /Refresh from tenant/);
  assert.match(html, /onclick="loadScopeWorkspaces\(true\)"/);
  assert.match(html, /loadScopeWorkspaces\(false\)/);
});

test('the run history shows a run without a scope as whole-tenant', async () => {
  const ejs = require('ejs');
  const scopeless = { id: 2, sp_name: 'SP', status: 'completed', started_at: '2026-07-01T00:00:00Z', total_workspaces: 40 };
  const html = await ejs.renderFile('src/views/analysis/index.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/analysis',
    breadcrumb: [], availableRuns: [], globalRun: null, title: 'Run Analysis',
    servicePrincipals: [], liveProgress: {}, error: null, schedules: [],
    scheduleTypes: scheduleDue.SCHEDULE_TYPES,
    // Exactly what the route hands over for a run recorded before scopes existed.
    runs: [{ ...scopeless, scope: analysisScope.scopeFromRow(scopeless), scopeLabel: analysisScope.describeScope(analysisScope.scopeFromRow(scopeless)) }],
  });
  assert.match(html, /Whole tenant/);
  assert.doesNotMatch(html, /Scoped ·/);
});

test('the run list reads every column its consumers depend on', () => {
  // A scoped run kept reading as "Whole tenant" after it finished, because the run
  // query names its columns and the scope was never added to the list. Three
  // things were silently wrong, not one: the run history showed every run as
  // tenant-wide; `pickTenantWideRun` could not tell a scoped run from a
  // tenant-wide one, so the Grant Access page's protection never engaged at all;
  // and the schedule overlap check compared an undefined `schedule_id`, so a
  // schedule could stack scans on itself.
  //
  // Each entry below is read by name somewhere. Adding a column to a run means
  // adding it here, and this test is what says so.
  const needed = [
    'id', 'sp_id', 'sp_name', 'tenant_id', 'status',
    'total_workspaces', 'total_reports', 'total_datasets', 'total_dashboards', 'total_users',
    'started_at', 'completed_at', 'run_by',
    'scope_kind', 'scope_workspaces', 'schedule_id',
  ];
  const columns = dbPrivate.RUN_META_COLUMNS.split(',').map(name => name.trim());
  for (const column of needed) {
    assert.ok(columns.includes(column), 'the run query must read ' + column);
  }
  // results_json is the scan document and can be megabytes; a run list must not
  // drag it along.
  assert.ok(!columns.includes('results_json'));
});

test('the pre-scoping fallback names only columns the full read also names', () => {
  // The fallback exists for a database that has not migrated yet. It must be a
  // strict subset: a column in the fallback but not the main list would be one
  // nothing ever verified.
  const columns = dbPrivate.RUN_META_COLUMNS.split(',').map(name => name.trim());
  const legacy = dbPrivate.RUN_META_COLUMNS_LEGACY.split(',').map(name => name.trim());
  for (const column of legacy) assert.ok(columns.includes(column), column + ' is not in the full read');
  // And it must drop exactly the columns the migration adds.
  assert.deepEqual(columns.filter(c => !legacy.includes(c)), ['scope_kind', 'scope_workspaces', 'schedule_id']);
});

test('a run gets a two-letter coverage tag for the run selector', () => {
  // The selector already carries an SP name, a run number and a timestamp. There
  // is no room for "3 workspaces: Finance, Sales and 1 more" — but which of two
  // scans covered everything is exactly what someone picking between them needs.
  assert.equal(analysisScope.scopeTag({ scope_kind: 'tenant' }), 'WT');
  assert.equal(analysisScope.scopeTag({ scope_kind: 'workspaces', scope_workspaces: '[{"id":"a","name":"Finance"}]' }), 'SC');
  // A run recorded before scopes existed was tenant-wide.
  assert.equal(analysisScope.scopeTag({ id: 4 }), 'WT');

  assert.equal(analysisScope.scopeTagTitle({ scope_kind: 'tenant' }), 'WT — whole tenant');
  assert.equal(
    analysisScope.scopeTagTitle({ scope_kind: 'workspaces', scope_workspaces: '[{"id":"a","name":"Finance"}]' }),
    'SC — scoped to 1 workspace: Finance');
});

test('the run selector shows each scan\'s coverage, and the current one carries a badge', async () => {
  const ejs = require('ejs');
  const decorate = run => ({ ...run, scopeTag: analysisScope.scopeTag(run), scopeTagTitle: analysisScope.scopeTagTitle(run) });
  const scoped = decorate({ id: 7, sp_name: 'Contoso SP', status: 'completed', started_at: '2026-08-26T02:00:00Z', scope_kind: 'workspaces', scope_workspaces: '[{"id":"a","name":"Finance"}]' });
  const wide = decorate({ id: 6, sp_name: 'Contoso SP', status: 'completed', started_at: '2026-08-25T02:00:00Z', scope_kind: 'tenant' });

  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/workspaces', breadcrumb: [], title: 'x',
    availableRuns: [scoped, wide], globalRun: scoped, selectedRunId: 7,
  });

  assert.match(html, /\[SC\] Contoso SP: Run#7/);
  assert.match(html, /\[WT\] Contoso SP: Run#6/);
  assert.match(html, /title="SC — scoped to 1 workspace: Finance"/);
});

test('a run list with no scope decoration still renders the selector', async () => {
  // The middleware decorates the runs, but the partial is rendered from several
  // places and must not depend on it having happened.
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/workspaces', breadcrumb: [], title: 'x',
    availableRuns: [{ id: 1, sp_name: 'SP', status: 'completed', started_at: '2026-08-01T00:00:00Z' }],
    globalRun: null, selectedRunId: 1,
  });
  assert.match(html, /\[WT\] SP: Run#1/, 'an undecorated run reads as whole tenant, which is what it was');
});

test('the middleware decorates every run it hands the selector', async () => {
  const { clearRunCache } = require('../src/middleware/loadRuns');
  const loadRuns = require('../src/middleware/loadRuns').loadRuns;
  const original = dbService.getAnalysisRuns;
  clearRunCache();
  dbService.getAnalysisRuns = async () => ([
    { id: 7, status: 'completed', scope_kind: 'workspaces', scope_workspaces: '[{"id":"a","name":"Finance"}]' },
    { id: 6, status: 'completed', scope_kind: 'tenant' },
    { id: 5, status: 'failed', scope_kind: 'tenant' },
  ]);

  try {
    const res = { locals: {} };
    await new Promise(resolve => loadRuns({ query: {}, session: {}, user: null }, res, resolve));
    assert.deepEqual(res.locals.availableRuns.map(r => r.scopeTag), ['SC', 'WT'], 'only completed runs, each tagged');
    assert.match(res.locals.availableRuns[0].scopeTagTitle, /Finance/);
  } finally {
    dbService.getAnalysisRuns = original;
    clearRunCache();
  }
});

test('comparing two scans of different coverage says so before the numbers', async () => {
  // Comparing a one-workspace scan with a whole-tenant one produces "-47
  // workspaces", which reads as the estate having shrunk. The page still shows
  // the comparison — refusing would be worse — but it must not be read as change.
  const ejs = require('ejs');
  const scoped = { id: 7, sp_name: 'SP', tenant_id: 't', started_at: '2026-08-26T00:00:00Z', scope_kind: 'workspaces', scope_workspaces: '[{"id":"a","name":"Finance"}]', total_workspaces: 1 };
  const wide = { id: 6, sp_name: 'SP', tenant_id: 't', started_at: '2026-08-25T00:00:00Z', scope_kind: 'tenant', total_workspaces: 48 };
  const base = {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/analysis/compare',
    breadcrumb: [], availableRuns: [], globalRun: null, title: 'Compare Runs',
    scopeTag: analysisScope.scopeTag, scopeTagTitle: analysisScope.scopeTagTitle,
    describeScope: analysisScope.describeScope, scopeFromRow: analysisScope.scopeFromRow,
    runs: [scoped, wide], metrics: [], changedMetrics: [], error: null, tenantSettingsComparable: true,
  };

  const mismatched = await ejs.renderFile('src/views/analysis/compare.ejs', { ...base, fromRun: wide, toRun: scoped });
  assert.match(mismatched, /did not cover the same thing/);
  assert.match(mismatched, /1 workspace: Finance/);

  // Two scans of the same coverage need no such warning.
  const matched = await ejs.renderFile('src/views/analysis/compare.ejs', { ...base, fromRun: wide, toRun: { ...wide, id: 5 } });
  assert.doesNotMatch(matched, /did not cover the same thing/);

  // And the picker leads with the coverage either way.
  assert.match(mismatched, /\[SC\] Run #7/);
  assert.match(mismatched, /\[WT\] Run #6/);
});
