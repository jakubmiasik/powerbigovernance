/* eslint-disable no-unused-vars */
const {
  assert, http, test, app, request, postJson, convertScheduleToUtc, scheduler, runMetrics, workspaceDeletion, dbService, stubDeletionDb, sampleRun, tenantRun, pbi, httpError, itemDetails, stubPbi, insights, SCAN_DATE, ws, findingKeys, dbPrivate, httpErrors, pipelineService, requireAuth, recon, INVOICE_RULE, runProgress, progressThrough, sqlSource, reconCompare, RUN_A, RUN_B, finding, reconRepo, fakeSqlPrimitives, withFakeSql, mdm, PERSON_FIELDS, personRecord, SURVIVOR_MODEL, survivorRecords, CUSTOMER_MODEL, RAW_CUSTOMERS, analysisModel, SCAN_RESULT, guide, jobProgress, workspaceAccess, analysisScope, scheduleDue, ACCESS_FIXTURE, analysisLauncher, analysisScheduleService, DUE_DAILY, namingService, NAMING, withServer, securityGroups, sgMapping, sgRepo, perms, sections, TENANTS, resolveFor, permMiddleware, fakeRes, withFakeDirectory, SOFTWAREONE, OTHER_TENANT, outcomeFixture, buildFixtureOutcome, compareFixture, compareResponse,
} = require('./support');


// ── Which workspaces the service principal cannot reach ──
//
// A scan reads the admin APIs, which see every workspace whether the principal is
// a member or not. It can say who the scan observed holding access; it cannot say
// what the principal can reach right now, and a grant made since the scan would
// not show up at all. So this is asked live.

test('the workspaces missing access are the difference between two live lists', () => {
  const result = workspaceAccess.missingServicePrincipalAccess(
    [
      { id: 'ws-1', displayName: 'Finance' },
      { id: 'ws-2', displayName: 'Marketing' },
      { id: 'ws-3', name: 'Sales Ops' },
    ],
    // What the principal itself can see. Case differs from the admin list, as the
    // two endpoints do not agree on it.
    [{ id: 'WS-1' }]
  );

  assert.equal(result.total, 3);
  assert.equal(result.withAccess, 1);
  assert.deepEqual(result.missing.map(w => w.name), ['Marketing', 'Sales Ops']);
  // The id is carried through as the tenant spelled it, because it is what the
  // grant call posts back.
  assert.deepEqual(result.missing.map(w => w.id), ['ws-2', 'ws-3']);
});

test('personal and deleted workspaces are left out of the list entirely', () => {
  // A service principal cannot be added to a personal workspace at all, and a
  // deleted or deleting one is on its way out. Offering either produces a failure
  // nobody can fix, so neither is offered.
  const result = workspaceAccess.missingServicePrincipalAccess(
    [
      { id: 'w', displayName: 'Finance' },
      { id: 'p', displayName: 'Personal of Ann', type: 'PersonalGroup' },
      { id: 'd', displayName: 'Old', state: 'Deleted' },
      { id: 'r', displayName: 'Archive', state: 'Removing' },
      { id: 'g', displayName: 'Going', state: 'Deleting' },
    ],
    []
  );
  assert.deepEqual(result.missing.map(w => w.id), ['w']);
  // Counted rather than silently dropped: "12 of 40 unreachable" beside a list of
  // 9 would look like a bug rather than like workspaces nothing can be done about.
  assert.equal(result.skipped, 4);
  assert.equal(result.total, 5);
});

test('a workspace with no state at all is treated as live', () => {
  // The Fabric endpoint does not return a state for ordinary workspaces, and
  // reading its absence as "deleted" would hide most of the tenant.
  const result = workspaceAccess.missingServicePrincipalAccess([{ id: 'a', displayName: 'Finance' }], []);
  assert.equal(result.missing.length, 1);
  assert.equal(result.skipped, 0);
  assert.equal(workspaceAccess.isRetiredWorkspace({ id: 'a' }), false);
  assert.equal(workspaceAccess.isRetiredWorkspace({ state: 'Active' }), false);
  assert.equal(workspaceAccess.isRetiredWorkspace({ state: 'deleted' }), true);
});

test('a duplicated workspace is offered once, not twice', () => {
  const result = workspaceAccess.missingServicePrincipalAccess(
    [{ id: 'a', displayName: 'Finance' }, { id: 'a', displayName: 'Finance again' }, { id: '' }],
    []
  );
  assert.equal(result.total, 1);
  assert.equal(result.missing.length, 1);
});

test('reaching everything leaves nothing to grant, and reaching nothing leaves all of it', () => {
  const all = [{ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' }];
  assert.deepEqual(workspaceAccess.missingServicePrincipalAccess(all, all).missing, []);
  assert.equal(workspaceAccess.missingServicePrincipalAccess(all, []).missing.length, 2);
  assert.equal(workspaceAccess.missingServicePrincipalAccess(all, [{ id: 'a' }]).withAccess, 1);
  // Nothing at all is an empty answer, not a crash.
  assert.deepEqual(workspaceAccess.missingServicePrincipalAccess(null, null),
    { total: 0, withAccess: 0, skipped: 0, personalLikely: 0, missing: [] });
});

test('the access check asks the tenant, not a scan', async () => {
  const original = { getServicePrincipals: dbService.getServicePrincipals, createPowerBIService: pbi.createPowerBIService };
  const calls = [];
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't', enterprise_app_object_id: 'sp1' }];
  pbi.createPowerBIService = () => ({
    getWorkspaces: async () => { calls.push('all'); return [{ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' }]; },
    getMyWorkspaces: async () => { calls.push('mine'); return [{ id: 'a' }]; },
  });

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = await postJson(server, '/settings/access/check', { spId: 1 });
    assert.equal(body.success, true);
    assert.equal(body.total, 2);
    assert.equal(body.withAccess, 1);
    assert.deepEqual(body.missing.map(w => w.id), ['b']);
    assert.equal(body.objectIdKnown, true);
    assert.ok(body.checkedAt, 'the answer is dated, because it is a point-in-time reading');
    // Two calls whatever the size of the tenant — not one per workspace.
    assert.deepEqual(calls, ['all', 'mine']);
  } finally {
    Object.assign(dbService, { getServicePrincipals: original.getServicePrincipals });
    pbi.createPowerBIService = original.createPowerBIService;
    await new Promise(resolve => server.close(resolve));
  }
});

test('the check says when the principal has no object id to grant with', async () => {
  // Without one nothing can be added, and saying so after forty workspaces have
  // been chosen is too late.
  const original = { getServicePrincipals: dbService.getServicePrincipals, createPowerBIService: pbi.createPowerBIService };
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't', enterprise_app_object_id: null }];
  pbi.createPowerBIService = () => ({ getWorkspaces: async () => [{ id: 'a' }], getMyWorkspaces: async () => [] });

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const body = await postJson(server, '/settings/access/check', {});
    assert.equal(body.objectIdKnown, false);
  } finally {
    Object.assign(dbService, { getServicePrincipals: original.getServicePrincipals });
    pbi.createPowerBIService = original.createPowerBIService;
    await new Promise(resolve => server.close(resolve));
  }
});

test('the grant section lists nothing until the tenant has been asked', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/access/index.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/settings/access',
    breadcrumb: [], availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Grant Access',
    accessLevels: workspaceAccess.ACCESS_LEVELS, principalTypes: workspaceAccess.PRINCIPAL_TYPES,
    fabricRoles: workspaceAccess.FABRIC_ROLES,
    accessLevel: workspaceAccess.accessLevel, principalTypeLabel: workspaceAccess.principalTypeLabel,
    describeScope: analysisScope.describeScope, scopeFromRow: analysisScope.scopeFromRow,
    overview: workspaceAccess.buildAccessOverview(ACCESS_FIXTURE), indexed: true, error: null,
    grantAuth: false, partialScope: false, runs: [],
    run: { id: 9, started_at: '2026-08-01T00:00:00Z', scope_kind: 'tenant' },
    servicePrincipals: [{ id: 1, name: 'SP', tenant_id: 'tid', enterprise_app_object_id: 'sp1' }],
  });

  // The list is hidden and empty on load — asking the tenant costs API calls, so
  // it happens when the operator asks for it.
  assert.match(html, /id="missingAccessPanel" *class="[^"]*d-none|class="mt-3 d-none" id="missingAccessPanel"/);
  assert.match(html, /Not checked yet/);
  assert.match(html, /onclick="checkServicePrincipalAccess\(\)"/);
  assert.match(html, /Checked live, not read from a scan/);

  // The modal it replaced is gone: two lists of workspaces that could disagree
  // about the same question is exactly what this change removes.
  assert.doesNotMatch(html, /grantAccessModal/);
  assert.doesNotMatch(html, /openGrantAccess/);

  // "Who has access to what" is unchanged — that view is what the scan observed.
  assert.match(html, /Who Has Access to What/);
  assert.match(html, /id="grantsTable"/);
});

