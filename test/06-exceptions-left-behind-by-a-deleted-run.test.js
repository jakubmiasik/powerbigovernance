/* eslint-disable no-unused-vars */
const {
  assert, http, test, app, request, postJson, convertScheduleToUtc, scheduler, runMetrics, workspaceDeletion, dbService, stubDeletionDb, sampleRun, tenantRun, pbi, httpError, itemDetails, stubPbi, insights, SCAN_DATE, ws, findingKeys, dbPrivate, httpErrors, pipelineService, requireAuth, recon, INVOICE_RULE, runProgress, progressThrough, sqlSource, reconCompare, RUN_A, RUN_B, finding, reconRepo, fakeSqlPrimitives, withFakeSql, mdm, PERSON_FIELDS, personRecord, SURVIVOR_MODEL, survivorRecords, CUSTOMER_MODEL, RAW_CUSTOMERS, analysisModel, SCAN_RESULT, guide, jobProgress, workspaceAccess, analysisScope, scheduleDue, ACCESS_FIXTURE, analysisLauncher, analysisScheduleService, DUE_DAILY, namingService, NAMING, withServer, securityGroups, sgMapping, sgRepo, perms, sections, TENANTS, resolveFor, permMiddleware, fakeRes, withFakeDirectory, SOFTWAREONE, OTHER_TENANT, outcomeFixture, buildFixtureOutcome, compareFixture, compareResponse,
} = require('./support');


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
    visibleSections: require('../src/services/appSectionService').APP_SECTIONS,
    permissions: { isAdmin: true },
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
    fabricRoles: workspaceAccess.FABRIC_ROLES,
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
    visibleSections: require('../src/services/appSectionService').APP_SECTIONS,
    permissions: { isAdmin: true },
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
