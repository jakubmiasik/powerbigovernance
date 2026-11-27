/* eslint-disable no-unused-vars */
const {
  assert, http, test, app, request, postJson, convertScheduleToUtc, scheduler, runMetrics, workspaceDeletion, dbService, stubDeletionDb, sampleRun, tenantRun, pbi, httpError, itemDetails, stubPbi, insights, SCAN_DATE, ws, findingKeys, dbPrivate, httpErrors, pipelineService, requireAuth, recon, INVOICE_RULE, runProgress, progressThrough, sqlSource, reconCompare, RUN_A, RUN_B, finding, reconRepo, fakeSqlPrimitives, withFakeSql, mdm, PERSON_FIELDS, personRecord, SURVIVOR_MODEL, survivorRecords, CUSTOMER_MODEL, RAW_CUSTOMERS, analysisModel, SCAN_RESULT, guide, jobProgress, workspaceAccess, analysisScope, scheduleDue, ACCESS_FIXTURE, analysisLauncher, analysisScheduleService, DUE_DAILY, namingService, NAMING, withServer, securityGroups, sgMapping, sgRepo, perms, sections, TENANTS, resolveFor, permMiddleware, fakeRes, withFakeDirectory, SOFTWAREONE, OTHER_TENANT, outcomeFixture, buildFixtureOutcome, compareFixture, compareResponse,
} = require('./support');


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
    assert.match(logged[0][3], /\bid 9\b/, 'the skip names the run that is in the way (unnumbered here, so by id)');
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
  assert.match(html, /<th title="Each service principal numbers its own scans from 1">Scan<\/th>\s*<th>Tenant<\/th>\s*<th>Status<\/th>/);
});