test('a code already in the name is never repeated as description', () => {
  // Reported: a pipeline named DE_PL_100_LOAD_ALL_TABLES was suggested as
  // DF_PL_100_DE_LOAD_ALL_TABLES. The DE is an experience code — the wrong one for
  // a pipeline, which is why the fix is DF — and stripping only the *expected*
  // code left it behind to be read as business text.
  assert.equal(
    namingService.suggestName({ name: 'DE_PL_100_LOAD_ALL_TABLES', type: 'DataPipeline' }, NAMING),
    'DF_PL_100_LOAD_ALL_TABLES');

  // Any configured code counts, wherever it sits and whichever segment it belongs
  // to: a token that is a code in this convention was meant as one.
  assert.equal(namingService.suggestName({ name: '100_DE_LOAD_ALL_TABLES', type: 'DataPipeline' }, NAMING), 'DF_PL_100_LOAD_ALL_TABLES');
  assert.equal(namingService.suggestName({ name: 'LH_100_LOAD_ALL_TABLES', type: 'DataPipeline' }, NAMING), 'DF_PL_100_LOAD_ALL_TABLES');
  assert.equal(namingService.suggestName({ name: 'DS_SALES', type: 'Lakehouse' }, NAMING), 'DE_LH_SALES');

  // A name that is nothing but codes has no description left, and says so rather
  // than producing a name with a part missing.
  assert.equal(namingService.suggestName({ name: 'DF_PL', type: 'DataPipeline' }, NAMING), 'DF_PL_RENAME_ME');

  // The cases that already worked keep working.
  assert.equal(namingService.suggestName({ name: 'Sales Bronze Lakehouse', type: 'Lakehouse' }, NAMING), 'DE_LH_BRONZE_SALES');
  assert.equal(namingService.suggestName({ name: 'Finance DW', type: 'Warehouse' }, NAMING), 'DW_WH_FINANCE');
});

test('only the codes this convention actually defines are stripped', () => {
  // A convention with a short code list must not strip words that are codes in
  // some other convention — the stripping is defined by what is configured.
  const narrow = namingService.normalizeConvention({
    ...NAMING,
    experiences: [{ code: 'DF', label: 'Data Factory' }],
    artifacts: [{ code: 'PL', label: 'Pipeline', experience: 'DF', itemTypes: ['DataPipeline'] }],
  });
  // DE is not a code here, so it stays as description.
  assert.equal(namingService.suggestName({ name: 'DE_LOAD_ALL', type: 'DataPipeline' }, narrow), 'DF_PL_DE_LOAD_ALL');
});

test('an interrupted grant is remembered across the administrator sign-in', async () => {
  // Otherwise the operator picks workspaces, is sent away to authorize, comes back
  // to an empty page and has to pick them all again — the second time being the
  // only one that does anything.
  const original = { getServicePrincipals: dbService.getServicePrincipals, getAnalysisRuns: dbService.getAnalysisRuns };
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't', enterprise_app_object_id: 'sp1' }];
  dbService.getAnalysisRuns = async () => [];

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const { port } = server.address();
    // The session cookie is what carries the stash, so the two calls have to share one.
    const stored = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ spId: '1', workspaceIds: ['ws-2', ' ws-3 ', '', null] });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/settings/access/pending', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let text = '';
        res.on('data', c => { text += c; });
        res.on('end', () => resolve({ body: JSON.parse(text), cookie: (res.headers['set-cookie'] || [])[0] }));
      });
      req.on('error', reject);
      req.end(body);
    });

    // Blanks are dropped and ids are trimmed before anything is remembered.
    assert.equal(stored.body.success, true);
    assert.equal(stored.body.stored, 2);
    assert.ok(stored.cookie, 'a session is needed to remember anything');

    const get = query => new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1', port, path: '/settings/access' + query,
        headers: { Cookie: stored.cookie.split(';')[0] },
      }, res => {
        let text = '';
        res.on('data', c => { text += c; });
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });

    const resumed = await get('?grantAuth=success');
    assert.match(resumed, /var pendingGrant = \{"spId":"1","workspaceIds":\["ws-2","ws-3"\]\}/);

    // Handed back exactly once: a refresh must not grant the same workspaces again.
    const refreshed = await get('?grantAuth=success');
    assert.match(refreshed, /var pendingGrant = null/);
  } finally {
    Object.assign(dbService, original);
    await new Promise(resolve => server.close(resolve));
  }
});

test('a stash is only acted on when the sign-in actually succeeded', async () => {
  // An abandoned attempt leaves one behind; picking it up on an ordinary visit
  // would grant workspaces nobody asked for at that moment.
  const original = { getServicePrincipals: dbService.getServicePrincipals, getAnalysisRuns: dbService.getAnalysisRuns };
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't', enterprise_app_object_id: 'sp1' }];
  dbService.getAnalysisRuns = async () => [];

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const { port } = server.address();
    const stored = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ spId: '1', workspaceIds: ['ws-9'] });
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/settings/access/pending', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let text = '';
        res.on('data', c => { text += c; });
        res.on('end', () => resolve({ cookie: (res.headers['set-cookie'] || [])[0] }));
      });
      req.on('error', reject);
      req.end(body);
    });

    const plain = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1', port, path: '/settings/access',
        headers: { Cookie: stored.cookie.split(';')[0] },
      }, res => {
        let text = '';
        res.on('data', c => { text += c; });
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    assert.match(plain, /var pendingGrant = null/);
  } finally {
    Object.assign(dbService, original);
    await new Promise(resolve => server.close(resolve));
  }
});

// ── Personal workspaces, workspace status, and granting roles ──────────────────
//
// A workspace that belongs to one person is not a workspace governance can
// manage: a confirmed personal one takes no members at all, and one merely named
// after a person is somebody's private working area holding organisational
// content. The distinction between those two is the whole point — the first is a
// fact from the API, the second is a guess from a name, and presenting a guess as
// a fact is how a legitimate workspace ends up excluded from a grant.

test('the API saying PersonalGroup is a fact; a name that reads like a person is not', () => {
  const confirmed = workspaceAccess.classifyWorkspacePersonal({ name: 'Ann Smith', type: 'PersonalGroup' });
  assert.equal(confirmed.personal, true);
  assert.equal(confirmed.confidence, 'confirmed');
  assert.equal(confirmed.grantable, false, 'a personal workspace rejects every member add');

  const guessed = workspaceAccess.classifyWorkspacePersonal({ name: 'Ann Smith' });
  assert.equal(guessed.personal, true);
  assert.equal(guessed.confidence, 'likely');
  assert.equal(guessed.grantable, true, 'refusing to grant on a guess blocks work nothing else can do');
  assert.match(guessed.reasons[0], /Named after a person/);
});

test('a mailbox for a name is personal; a subject area is not', () => {
  assert.equal(workspaceAccess.classifyWorkspacePersonal({ name: 'ann.smith@contoso.com' }).personal, true);

  // The false positives that matter: two capitalized words that are a subject
  // area, an acronym, anything with a digit, and a single word.
  for (const name of ['Finance Reporting', 'Global Sales', 'EMEA Sales', 'DWH Prod', 'Finance 2026', 'Finance', 'Sales_Ops']) {
    assert.equal(workspaceAccess.classifyWorkspacePersonal({ name }).personal, false, name + ' is not a person');
  }
});

test('nobody holding Admin is evidence a workspace is somebody\'s own, but only when the list was read', () => {
  const noAdmin = workspaceAccess.classifyWorkspacePersonal({ name: 'Project Alpha', adminCount: 0, usersReadable: true });
  assert.equal(noAdmin.personal, true);
  assert.match(noAdmin.reasons[0], /Nobody holds Admin/);

  // "We could not see who holds Admin" is the opposite claim to "nobody does".
  const unreadable = workspaceAccess.classifyWorkspacePersonal({ name: 'Project Alpha', adminCount: null, usersReadable: false });
  assert.equal(unreadable.personal, false);
});

