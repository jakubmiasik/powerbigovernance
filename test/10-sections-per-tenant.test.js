/* eslint-disable no-unused-vars */
const {
  assert, http, test, app, request, postJson, convertScheduleToUtc, scheduler, runMetrics, workspaceDeletion, dbService, stubDeletionDb, sampleRun, tenantRun, pbi, httpError, itemDetails, stubPbi, insights, SCAN_DATE, ws, findingKeys, dbPrivate, httpErrors, pipelineService, requireAuth, recon, INVOICE_RULE, runProgress, progressThrough, sqlSource, reconCompare, RUN_A, RUN_B, finding, reconRepo, fakeSqlPrimitives, withFakeSql, mdm, PERSON_FIELDS, personRecord, SURVIVOR_MODEL, survivorRecords, CUSTOMER_MODEL, RAW_CUSTOMERS, analysisModel, SCAN_RESULT, guide, jobProgress, workspaceAccess, analysisScope, scheduleDue, ACCESS_FIXTURE, analysisLauncher, analysisScheduleService, DUE_DAILY, namingService, NAMING, withServer, securityGroups, sgMapping, sgRepo, perms, sections, TENANTS, resolveFor, permMiddleware, fakeRes, withFakeDirectory, SOFTWAREONE, OTHER_TENANT, outcomeFixture, buildFixtureOutcome, compareFixture, compareResponse,
} = require('./support');


// ── Sections per tenant ──

test('a user can hold different sections in different tenants', () => {
  const p = require('../src/services/permissionService');
  const resolved = p.resolvePermissions({
    user: { email: 'ann@x.com' }, anyAdminConfigured: true, tenants: [{ id: 1 }, { id: 2 }, { id: 3 }],
    record: {
      is_active: true, tenantIds: [1, 2], sectionKeys: ['mdm'],
      tenantSections: { 1: ['workspaces', 'analysis'], 2: ['workspaces', 'settings'], 3: ['capacities'] },
    },
  });
  assert.deepEqual(resolved.tenantIds, [1, 2]);
  assert.deepEqual(resolved.tenantSections[1], ['workspaces', 'analysis']);
  // An admin-only section is never granted, and a section in a tenant the entry
  // cannot see (3) grants nothing.
  assert.deepEqual(resolved.tenantSections[2], ['workspaces']);
  assert.equal(resolved.tenantSections[3], undefined);
  assert.equal(p.canUseSectionInTenant(resolved, 'analysis', 1), true);
  assert.equal(p.canUseSectionInTenant(resolved, 'analysis', 2), false);
  assert.equal(p.canUseSectionInTenant(resolved, 'capacities', 3), false);
  // Application-wide sections do not depend on a tenant.
  assert.equal(p.canUseSectionInTenant(resolved, 'mdm', 2), true);
  // The menu shows a section when it is held in at least one tenant.
  assert.ok(resolved.sectionKeys.includes('analysis'));
  assert.ok(!resolved.sectionKeys.includes('capacities'));
});

test('grants stored before per-tenant sections keep applying to every granted tenant', () => {
  const p = require('../src/services/permissionService');
  const resolved = p.resolvePermissions({
    user: { email: 'ann@x.com' }, anyAdminConfigured: true, tenants: [{ id: 1 }, { id: 2 }],
    record: { is_active: true, tenantIds: [1, 2], sectionKeys: ['workspaces', 'reconciliation'] },
  });
  assert.equal(p.canUseSectionInTenant(resolved, 'workspaces', 1), true);
  assert.equal(p.canUseSectionInTenant(resolved, 'workspaces', 2), true);
  assert.equal(p.canSeeSection(resolved, 'reconciliation'), true);
});

test('a person and their groups combine per tenant', () => {
  const p = require('../src/services/permissionService');
  const resolved = p.resolvePermissions({
    user: { email: 'ann@x.com' }, anyAdminConfigured: true, tenants: [{ id: 1 }, { id: 2 }],
    record: { is_active: true, tenantIds: [1], sectionKeys: [], tenantSections: { 1: ['workspaces'] } },
    groupRecords: [{ is_active: true, principal_type: 'group', display_name: 'Ops', tenantIds: [1, 2], sectionKeys: [], tenantSections: { 1: ['capacities'], 2: ['pipelines'] } }],
  });
  assert.deepEqual(resolved.tenantSections[1].sort(), ['capacities', 'workspaces']);
  assert.deepEqual(resolved.tenantSections[2], ['pipelines']);
});

test('a page with no scan falls back to a tenant where the section is held', () => {
  const p = require('../src/services/permissionService');
  const resolved = p.resolvePermissions({
    user: { email: 'ann@x.com' }, anyAdminConfigured: true, tenants: [{ id: 1 }, { id: 2 }],
    record: { is_active: true, tenantIds: [1, 2], sectionKeys: [], tenantSections: { 2: ['capacities'] } },
  });
  const sps = [{ id: 1, name: 'Contoso' }, { id: 2, name: 'Fabrikam' }];
  // Not simply the first configured tenant: Ann has no Capacities in Contoso.
  assert.equal(p.fallbackTenant(resolved, 'capacities', sps).name, 'Fabrikam');
  assert.equal(p.fallbackTenant(resolved, 'pipelines', sps), null);
  assert.deepEqual(p.tenantsForSection({ isAdmin: true }, 'pipelines', sps), sps);
});

test('the grant grid is read per tenant, and only for tenants that are ticked', () => {
  const { _readGrant } = require('../src/routes/permissions');
  const grant = _readGrant({
    tenantIds: ['1', '2', '99'],
    ts_1: ['workspaces', 'analysis', 'mdm'],
    ts_2: 'capacities',
    ts_3: ['workspaces'],
    sectionKeys: ['reconciliation', 'workspaces'],
  }, [1, 2, 3]);
  // 99 is not a configured tenant, 3 was not ticked.
  assert.deepEqual(grant.tenantIds, [1, 2]);
  // An application-wide section posted inside a tenant row is not a tenant grant.
  assert.deepEqual(grant.tenantSections, { 1: ['workspaces', 'analysis'], 2: ['capacities'] });
  // A tenant-bound section posted as application-wide is ignored: it can only be
  // granted in a named tenant.
  assert.deepEqual(grant.sectionKeys, ['reconciliation']);
});

test('saving stores each tenant\'s sections, and only for granted tenants', async () => {
  const repo = require('../src/services/permissionRepository');
  const { executed } = await withFakeSql(sql => (/OUTPUT INSERTED.id/.test(sql) ? [{ id: 7 }] : []), () =>
    repo.saveUser({
      email: 'ann@x.com', role: 'user', tenantIds: [1, 2], sectionKeys: ['mdm'],
      tenantSections: { 1: ['workspaces', 'analysis'], 2: ['capacities'], 3: ['workspaces'] },
    })
  );
  const sqls = executed.map(e => e.sql);
  assert.ok(sqls.some(s => /DELETE FROM app_user_tenant_sections/.test(s)), 'old per-tenant grants are replaced');
  const inserts = executed.filter(e => /INSERT INTO app_user_tenant_sections/.test(e.sql))
    .map(e => e.params.find(p => p.name === 'spId').value + ':' + e.params.find(p => p.name === 'sectionKey').value);
  assert.deepEqual(inserts, ['1:workspaces', '1:analysis', '2:capacities']);
});

