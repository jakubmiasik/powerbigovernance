/* eslint-disable no-unused-vars */
const {
  assert, http, test, app, request, postJson, convertScheduleToUtc, scheduler, runMetrics, workspaceDeletion, dbService, stubDeletionDb, sampleRun, tenantRun, pbi, httpError, itemDetails, stubPbi, insights, SCAN_DATE, ws, findingKeys, dbPrivate, httpErrors, pipelineService, requireAuth, recon, INVOICE_RULE, runProgress, progressThrough, sqlSource, reconCompare, RUN_A, RUN_B, finding, reconRepo, fakeSqlPrimitives, withFakeSql, mdm, PERSON_FIELDS, personRecord, SURVIVOR_MODEL, survivorRecords, CUSTOMER_MODEL, RAW_CUSTOMERS, analysisModel, SCAN_RESULT, guide, jobProgress, workspaceAccess, analysisScope, scheduleDue, ACCESS_FIXTURE, analysisLauncher, analysisScheduleService, DUE_DAILY, namingService, NAMING, withServer, securityGroups, sgMapping, sgRepo, perms, sections, TENANTS, resolveFor, permMiddleware, fakeRes, withFakeDirectory, SOFTWAREONE, OTHER_TENANT, outcomeFixture, buildFixtureOutcome, compareFixture, compareResponse,
} = require('./support');


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

test('User 360 entries carry the ids needed to link to their source', () => {
  // Without ids the User 360 lists are dead text: there is nothing to build a
  // workspace or item URL from.
  const users = runMetrics.buildUser360([{
    id: 'ws-1', name: 'Sales',
    users: [{ name: 'Ann', email: 'ann@contoso.com', role: 'Admin' }],
    items: [{ id: 'item-1', name: 'Revenue', type: 'Report', creator: { name: 'Ann', upn: 'ann@contoso.com' } }],
  }]);

  const ann = users.find(u => u.upn === 'ann@contoso.com');
  assert.ok(ann, 'expected Ann in User 360');
  assert.deepStrictEqual(ann.items[0], {
    id: 'item-1', name: 'Revenue', type: 'Report', workspace: 'Sales', workspaceId: 'ws-1',
  });
  assert.strictEqual(ann.workspaces[0].id, 'ws-1');
});

test('User 360 opens artifact details in place instead of navigating away', async () => {
  const ejs = require('ejs');
  // Clicking an artifact should answer "what is this item?" without losing the
  // user's place in the User 360 list.
  const html = await ejs.renderFile('src/views/governance/users.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T', email: 't@example.com' },
    currentPath: '/governance/users', pagePath: '/governance/users', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'User 360',
    run: { id: 4 }, totalUsers: 1,
    users: [{
      name: 'Ann', upn: 'ann@contoso.com',
      createdItems: [
        { id: 'item-1', name: 'Revenue "2026" Report', type: 'Report', workspace: 'Sales', workspaceId: 'ws-1' },
        { name: 'No Id', type: 'Report', workspace: 'Sales', workspaceId: 'ws-1' },
      ],
      workspaces: [{ id: 'ws-1', workspace: 'Sales', role: 'Admin' }],
    }],
  });

  // Binding must go through data attributes: an artifact name containing a quote
  // would end an inline onclick early and silently kill the click.
  assert.match(html, /class="[^"]*js-item-details"[\s\S]*?data-workspace-id="ws-1"/);
  assert.match(html, /data-item-id="item-1"/);
  assert.match(html, /data-item-name="Revenue &#34;2026&#34; Report"/);
  assert.match(html, /data-item-type="Report"/);
  assert.ok(
    !/onclick="showItemDetails/.test(html),
    'the handler must not be inlined into an attribute',
  );
  assert.match(html, /\.js-item-details/, 'a delegated click handler must be wired up');
  assert.ok(html.includes('id="itemDetailsModal"'), 'the shared details modal must be on the page');
  assert.ok(
    !/href="\/workspaces\/ws-1[^"]*item=/.test(html),
    'the artifact name must not navigate to the workspace page',
  );
  // The workspace name is still a link; only the artifact changed.
  assert.match(html, /href="\/workspaces\/ws-1\?creator=/);
  // An item without an id has nothing to fetch, so it stays plain text.
  assert.match(html, /<strong class="small">No Id<\/strong>/);
});