test('workspace status names what the API said, including states it has not heard of', () => {
  assert.equal(workspaceAccess.workspaceStatus({ state: 'Active' }).key, 'active');
  assert.equal(workspaceAccess.workspaceStatus({ state: 'Deleted' }).key, 'deleted');
  assert.equal(workspaceAccess.workspaceStatus({ state: 'Removing' }).key, 'removing');
  assert.equal(workspaceAccess.workspaceStatus({ state: 'Orphaned' }).key, 'orphaned');
  assert.equal(workspaceAccess.workspaceStatus({ type: 'PersonalGroup' }).key, 'personal');
  // No state is not a state. The Fabric endpoint returns none for live workspaces.
  assert.equal(workspaceAccess.workspaceStatus({}).key, 'unknown');
  assert.equal(workspaceAccess.workspaceStatus({ state: 'Provisioning' }).label, 'Provisioning');
});

test('the access overview carries a status and a personal verdict for every workspace', () => {
  const overview = workspaceAccess.buildAccessOverview(ACCESS_FIXTURE);

  const finance = overview.workspaces.find(w => w.workspaceId === 'ws-1');
  assert.equal(finance.status.key, 'active');
  assert.equal(finance.personal.personal, false);

  // Nobody administers this one, which is the supporting signal.
  const orphan = overview.workspaces.find(w => w.workspaceId === 'ws-2');
  assert.equal(orphan.personal.personal, true);
  assert.match(orphan.personal.reasons.join(' '), /Nobody holds Admin/);

  // Unreadable: no user data, so no verdict drawn from user data.
  const marketing = overview.workspaces.find(w => w.workspaceId === 'ws-3');
  assert.equal(marketing.personal.personal, false);

  assert.equal(overview.totals.personal, 1);
  assert.equal(overview.totals.personalConfirmed, 0);
});

test('the live check annotates what it offers rather than dropping it', () => {
  const result = workspaceAccess.missingServicePrincipalAccess(
    [
      { id: 'a', displayName: 'Finance Reporting' },
      { id: 'b', displayName: 'Anna Nowak' },
      { id: 'c', displayName: 'Ann Smith', type: 'PersonalGroup' },
    ],
    []
  );

  // The confirmed personal one is skipped — nothing can be granted on it. The one
  // that merely reads like a person is still offered, with the reason attached.
  // Sorted by name, so "Anna Nowak" comes before "Finance Reporting".
  assert.deepEqual(result.missing.map(w => w.id), ['b', 'a']);
  assert.equal(result.skipped, 1);
  assert.equal(result.personalLikely, 1);

  const anna = result.missing.find(w => w.id === 'b');
  assert.equal(anna.personal.personal, true);
  assert.match(anna.personal.reasons[0], /Named after a person/);
  assert.equal(anna.status.key, 'unknown', 'the tenant listing reports no state for a live workspace');
});

test('access held only by named people is a finding; a security group clears it', () => {
  const result = insights.computeWorkspaceInsights({
    workspaces: [
      ws({ name: 'ByPeople', users: [
        { name: 'Ann', email: 'ann@x.com', role: 'Admin', type: 'User' },
        { name: 'Bob', email: 'bob@x.com', role: 'Admin', type: 'User' },
      ] }),
      ws({ name: 'ByGroup', users: [
        { name: 'Ann', email: 'ann@x.com', role: 'Admin', type: 'User' },
        { name: 'Bob', email: 'bob@x.com', role: 'Admin', type: 'User' },
        { name: 'BI Admins', role: 'Member', type: 'Group' },
      ] }),
    ],
  }, { referenceDate: SCAN_DATE });

  assert.ok(findingKeys(result, 'ByPeople').includes('personalAccess'));
  assert.ok(!findingKeys(result, 'ByGroup').includes('personalAccess'));

  const detail = result.workspaces.find(w => w.name === 'ByPeople').findings
    .find(f => f.key === 'personalAccess').detail;
  assert.match(detail, /2 individual account\(s\)/);
  assert.match(detail, /Ann/);
});

test('a workspace whose access could not be read is not accused of lacking a group', () => {
  // No user list is a gap in the evidence, not an access model made of people.
  const result = insights.computeWorkspaceInsights({
    workspaces: [ws({ name: 'Unreadable', users: [] })],
  }, { referenceDate: SCAN_DATE });
  assert.ok(!findingKeys(result, 'Unreadable').includes('personalAccess'));
});

test('the risk score is the sum of the weights of what was found', () => {
  const result = insights.computeWorkspaceInsights({
    workspaces: [ws({ name: 'Bad', users: [{ name: 'Bob', email: 'b@x.com', role: 'Viewer', type: 'User' }] })],
  }, { referenceDate: SCAN_DATE });

  const bad = result.workspaces.find(w => w.name === 'Bad');
  assert.equal(bad.score, bad.findings.reduce((sum, f) => sum + f.weight, 0),
    'the number on the badge has to be the sum of the rows behind it');
  assert.equal(bad.band.key, insights.riskBand(bad.score).key);

  // The bands are read off the total, not off the worst single finding.
  assert.equal(insights.riskBand(0).key, 'clean');
  assert.equal(insights.riskBand(1).key, 'low');
  assert.equal(insights.riskBand(35).key, 'medium');
  assert.equal(insights.riskBand(80).key, 'high');
  assert.equal(insights.riskBand(150).key, 'critical');

  // The page explains the score from these, so they have to reach it.
  assert.ok(result.riskBands.length);
  assert.equal(result.maxScore, insights.FINDING_DEFS.reduce((sum, def) => sum + def.weight, 0));
});

test('the role page names the roles, explains the Admin requirement and links the group guide', async () => {
  const original = dbService.getServicePrincipals;
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 'tid' }];
  try {
    const html = await withServer(server => request(server, '/settings/access/roles').then(r => r.body));
    for (const role of ['Admin', 'Member', 'Contributor', 'Viewer']) {
      assert.match(html, new RegExp('>' + role + '<'), role + ' has to be offered');
    }
    // The one thing that makes this page fail in practice, said before it does.
    assert.match(html, /workspace Admin/);
    // Designing the groups comes before granting them anything, and that guidance
    // is a page in this application rather than a link off it.
    assert.match(html, /\/quality\/security-groups/);
  } finally {
    dbService.getServicePrincipals = original;
  }
});

test('the workspaces offered are the live ones, with the last scan marking where it is Admin', async () => {
  const original = {
    getServicePrincipals: dbService.getServicePrincipals,
    getAnalysisRuns: dbService.getAnalysisRuns,
    createPowerBIService: pbi.createPowerBIService,
  };
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't', enterprise_app_object_id: 'sp1' }];
  dbService.getAnalysisRuns = async () => [];
  pbi.createPowerBIService = () => ({
    getMyWorkspaces: async () => [
      { id: 'w1', name: 'Finance' },
      { id: 'w2', name: 'Ann Smith', type: 'PersonalGroup' },
      { id: 'w3', name: 'Old', state: 'Deleted' },
      { id: 'w4', name: 'Anna Nowak' },
    ],
  });

  try {
    const body = await withServer(async server => {
      const res = await request(server, '/settings/access/roles/candidates?spId=1');
      return JSON.parse(res.body);
    });

    assert.equal(body.success, true);
    // Nothing can be granted in a personal workspace and nothing should be granted
    // in a deleted one, so neither is offered.
    assert.deepEqual(body.workspaces.map(w => w.id), ['w4', 'w1']);
    // The one named after a person is offered, with the reason attached.
    assert.equal(body.workspaces.find(w => w.id === 'w4').personal.personal, true);
    // No scan to read roles from is said plainly rather than reported as "none".
    assert.equal(body.rolesFromScan, false);
  } finally {
    Object.assign(dbService, {
      getServicePrincipals: original.getServicePrincipals,
      getAnalysisRuns: original.getAnalysisRuns,
    });
    pbi.createPowerBIService = original.createPowerBIService;
  }
});

