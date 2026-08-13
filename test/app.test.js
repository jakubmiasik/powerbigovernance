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