test('a tenant-bound page refuses the selected scan\'s tenant when the section is held elsewhere', () => {
  const { requireSectionAccess } = require('../src/middleware/permissions');
  const p = require('../src/services/permissionService');
  const permsFor = () => p.resolvePermissions({
    user: { email: 'ann@x.com' }, anyAdminConfigured: true, tenants: [{ id: 1 }, { id: 2 }],
    record: { is_active: true, tenantIds: [1, 2], sectionKeys: [], tenantSections: { 1: ['workspaces'] } },
  });
  const runs = [
    { id: 20, sp_id: 2, sp_name: 'Fabrikam' },
    { id: 10, sp_id: 1, sp_name: 'Contoso' },
  ];
  function call(globalRun) {
    const out = { next: false, status: null, view: null, locals: null };
    const req = { path: '/workspaces', permissions: permsFor(), xhr: false, get: () => '' };
    const res = {
      locals: { globalRun, availableRuns: runs },
      status(code) { out.status = code; return this; },
      render(view, locals) { out.view = view; out.locals = locals; },
      json() {},
    };
    requireSectionAccess(req, res, () => { out.next = true; });
    return out;
  }

  assert.equal(call(runs[1]).next, true, 'Contoso: Workspaces is held there');
  const refused = call(runs[0]);
  assert.equal(refused.next, false);
  assert.equal(refused.status, 403);
  assert.match(refused.locals.message, /not in Fabrikam/);
  // The way forward: Contoso's newest scan, on the same page.
  assert.deepEqual(refused.locals.switchTo, [{ label: 'Switch to Contoso', href: '/workspaces?runId=10' }]);
  assert.equal(refused.locals.hideRunSelector, false);
});

test('Edit on the access panel receives data it can parse, whatever the name contains', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/settings/permissions.ejs', {
    currentUser: { name: 'T' }, user: { name: 'T' }, currentPath: '/settings/permissions',
    breadcrumb: [], availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Users & Access',
    users: [{ id: 1, email: 'ann@x.com', display_name: 'Ann "The Boss" O\'Neil <x>', role: 'user', is_active: true,
      tenantIds: [2], sectionKeys: ['mdm'], tenantSections: { 2: ['workspaces'] } }],
    tenants: [{ id: 2, name: 'Fabrikam', tenant_id: 'abc' }, { id: 3, name: 'Contoso', tenant_id: 'def' }],
    sections: sections.GRANTABLE_SECTIONS,
    bootstrap: false, success: [], error: [],
    permissions: { isAdmin: true }, visibleSections: sections.APP_SECTIONS,
  });
  // Decode the attribute exactly as a browser does, then parse it as the page does.
  const raw = html.match(/class="btn btn-sm btn-outline-primary js-edit-user"\s+data-user="([^"]*)"/)[1];
  const decoded = raw.replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const row = JSON.parse(decoded);
  assert.equal(row.display_name, 'Ann "The Boss" O\'Neil <x>');
  assert.deepEqual(row.tenantSections, { 2: ['workspaces'] });
  // Removing asks first without inlining the name into script.
  assert.doesNotMatch(html, /onsubmit=/);
  assert.match(html, /class="d-inline js-remove-user"/);
  // One grid row per tenant, one box per tenant-bound section, named per tenant.
  for (const section of sections.TENANT_SECTIONS) {
    assert.match(html, new RegExp('name="ts_2"\\s+value="' + section.key + '"'));
    assert.match(html, new RegExp('name="ts_3"\\s+value="' + section.key + '"'));
  }
  // Application-wide sections are offered once, not per tenant.
  for (const section of sections.APP_WIDE_SECTIONS) {
    assert.match(html, new RegExp('name="sectionKeys"\\s+value="' + section.key + '"'));
  }
  // The row summary names what each tenant grants.
  assert.match(html, /<strong>Fabrikam:<\/strong>/);
});

test('the sidebar names the application only', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/', breadcrumb: [], availableRuns: [], globalRun: null,
    hideRunSelector: true, title: 'x', visibleSections: sections.APP_SECTIONS, permissions: { isAdmin: true },
  });
  assert.match(html, /class="pd-brand-name">Fabric Governance</);
  assert.doesNotMatch(html, /pd-brand-suite/);
});

test('every view compiles with EJS, so a malformed tag cannot reach production', () => {
  const ejs = require('ejs');
  const fs = require('fs');
  const path = require('path');
  const views = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ejs')) views.push(full);
    });
  })(path.join(__dirname, '..', 'src', 'views'));
  assert.ok(views.length > 10);
  views.forEach(file => {
    // A comment that mentions a tag (an output tag written inside a comment, say)
    // ends the comment early and the whole page fails to render.
    assert.doesNotThrow(() => ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file }), file);
  });
});

test('governance outcome: KPIs, types and SKUs are the stored values, read as numbers', () => {
  const o = buildFixtureOutcome();
  assert.equal(o.run.id, 37);
  assert.deepEqual([o.run.principal, o.run.number, o.run.label], ['SoftwareOne', 12, 'SoftwareOne #12'], 'a scan is named by principal and number');
  assert.equal(o.findings[0].scan.label, 'SoftwareOne #12');
  assert.equal(o.dataAsOf, '2026-11-26T09:52:30.000Z');
  assert.deepEqual([o.kpis.workspaces, o.kpis.items, o.kpis.users, o.kpis.creators, o.kpis.explorers, o.kpis.capacities], [63, 578, 27, 17, 10, 11]);
  assert.deepEqual(o.kpis.settings, { total: 189, enabled: 120, disabled: 69, groupScoped: 3, delegated: 21 });
  assert.deepEqual(o.itemTypes.map(t => t.value), [45, 94, 0, 6, 48, 104, 76, 67]);
  assert.deepEqual(o.workspacesByType.map(t => t.type + ' ' + t.workspaces), ['Workspace 37', 'Personal 25', 'AdminWorkspace 1']);
  assert.deepEqual(o.skus.find(s => s.sku === 'F8'), { sku: 'F8', workspaces: 12, items: 407, pctItems: 70.4 });
  assert.equal(o.kpis.storage.status, 'Not collected');
  assert.equal(o.kpis.storage.raw, null, 'zero storage from an unscanned run is not a value');
});

test('governance outcome: the fixed rules reproduce the acceptance findings', () => {
  const o = buildFixtureOutcome();
  const f = id => o.findings.find(x => x.id === id);
  assert.deepEqual([f('F1').status, f('F1').count, f('F1').denominator], ['Fail', 37, 37]);
  assert.deepEqual([f('F2').status, f('F2').count, f('F2').denominator], ['Potential risk', 37, 37]);
  assert.deepEqual([f('F3').status, f('F3').count, f('F3').denominator, f('F3').value], ['Potential risk', 96, 108, 88.9]);
  assert.deepEqual(f('F3').affected, [], 'no person is named on the main page');
  assert.deepEqual([f('F4').count, f('F4').affected.map(a => a.name)], [1, ['test_gn']]);
  assert.deepEqual(f('F5').affected.map(a => a.name).sort(), ['test_gn', 'ws_poc_adventureworks']);
  assert.deepEqual([f('F6').status, f('F6').count], ['Potential risk', 2]);
  assert.deepEqual([f('F7').status, f('F7').value, f('F7').affected.map(a => a.name)], ['Potential risk', 45.8, ['DemoFabric', 'Test', 'ws_demo_dev']]);
  assert.equal(f('F8').status, 'Unknown', 'nine workspaces have no SKU while none is on shared capacity');
  assert.equal(f('T1').status, 'Potential risk');
  assert.deepEqual(f('T1').affected.map(a => a.name + ' ' + a.detail), ['Warehouses 36 → 67 (+86.1%)']);
  assert.deepEqual(o.findings.map(x => x.severity), o.findings.map(x => x.severity).slice().sort((a, b) => ({ High: 0, Medium: 1, Low: 2 })[a] - ({ High: 0, Medium: 1, Low: 2 })[b]), 'High before Medium before Low');
  assert.ok(o.findings.every(x => ['Pass', 'Fail', 'Potential risk', 'Unknown'].includes(x.status)));
  assert.doesNotMatch(JSON.stringify(o), /compliant|compliance score/i);
});