test('a 403 reading role assignments is reported as "not an Admin there", not as a status code', async () => {
  const original = {
    getServicePrincipals: dbService.getServicePrincipals,
    createPowerBIService: pbi.createPowerBIService,
  };
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't' }];
  pbi.createPowerBIService = () => ({
    getRoleAssignments: async () => {
      const err = new Error('Request failed with status code 403');
      err.response = { status: 403 };
      throw err;
    },
  });

  try {
    const body = await withServer(async server => {
      const res = await request(server, '/settings/access/roles/w1/assignments?spId=1');
      return JSON.parse(res.body);
    });
    assert.equal(body.success, false);
    assert.equal(body.canManage, false, 'the failure is the answer to "can it manage roles here"');
    assert.match(body.message, /not an Admin/);
  } finally {
    dbService.getServicePrincipals = original.getServicePrincipals;
    pbi.createPowerBIService = original.createPowerBIService;
  }
});

test('role assignments are flattened so the page can show who the principal is', async () => {
  const original = {
    getServicePrincipals: dbService.getServicePrincipals,
    createPowerBIService: pbi.createPowerBIService,
  };
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't' }];
  pbi.createPowerBIService = () => ({
    getRoleAssignments: async () => [
      { id: 'ra1', role: 'Admin', principal: { id: 'u1', type: 'User', displayName: 'Ann', userDetails: { userPrincipalName: 'ann@x.com' } } },
      { id: 'ra2', role: 'Viewer', principal: { id: 'g1', type: 'Group', displayName: 'BI Readers', groupDetails: { email: 'bi@x.com' } } },
    ],
  });

  try {
    const body = await withServer(async server => {
      const res = await request(server, '/settings/access/roles/w1/assignments?spId=1');
      return JSON.parse(res.body);
    });
    assert.equal(body.success, true);
    // The identifier is nested differently per principal type; the page should not
    // have to know that.
    assert.deepEqual(body.assignments.map(a => a.detail), ['ann@x.com', 'bi@x.com']);
    assert.deepEqual(body.assignments.map(a => a.role), ['Admin', 'Viewer']);
  } finally {
    dbService.getServicePrincipals = original.getServicePrincipals;
    pbi.createPowerBIService = original.createPowerBIService;
  }
});

test('granting a role posts the principal and role through, and refuses an unknown role', async () => {
  const original = {
    getServicePrincipals: dbService.getServicePrincipals,
    createPowerBIService: pbi.createPowerBIService,
  };
  const calls = [];
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't' }];
  pbi.createPowerBIService = () => ({
    addRoleAssignment: async (...args) => { calls.push(args); return {}; },
  });

  try {
    await withServer(async server => {
      const granted = await postJson(server, '/settings/access/roles/w1',
        { spId: 1, principalId: 'g1', principalType: 'Group', role: 'Contributor' });
      assert.equal(granted.success, true);
      assert.deepEqual(calls[0], ['w1', 'g1', 'Group', 'Contributor']);

      // A role the API does not have would fail at the far end with nothing useful
      // said; it is refused here instead.
      const bogus = await postJson(server, '/settings/access/roles/w1',
        { spId: 1, principalId: 'g1', principalType: 'Group', role: 'Owner' });
      assert.equal(bogus.success, false);
      assert.match(bogus.message, /Unknown role/);

      const incomplete = await postJson(server, '/settings/access/roles/w1', { spId: 1, role: 'Viewer' });
      assert.equal(incomplete.success, false);
      assert.equal(calls.length, 1, 'nothing is posted for an incomplete form');
    });
  } finally {
    dbService.getServicePrincipals = original.getServicePrincipals;
    pbi.createPowerBIService = original.createPowerBIService;
  }
});

test('a mail group is found and offered, with a nudge towards a security group', async () => {
  const original = {
    getServicePrincipals: dbService.getServicePrincipals,
    createPowerBIService: pbi.createPowerBIService,
  };
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't' }];
  pbi.createPowerBIService = () => ({
    searchEntraGroups: async () => [
      { id: 'g1', displayName: 'BI Readers', securityEnabled: true },
      { id: 'g2', displayName: 'BI Newsletter', securityEnabled: false },
    ],
  });

  try {
    const body = await withServer(async server => {
      const res = await request(server, '/settings/access/roles/entra/search?q=BI&type=Group&spId=1');
      return JSON.parse(res.body);
    });
    // Fabric accepts these, so the choice stays open — the mail group is marked
    // rather than blocked. Claiming it cannot hold a role would be wrong.
    assert.deepEqual(body.results.map(r => r.usable), [true, true]);
    assert.equal(body.results[0].warning, null);
    assert.match(body.results[1].warning, /Prefer a security group/);
  } finally {
    dbService.getServicePrincipals = original.getServicePrincipals;
    pbi.createPowerBIService = original.createPowerBIService;
  }
});

test('a one-character search does not reach Entra ID at all', async () => {
  const original = {
    getServicePrincipals: dbService.getServicePrincipals,
    createPowerBIService: pbi.createPowerBIService,
  };
  let searched = false;
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't' }];
  pbi.createPowerBIService = () => ({ searchEntraUsers: async () => { searched = true; return []; } });

  try {
    const body = await withServer(async server => {
      const res = await request(server, '/settings/access/roles/entra/search?q=a&spId=1');
      return JSON.parse(res.body);
    });
    assert.deepEqual(body.results, []);
    assert.equal(searched, false, 'a prefix search on one character returns most of the directory');
  } finally {
    dbService.getServicePrincipals = original.getServicePrincipals;
    pbi.createPowerBIService = original.createPowerBIService;
  }
});

test('the triage page explains the risk score rather than asking for it to be trusted', async () => {
  const ejs = require('ejs');
  const computed = insights.computeWorkspaceInsights({
    workspaces: [{
      id: 'a', name: 'Solo', state: 'Active', items: [],
      users: [{ name: 'Ann', email: 'ann@x.com', role: 'Admin', type: 'User' }],
    }],
  }, { referenceDate: SCAN_DATE });

  const html = await ejs.renderFile('src/views/workspaces/list.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/workspaces', breadcrumb: [],
    availableRuns: [], globalRun: null, title: 'Workspaces', fromSavedData: true, run: null,
    insights: computed, findingDefs: insights.FINDING_DEFS, namingPattern: null,
  });

  // How the number is arrived at, what it is out of, and what a given number means.
  assert.match(html, /How the Risk score works/);
  assert.match(html, /adds its weight/);
  assert.match(html, new RegExp('is ' + computed.maxScore));
  for (const band of computed.riskBands) assert.match(html, new RegExp('>\\s*' + band.label));

  // Every check, with its weight, so the sum can be checked by hand.
  for (const def of insights.FINDING_DEFS) assert.match(html, new RegExp('\\+' + def.weight + '<'));

  // And the score on the row spells out its own arithmetic.
  const solo = computed.workspaces[0];
  assert.match(html, new RegExp('title="' + solo.band.label + ' risk — ' + solo.score + ' = '));
});

test('the access page shows workspace status, marks personal ones and offers the role page', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/access/index.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/settings/access',
    breadcrumb: [], availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Grant Access',
    accessLevels: workspaceAccess.ACCESS_LEVELS, principalTypes: workspaceAccess.PRINCIPAL_TYPES,
    fabricRoles: workspaceAccess.FABRIC_ROLES,
    accessLevel: workspaceAccess.accessLevel, principalTypeLabel: workspaceAccess.principalTypeLabel,
    describeScope: analysisScope.describeScope, scopeFromRow: analysisScope.scopeFromRow,
    overview: workspaceAccess.buildAccessOverview({
      workspaces: [
        { workspace_id: 'w1', name: 'Finance', state: 'Active', item_count: 2, users_readable: 1 },
        { workspace_id: 'w2', name: 'Ann Smith', type: 'PersonalGroup', state: 'Active', users_readable: 1 },
      ],
      grants: [
        { workspace_id: 'w1', principal_id: 'u1', principal_type: 'User', display_name: 'Ann', email: 'ann@x.com', access_right: 'Admin' },
      ],
    }),
    indexed: true, error: null, grantAuth: false, partialScope: false, runs: [],
    run: { id: 9, started_at: '2026-08-01T00:00:00Z', scope_kind: 'tenant' },
    servicePrincipals: [{ id: 1, name: 'SP', tenant_id: 'tid', enterprise_app_object_id: 'sp1' }],
  });

  assert.match(html, /<th>Status<\/th>/);
  assert.match(html, />Active</);
  // The personal one is named as such, and offers no way to grant a role in it.
  assert.match(html, />\s*personal\s*</);
  assert.match(html, /takes no members/);
  // The one that can take a role carries the button that grants one, beside its
  // name and opening over the table rather than navigating away from it.
  assert.match(html, /openRoleGrantModal\('w1', "Finance"\)/);
  assert.match(html, /id="roleGrantModal"/);
  assert.match(html, /Grant a user or group a role/);
});