test('the Grant Access page says so when the scan behind it was scoped', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/access/index.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/settings/access',
    breadcrumb: [], availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Grant Access',
    accessLevels: workspaceAccess.ACCESS_LEVELS, principalTypes: workspaceAccess.PRINCIPAL_TYPES,
    fabricRoles: workspaceAccess.FABRIC_ROLES,
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
  assert.deepEqual(columns.filter(c => !legacy.includes(c)), ['scope_kind', 'scope_workspaces', 'schedule_id', 'sp_run_number']);
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
  const scoped = decorate({ id: 7, sp_name: 'Contoso SP', sp_run_number: 2, status: 'completed', started_at: '2026-08-26T02:00:00Z', scope_kind: 'workspaces', scope_workspaces: '[{"id":"a","name":"Finance"}]' });
  const wide = decorate({ id: 6, sp_name: 'Contoso SP', sp_run_number: 1, status: 'completed', started_at: '2026-08-25T02:00:00Z', scope_kind: 'tenant' });

  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/workspaces', breadcrumb: [], title: 'x',
    availableRuns: [scoped, wide], globalRun: scoped, selectedRunId: 7,
  });

  // Named by principal and that principal's scan number, not the database id.
  assert.match(html, /\[SC\] Contoso SP #2/);
  assert.match(html, /\[WT\] Contoso SP #1/);
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
  assert.match(html, /\[WT\] SP \(unnumbered, id 1\)/, 'an undecorated run reads as whole tenant, which is what it was');
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
    const permissions = { isAdmin: true, allTenants: true, tenantIds: [], sectionKeys: [] };
    await new Promise(resolve => loadRuns({ query: {}, session: {}, user: null, permissions }, res, resolve));
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
  const scoped = { id: 7, sp_name: 'SP', sp_run_number: 7, tenant_id: 't', started_at: '2026-08-26T00:00:00Z', scope_kind: 'workspaces', scope_workspaces: '[{"id":"a","name":"Finance"}]', total_workspaces: 1 };
  const wide = { id: 6, sp_name: 'SP', sp_run_number: 6, tenant_id: 't', started_at: '2026-08-25T00:00:00Z', scope_kind: 'tenant', total_workspaces: 48 };
  const base = {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/analysis/compare',
    breadcrumb: [], availableRuns: [], globalRun: null, title: 'Compare Runs',
    scopeTag: analysisScope.scopeTag, scopeTagTitle: analysisScope.scopeTagTitle,
    describeScope: analysisScope.describeScope, scopeFromRow: analysisScope.scopeFromRow,
    runs: [scoped, wide], metrics: [], changedMetrics: [], error: null, tenantSettingsComparable: true,
  };

  const tenantLocals = { tenants: [{ id: 't', label: 'SP', scans: 2 }], tenantId: 't' };
  const metrics = [{ key: 'totalWorkspaces', label: 'Workspaces', from: 48, to: 1, delta: -47, percent: -97.9, changed: true }];
  // Once the reader has confirmed in the dialog, the warning stays above the numbers.
  const mismatched = await ejs.renderFile('src/views/analysis/compare.ejs', { ...base, ...tenantLocals, fromRun: wide, toRun: scoped, metrics, scopeConfirmed: true });
  assert.match(mismatched, /did not cover the same thing/);
  assert.match(mismatched, /1 workspace: Finance/);

  // Two scans of the same coverage need no such warning.
  const matched = await ejs.renderFile('src/views/analysis/compare.ejs', { ...base, ...tenantLocals, fromRun: wide, toRun: { ...wide, id: 5 }, metrics });
  assert.doesNotMatch(matched, /did not cover the same thing/);

  // And the picker leads with the coverage either way.
  assert.match(mismatched, /\[SC\] SP #7/);
  assert.match(mismatched, /\[WT\] SP #6/);
});

test('the document\'s own examples pass the default convention', () => {
  for (const [name, type] of [
    ['DE_LH_100_BRONZE_SALES', 'Lakehouse'],
    ['DW_WH_300_GOLD_SALES', 'Warehouse'],
    ['DF_PL_100_BRONZE_RUN_DATA_INGESTION', 'DataPipeline'],
  ]) {
    const result = namingService.checkName(name, type, NAMING);
    assert.ok(result.ok, name + ': ' + result.problems.join(' '));
  }
  assert.equal(namingService.describeConvention(NAMING), 'EXPERIENCE_ARTIFACT_[INDEX]_[STAGE]_DESCRIPTION');
  assert.equal(namingService.exampleName(NAMING), 'DE_LH_100_BRONZE_SALES');
});

test('optional parts may be absent, in any combination', () => {
  // Not every artifact belongs to a medallion layer and not everything needs
  // ordering, so a checker that demanded both would flag correct names.
  for (const name of ['DE_LH_SALES', 'DE_LH_100_SALES', 'DE_LH_BRONZE_SALES', 'DE_LH_100_BRONZE_SALES']) {
    assert.ok(namingService.checkName(name, 'Lakehouse', NAMING).ok, name);
  }
});

test('a description may contain the separator, because business text does', () => {
  // SOURCE_TO_BRONZE is one description, not three parts.
  const result = namingService.checkName('DF_PL_100_BRONZE_SOURCE_TO_BRONZE', 'DataPipeline', NAMING);
  assert.ok(result.ok, result.problems.join(' '));
  assert.equal(result.matched.description, 'SOURCE_TO_BRONZE');
});

test('each problem names the part at fault, not just "invalid"', () => {
  const wrongExperience = namingService.checkName('XX_LH_SALES', 'Lakehouse', NAMING);
  assert.match(wrongExperience.problems[0], /Experience should be one of/);

  const wrongCase = namingService.checkName('de_lh_100_bronze_sales', 'Lakehouse', NAMING);
  assert.deepEqual(wrongCase.problems, ['Should be upper case.']);

  const noName = namingService.checkName('', 'Lakehouse', NAMING);
  assert.match(noName.problems[0], /no name/);
});

test('the artifact code has to agree with what the item actually is', () => {
  // Otherwise a lakehouse named DE_PL_100_SALES passes a check that means nothing.
  const result = namingService.checkName('DE_PL_100_BRONZE_SALES', 'Lakehouse', NAMING);
  assert.ok(!result.ok);
  assert.match(result.problems[0], /This is a Lakehouse, so the artifact code should be "LH"/);
});

test('a suggested name keeps the meaning already in the name', () => {
  // The point is a name someone will actually use, so the business words survive
  // and only the codes are added.
  assert.equal(namingService.suggestName({ name: 'Sales Bronze Lakehouse', type: 'Lakehouse' }, NAMING), 'DE_LH_BRONZE_SALES');
  assert.equal(namingService.suggestName({ name: '100 Silver Ingest Pipeline', type: 'DataPipeline' }, NAMING), 'DF_PL_100_SILVER_INGEST');
  // "Finance DW" — DW is the experience code, so it is not repeated as description.
  assert.equal(namingService.suggestName({ name: 'Finance DW', type: 'Warehouse' }, NAMING), 'DW_WH_FINANCE');
  // Nothing left to describe is said plainly rather than produced as DE_LH.
  assert.equal(namingService.suggestName({ name: 'Lakehouse', type: 'Lakehouse' }, NAMING), 'DE_LH_RENAME_ME');
});

test('a type the convention says nothing about gets no suggestion and no finding', () => {
  // A suggestion nobody could act on is worse than none, and judging an item by a
  // rule that does not cover it is not a finding.
  assert.equal(namingService.suggestName({ name: 'thing', type: 'MirroredDatabase' }, NAMING), null);
  const workspace = { items: [{ id: '1', name: 'whatever', type: 'MirroredDatabase' }] };
  const result = namingService.checkWorkspace(workspace, NAMING);
  assert.equal(result.checked, 0);
  assert.equal(result.offenders.length, 0);
});

test('checking a workspace reports only the artifacts that break the rules', () => {
  const workspace = {
    items: [
      { id: '1', name: 'DE_LH_100_BRONZE_SALES', type: 'Lakehouse' },
      { id: '2', name: 'Sales Report', type: 'Report' },
      { id: '3', name: 'finance dw', type: 'Warehouse' },
    ],
  };
  const result = namingService.checkWorkspace(workspace, NAMING);
  assert.equal(result.checked, 3);
  assert.deepEqual(result.offenders.map(o => o.name), ['Sales Report', 'finance dw']);
  assert.equal(result.offenders[0].suggestion, 'PBI_RPT_SALES');
  assert.equal(result.offenders[1].suggestion, 'DW_WH_FINANCE');
});

test('an item type the convention is told to skip is not checked', () => {
  // For artifacts nobody names by hand — a finding nobody can clear is noise.
  const convention = { ...NAMING, ignoredItemTypes: ['report'] };
  const workspace = { items: [{ id: '2', name: 'Sales Report', type: 'Report' }] };
  assert.equal(namingService.checkWorkspace(workspace, convention).checked, 0);
});

test('a convention is configurable down to the separator and the case', () => {
  const dashed = namingService.normalizeConvention({
    ...NAMING, separator: '-', letterCase: 'lower',
    segments: [{ key: 'artifact', required: true }, { key: 'description', required: true }],
  });
  assert.ok(namingService.checkName('lh-sales', 'Lakehouse', dashed).ok);
  assert.ok(!namingService.checkName('LH-SALES', 'Lakehouse', dashed).ok);
  assert.equal(namingService.suggestName({ name: 'Sales Lakehouse', type: 'Lakehouse' }, dashed), 'lh-sales');
  assert.equal(namingService.describeConvention(dashed), 'ARTIFACT-DESCRIPTION');
});

test('a half-written convention falls back to the default rather than to no rules', () => {
  // A convention with no codes would report every name as fine, which is worse
  // than not checking at all.
  const empty = namingService.normalizeConvention({ enabled: true, experiences: [], artifacts: [], segments: [] });
  assert.ok(empty.experiences.length > 0);
  assert.ok(empty.artifacts.length > 0);
  assert.ok(empty.segments.length > 0);
  assert.equal(namingService.normalizeConvention(null).enabled, false);
});

test('a broken index pattern is reported, not silently ignored', () => {
  const broken = { ...NAMING, indexPattern: '([' };
  const result = namingService.checkName('DE_LH_100_SALES', 'Lakehouse', broken);
  assert.ok(result.problems.some(p => /not a valid regular expression/.test(p)));
});

test('the settings form parses into a convention', () => {
  const convention = namingService.conventionFromForm({
    enabled: 'true', separator: '_', letterCase: 'upper', indexPattern: '^[1-9]00$',
    segment: ['experience', 'artifact', 'description'],
    required_experience: 'true', required_artifact: 'true', required_description: 'true',
    experiences: 'PBI = Power BI\nDE = Data Engineering\n\n  ',
    artifacts: 'LH = Lakehouse | DE | Lakehouse\nRPT = Report | PBI | Report, PaginatedReport',
    stages: '', ignoredItemTypes: 'Dashboard\n',
  });

  assert.equal(convention.enabled, true);
  assert.deepEqual(convention.segments.map(s => s.key), ['experience', 'artifact', 'description']);
  assert.deepEqual(convention.experiences.map(e => e.code), ['PBI', 'DE']);
  assert.deepEqual(convention.artifacts[1].itemTypes, ['Report', 'PaginatedReport']);
  assert.deepEqual(convention.ignoredItemTypes, ['dashboard']);
  // Segments keep the definition order, not the order the checkboxes arrived in.
  const reordered = namingService.conventionFromForm({
    segment: ['description', 'experience'], required_description: 'true', required_experience: 'true',
  });
  assert.deepEqual(reordered.segments.map(s => s.key), ['experience', 'description']);
});

test('a convention that could never be satisfied is refused', () => {
  const problems = namingService.validateConvention(namingService.normalizeConvention({
    segments: [{ key: 'stage', required: false }],
    indexPattern: '([',
    stages: [],
    experiences: [{ code: 'DE', label: 'Data Engineering' }],
    artifacts: [
      { code: 'X', experience: 'NOPE', itemTypes: ['Lakehouse'] },
      { code: 'Y', experience: 'DE', itemTypes: ['lakehouse'] },
    ],
  }));

  assert.ok(problems.some(p => /At least one part of the name must be required/.test(p)));
  assert.ok(problems.some(p => /not a valid regular expression/.test(p)));
  assert.ok(problems.some(p => /no stages are listed/.test(p)));
  assert.ok(problems.some(p => /refers to experience "NOPE"/.test(p)));
  // The same item type under two codes would make the suggestion arbitrary.
  assert.ok(problems.some(p => /claimed by both/.test(p)));

  assert.deepEqual(namingService.validateConvention(NAMING), []);
});

test('triage flags off-convention names only when a convention is switched on', () => {
  const results = { workspaces: [{
    id: 'a', name: 'Finance',
    users: [{ name: 'Ann', email: 'a@x.com', role: 'Admin', type: 'User' }],
    items: [
      { id: '1', name: 'DE_LH_100_BRONZE_SALES', type: 'Lakehouse' },
      { id: '2', name: 'Sales Report', type: 'Report' },
    ],
  }] };

  // An unconfigured convention would flag an entire tenant on its first scan.
  const off = insights.computeWorkspaceInsights(results, {});
  assert.equal(off.byFinding.namingConvention, 0);
  assert.equal(off.namingConventionEnabled, false);

  const on = insights.computeWorkspaceInsights(results, { namingConvention: NAMING });
  assert.equal(on.byFinding.namingConvention, 1);
  assert.equal(on.namingConventionEnabled, true);
  const finding = on.workspaces[0].findings.find(f => f.key === 'namingConvention');
  assert.match(finding.detail, /1 of 2 checked artifact\(s\)/);
  assert.match(finding.detail, /Sales Report/);

  // A convention that exists but is switched off changes nothing.
  const disabled = insights.computeWorkspaceInsights(results, { namingConvention: { ...NAMING, enabled: false } });
  assert.equal(disabled.byFinding.namingConvention, 0);
});

test('the governance configuration page offers the convention, and triage explains it', async () => {
  const ejs = require('ejs');
  const convention = namingService.normalizeConvention(NAMING);
  const page = await ejs.renderFile('src/views/governance-config/index.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/settings/governance', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Governance Configuration',
    success: [], error: [],
    naming: convention, segmentDefs: namingService.SEGMENT_DEFS, letterCases: namingService.LETTER_CASES,
    namingPattern: namingService.describeConvention(convention),
    namingExample: namingService.exampleName(convention),
  });
  assert.match(page, /Fabric Artifact Naming Convention/);
  assert.match(page, /EXPERIENCE_ARTIFACT/);
  assert.match(page, /DE_LH_100_BRONZE_SALES/);
  assert.match(page, /action="\/settings\/governance\/naming"/);

  const triage = await ejs.renderFile('src/views/workspaces/list.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/workspaces', breadcrumb: [],
    availableRuns: [], globalRun: null, title: 'Workspaces', fromSavedData: true, run: null,
    insights: insights.computeWorkspaceInsights({ workspaces: [] }, { namingConvention: NAMING }),
    findingDefs: insights.FINDING_DEFS,
    namingPattern: namingService.describeConvention(convention),
  });
  assert.match(triage, /Off-convention names/);
  assert.match(triage, /Artifact names are checked as/);
});

