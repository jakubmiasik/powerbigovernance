/* eslint-disable no-unused-vars */
const {
  assert, http, test, app, request, postJson, convertScheduleToUtc, scheduler, runMetrics, workspaceDeletion, dbService, stubDeletionDb, sampleRun, tenantRun, pbi, httpError, itemDetails, stubPbi, insights, SCAN_DATE, ws, findingKeys, dbPrivate, httpErrors, pipelineService, requireAuth, recon, INVOICE_RULE, runProgress, progressThrough, sqlSource, reconCompare, RUN_A, RUN_B, finding, reconRepo, fakeSqlPrimitives, withFakeSql, mdm, PERSON_FIELDS, personRecord, SURVIVOR_MODEL, survivorRecords, CUSTOMER_MODEL, RAW_CUSTOMERS, analysisModel, SCAN_RESULT, guide, jobProgress, workspaceAccess, analysisScope, scheduleDue, ACCESS_FIXTURE, analysisLauncher, analysisScheduleService, DUE_DAILY, namingService, NAMING, withServer, securityGroups, sgMapping, sgRepo, perms, sections, TENANTS, resolveFor, permMiddleware, fakeRes, withFakeDirectory, SOFTWAREONE, OTHER_TENANT, outcomeFixture, buildFixtureOutcome, compareFixture, compareResponse,
} = require('./support');


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