test('the group plan is a group per role per environment, plus one for the applications', () => {
  const plan = securityGroups.securityGroupPlan({ domain: 'Finance', environments: ['dev', 'prod'] });

  assert.deepEqual(plan.groups.map(group => group.name), [
    'FAB-FINANCE-DEV-ADMIN', 'FAB-FINANCE-DEV-MEMBER', 'FAB-FINANCE-DEV-CONTRIBUTOR', 'FAB-FINANCE-DEV-VIEWER',
    'FAB-FINANCE-PROD-ADMIN', 'FAB-FINANCE-PROD-MEMBER', 'FAB-FINANCE-PROD-CONTRIBUTOR', 'FAB-FINANCE-PROD-VIEWER',
    // An application is one identity whatever environment it reads, so its group
    // is per domain rather than per environment.
    'FAB-FINANCE-SP',
  ]);

  // Every row says what to do with the group, not just what to call it.
  assert.ok(plan.groups.every(group => group.holds && group.assignTo));
  assert.match(plan.groups[0].assignTo, /DEV FINANCE/);
});

test('a domain nobody typed still produces a usable plan', () => {
  const plan = securityGroups.securityGroupPlan({});
  assert.equal(plan.domain, 'DOMAIN');
  assert.deepEqual(plan.environments, ['DEV', 'TEST', 'PROD']);
  assert.equal(plan.groups.length, 13, 'four roles across three environments, and the application group');
});

test('group names cannot carry whatever was typed into them', () => {
  // These names are pasted into a directory. A separator or a space arriving from
  // the form would produce a name that does not match the pattern it claims to.
  const plan = securityGroups.securityGroupPlan({
    domain: 'fin ance/2!', prefix: '  fab  ', environments: ['Pro d'], separator: '_',
  });
  assert.equal(plan.groups[0].name, 'FAB_FINANCE2_PROD_ADMIN');
  assert.equal(securityGroups.plainGroupList(plan).split('\n')[0], 'FAB_FINANCE2_PROD_ADMIN');
});

test('an environment list of nothing but noise still names the roles', () => {
  // Otherwise a stray comma in the form empties the plan, which reads as "no
  // groups are needed".
  const plan = securityGroups.securityGroupPlan({ domain: 'HR', environments: ['', '  ', '!!'] });
  assert.deepEqual(plan.groups.map(group => group.name), [
    'FAB-HR-ADMIN', 'FAB-HR-MEMBER', 'FAB-HR-CONTRIBUTOR', 'FAB-HR-VIEWER', 'FAB-HR-SP',
  ]);
});

test('the security group page is part of the application, and generates from the form', async () => {
  const html = await withServer(server =>
    request(server, '/quality/security-groups?domain=Finance&environments=DEV,PROD').then(r => r.body));

  assert.match(html, /FAB-FINANCE-PROD-CONTRIBUTOR/);
  // The reasoning, not just the names.
  assert.match(html, /Grant roles to groups, never to people/);
  assert.match(html, /Service principals allowed to use Fabric APIs/);
  // And the way back to acting on it.
  assert.match(html, /\/settings\/access\/roles/);
  // Nothing in the design tab touches the tenant, which it says rather than implies.
  assert.match(html, /Nothing in this tab reads or changes your tenant/);
});

test('the role panel is one panel, reached from the page and from the table', async () => {
  const ejs = require('ejs');
  const common = {
    user: { name: 'T' }, currentUser: { name: 'T' }, breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true,
    servicePrincipals: [{ id: 1, name: 'SP', tenant_id: 't', enterprise_app_object_id: 'sp1' }],
    fabricRoles: workspaceAccess.FABRIC_ROLES,
  };

  const page = await ejs.renderFile('src/views/access/roles.ejs', {
    ...common, currentPath: '/settings/access/roles', title: 'Grant Workspace Roles',
    accessLevels: workspaceAccess.ACCESS_LEVELS, workspaceId: null, error: null,
  });

  const table = await ejs.renderFile('src/views/access/index.ejs', {
    ...common, currentPath: '/settings/access', title: 'Grant Access',
    accessLevels: workspaceAccess.ACCESS_LEVELS, principalTypes: workspaceAccess.PRINCIPAL_TYPES,
    accessLevel: workspaceAccess.accessLevel, principalTypeLabel: workspaceAccess.principalTypeLabel,
    describeScope: analysisScope.describeScope, scopeFromRow: analysisScope.scopeFromRow,
    overview: workspaceAccess.buildAccessOverview(ACCESS_FIXTURE), indexed: true, error: null,
    grantAuth: false, partialScope: false, runs: [],
    run: { id: 9, started_at: '2026-08-01T00:00:00Z', scope_kind: 'tenant' },
  });

  // Both carry the same panel — two copies of it would drift within a release.
  for (const html of [page, table]) {
    assert.match(html, /function roleGrantOpen\(/);
    assert.match(html, /id="assignmentsBody"/);
    assert.match(html, /list-group-item list-group-item-action/,
      'search results are a list, not a stack of full-width outlined buttons');
  }

  // Each names the select holding the acting principal, and they are not the same
  // one: the page has a picker, the modal has its own.
  assert.match(page, /ROLE_GRANT_SP_SELECT = 'roleSpSelect'/);
  assert.match(table, /ROLE_GRANT_SP_SELECT = 'modalRoleSpSelect'/);

  // The grant button sits with the label it belongs to rather than at the foot of
  // the form.
  assert.match(page, /Grant a role<\/span>[\s\S]{0,400}id="grantRoleBtn"/);
});

test('a group name is stream, role and environment, and nothing that was typed by hand', () => {
  assert.equal(sgMapping.groupName('IBP', 'DE', 'DEV'), 'SG-IBP-DE-DEV');
  // These names are created in a directory and then matched against what is there,
  // so a stray space produces a name that does not match the pattern it claims to.
  assert.equal(sgMapping.groupName(' i b p ', 'de', 'dev'), 'SG-IBP-DE-DEV');
  assert.equal(sgMapping.groupName('', '', ''), 'SG-STREAM-ROLE-ENV');
});

test('production takes no builders, whatever their project role', () => {
  assert.equal(sgMapping.fabricRoleFor('IBP', 'DE', 'DEV').role, 'Contributor');
  assert.equal(sgMapping.fabricRoleFor('IBP', 'DE', 'TEST').role, 'Contributor');
  assert.equal(sgMapping.fabricRoleFor('IBP', 'DE', 'PROD').role, 'Viewer');
  assert.equal(sgMapping.fabricRoleFor('IBP', 'BI', 'PROD').role, 'Viewer');
  // The exception is the person who administers the platform.
  assert.equal(sgMapping.fabricRoleFor('IBP', 'ADMIN', 'PROD').role, 'Admin');
  // And the rule can be turned off, in which case a builder builds in production.
  assert.equal(sgMapping.fabricRoleFor('IBP', 'DE', 'PROD', { prodViewerNonAdmin: false }).role, 'Contributor');
});

test('project managers read and administrators administer, in every environment', () => {
  assert.equal(sgMapping.fabricRoleFor('IBP', 'PM', 'DEV').role, 'Viewer');
  assert.equal(sgMapping.fabricRoleFor('IBP', 'ADMIN', 'DEV').role, 'Admin');
  assert.equal(sgMapping.fabricRoleFor('IBP', 'UX', 'DEV').role, 'Contributor');
});

test('central platform work is granted across workspaces rather than within one stream', () => {
  const admin = sgMapping.fabricRoleFor('CORP', 'ADMIN', 'PROD');
  assert.equal(admin.role, 'Admin');
  assert.equal(admin.allWorkspaces, true);
  assert.equal(admin.label, 'Admin (All)');

  // And the production rule does not override it — CORP is decided first.
  const engineer = sgMapping.fabricRoleFor('CORP', 'DE', 'PROD');
  assert.equal(engineer.label, 'Contributor (All)');
  assert.equal(sgMapping.fabricRoleFor('CORP', 'PM', 'DEV').label, 'Viewer (All)');
});

test('an assignment with no environment covers development, not nothing', () => {
  // A row that grants nothing is never what was meant by leaving the boxes alone.
  assert.deepEqual(sgMapping.normalizeEnvironments([]), ['DEV']);
  assert.deepEqual(sgMapping.normalizeEnvironments(['prod', 'dev']), ['DEV', 'PROD'],
    'listed in the order work moves through them, not the order they were ticked');
  assert.deepEqual(sgMapping.normalizeEnvironments(['nonsense']), ['DEV']);
});

test('the same group gathers everyone the assignments put in it', () => {
  const mappingResult = sgMapping.buildMapping([
    { id: 1, name: 'Anna', stream: 'IBP', projectRole: 'DE', environments: ['DEV', 'PROD'] },
    { id: 2, name: 'Bob', stream: 'IBP', projectRole: 'DE', environments: ['DEV'] },
    { id: 3, name: 'Cleo', stream: 'CORP', projectRole: 'ADMIN', environments: ['PROD'] },
  ]);

  assert.deepEqual(mappingResult.groups.map(group => group.name),
    ['SG-CORP-ADMIN-PROD', 'SG-IBP-DE-DEV', 'SG-IBP-DE-PROD']);

  const dev = mappingResult.groups.find(group => group.name === 'SG-IBP-DE-DEV');
  assert.deepEqual(dev.members.map(member => member.name), ['Anna', 'Bob']);
  assert.equal(dev.fabricRole.role, 'Contributor');

  const prod = mappingResult.groups.find(group => group.name === 'SG-IBP-DE-PROD');
  assert.deepEqual(prod.members.map(member => member.name), ['Anna']);
  assert.equal(prod.fabricRole.role, 'Viewer');
});

test('the justification says what was decided and why, not just what was decided', () => {
  const why = sgMapping.personJustification(
    { name: 'Anna', stream: 'IBP', projectRole: 'DE', environments: ['DEV', 'PROD'] });
  assert.match(why, /Anna/);
  assert.match(why, /IBP/);
  assert.match(why, /Contributor \(DEV\)/);
  assert.match(why, /Viewer \(PROD\)/);

  const prodGroup = { stream: 'IBP', projectRole: 'DE', environment: 'PROD' };
  assert.match(sgMapping.groupJustification(prodGroup), /Production is read-only/);
});

test('a CSV keeps names that contain commas, and names the rows it could not read', () => {
  const parsed = sgMapping.parseMappingCsv([
    'Stream,Project Role,Name,Email,Environments',
    'IBP,DE,"Nowak, Anna",anna@x.com,DEV;PROD',
    'RGM,WIZARD,Bob,,TEST',
    ',DE,Nobody,,DEV',
    'IBP,DE,"Nowak, Anna",anna@x.com,DEV',
  ].join('\n'));

  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.assignments.map(a => a.name), ['Nowak, Anna', 'Bob']);
  assert.deepEqual(parsed.assignments[0].environments, ['DEV', 'PROD']);
  // An unknown project role still describes somebody who needs access.
  assert.equal(parsed.assignments[1].projectRole, 'OTHER');
  assert.ok(parsed.skipped.some(note => /Unknown project role/.test(note.reason)));
  // And the two that cannot be used are named rather than dropped in silence.
  assert.ok(parsed.skipped.some(note => /Needs both a stream and a name/.test(note.reason)));
  assert.ok(parsed.skipped.some(note => /Already in this file/.test(note.reason)));
});