test('governance outcome: access, trend, deletions and data gaps follow the spec', () => {
  const o = buildFixtureOutcome();
  assert.equal(o.access.runId, 36);
  assert.equal(o.access.isLatestRun, false);
  assert.deepEqual([o.access.totalAssignments, o.access.adminAssignments, o.access.adminSharePct, o.access.groupAssignments], [108, 96, 88.9, 0]);
  assert.deepEqual(o.trend.runs.map(r => r.runId), [24, 28, 29, 36, 37]);
  assert.deepEqual(o.trend.runs.map(r => r.label), ['SoftwareOne #7', 'SoftwareOne #9', 'SoftwareOne #10', 'SoftwareOne #11', 'SoftwareOne #12']);
  assert.equal(o.findings.find(f => f.id === 'T1').detail, 'SoftwareOne #12 compared with SoftwareOne #11 (threshold ±25%).');
  assert.equal(o.deletions[0].scan, 'SoftwareOne #10');
  assert.deepEqual(o.trend.runs[4].changes.total_warehouses, { abs: 31, pct: 86.1, hit: true });
  assert.equal(o.deletions.length, 28);
  const gapIds = o.gaps.map(g => g.id);
  assert.ok(gapIds.includes('storage-not-collected'));
  assert.ok(gapIds.includes('access-older-run'));
  assert.equal(o.gaps.find(g => g.id === 'access-older-run').message, 'Access data from SoftwareOne #11 (2026-11-25 18:10:00 UTC): SoftwareOne #12 recorded no access, so access and F3 are read from the earlier scan.');
  assert.equal(o.access.label, 'SoftwareOne #11');
  assert.ok(gapIds.includes('sku-not-recorded'));
});

test('governance outcome: missing data is Unknown, never 0 or Pass', () => {
  const o = buildFixtureOutcome(fx => {
    fx.data.totals = null;
    fx.data.accessRun = null;
    fx.data.access = [];
    fx.data.trend = fx.data.trend.slice(-1);
    fx.data.workspaces = [];
  });
  assert.equal(o.kpis.workspaces, null);
  assert.equal(o.kpis.storage.status, 'Unknown');
  assert.ok(o.itemTypes.every(t => t.value === null));
  assert.ok(o.findings.every(f => f.status === 'Unknown' && f.count === null), JSON.stringify(o.findings.map(f => f.id + ':' + f.status)));
  assert.ok(o.gaps.some(g => g.id === 'totals-missing'));
  assert.ok(o.gaps.some(g => g.id === 'access-missing'));
});

test('governance outcome: thresholds come from the rules file and a change from 0 has no percentage', () => {
  const { buildOutcome, loadRules, validateRules, pctChange } = require('../src/services/governanceRulesService');
  const rules = loadRules();
  const strict = { ...rules, thresholds: { ...rules.thresholds, topWorkspacesItemSharePct: 50, adminSharePct: 95 } };
  const fx = outcomeFixture();
  fx.data.access.push({ principal_type: 'Group', access_right: 'Viewer', assignments: 5, distinct_principals: 2 });
  const o = buildOutcome({ run: fx.run, data: fx.data, rules: strict, generatedAt: new Date() });
  assert.equal(o.findings.find(f => f.id === 'F7').status, 'Pass', '45.8% is under a 50% threshold');
  assert.equal(o.findings.find(f => f.id === 'F3').status, 'Pass', 'under 95% with a group present');
  assert.equal(pctChange(5, 0), null);
  assert.throws(() => validateRules({ ...rules, rules: [{ id: 'X', check: 'empty', severity: 'Low', statusIfHit: 'Compliant' }] }), /Fail, Potential risk or Unknown/);
});

test('governance outcome: only tenants the reader may see, and never another tenant', () => {
  const { allowedTenants, pickTenant } = require('../src/services/governanceOutcomeService');
  const runs = [
    { id: 37, tenant_id: SOFTWAREONE.toUpperCase(), sp_id: 1, sp_name: 'SoftwareOne', completed_at: '2026-11-26' },
    { id: 50, tenant_id: OTHER_TENANT, sp_id: 2, sp_name: 'Other', completed_at: '2026-11-26' },
  ];
  const reader = resolveFor({ role: 'user', is_active: true, tenantIds: [1], sectionKeys: [], tenantSections: { 1: ['governance'] } });
  const allowed = allowedTenants(reader, runs);
  assert.deepEqual(allowed.map(t => t.id), [SOFTWAREONE]);
  assert.deepEqual(pickTenant(OTHER_TENANT, allowed, { defaultTenantId: SOFTWAREONE }), { error: 403, message: 'You do not have access to that tenant.' });
  assert.deepEqual(pickTenant(undefined, allowed, { defaultTenantId: SOFTWAREONE }), { tenantId: SOFTWAREONE });
  assert.equal(pickTenant('not-a-guid', allowed).error, 400);
  const noGovernance = resolveFor({ role: 'user', is_active: true, tenantIds: [1], sectionKeys: [], tenantSections: { 1: ['workspaces'] } });
  assert.deepEqual(allowedTenants(noGovernance, runs), []);
  assert.equal(pickTenant(undefined, [], { defaultTenantId: SOFTWAREONE }).error, 403);
});

test('governance outcome: cached per tenant and run, regenerated by a new scan or on demand', async () => {
  const service = require('../src/services/governanceOutcomeService');
  service.clearCache();
  const fx = outcomeFixture();
  let latest = fx.run;
  let reads = 0;
  const repo = {
    latestRun: async tenantId => (tenantId === SOFTWAREONE ? latest : null),
    readOutcomeData: async (tenantId, run) => { reads += 1; assert.equal(tenantId, SOFTWAREONE); assert.equal(run.run_id, latest.run_id); assert.equal(run.sp_id, 1, 'the principal decides the access fallback and trend'); return fx.data; },
  };
  assert.equal((await service.getOutcome(OTHER_TENANT, { repo })).status, 404, 'No completed tenant scan');
  const first = await service.getOutcome(SOFTWAREONE, { repo });
  const second = await service.getOutcome(SOFTWAREONE, { repo });
  assert.equal(reads, 1);
  assert.equal(second.cached, true);
  assert.equal(first.outcome.tenant.id, SOFTWAREONE);
  await service.getOutcome(SOFTWAREONE, { repo, force: true });
  assert.equal(reads, 2, 'Regenerate reads again');
  latest = { ...fx.run, run_id: 38, sp_run_number: 13 };
  const after = await service.getOutcome(SOFTWAREONE, { repo });
  assert.equal(reads, 3, 'a new scan makes the cached outcome stale');
  assert.equal(after.outcome.run.label, 'SoftwareOne #13');
  const generated = await service.generateAfterScan(SOFTWAREONE, { repo });
  assert.equal(generated.generated, true);
  assert.deepEqual(await service.generateAfterScan(SOFTWAREONE, { scopeKind: 'workspaces', repo }), { generated: false, reason: 'scoped scan' });
  latest = { ...fx.run, tenant_id: OTHER_TENANT };
  await assert.rejects(service.getOutcome(SOFTWAREONE, { repo, force: true }), /does not belong/);
  service.clearCache();
});

