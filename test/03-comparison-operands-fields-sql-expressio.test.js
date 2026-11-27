/* eslint-disable no-unused-vars */
const {
  assert, http, test, app, request, postJson, convertScheduleToUtc, scheduler, runMetrics, workspaceDeletion, dbService, stubDeletionDb, sampleRun, tenantRun, pbi, httpError, itemDetails, stubPbi, insights, SCAN_DATE, ws, findingKeys, dbPrivate, httpErrors, pipelineService, requireAuth, recon, INVOICE_RULE, runProgress, progressThrough, sqlSource, reconCompare, RUN_A, RUN_B, finding, reconRepo, fakeSqlPrimitives, withFakeSql, mdm, PERSON_FIELDS, personRecord, SURVIVOR_MODEL, survivorRecords, CUSTOMER_MODEL, RAW_CUSTOMERS, analysisModel, SCAN_RESULT, guide, jobProgress, workspaceAccess, analysisScope, scheduleDue, ACCESS_FIXTURE, analysisLauncher, analysisScheduleService, DUE_DAILY, namingService, NAMING, withServer, securityGroups, sgMapping, sgRepo, perms, sections, TENANTS, resolveFor, permMiddleware, fakeRes, withFakeDirectory, SOFTWAREONE, OTHER_TENANT, outcomeFixture, buildFixtureOutcome, compareFixture, compareResponse,
} = require('./support');


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