test('a CSV without the columns it needs is refused, not half-read', () => {
  const parsed = sgMapping.parseMappingCsv('Person,Team\nAnna,IBP');
  assert.match(parsed.error, /Stream, Project Role and Name/);
  assert.deepEqual(parsed.assignments, []);
});

test('the export carries the derived columns, not only what was typed', () => {
  const csv = sgMapping.toMappingCsv([
    { name: 'Anna', email: 'a@x.com', stream: 'IBP', projectRole: 'DE', environments: ['DEV', 'PROD'] },
  ]);
  const [header, row] = csv.split('\n');
  assert.match(header, /Security Groups/);
  assert.match(row, /SG-IBP-DE-DEV;SG-IBP-DE-PROD/);
  assert.match(row, /Contributor \(DEV\);Viewer \(PROD\)/);

  // What went out comes back in.
  const back = sgMapping.parseMappingCsv(csv);
  assert.equal(back.assignments.length, 1);
  assert.deepEqual(back.assignments[0].environments, ['DEV', 'PROD']);
});

test('checking a workspace tells apart absent, wrong, unlinked and unreadable', () => {
  const roles = [
    { id: 'ra1', role: 'Contributor', principal: { id: 'G-1', type: 'Group', displayName: 'BI Builders' } },
  ];

  assert.equal(sgMapping.compareAssignment({ entraGroupId: 'g-1', intendedRole: 'Contributor' }, roles).state, 'present');
  const wrong = sgMapping.compareAssignment({ entraGroupId: 'g-1', intendedRole: 'Viewer' }, roles);
  assert.equal(wrong.state, 'wrong-role');
  assert.equal(wrong.actualRole, 'Contributor');
  assert.equal(sgMapping.compareAssignment({ entraGroupId: 'other', intendedRole: 'Viewer' }, roles).state, 'missing');
  // Never linked cannot be looked for, and is not the same as being absent.
  assert.equal(sgMapping.compareAssignment({ entraGroupId: null }, roles).state, 'unlinked');
  // And "could not read the workspace" is not the tenant disagreeing with you.
  assert.equal(sgMapping.compareAssignment({ entraGroupId: 'g-1' }, null).state, 'unreadable');

  const summary = sgMapping.summarizeChecks([
    { state: 'present' }, { state: 'missing' }, { state: 'wrong-role' }, { state: 'unreadable' },
  ]);
  assert.equal(summary.actionable, 2, 'only what somebody can act on');
  assert.equal(summary.total, 4);
});

test('saving a person creates the lookups, the assignment, its environments and its groups', async () => {
  // Lookup rows are created on demand because a tenant invents streams as it goes
  // — a fixed list somebody maintains by hand means an import fails on a stream
  // nobody thought of.
  const { result, executed } = await withFakeSql(sql => {
    if (/OUTPUT INSERTED\.id/.test(sql)) return [{ id: 7 }];
    return [];
  }, () => sgRepo.saveAssignment(
    { stream: 'IBP', projectRole: 'DE', name: 'Anna', email: 'A@X.com', environments: ['DEV', 'PROD'] }, 'tester', 'Tenant-A'));

  assert.equal(result.created, true);
  const statements = executed.map(entry => entry.sql).join('\n');
  assert.match(statements, /INSERT INTO sg_streams/);
  assert.match(statements, /INSERT INTO sg_project_roles/);
  assert.match(statements, /INSERT INTO sg_people/);
  assert.match(statements, /INSERT INTO sg_assignments/);
  // One environment row and one group row per environment.
  assert.equal(executed.filter(e => /INSERT INTO sg_assignment_environments/.test(e.sql)).length, 2);
  assert.equal(executed.filter(e => /INSERT INTO sg_groups/.test(e.sql)).length, 2);

  // Email is stored folded, so the same person typed two ways is one person.
  const person = executed.find(entry => /INSERT INTO sg_people/.test(entry.sql));
  assert.equal(person.params.find(p => p.name === 'email').value, 'a@x.com');
});

test('the same person, stream and role is updated rather than duplicated', async () => {
  const { result, executed } = await withFakeSql(sql => {
    // Every lookup and the assignment itself already exist.
    if (/SELECT (TOP 1 )?id/.test(sql)) return [{ id: 3, tenant_id: 'tenant-a' }];
    if (/OUTPUT INSERTED\.id/.test(sql)) return [{ id: 3 }];
    return [];
  }, () => sgRepo.saveAssignment(
    { stream: 'IBP', projectRole: 'DE', name: 'Anna', environments: ['TEST'] }, 'tester', 'tenant-a'));

  assert.equal(result.created, false);
  const statements = executed.map(entry => entry.sql).join('\n');
  assert.match(statements, /UPDATE sg_assignments/);
  assert.doesNotMatch(statements, /INSERT INTO sg_assignments/);
  // Environments are replaced, not merged: unticking a box has to mean something.
  assert.match(statements, /DELETE FROM sg_assignment_environments/);
});