test('creator filtering matches on UPN or display name and both creator shapes', () => {
  const items = [
    { name: 'Saved', creator: { name: 'Ann', upn: 'ann@contoso.com' } },
    { name: 'Live', creatorPrincipal: { displayName: 'Bob', userDetails: { userPrincipalName: 'bob@contoso.com' } } },
    { name: 'LegacyString', creator: 'Cara' },
    { name: 'Orphan' },
  ];

  assert.deepStrictEqual(runMetrics.filterItemsByCreator(items, 'ann@contoso.com').map(i => i.name), ['Saved']);
  // Items captured without a UPN must still be reachable by display name.
  assert.deepStrictEqual(runMetrics.filterItemsByCreator(items, 'Ann').map(i => i.name), ['Saved']);
  assert.deepStrictEqual(runMetrics.filterItemsByCreator(items, 'bob@contoso.com').map(i => i.name), ['Live']);
  assert.deepStrictEqual(runMetrics.filterItemsByCreator(items, 'Cara').map(i => i.name), ['LegacyString']);
  assert.deepStrictEqual(runMetrics.filterItemsByCreator(items, 'nobody@contoso.com'), []);
  // No filter must never hide anything, including items with no creator at all.
  assert.strictEqual(runMetrics.filterItemsByCreator(items, null).length, 4);
});

test('the workspace page narrows to one creator when asked and shows everything otherwise', async () => {
  const db = require('../src/services/databaseService');
  const originalGet = db.getAnalysisRunById;
  db.getAnalysisRunById = async () => ({
    id: 3,
    started_at: '2024-05-01T10:00:00.000Z',
    results_json: JSON.stringify({
      workspaces: [{
        id: 'ws-1', name: 'Sales', users: [],
        items: [
          { id: 'item-1', name: 'AnnReport', type: 'Report', creator: { name: 'Ann', upn: 'ann@contoso.com' } },
          { id: 'item-2', name: 'BobReport', type: 'Report', creator: { name: 'Bob', upn: 'bob@contoso.com' } },
        ],
      }],
    }),
  });

  delete require.cache[require.resolve('../src/routes/workspaces')];
  const express = require('express');
  const testApp = express();
  testApp.use((req, res, next) => {
    res.locals.globalRun = { id: 3, sp_id: 1 };
    // Normally set by the app's auth middleware; the header partial needs it.
    res.locals.currentUser = null;
    res.locals.pagePath = req.path;
    next();
  });
  testApp.set('view engine', 'ejs');
  testApp.set('views', require('node:path').join(__dirname, '..', 'src', 'views'));
  testApp.use('/workspaces', require('../src/routes/workspaces'));
  const server = testApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path, headers: { host: '127.0.0.1' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });

  try {
    const filtered = await get('/workspaces/ws-1?creator=' + encodeURIComponent('ann@contoso.com'));
    assert.ok(filtered.includes('AnnReport'), 'the requested creator\'s item should be listed');
    assert.ok(!filtered.includes('BobReport'), 'another creator\'s item must be filtered out');
    assert.ok(filtered.includes('Showing only items created by'), 'the filter must be visible and clearable');

    const unfiltered = await get('/workspaces/ws-1');
    assert.ok(unfiltered.includes('AnnReport') && unfiltered.includes('BobReport'));
    assert.ok(!unfiltered.includes('Showing only items created by'));
  } finally {
    server.close();
    db.getAnalysisRunById = originalGet;
    delete require.cache[require.resolve('../src/routes/workspaces')];
  }
});