test('the triage card for naming is hidden when nothing is enforced', async () => {
  // A permanent zero reads as "clean" rather than "not looked at".
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/workspaces/list.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/workspaces', breadcrumb: [],
    availableRuns: [], globalRun: null, title: 'Workspaces', fromSavedData: true, run: null,
    insights: insights.computeWorkspaceInsights({ workspaces: [] }, {}),
    findingDefs: insights.FINDING_DEFS, namingPattern: null,
  });
  // The label still appears in the filter's lookup table, which is JSON for the
  // page's own script — what must be absent is the card.
  assert.doesNotMatch(html, /setFindingFilter\('namingConvention'\)/);
  assert.match(html, /No naming convention is being enforced/);
});

test('the workspace page lists each off-convention artifact with its suggestion', async () => {
  const ejs = require('ejs');
  const workspace = {
    id: 'a', name: 'Finance',
    items: [
      { id: '1', name: 'DE_LH_100_BRONZE_SALES', type: 'Lakehouse' },
      { id: '2', name: 'Sales Report', type: 'Report' },
    ],
    users: [],
  };
  const html = await ejs.renderFile('src/views/workspaces/detail.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/workspaces/a', breadcrumb: [],
    availableRuns: [], globalRun: null, title: 'Finance',
    workspace, items: workspace.items, users: [], sourceRun: null,
    reports: [workspace.items[1]], datasets: [], dashboards: [], dataflows: [],
    lakehouses: [workspace.items[0]], notebooks: [], pipelines: [], warehouses: [], others: [],
    naming: namingService.checkWorkspace(workspace, NAMING),
    namingPattern: namingService.describeConvention(NAMING),
  });

  assert.match(html, /tab-naming/);
  assert.match(html, /PBI_RPT_SALES/);
  // The compliant lakehouse is not listed as an offender.
  const table = (html.match(/id="naming-offenders-table"[\s\S]*?<\/table>/) || [''])[0];
  assert.ok(!/DE_LH_100_BRONZE_SALES/.test(table));
  // Renaming happens in the Fabric portal; the page must not imply otherwise.
  assert.match(html, /Nothing is renamed here/);
});