test('an assignment refuses to be saved without the two things that identify it', async () => {
  await assert.rejects(() => sgRepo.saveAssignment({ projectRole: 'DE', name: 'Anna' }), /stream is required/);
  await assert.rejects(() => sgRepo.saveAssignment({ stream: 'IBP', projectRole: 'DE' }), /name is required/);
});

test('removing the last assignment removes the person, and an earlier one does not', async () => {
  const lonely = await withFakeSql(sql => {
    if (/SELECT person_id/.test(sql)) return [{ person_id: 4 }];
    if (/COUNT\(\*\)/.test(sql)) return [{ total: 0 }];
    return [];
  }, () => sgRepo.deleteAssignment(1));
  assert.match(lonely.executed.map(e => e.sql).join('\n'), /DELETE FROM sg_people/);

  const stillUsed = await withFakeSql(sql => {
    if (/SELECT person_id/.test(sql)) return [{ person_id: 4 }];
    if (/COUNT\(\*\)/.test(sql)) return [{ total: 2 }];
    return [];
  }, () => sgRepo.deleteAssignment(1));
  assert.doesNotMatch(stillUsed.executed.map(e => e.sql).join('\n'), /DELETE FROM sg_people/);
});

test('a group carries its directory link and the latest answer for each workspace', async () => {
  const { result } = await withFakeSql(sql => {
    if (/FROM sg_groups/.test(sql)) {
      return [{
        id: 5, stream: 'IBP', project_role: 'DE', environment: 'PROD',
        entra_group_id: 'g-1', entra_group_name: 'BI Prod Readers', entra_group_type: 'Security group',
      }];
    }
    if (/FROM sg_group_workspaces/.test(sql)) {
      return [{
        id: 11, group_id: 5, workspace_id: 'w1', workspace_name: 'Finance', intended_role: 'Viewer',
        state: 'missing', actual_role: null, message: 'The group holds no role in this workspace.',
        checked_at: '2026-08-20T10:00:00Z',
      }];
    }
    return [];
  }, () => sgRepo.listGroups('tenant-a'));

  assert.equal(result[0].entraGroupName, 'BI Prod Readers');
  assert.equal(result[0].workspaces[0].lastCheck.state, 'missing');
  // The latest answer only. A row showing five checks would bury the current state.
  assert.equal(result[0].workspaces.length, 1);
});

test('the mapping page shows people, their derived groups and what the tenant said', async () => {
  const original = {
    loadMapping: sgRepo.loadMapping,
    getServicePrincipals: dbService.getServicePrincipals,
  };
  sgRepo.loadMapping = async () => ({
    assignments: [
      { id: 1, personId: 1, name: 'Anna Nowak', email: 'anna@x.com', stream: 'IBP', projectRole: 'DE', environments: ['DEV', 'PROD'] },
    ],
    groups: [
      { id: 5, stream: 'IBP', projectRole: 'DE', environment: 'PROD', entraGroupId: 'g-1',
        entraGroupName: 'BI Prod Readers', workspaces: [
          { id: 11, workspaceId: 'w1', workspaceName: 'Finance', intendedRole: 'Viewer',
            lastCheck: { state: 'missing', message: 'The group holds no role in this workspace.', checkedAt: '2026-08-20T10:00:00Z' } },
        ] },
    ],
  });
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't' }];

  try {
    const html = await withServer(server => request(server, '/quality/security-groups').then(r => r.body));
    assert.match(html, /Anna Nowak/);
    // The derived columns, computed from the rules rather than read from a table.
    assert.match(html, /SG-IBP-DE-DEV/);
    assert.match(html, /Viewer \(PROD\)/);
    // The directory group, and that its name differs from the suggested one.
    assert.match(html, /BI Prod Readers/);
    assert.match(html, /named differently/);
    // And the workspace it should be in, with what the last check found.
    assert.match(html, /Finance/);
    assert.match(html, /holds no role in this workspace/);
  } finally {
    sgRepo.loadMapping = original.loadMapping;
    dbService.getServicePrincipals = original.getServicePrincipals;
  }
});

test('the check reads each workspace once, however many groups point at it', async () => {
  const original = {
    listGroups: sgRepo.listGroups,
    recordChecks: sgRepo.recordChecks,
    getServicePrincipals: dbService.getServicePrincipals,
    createPowerBIService: pbi.createPowerBIService,
  };
  const reads = [];
  let recorded = null;

  sgRepo.listGroups = async () => [
    { id: 1, stream: 'IBP', projectRole: 'DE', environment: 'DEV', entraGroupId: 'g-1', entraGroupName: 'Builders',
      workspaces: [{ id: 11, workspaceId: 'w1', workspaceName: 'Finance', intendedRole: 'Contributor' }] },
    { id: 2, stream: 'IBP', projectRole: 'PM', environment: 'DEV', entraGroupId: 'g-2', entraGroupName: 'Managers',
      workspaces: [{ id: 12, workspaceId: 'w1', workspaceName: 'Finance', intendedRole: 'Viewer' }] },
    // Never linked: nothing to look for, and no call to make.
    { id: 3, stream: 'RGM', projectRole: 'DE', environment: 'DEV', entraGroupId: null, entraGroupName: null,
      workspaces: [{ id: 13, workspaceId: 'w2', workspaceName: 'Sales', intendedRole: 'Contributor' }] },
  ];
  sgRepo.recordChecks = async results => { recorded = results; return { recorded: results.length }; };
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't' }];
  pbi.createPowerBIService = () => ({
    getRoleAssignments: async workspaceId => {
      reads.push(workspaceId);
      return [{ id: 'ra1', role: 'Contributor', principal: { id: 'g-1', type: 'Group', displayName: 'Builders' } }];
    },
  });

  try {
    const body = await withServer(server => postJson(server, '/quality/security-groups/verify', { spId: 1 }));

    assert.equal(body.success, true);
    // Two groups point at Finance; reading it twice would turn a plan of forty rows
    // into forty calls. The unlinked group needs no call at all.
    assert.deepEqual(reads, ['w1']);
    assert.equal(body.workspacesRead, 1);

    const states = body.results.map(result => result.state);
    assert.deepEqual(states, ['present', 'missing', 'unlinked']);
    assert.equal(body.summary.actionable, 1, 'unlinked is not the tenant disagreeing with you');
    // What was found is kept, so drift is visible over time rather than only now.
    assert.equal(recorded.length, 3);
  } finally {
    Object.assign(sgRepo, { listGroups: original.listGroups, recordChecks: original.recordChecks });
    dbService.getServicePrincipals = original.getServicePrincipals;
    pbi.createPowerBIService = original.createPowerBIService;
  }
});

test('a workspace that cannot be read is reported as unreadable, not as missing', async () => {
  const original = {
    listGroups: sgRepo.listGroups,
    recordChecks: sgRepo.recordChecks,
    getServicePrincipals: dbService.getServicePrincipals,
    createPowerBIService: pbi.createPowerBIService,
  };
  sgRepo.listGroups = async () => [
    { id: 1, stream: 'IBP', projectRole: 'DE', environment: 'DEV', entraGroupId: 'g-1', entraGroupName: 'Builders',
      workspaces: [{ id: 11, workspaceId: 'w1', workspaceName: 'Finance', intendedRole: 'Contributor' }] },
  ];
  sgRepo.recordChecks = async () => ({ recorded: 1 });
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'SP', tenant_id: 't' }];
  pbi.createPowerBIService = () => ({
    getRoleAssignments: async () => { throw new Error('Request failed with status code 403'); },
  });

  try {
    const body = await withServer(server => postJson(server, '/quality/security-groups/verify', {}));
    assert.equal(body.results[0].state, 'unreadable');
    assert.equal(body.summary.actionable, 0);
  } finally {
    Object.assign(sgRepo, { listGroups: original.listGroups, recordChecks: original.recordChecks });
    dbService.getServicePrincipals = original.getServicePrincipals;
    pbi.createPowerBIService = original.createPowerBIService;
  }
});