test('governance outcome: the endpoint answers 403 for a tenant the reader cannot see', async () => {
  const express = require('express');
  const { createRouter } = require('../src/routes/governanceOutcome');
  const real = require('../src/services/governanceOutcomeService');
  const calls = [];
  const fake = { ...real, getOutcome: async (tenantId, options) => { calls.push([tenantId, options.force === true]); return { status: 200, outcome: { tenant: { id: tenantId }, meta: {} }, cached: false }; } };
  const reader = resolveFor({ role: 'user', is_active: true, tenantIds: [1], sectionKeys: [], tenantSections: { 1: ['governance'] } });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.permissions = reader; res.locals.availableRuns = [{ id: 37, tenant_id: SOFTWAREONE, sp_id: 1, sp_name: 'SoftwareOne' }]; next(); });
  app.use('/api/governance', createRouter({ service: fake }));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port + '/api/governance/summary';
  try {
    const denied = await fetch(base + '?tenantId=' + OTHER_TENANT);
    assert.equal(denied.status, 403);
    const ok = await fetch(base + '?tenantId=' + SOFTWAREONE);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).tenant.id, SOFTWAREONE);
    assert.equal((await fetch(base + '/regenerate?tenantId=' + SOFTWAREONE, { method: 'POST' })).status, 415, 'a plain form post cannot trigger it');
    assert.equal((await fetch(base + '/regenerate?tenantId=' + SOFTWAREONE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    assert.deepEqual(calls, [[SOFTWAREONE, false], [SOFTWAREONE, true]], 'the other tenant never reached the service');
  } finally {
    server.close();
  }
});

test('governance outcome: the data access layer only reads, only the five tables, always by tenant', () => {
  const fs = require('fs');
  const { SQL } = require('../src/services/governanceOutcomeRepository');
  const allowedTables = ['analysis_runs', 'analysis_run_totals', 'analysis_workspaces', 'analysis_workspace_users', 'workspace_states'];
  for (const [name, sql] of Object.entries(SQL)) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|EXEC|EXECUTE|GRANT)\b/i, name + ' must only read');
    assert.doesNotMatch(sql, /SELECT\s+\*/i, name + ' must name its columns');
    assert.doesNotMatch(sql, /service_principals|client_secret/i, name);
    assert.doesNotMatch(sql, /display_name|email/i, name + ' must not read people\'s names or addresses');
    assert.match(sql, /@TenantId/, name + ' must be tied to the tenant');
    for (const table of sql.match(/dbo\.(\w+)/g) || []) assert.ok(allowedTables.includes(table.slice(4)), name + ' reads ' + table);
  }
  const sources = ['src/services/governanceOutcomeRepository.js', 'src/services/governanceRulesService.js', 'src/services/governanceOutcomeService.js', 'src/routes/governanceOutcome.js', 'src/public/js/governance-outcome.js']
    .map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(sources, /openai|anthropic|azure-openai|\bllm\b|chat\/completions|generative/i, 'no model or AI service is called');
  assert.doesNotMatch(sources, /innerHTML/, 'the page builds its markup with textContent only');
  assert.doesNotMatch(sources, /password\s*[:=]\s*['"][^'"]+['"]/i, 'no credentials in code');
});

test('Home shows the governance outcome for a tenant the reader may see, and nothing otherwise', async () => {
  const ejs = require('ejs');
  const locals = {
    title: 'Home', user: { name: 'T' }, currentUser: { name: 'T', email: 't@example.com' }, currentPath: '/', pagePath: '/', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, prerequisites: [], visibleSections: [],
  };
  const shown = await ejs.renderFile('src/views/home.ejs', { ...locals, outcomeTenants: [{ id: SOFTWAREONE, name: 'SoftwareOne' }, { id: '11111111-1111-4111-8111-111111111111', name: 'Contoso' }], outcomeTenantId: SOFTWAREONE });
  assert.match(shown, new RegExp('id="governanceOutcome" data-tenant-id="' + SOFTWAREONE + '"'));
  assert.match(shown, /src="\/js\/governance-outcome\.js"/);
  assert.match(shown, /aria-busy="true"/, 'a loading state is shown until the data arrives');
  assert.match(shown, /id="goTenant"/);
  const hidden = await ejs.renderFile('src/views/home.ejs', { ...locals, outcomeTenants: [], outcomeTenantId: null });
  assert.doesNotMatch(hidden, /governanceOutcome/);
});

// ── Scans numbered per service principal ──

test('a scan is named by its service principal and that principal\'s own number', () => {
  const { runLabel, runNumber } = require('../src/services/runLabelService');
  assert.equal(runLabel({ id: 212, sp_id: 3, sp_name: 'SoftwareOne', sp_run_number: 5 }), 'SoftwareOne #5');
  assert.equal(runLabel({ id: 9, sp_id: null, sp_name: null, sp_run_number: 2 }), 'Managed identity #2');
  assert.equal(runLabel({ id: 9, sp_id: 4, sp_run_number: 1 }), 'Principal 4 #1');
  assert.equal(runLabel({ id: 77, sp_name: 'Contoso' }), 'Contoso (unnumbered, id 77)', 'an id is never passed off as a scan number');
  assert.equal(runNumber({ sp_run_number: '0' }), null);
});

test('scan numbers start at 1 per principal, follow start order, and are unique per principal', () => {
  const db = require('../src/services/databaseService');
  const { RUN_NUMBER_BACKFILL_SQL, ASSIGN_RUN_NUMBER_SQL } = db._runNumbers;
  // Backfill: per principal, oldest first, after any number it already has, unnumbered rows only.
  assert.match(RUN_NUMBER_BACKFILL_SQL, /ROW_NUMBER\(\) OVER \(PARTITION BY sp_id ORDER BY started_at, id\)/);
  assert.match(RUN_NUMBER_BACKFILL_SQL, /WHERE sp_run_number IS NULL/);
  assert.match(RUN_NUMBER_BACKFILL_SQL, /ISNULL\(b\.last_number, 0\) \+ t\.position/);
  // New scan: the principal's next number, under a range lock so two scans cannot share it.
  assert.match(ASSIGN_RUN_NUMBER_SQL, /MAX\(x\.sp_run_number\), 0\) \+ 1/);
  assert.match(ASSIGN_RUN_NUMBER_SQL, /WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.match(ASSIGN_RUN_NUMBER_SQL, /x\.sp_id = r\.sp_id OR \(x\.sp_id IS NULL AND r\.sp_id IS NULL\)/);
  assert.match(ASSIGN_RUN_NUMBER_SQL, /r\.sp_run_number IS NULL/, 'a numbered scan is never renumbered');
  const source = require('fs').readFileSync('src/services/databaseService.js', 'utf8');
  assert.match(source, /CREATE UNIQUE INDEX UX_analysis_runs_sp_number ON analysis_runs \(sp_id, sp_run_number\)/);
  assert.match(source, /RUN_META_COLUMNS = `[^`]*sp_run_number/);

  // What the backfill does, on rows: two principals, out-of-order ids, one already numbered.
  const rows = [
    { id: 1, sp_id: 1, started_at: '2026-11-02', n: null }, { id: 2, sp_id: 2, started_at: '2026-11-01', n: null },
    { id: 3, sp_id: 1, started_at: '2026-11-01', n: null }, { id: 4, sp_id: 2, started_at: '2026-11-03', n: null },
    { id: 5, sp_id: 3, started_at: '2026-11-05', n: 4 }, { id: 6, sp_id: 3, started_at: '2026-11-06', n: null },
  ];
  const last = {};
  rows.forEach(r => { if (r.n) last[r.sp_id] = Math.max(last[r.sp_id] || 0, r.n); });
  const pending = rows.filter(r => r.n === null).sort((a, b) => a.sp_id - b.sp_id || a.started_at.localeCompare(b.started_at) || a.id - b.id);
  const position = {};
  pending.forEach(r => { position[r.sp_id] = (position[r.sp_id] || 0) + 1; r.n = (last[r.sp_id] || 0) + position[r.sp_id]; });
  assert.deepEqual(rows.map(r => r.sp_id + '#' + r.n), ['1#2', '2#1', '1#1', '2#2', '3#4', '3#5']);
});