test('a workspace page with no convention configured has no naming tab', async () => {
  const ejs = require('ejs');
  const workspace = { id: 'a', name: 'Finance', items: [], users: [] };
  const html = await ejs.renderFile('src/views/workspaces/detail.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/workspaces/a', breadcrumb: [],
    availableRuns: [], globalRun: null, title: 'Finance',
    workspace, items: [], users: [], sourceRun: null,
    reports: [], datasets: [], dashboards: [], dataflows: [],
    lakehouses: [], notebooks: [], pipelines: [], warehouses: [], others: [],
    naming: null, namingPattern: null,
  });
  assert.doesNotMatch(html, /tab-naming/);
});

test('a name in no recognisable shape gets one problem, not five restatements of it', () => {
  // Walking the segments against an unsegmented name derives "Experience should be
  // one of…", "Artifact is missing", "Description is missing" — a wall of text
  // saying one thing. The suggested name is what the reader needs next.
  const result = namingService.checkName('Sales Report', 'Report', NAMING);
  assert.equal(result.problems.length, 2);
  assert.match(result.problems[0], /upper case/);
  assert.match(result.problems[1], /Not in the form EXPERIENCE_ARTIFACT/);

  // A name that *is* in the right shape still gets the specific problem.
  const specific = namingService.checkName('XX_LH_SALES', 'Lakehouse', NAMING);
  assert.deepEqual(specific.problems.length, 1);
  assert.match(specific.problems[0], /Experience should be one of/);
});