test('importing a CSV saves the rows it could read and names the ones it could not', async () => {
  const original = sgRepo.saveAssignment;
  const saved = [];
  sgRepo.saveAssignment = async assignment => { saved.push(assignment); return { id: saved.length, created: true }; };

  try {
    const body = await withServer(server => postJson(server, '/quality/security-groups/import', {
      csv: [
        'Stream,Project Role,Name,Environments',
        'IBP,DE,Anna,DEV;PROD',
        ',DE,Nobody,DEV',
        'RGM,PM,Bob,TEST',
      ].join('\n'),
    }));

    assert.equal(body.success, true);
    assert.equal(body.imported, 2);
    assert.deepEqual(saved.map(entry => entry.name), ['Anna', 'Bob']);
    // The row that could not be used is named, with its line number.
    assert.equal(body.skipped.length, 1);
    assert.equal(body.skipped[0].line, 3);
  } finally {
    sgRepo.saveAssignment = original;
  }
});

test('the export is a file, not a page', async () => {
  const original = sgRepo.listAssignments;
  sgRepo.listAssignments = async () => [
    { name: 'Anna', email: 'a@x.com', stream: 'IBP', projectRole: 'DE', environments: ['DEV'] },
  ];
  try {
    const response = await withServer(server => request(server, '/quality/security-groups/export.csv'));
    assert.match(response.headers['content-type'], /text\/csv/);
    assert.match(response.headers['content-disposition'], /attachment; filename="fabric-security-mapping\.csv"/);
    assert.match(response.body, /SG-IBP-DE-DEV/);
  } finally {
    sgRepo.listAssignments = original;
  }
});

test('while no administrator exists at all, a signed-in user is treated as one', () => {
  // Otherwise the very first person to open the app could never name an admin,
  // and the panel that grants access would itself be unreachable.
  const p = resolveFor(null, { anyAdminConfigured: false });
  assert.equal(p.isAdmin, true);
  assert.equal(p.isBootstrap, true);
  assert.equal(p.reason, 'bootstrap');
});

test('bootstrap ends the moment a real administrator exists', () => {
  const p = resolveFor(null);
  assert.equal(p.isAdmin, false);
  assert.equal(p.isKnown, false);
  assert.equal(p.reason, 'unknown');
  assert.deepEqual(p.sectionKeys, []);
  assert.deepEqual(p.tenantIds, []);
});

test('ADMIN_EMAILS confers administrator rights even when the table says otherwise', () => {
  // The second lockout guard: configuration stays reachable when the data is wrong.
  const p = resolveFor({ role: 'user', is_active: true, tenantIds: [], sectionKeys: [] }, {
    adminEmails: ['ANN@X.com'],
  });
  assert.equal(p.isAdmin, true);
  assert.equal(p.reason, 'configured-admin');
  assert.equal(perms.parseAdminEmails(' a@x.com, B@X.com ').join(','), 'a@x.com,b@x.com');
});

test('a deactivated user keeps nothing, including a deactivated administrator', () => {
  const p = resolveFor({ role: 'admin', is_active: false, tenantIds: [1], sectionKeys: ['workspaces'] });
  assert.equal(p.isAdmin, false);
  assert.equal(p.reason, 'deactivated');
  assert.deepEqual(p.tenantIds, []);
});

test('an administrator holds every tenant and every section by role', () => {
  const p = resolveFor({ role: 'admin', is_active: true, tenantIds: [], sectionKeys: [] });
  assert.equal(p.allTenants, true);
  assert.deepEqual(perms.visibleTenants(p, TENANTS), TENANTS);
  assert.equal(perms.canAccessPath(p, '/settings/permissions'), true);
});

test('an ordinary user cannot be granted an administrator-only section, whatever the table says', () => {
  const p = resolveFor({ role: 'user', is_active: true, tenantIds: [1], sectionKeys: ['workspaces', 'settings'] });
  assert.deepEqual(p.sectionKeys, ['workspaces']);
  assert.equal(perms.canAccessPath(p, '/settings'), false);
  assert.equal(perms.canAccessPath(p, '/settings/permissions'), false);
});

test('a path is matched to the most specific section that claims it', () => {
  const p = resolveFor({ role: 'user', is_active: true, tenantIds: [], sectionKeys: ['security-groups'] });
  // Security Groups lives under /quality but is granted separately, so holding it
  // must not hand over the rest of /quality.
  assert.equal(perms.canAccessPath(p, '/quality/security-groups'), true);
  assert.equal(perms.canAccessPath(p, '/quality/security-groups/export.csv'), true);
  assert.equal(perms.canAccessPath(p, '/quality'), false);
  assert.equal(perms.canAccessPath(p, '/quality/rules'), false);
});

test('the home page and the shared APIs stay open to any signed-in user', () => {
  const p = resolveFor(null);
  assert.equal(perms.canAccessPath(p, '/'), true);
  assert.equal(perms.canAccessPath(p, '/home'), true);
  assert.equal(perms.canAccessPath(p, '/api/select-run'), true);
  assert.equal(perms.canAccessPath(p, '/health'), true);
});

test('every declared section is reachable by its own href', () => {
  // A section the guard cannot match would be granted but never allowed.
  for (const section of sections.APP_SECTIONS) {
    const hit = sections.sectionForPath(section.href);
    assert.ok(hit, 'no section matches ' + section.href);
    assert.equal(hit.key, section.key, section.href + ' resolved to ' + hit.key);
  }
});

test('scans belonging to a tenant the user cannot see are filtered out entirely', () => {
  // The run selector drives every page, so filtering here is what makes the tenant
  // grant mean something beyond the analysis screen.
  const p = resolveFor({ role: 'user', is_active: true, tenantIds: [2], sectionKeys: ['workspaces'] });
  const runs = [{ id: 10, sp_id: 1 }, { id: 11, sp_id: 2 }, { id: 12, sp_id: 3 }];
  assert.deepEqual(perms.visibleRuns(p, runs).map(r => r.id), [11]);
  assert.deepEqual(perms.visibleTenants(p, TENANTS).map(t => t.id), [2]);
  assert.equal(perms.canSeeTenant(p, '2'), true);
  assert.equal(perms.canSeeTenant(p, 1), false);
});

test('a forbidden page renders an explanation, while a forbidden fetch gets JSON it can read', () => {
  const p = resolveFor({ role: 'user', is_active: true, tenantIds: [], sectionKeys: ['workspaces'] });

  const page = fakeRes();
  permMiddleware.requireSectionAccess({ permissions: p, path: '/mdm', get: () => '', xhr: false }, page, () => {
    throw new Error('should not have been allowed through');
  });
  assert.equal(page.statusCode, 403);
  assert.equal(page.rendered.view, 'no-access');
  assert.equal(page.rendered.model.section.key, 'mdm');

  const xhr = fakeRes();
  permMiddleware.requireSectionAccess({ permissions: p, path: '/mdm/models', get: () => '', xhr: true }, xhr, () => {
    throw new Error('should not have been allowed through');
  });
  assert.equal(xhr.statusCode, 403);
  assert.equal(xhr.jsonBody.success, false);
  assert.equal(xhr.jsonBody.section, 'mdm');

  let passed = false;
  permMiddleware.requireSectionAccess({ permissions: p, path: '/workspaces', get: () => '', xhr: false }, fakeRes(), () => { passed = true; });
  assert.equal(passed, true);
});

test('permissions that cannot be read hand out nothing and say so', async () => {
  // Failing open here would turn a database blip into a tenant-wide disclosure.
  const repo = require('../src/services/permissionRepository');
  const originals = { getUserByEmail: repo.getUserByEmail, hasAnyAdmin: repo.hasAnyAdmin };
  repo.getUserByEmail = async () => { throw new Error('login failed'); };
  repo.hasAnyAdmin = async () => { throw new Error('login failed'); };
  permMiddleware.clearPermissionCache();

  try {
    const res = fakeRes();
    const req = { user: { email: 'ann@x.com' }, path: '/workspaces', get: () => '', xhr: false };
    await permMiddleware.loadPermissions(req, res, () => {});
    assert.equal(req.permissions.isAdmin, false);
    assert.equal(req.permissions.reason, 'error');
    assert.deepEqual(req.permissions.sectionKeys, []);

    permMiddleware.requireSectionAccess(Object.assign(req, { xhr: true }), res, () => {
      throw new Error('should not have been allowed through');
    });
    assert.match(res.jsonBody.message, /could not be determined/);
  } finally {
    Object.assign(repo, originals);
    permMiddleware.clearPermissionCache();
  }
});