test('the scan selector and pages name scans by principal and number', async () => {
  const ejs = require('ejs');
  const runs = [
    { id: 212, sp_id: 3, sp_name: 'SoftwareOne', sp_run_number: 5, status: 'completed', started_at: '2026-11-26T09:00:00Z', scopeTag: 'WT', scopeTagTitle: 'WT' },
    { id: 199, sp_id: 3, sp_name: 'SoftwareOne', sp_run_number: 4, status: 'completed', started_at: '2026-11-25T09:00:00Z', scopeTag: 'WT', scopeTagTitle: 'WT' },
  ];
  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/governance', breadcrumb: [], title: 'x',
    availableRuns: runs, globalRun: runs[0], selectedRunId: 212, hideRunSelector: false,
    visibleSections: [], permissions: { isAdmin: true },
  });
  assert.match(html, /<option value="212" selected[^>]*>\[WT\] SoftwareOne #5 &mdash;/);
  assert.match(html, /<option value="199"[^>]*>\[WT\] SoftwareOne #4 &mdash;/);
  assert.doesNotMatch(html, /Run#212|Run #212/);
});

test('Since Last Scan pairs a scan with the same principal\'s previous scan of the same scope', () => {
  const { comparableRuns, previousOfPrincipal, defaultPair } = require('../src/routes/compareRuns');
  const T = SOFTWAREONE;
  const runs = [
    { id: 50, sp_id: 1, sp_name: 'SoftwareOne', sp_run_number: 3, tenant_id: T, status: 'completed', started_at: '2026-11-26' },
    { id: 49, sp_id: 2, sp_name: 'Backup SP', sp_run_number: 8, tenant_id: T, status: 'completed', started_at: '2026-11-25' },
    { id: 48, sp_id: 1, sp_name: 'SoftwareOne', sp_run_number: 2, tenant_id: T, status: 'completed', started_at: '2026-11-24', scope_kind: 'workspaces', scope_workspaces: JSON.stringify([{ id: 'w1' }]) },
    { id: 40, sp_id: 1, sp_name: 'SoftwareOne', sp_run_number: 1, tenant_id: T, status: 'completed', started_at: '2026-11-20' },
    { id: 41, sp_id: 1, sp_name: 'SoftwareOne', sp_run_number: 4, tenant_id: T, status: 'failed', started_at: '2026-11-27' },
  ];
  const all = comparableRuns({ isAdmin: true }, runs);
  assert.ok(!all.some(r => r.id === 41), 'only completed scans');
  assert.equal(previousOfPrincipal(all.find(r => r.id === 50), all).id, 40, 'not the other principal\'s newer scan, not the scoped one');
  assert.equal(previousOfPrincipal(all.find(r => r.id === 40), all), null);
  const pair = defaultPair(all, { id: 50 });
  assert.deepEqual([pair.to.id, pair.from.id], [50, 40]);

  const reader = resolveFor({ role: 'user', is_active: true, tenantIds: [1, 2], sectionKeys: [], tenantSections: { 1: ['governance'], 2: ['workspaces'] } });
  assert.deepEqual(comparableRuns(reader, runs, 'governance').map(r => r.id).sort(), [40, 48, 50], 'only principals where the reader holds the section');
});

test('Compare runs refuses scans the reader cannot see, on the page and on the details endpoint', async () => {
  const { comparePage, compareDetails } = require('../src/routes/compareRuns');
  const visible = [{ id: 50, sp_id: 1, sp_name: 'SoftwareOne', sp_run_number: 3, tenant_id: SOFTWAREONE, status: 'completed', started_at: '2026-11-26' }];
  function fakeResponse() {
    return {
      locals: { availableRuns: visible, globalRun: visible[0] }, statusCode: 200, rendered: null, body: null,
      status(code) { this.statusCode = code; return this; },
      render(view, model) { this.rendered = { view, model }; return this; },
      json(body) { this.body = body; return this; },
    };
  }
  const page = comparePage({ basePath: '/analysis/compare', detailsPath: '/analysis/compare/details', title: 'Compare Runs' });
  const res = fakeResponse();
  await page({ query: { from: '50', to: '999' }, permissions: { isAdmin: true }, user: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.rendered.model.error, 'You do not have access to one of those scans.');

  const details = compareDetails();
  const jres = fakeResponse();
  await details({ query: { from: '999', to: '50' }, permissions: { isAdmin: true } }, jres);
  assert.equal(jres.statusCode, 403);
  assert.equal(jres.body.success, false);

  // Since Last Scan with nothing earlier: says so instead of comparing with anything.
  const since = comparePage({ basePath: '/governance/changes', detailsPath: '/governance/changes/details', section: 'governance', title: 'Since Last Scan', defaultToLatest: true });
  const sres = fakeResponse();
  await since({ query: {}, permissions: { isAdmin: true }, user: {} }, sres);
  assert.equal(sres.rendered.view, 'analysis/compare');
  assert.equal(sres.rendered.model.compare.basePath, '/governance/changes');
  assert.match(sres.rendered.model.notice, /^SoftwareOne #3 is the first whole-tenant scan of this principal/);
});

test('the compare view posts to the page it is shown on and names scans by principal and number', async () => {
  const ejs = require('ejs');
  const { scopeTag, scopeTagTitle, describeScope, scopeFromRow } = require('../src/services/analysisScopeService');
  const runs = [
    { id: 50, sp_id: 1, sp_name: 'SoftwareOne', sp_run_number: 3, tenant_id: SOFTWAREONE, status: 'completed', started_at: '2026-11-26T06:00:00Z' },
    { id: 40, sp_id: 1, sp_name: 'SoftwareOne', sp_run_number: 1, tenant_id: SOFTWAREONE, status: 'completed', started_at: '2026-11-20T06:00:00Z' },
  ];
  const html = await ejs.renderFile('src/views/analysis/compare.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/governance/changes', breadcrumb: [], title: 'Since Last Scan',
    availableRuns: [], globalRun: null, hideRunSelector: true,
    runs, tenants: [{ id: SOFTWAREONE, label: 'SoftwareOne · 77f4d6ee…', scans: 2 }], tenantId: SOFTWAREONE,
    fromRun: runs[1], toRun: runs[0], metrics: [{ key: 'totalWorkspaces', label: 'Workspaces', from: 3, to: 4, delta: 1, percent: 33.3, changed: true }],
    error: null, notice: null, tenantSettingsComparable: true, scopeTag, scopeTagTitle, describeScope, scopeFromRow,
    compare: { basePath: '/governance/changes', detailsPath: '/governance/changes/details', title: 'Since Last Scan', subtitle: 'x', backHref: null },
  });
  assert.match(html, /<form method="get" action="\/governance\/changes"/);
  assert.match(html, /"\/governance\/changes\/details" \+ '\?from='/);
  assert.match(html, /\[WT\] SoftwareOne #3 —/);
  assert.match(html, /<th class="text-end">SoftwareOne #1<\/th>/);
  assert.doesNotMatch(html, /Run #50|Run #40/);
});

test('Compare lists one tenant\'s scans only and never compares two tenants', async () => {
  const { comparePage, tenantsOf } = require('../src/routes/compareRuns');
  const { A, B, runs } = compareFixture();
  assert.deepEqual(tenantsOf(runs).map(t => t.id).sort(), [A, B].sort());
  const page = comparePage({ basePath: '/analysis/compare', detailsPath: '/analysis/compare/details', title: 'Compare Runs' });

  const res = compareResponse(runs, runs[0]);
  await page({ query: {}, permissions: { isAdmin: true }, user: {} }, res);
  assert.equal(res.rendered.model.tenantId, A, 'the selected scan\'s tenant');
  assert.ok(res.rendered.model.runs.every(r => r.tenant_id === A), 'only that tenant\'s scans are offered');
  assert.deepEqual([res.rendered.model.toRun.id, res.rendered.model.fromRun.id], [50, 40], 'preselected: the scan and the same principal\'s previous one');
  assert.deepEqual(res.rendered.model.metrics, [], 'Compare Runs waits for the button');

  const other = compareResponse(runs, runs[0]);
  await page({ query: { tenant: B }, permissions: { isAdmin: true }, user: {} }, other);
  assert.deepEqual(other.rendered.model.runs.map(r => r.id), [60]);
  assert.equal(other.rendered.model.fromRun, null, 'nothing of the previous tenant is carried over');

  const cross = compareResponse(runs);
  await page({ query: { from: '60', to: '50' }, permissions: { isAdmin: true }, user: {} }, cross);
  assert.match(cross.rendered.model.error, /only be compared within one tenant/);
  assert.deepEqual(cross.rendered.model.metrics, []);
});

test('a whole-tenant scan against a scoped one is not compared until confirmed', async () => {
  const { comparePage, compareDetails, scopeMismatch } = require('../src/routes/compareRuns');
  const { runs } = compareFixture();
  const mismatch = scopeMismatch(runs[0], runs[2]);
  assert.equal(mismatch.kind, 'tenant-vs-scoped');
  assert.equal(mismatch.title, 'Compare a whole-tenant scan with a scoped scan?');
  assert.deepEqual([mismatch.from.label, mismatch.from.scope, mismatch.to.label, mismatch.to.scope], ['SoftwareOne #3', 'the whole tenant', 'SoftwareOne #4', '1 workspace: Finance']);
  assert.equal(scopeMismatch(runs[0], runs[1]), null);

  const original = { meta: dbService.getAnalysisRunMeta, byId: dbService.getAnalysisRunById, totals: dbService.getRunTotals };
  const byId = new Map(runs.map(r => [r.id, r]));
  let totalsRead = 0;
  dbService.getAnalysisRunMeta = async id => byId.get(id) || null;
  dbService.getAnalysisRunById = async id => ({ ...byId.get(id), results_json: '{"workspaces":[]}' });
  dbService.getRunTotals = async () => { totalsRead += 1; return { total_workspaces: 1, tenant_settings_captured: 1 }; };
  try {
    const page = comparePage({ basePath: '/analysis/compare', detailsPath: '/analysis/compare/details', title: 'Compare Runs' });
    const pending = compareResponse(runs);
    await page({ query: { from: '50', to: '52' }, permissions: { isAdmin: true }, user: {} }, pending);
    assert.equal(pending.rendered.model.scopeConfirm.kind, 'tenant-vs-scoped');
    assert.deepEqual(pending.rendered.model.metrics, []);
    assert.equal(totalsRead, 0, 'nothing is computed before the reader confirms');

    const confirmed = compareResponse(runs);
    await page({ query: { from: '50', to: '52', confirm: '1' }, permissions: { isAdmin: true }, user: {} }, confirmed);
    assert.equal(confirmed.rendered.model.scopeConfirm, null);
    assert.equal(confirmed.rendered.model.scopeConfirmed, true);
    assert.ok(confirmed.rendered.model.metrics.length > 0);

    const details = compareDetails();
    const unconfirmed = compareResponse(runs);
    await details({ query: { from: '50', to: '52' }, permissions: { isAdmin: true } }, unconfirmed);
    assert.equal(unconfirmed.body.success, false);
    const ok = compareResponse(runs);
    await details({ query: { from: '50', to: '52', confirm: '1' }, permissions: { isAdmin: true } }, ok);
    assert.equal(ok.body.success, true);
  } finally {
    dbService.getAnalysisRunMeta = original.meta;
    dbService.getAnalysisRunById = original.byId;
    dbService.getRunTotals = original.totals;
  }
});

test('the compare page asks in a design-system dialog, and offers one tenant at a time', async () => {
  const ejs = require('ejs');
  const scope = require('../src/services/analysisScopeService');
  const { scopeMismatch } = require('../src/routes/compareRuns');
  const { runs } = compareFixture();
  const tenantRuns = runs.filter(r => r.tenant_id === SOFTWAREONE);
  const html = await ejs.renderFile('src/views/analysis/compare.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/analysis/compare', breadcrumb: [], title: 'Compare Runs',
    availableRuns: [], globalRun: null, hideRunSelector: true,
    runs: tenantRuns, tenants: [{ id: SOFTWAREONE, label: 'SoftwareOne', scans: 3 }, { id: OTHER_TENANT, label: 'Other', scans: 1 }], tenantId: SOFTWAREONE,
    fromRun: runs[0], toRun: runs[2], metrics: [], error: null, notice: null, tenantSettingsComparable: true,
    scopeConfirm: scopeMismatch(runs[0], runs[2]),
    scopeTag: scope.scopeTag, scopeTagTitle: scope.scopeTagTitle, describeScope: scope.describeScope, scopeFromRow: scope.scopeFromRow,
  });
  assert.match(html, /<select class="form-select form-select-sm" id="tenantSelect" name="tenant">/);
  assert.match(html, new RegExp('<option value="' + SOFTWAREONE + '" selected>'));
  assert.doesNotMatch(html, /data-scope-key="[^"]*"[^>]*>\[WT\] Other #1/, 'the other tenant\'s scans are not offered');
  assert.match(html, /<dialog class="pd-dialog" id="scopeMismatchDialog"/, 'the app\'s dialog, not a browser alert');
  assert.match(html, /Compare a whole-tenant scan with a scoped scan\?/);
  assert.match(html, /id="scopeConfirmBtn">Compare anyway</);
  assert.match(html, /data-pd-dialog-close>Pick other scans</);
  assert.match(html, /Not compared yet: SoftwareOne #3 and SoftwareOne #4 cover different workspaces/);
  assert.doesNotMatch(html, /\balert\(|\bconfirm\(/, 'no native browser pop-ups');
});

test('Home is the governance outcome; onboarding has its own page', async () => {
  const ejs = require('ejs');
  const locals = {
    title: 'Home', user: { name: 'T' }, currentUser: { name: 'T', email: 't@example.com' }, currentPath: '/', pagePath: '/', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, prerequisites: [], visibleSections: [],
  };
  const withOutcome = await ejs.renderFile('src/views/home.ejs', { ...locals, outcomeTenants: [{ id: SOFTWAREONE, name: 'SoftwareOne' }], outcomeTenantId: SOFTWAREONE });
  assert.match(withOutcome, /id="governanceOutcome"/);
  assert.doesNotMatch(withOutcome, /Before You Start/);
  assert.match(withOutcome, /href="\/getting-started"/);
  const fresh = await ejs.renderFile('src/views/home.ejs', { ...locals, outcomeTenants: [], outcomeTenantId: null });
  assert.match(fresh, /Before You Start/, 'with nothing to show yet, Home still says how to start');
  const page = await ejs.renderFile('src/views/getting-started.ejs', { ...locals, title: 'Getting started', currentPath: '/getting-started', pagePath: '/getting-started' });
  assert.match(page, /Before You Start/);
  assert.match(page, /id="prerequisitesModal"/);
});

// ── Governance outcome follows the selected scan ──

test('governance outcome shows the selected scan, and for a scoped one the whole-tenant scan before it', async () => {
  const service = require('../src/services/governanceOutcomeService');
  service.clearCache();
  const fx = outcomeFixture();
  const wide36 = { ...fx.run, run_id: 36, sp_run_number: 11, completed_at: new Date('2026-11-25T18:10:00Z') };
  const scoped38 = { ...fx.run, run_id: 38, sp_run_number: 13, scope_kind: 'workspaces' };
  const shown = [];
  const repo = {
    latestRun: async () => fx.run,
    runForSelected: async (tenantId, runId) => {
      assert.equal(tenantId, SOFTWAREONE);
      if (runId === 36) return { run: wide36, selected: wide36 };
      if (runId === 38) return { run: fx.run, selected: scoped38 };
      return null;
    },
    readOutcomeData: async (tenantId, run) => { shown.push(run.run_id); return fx.data; },
  };

  const picked = await service.getOutcome(SOFTWAREONE, { runId: 36, repo });
  assert.equal(picked.outcome.run.label, 'SoftwareOne #11', 'the selected scan, not the latest');
  assert.equal(picked.outcome.selection, null);

  const latest = await service.getOutcome(SOFTWAREONE, { repo });
  assert.equal(latest.outcome.run.label, 'SoftwareOne #12', 'with nothing selected: the latest');
  assert.equal((await service.getOutcome(SOFTWAREONE, { runId: 36, repo })).cached, true, 'each scan is cached on its own');

  const forScoped = await service.getOutcome(SOFTWAREONE, { runId: 38, repo });
  assert.equal(forScoped.outcome.run.label, 'SoftwareOne #12');
  assert.deepEqual(forScoped.outcome.selection, { selectedRunId: 38, selectedLabel: 'SoftwareOne #13', shownLabel: 'SoftwareOne #12' });
  assert.match(forScoped.outcome.gaps[0].message, /^The selected scan, SoftwareOne #13, covered only some workspaces\. The outcome reads whole-tenant scans, so it shows SoftwareOne #12/);

  assert.equal((await service.getOutcome(SOFTWAREONE, { runId: 999, repo })).status, 404);
  assert.deepEqual(shown, [36, 37, 37]);
  service.clearCache();
});

test('the selected scan\'s tenant comes before the configured tenant', () => {
  const { pickTenant } = require('../src/services/governanceOutcomeService');
  const allowed = [{ id: SOFTWAREONE, name: 'SoftwareOne' }, { id: OTHER_TENANT, name: 'Other' }];
  assert.deepEqual(pickTenant(undefined, allowed, { defaultTenantId: SOFTWAREONE, selectedRun: { tenant_id: OTHER_TENANT } }), { tenantId: OTHER_TENANT });
  assert.deepEqual(pickTenant(undefined, allowed, { defaultTenantId: SOFTWAREONE, selectedRun: null }), { tenantId: SOFTWAREONE });
});

test('the outcome endpoint takes the selected scan only from the reader\'s list and this tenant', async () => {
  const express = require('express');
  const { createRouter } = require('../src/routes/governanceOutcome');
  const real = require('../src/services/governanceOutcomeService');
  const calls = [];
  const fake = { ...real, getOutcome: async (tenantId, options) => { calls.push([tenantId, options.runId]); return { status: 200, outcome: { tenant: { id: tenantId }, meta: {} }, cached: false }; } };
  const runs = [
    { id: 37, tenant_id: SOFTWAREONE, sp_id: 1, sp_name: 'SoftwareOne' },
    { id: 36, tenant_id: SOFTWAREONE, sp_id: 1, sp_name: 'SoftwareOne' },
    { id: 60, tenant_id: OTHER_TENANT, sp_id: 2, sp_name: 'Other' },
  ];
  const app = express();
  app.use((req, res, next) => { req.permissions = { isAdmin: true }; res.locals.availableRuns = runs; res.locals.globalRun = runs[1]; next(); });
  app.use('/api/governance', createRouter({ service: fake }));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port + '/api/governance/summary?tenantId=' + SOFTWAREONE;
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(base + '&runId=37')).status, 200);
    assert.equal((await fetch(base + '&runId=999')).status, 403, 'not in the reader\'s list');
    assert.equal((await fetch(base + '&runId=60')).status, 400, 'another tenant\'s scan');
    assert.deepEqual(calls, [[SOFTWAREONE, 36], [SOFTWAREONE, 37]], 'without runId, the scan selected at the top');
  } finally {
    server.close();
  }
});

test('Home hands the selected scan to the outcome, and Getting Started sits above Home', async () => {
  const ejs = require('ejs');
  const sections = require('../src/services/appSectionService');
  const html = await ejs.renderFile('src/views/home.ejs', {
    title: 'Home', user: { name: 'T' }, currentUser: { name: 'T', email: 't@example.com' }, currentPath: '/', pagePath: '/', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, prerequisites: [], visibleSections: sections.APP_SECTIONS, permissions: { isAdmin: true },
    outcomeTenants: [{ id: SOFTWAREONE, name: 'SoftwareOne' }], outcomeTenantId: SOFTWAREONE, outcomeRunId: 36,
  });
  assert.match(html, new RegExp('data-tenant-id="' + SOFTWAREONE + '" data-run-id="36"'));
  // Menu entries carry title="..."; the logo link to "/" does not.
  const gs = html.indexOf('title="Getting Started" data-nav-group="Overview"');
  const home = html.indexOf('title="Home" data-nav-group="Overview"');
  assert.ok(gs > -1 && home > -1 && gs < home, 'Getting Started comes before Home in the menu');
});

// ── Access through the admin scanner, capacities in Azure, Run Analysis layout ──

test('workspace access is read through the scanner, 100 at a time, with a fallback only for what it missed', async () => {
  const { readWorkspaceAccess } = require('../src/services/workspaceAccessScanService');
  const ids = Array.from({ length: 230 }, (_, i) => 'WS-' + i);
  const started = [];
  const perWorkspace = [];
  const api = {
    startAccessScan: async (batch) => { started.push(batch.length); return { id: 'scan-' + started.length }; },
    getScanStatus: async () => ({ status: 'Succeeded' }),
    getScanResult: async (scanId) => {
      const n = Number(scanId.split('-')[1]);
      const batch = ids.slice((n - 1) * 100, n * 100);
      return { workspaces: batch.map(id => (id === 'WS-5'
        ? { id: id.toLowerCase() } // answered without users: not read
        : { id: id.toLowerCase(), users: [{ displayName: 'A', groupUserAccessRight: 'Admin', principalType: 'User' }] })) };
    },
    readWorkspaceUsers: async (id) => { perWorkspace.push(id); if (id === 'WS-5') throw new Error('429'); return []; },
  };
  const result = await readWorkspaceAccess(api, ids, { pollMs: 0 });
  assert.deepEqual(started, [100, 100, 30], 'three scanner requests rather than 230 per-workspace calls');
  assert.equal(result.viaScanner, 229);
  assert.deepEqual(perWorkspace, ['WS-5'], 'only the workspace the scanner did not answer is asked one by one');
  assert.deepEqual(result.unread, ['WS-5'], 'and a refusal there leaves it unread, not empty');
  assert.equal(result.users.get('WS-0').length, 1);
  assert.equal(result.users.has('WS-5'), false);
});

test('a scanner that fails entirely falls back to one request per workspace and says so', async () => {
  const { readWorkspaceAccess } = require('../src/services/workspaceAccessScanService');
  const api = {
    startAccessScan: async () => { throw new Error('Unauthorized'); },
    getScanStatus: async () => ({}), getScanResult: async () => ({}),
    readWorkspaceUsers: async (id) => (id === 'b' ? Promise.reject(new Error('429')) : [{ displayName: 'X' }]),
  };
  const result = await readWorkspaceAccess(api, ['a', 'b', 'c'], { pollMs: 0 });
  assert.equal(result.scannerError, 'Unauthorized');
  assert.equal(result.viaFallback, 2);
  assert.deepEqual(result.unread, ['b']);
});

test('a scan that never finishes stops waiting instead of hanging the run', async () => {
  const { readWorkspaceAccess } = require('../src/services/workspaceAccessScanService');
  let clock = 0;
  const api = {
    startAccessScan: async () => ({ id: 's' }),
    getScanStatus: async () => ({ status: 'Running' }),
    getScanResult: async () => { throw new Error('should not be read'); },
    readWorkspaceUsers: async () => [],
  };
  const result = await readWorkspaceAccess(api, ['a'], { pollMs: 0, timeoutMs: 10, now: () => (clock += 5), sleep: async () => {} });
  assert.match(result.scannerError, /did not finish/);
  assert.equal(result.viaFallback, 1);
});

test('the analysis stores unreadable access as not readable, never as an empty workspace', () => {
  const source = require('fs').readFileSync('src/routes/analysis.js', 'utf8');
  assert.match(source, /readWorkspaceAccess\(accessApi/);
  assert.match(source, /wsDetail\.usersReadable = false;/);
  assert.doesNotMatch(source, /batch\.map\(\(ws\) => pbi\.getWorkspaceUsers/, 'no per-workspace loop as the main path');
});

test('Grant Access reads only scans the user may see, and follows the selected scan\'s tenant', async () => {
  const { _resolveRun } = require('../src/routes/access');
  const runs = [
    { id: 40, status: 'completed', tenant_id: 'B', scope_kind: 'workspaces', scope_workspaces: '["x"]' },
    { id: 39, status: 'completed', tenant_id: 'A' },
    { id: 38, status: 'completed', tenant_id: 'B' },
  ];
  const picked = await _resolveRun(undefined, { availableRuns: runs, globalRun: runs[0] });
  assert.equal(picked.run.id, 38, 'the whole-tenant scan of the selected scan\'s tenant');
  const own = await _resolveRun(undefined, { availableRuns: runs, globalRun: runs[1] });
  assert.equal(own.run.id, 39);
  const foreign = await _resolveRun('99', { availableRuns: runs, globalRun: runs[1] });
  assert.equal(foreign.run.id, 39, 'a scan outside the user\'s list is ignored');
});

test('Grant Access says a scan with no access recorded is a gap, not an empty tenant', async () => {
  const ejs = require('ejs');
  const overview = workspaceAccess.buildAccessOverview({ workspaces: [{ workspace_id: 'w1', name: 'Sales' }, { workspace_id: 'w2', name: 'Ops' }], grants: [] });
  const html = await ejs.renderFile('src/views/access/index.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T', email: 't@example.com' },
    currentPath: '/settings/access', breadcrumb: [], availableRuns: [], globalRun: null,
    hideRunSelector: true, title: 'Grant Access',
    accessLevels: workspaceAccess.ACCESS_LEVELS, principalTypes: workspaceAccess.PRINCIPAL_TYPES,
    fabricRoles: workspaceAccess.FABRIC_ROLES,
    accessLevel: workspaceAccess.accessLevel, principalTypeLabel: workspaceAccess.principalTypeLabel,
    describeScope: analysisScope.describeScope, scopeFromRow: analysisScope.scopeFromRow,
    partialScope: false, overview, indexed: true, error: null, grantAuth: false,
    runs: [{ id: 9, started_at: '2026-08-01T00:00:00Z' }], run: { id: 9, started_at: '2026-08-01T00:00:00Z' },
    servicePrincipals: [],
  });
  assert.match(html, /id="noAccessRecorded"/);
  assert.match(html, /recorded <strong>no access at all<\/strong> across\s+2 workspace/);
});

test('a capacity is matched in Azure by name only, and its resource group is read from the resource id', () => {
  const arm = require('../src/services/capacityArmService');
  const armCaps = [
    { name: 'otherCap', id: '/subscriptions/S1/resourceGroups/rg-x/providers/Microsoft.Fabric/capacities/otherCap', properties: { administration: { members: ['a'] } } },
    { name: 'fabricprod', id: '/subscriptions/S2/resourceGroups/rg-fabric/providers/Microsoft.Fabric/capacities/fabricprod' },
  ];
  assert.deepEqual(arm.describeArmAccess({ displayName: 'FabricProd', sku: 'F64' }, armCaps),
    { status: 'reachable', arm: armCaps[1], subscriptionId: 'S2', resourceGroup: 'rg-fabric' });
  assert.equal(arm.describeArmAccess({ displayName: 'missing', sku: 'F2' }, armCaps).status, 'no-access',
    'a capacity with admins listed is not a match for another one');
  assert.equal(arm.describeArmAccess({ displayName: 'otherCap', sku: 'P1' }, armCaps).status, 'not-azure');
  assert.equal(arm.describeArmAccess({ displayName: 'trial', sku: 'FT1' }, armCaps).status, 'not-azure');
});

test('capacities are looked up in every subscription the principal can list', async () => {
  const arm = require('../src/services/capacityArmService');
  arm.clearCache();
  const asked = [];
  const pbi = {
    listSubscriptions: async () => [{ subscriptionId: 'S2' }, { subscriptionId: 'S1' }],
    listArmCapacities: async (sub) => { asked.push(sub); if (sub === 'S1') throw new Error('403'); return [{ name: 'c-' + sub }]; },
  };
  const found = await arm.listVisibleArmCapacities(pbi, { configuredSubscriptionId: 'S1' });
  assert.deepEqual(asked.sort(), ['S1', 'S2']);
  assert.deepEqual(found, { capacities: [{ name: 'c-S2' }], error: null });

  const none = await arm.listVisibleArmCapacities({ listSubscriptions: async () => { throw new Error('No Azure access'); }, listArmCapacities: async () => [] }, {});
  assert.deepEqual(none, { capacities: [], error: 'No Azure access' });
});

test('Pause / Resume locks the subscription and resource group when they were read from Azure', async () => {
  const ejs = require('ejs');
  const common = {
    user: { name: 'T' }, currentUser: { name: 'T', email: 't@example.com' }, currentPath: '/capacities/c1', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Capacity',
    capacity: { id: 'c1', displayName: 'fabricprod', sku: 'F64', state: 'Active' },
    schedules: [], history: [], schedulerStatus: {},
  };
  const reachable = await ejs.renderFile('src/views/capacities/detail.ejs', {
    ...common, subscriptionId: 'S2',
    armDetail: { id: '/subscriptions/S2/resourceGroups/rg-fabric/providers/Microsoft.Fabric/capacities/fabricprod', name: 'fabricprod', properties: { state: 'Active' } },
    armAccess: { status: 'reachable', subscriptionId: 'S2', resourceGroup: 'rg-fabric' },
  });
  assert.match(reachable, /id="armSubscription" value="S2"[^>]* readonly/);
  assert.match(reachable, /id="armResourceGroup" value="rg-fabric"[^>]* readonly/);
  assert.match(reachable, /bg-body-secondary/);

  const blocked = await ejs.renderFile('src/views/capacities/detail.ejs', {
    ...common, subscriptionId: '', armDetail: { error: '403' }, armAccess: { status: 'no-access' },
  });
  assert.doesNotMatch(blocked, /id="armSubscription"[^>]* readonly/);
  assert.match(blocked, /Service principal does not have access to this capacity in Azure/);
});

test('the Capacities list marks each capacity the service principal cannot reach in Azure', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/capacities/list.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T', email: 't@example.com' }, currentPath: '/capacities', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Capacities', armError: null,
    capacities: [
      { id: 'a', displayName: 'ok', sku: 'F2', armAccess: { status: 'reachable' } },
      { id: 'b', displayName: 'blocked', sku: 'F4', armAccess: { status: 'no-access' } },
      { id: 'c', displayName: 'premium', sku: 'P1', armAccess: { status: 'not-azure' } },
    ],
  });
  assert.equal((html.match(/cap-no-sp-access/g) || []).length, 1);
  assert.match(html, /Service principal does not have access/);
  assert.match(html, /Not an Azure resource/);
});

test('Run Analysis puts its hint above the button, so the button lines up with the select', () => {
  const view = require('fs').readFileSync('src/views/analysis/index.ejs', 'utf8');
  assert.match(view, /<label for="runAnalysisBtn" class="form-label">Scan &mdash; you choose the scope next<\/label>\s*<button class="btn btn-primary w-100" id="runAnalysisBtn"/);
  assert.doesNotMatch(view, /form-text text-center">You choose the scope next/);
});