test('the convention lives on its own page, not on Settings', async () => {
  // Settings is about reaching the tenant — which service principal, whose secret.
  // A convention deciding whether a lakehouse is named acceptably is a different
  // question with a different audience, and Settings should not carry both.
  const ejs = require('ejs');
  const settings = await ejs.renderFile('src/views/config.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/settings', breadcrumb: [],
    availableRuns: [], globalRun: null, title: 'Settings',
    servicePrincipals: [], secretEncryptionReady: true, success: [], error: [],
  });

  // No form, and no locals it would need — the page renders without them at all.
  assert.doesNotMatch(settings, /action="\/settings\/(governance\/)?naming"/);
  assert.doesNotMatch(settings, /Experience codes/);
  // But it still says where the convention went, rather than leaving no trace.
  assert.match(settings, /Governance Configuration/);
  assert.match(settings, /href="\/settings\/governance"/);
});

test('the sidebar lists Governance Configuration under Settings, with its own icon', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/settings/governance', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'x',
    visibleSections: require('../src/services/appSectionService').APP_SECTIONS,
    permissions: { isAdmin: true },
  });

  assert.match(html, /<span>Governance Configuration<\/span>/);
  assert.match(html, /href="\/settings\/governance"[^>]*active/, 'the page highlights itself');
  // Settings matches its own path exactly, so it does not also light up here.
  assert.doesNotMatch(html, /href="\/settings" class="sidebar-link active"/);

  // Governance Overview already uses bi-shield-check; two identical icons in one
  // sidebar is the confusion Master Data and Deployment Pipelines already caused.
  const icons = (html.match(/bi bi-[a-z0-9-]+"><\/i> <span>/g) || []);
  assert.equal(new Set(icons).size, icons.length, 'every sidebar icon must be distinct: ' + icons.join(', '));
});