// ── Coverage by group and business area ──
test('the dashboard counts rules and findings by group and business area', async () => {
  // The group total alone can hide a business area with no rules pointed at it,
  // which is the gap this panel exists to make visible.
  const { executed } = await withFakeSql(() => [], () => reconRepo.getDashboardData({}));
  const statements = executed.map(e => e.sql);

  const rulesByArea = statements.find(sql =>
    /FROM recon_rules/.test(sql) && /GROUP BY rule_group, /.test(sql));
  assert.ok(rulesByArea, 'expected a rules-by-group-and-area aggregate');
  assert.match(rulesByArea, /business_area/);
  assert.match(rulesByArea, /'\(unassigned\)'/);
  assert.match(rulesByArea, /SUM\(CASE WHEN status='active'/);

  const exceptionsByArea = statements.find(sql =>
    /FROM recon_exceptions/.test(sql) && /GROUP BY rule_group, /.test(sql));
  assert.ok(exceptionsByArea, 'expected an exceptions-by-group-and-area aggregate');
  assert.match(exceptionsByArea, /business_area/);
  assert.match(exceptionsByArea, /SUM\(CASE WHEN severity='high'/);
});

test('a business area filter narrows exceptions, and the unassigned line filters for absence', async () => {
  // The coverage panel reports rules with no business area under a placeholder, so
  // clicking that line must look for the absence, not for the literal text.
  const named = await withFakeSql(() => [], () =>
    reconRepo.listExceptions({ businessArea: 'Finance', openOnly: true }));
  assert.match(named.executed[0].sql, /business_area=@area/);
  assert.ok(named.executed[0].params.some(p => p.value === 'Finance'));

  const unassigned = await withFakeSql(() => [], () =>
    reconRepo.listExceptions({ businessArea: reconRepo.UNASSIGNED_BUSINESS_AREA, openOnly: true }));
  assert.match(unassigned.executed[0].sql, /business_area IS NULL OR LTRIM\(RTRIM\(business_area\)\)=''/);
  assert.ok(!unassigned.executed[0].params.some(p => p.value === reconRepo.UNASSIGNED_BUSINESS_AREA),
    'the placeholder must never be matched as a literal business area');

  // Listing, counting and bulk action must agree, or a bulk change applied to "the
  // whole filter" would hit more rows than the page was showing.
  const filters = { businessArea: 'Finance', ruleGroup: 'start_to_start', openOnly: true };
  const listed = await withFakeSql(() => [], () => reconRepo.listExceptions(filters));
  const acted = await withFakeSql(() => [], () => reconRepo.listExceptionsForAction(filters));
  const clauseOf = sql => sql
    .slice(sql.indexOf(' WHERE '), sql.indexOf(' ORDER BY ') === -1 ? undefined : sql.indexOf(' ORDER BY '))
    .replace(/ AND id > @after$/, '');
  assert.equal(clauseOf(listed.executed[0].sql), clauseOf(acted.executed[0].sql));
});

test('the coverage panel shows each business area under its group and the areas add up', async () => {
  const ejs = require('ejs');
  const fs = require('node:fs');
  const { RULE_GROUP_DEFS, ruleGroupLabel } = require('../src/services/reconciliationService');
  const { RECONCILIATION_HELP } = require('../src/services/qualityGuideService');
  const file = 'src/views/reconciliation/dashboard.ejs';
  const group = RULE_GROUP_DEFS[0].key;

  const html = ejs.render(fs.readFileSync(file, 'utf8'), {
    title: 'R', user: null, currentUser: null,
    selectedRunId: null, ruleStatus: null, ruleGroup: null,
    outcomeDefs: [], statusDefs: [], helpTopic: RECONCILIATION_HELP,
    ruleGroupDefs: RULE_GROUP_DEFS, ruleGroupLabel,
    runs: [], rulesOverview: [], orphanedExceptions: 0, error: null,
    data: {
      rules: [], exceptionsByStatus: [], exceptionsByOutcome: [], exceptionsBySeverity: [],
      byRule: [], byOwner: [], recentRuns: [], problems: [],
      ageing: { week1: 0, month1: 0, older: 0 }, scoped: false, scopedRun: null,
      byGroup: [{ rule_group: group, total: 7, high: 2 }],
      rulesByGroup: [{ rule_group: group, total: 5, active: 4 }],
      rulesByGroupArea: [
        { rule_group: group, business_area: 'Finance', total: 3, active: 3 },
        { rule_group: group, business_area: '(unassigned)', total: 2, active: 1 },
      ],
      byGroupArea: [
        { rule_group: group, business_area: 'Finance', total: 5, high: 2 },
        { rule_group: group, business_area: '(unassigned)', total: 2, high: 0 },
      ],
    },
  }, { filename: file });

  const start = html.indexOf('Coverage by Group of Rules');
  const table = html.slice(start, html.indexOf('</table>', start));

  assert.match(table, /Business area/, 'the panel must expose the business area dimension');
  assert.match(table, /Finance/);
  assert.match(table, /\(unassigned\)/, 'rules with no business area must stay countable');
  // Each area line drills through carrying both dimensions, not just the group.
  assert.match(table, new RegExp('ruleGroup=' + group + '&businessArea=Finance'));

  // The area lines must reconcile with the group line above them, otherwise the
  // split invites exactly the wrong conclusion about coverage.
  const cells = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(row =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map(c => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()));
  const areaRows = cells.filter(r => r.length === 7 && /Finance|\(unassigned\)/.test(r[1]));
  assert.equal(areaRows.length, 2);
  assert.equal(areaRows.reduce((sum, r) => sum + Number(r[2]), 0), 5, 'area rule counts must equal the group total');
  assert.equal(areaRows.reduce((sum, r) => sum + Number(r[4]), 0), 7, 'area finding counts must equal the group total');
});

test('the workspace detail view renders inline scripts that actually parse', async () => {
  // A broken declaration in one inline script block kills every function defined
  // in it, so the Security tab's "Refresh from Fabric API" button silently does
  // nothing with only a console error to show for it.
  const ejs = require('ejs');
  const fs = require('node:fs');
  const vm = require('node:vm');
  const file = 'src/views/workspaces/detail.ejs';

  const html = ejs.render(fs.readFileSync(file, 'utf8'), {
    title: 'WS', user: null, currentUser: null,
    workspace: { id: '11111111-2222-3333-4444-555555555555', name: 'WS' },
    items: [], reports: [], datasets: [], dashboards: [], dataflows: [],
    lakehouses: [], notebooks: [], pipelines: [], warehouses: [], others: [],
    users: [], sourceRun: { id: 1, started_at: new Date().toISOString() },
    lockRunSelector: false, lockedRun: null,
  }, { filename: file });

  const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0, 'expected inline script blocks');
  for (const [index, code] of blocks.entries()) {
    assert.doesNotThrow(() => new vm.Script(code), `inline script block ${index} does not parse`);
  }
  assert.ok(html.includes('loadFabricRoles'), 'the refresh handler should be defined');
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
