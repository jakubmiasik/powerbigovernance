/* eslint-disable no-unused-vars */
const {
  assert, http, test, app, request, postJson, convertScheduleToUtc, scheduler, runMetrics, workspaceDeletion, dbService, stubDeletionDb, sampleRun, tenantRun, pbi, httpError, itemDetails, stubPbi, insights, SCAN_DATE, ws, findingKeys, dbPrivate, httpErrors, pipelineService, requireAuth, recon, INVOICE_RULE, runProgress, progressThrough, sqlSource, reconCompare, RUN_A, RUN_B, finding, reconRepo, fakeSqlPrimitives, withFakeSql, mdm, PERSON_FIELDS, personRecord, SURVIVOR_MODEL, survivorRecords, CUSTOMER_MODEL, RAW_CUSTOMERS, analysisModel, SCAN_RESULT, guide, jobProgress, workspaceAccess, analysisScope, scheduleDue, ACCESS_FIXTURE, analysisLauncher, analysisScheduleService, DUE_DAILY, namingService, NAMING, withServer, securityGroups, sgMapping, sgRepo, perms, sections, TENANTS, resolveFor, permMiddleware, fakeRes, withFakeDirectory, SOFTWAREONE, OTHER_TENANT, outcomeFixture, buildFixtureOutcome, compareFixture, compareResponse,
} = require('./support');


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
