// ── Security Groups: one tenant at a time, people from the scan, groups at the end ──
const assert = require('node:assert/strict');
const test = require('node:test');
const { withFakeSql } = require('./support');
const sgRepo = require('../src/services/securityGroupRepository');
const sgPeople = require('../src/services/securityGroupPeopleService');

test('only the most specific menu entry is highlighted', async () => {
  const ejs = require('ejs');
  const sections = require('../src/services/appSectionService');
  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/quality/security-groups', pagePath: '/quality/security-groups', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'x', visibleSections: sections.APP_SECTIONS, permissions: { isAdmin: true },
  });
  const active = [...html.matchAll(/<a[^>]*class="[^"]*\bactive\b[^"]*"[^>]*title="([^"]+)"/g)].map(m => m[1]);
  const alt = [...html.matchAll(/<a[^>]*title="([^"]+)"[^>]*class="[^"]*\bactive\b/g)].map(m => m[1]);
  const highlighted = [...new Set(active.concat(alt))];
  assert.ok(highlighted.includes('Security Groups'), 'Security Groups is highlighted: ' + highlighted);
  assert.ok(!highlighted.includes('Quality Configuration'), 'Quality Configuration is not: ' + highlighted);
});

test('assignments and groups are read for one tenant, plus rows from before tenants', async () => {
  const { executed } = await withFakeSql(() => [], () => sgRepo.loadMapping('Tenant-A'));
  const reads = executed.map(e => e.sql).join('\n');
  assert.match(reads, /WHERE a\.tenant_id = @tenant OR a\.tenant_id IS NULL/);
  assert.match(reads, /WHERE g\.tenant_id = @tenant OR g\.tenant_id IS NULL/);
  assert.match(reads, /JOIN sg_groups g ON g\.id = gw\.group_id AND \(g\.tenant_id = @tenant OR g\.tenant_id IS NULL\)/);
  assert.ok(executed.every(e => !(e.params || []).length || e.params.some(p => p.name === 'tenant' && p.value === 'tenant-a')), 'the tenant is a parameter, lower-cased');
  await assert.rejects(() => sgRepo.loadMapping(''), /A tenant is required/);
});

test('a new assignment and its groups are stored under the tenant', async () => {
  const { executed } = await withFakeSql(sql => (/OUTPUT INSERTED\.id/.test(sql) ? [{ id: 5 }] : []),
    () => sgRepo.saveAssignment({ stream: 'DATA', projectRole: 'OTHER', name: 'Ann', email: 'ann@x.com', environments: ['DEV'] }, 'me', 'T-1'));
  const insertA = executed.find(e => /INSERT INTO sg_assignments/.test(e.sql));
  const insertG = executed.find(e => /INSERT INTO sg_groups/.test(e.sql));
  assert.equal(insertA.params.find(p => p.name === 'tenant').value, 't-1');
  assert.equal(insertG.params.find(p => p.name === 't').value, 't-1');
});

test('a change by id is refused when the row belongs to another tenant', async () => {
  await withFakeSql(() => [{ tenant_id: 'tenant-b' }], async () => {
    await assert.rejects(() => sgRepo.assertInTenant('group', 4, 'tenant-a'), err => err.status === 403);
  });
  await withFakeSql(() => [{ tenant_id: null }], async () => {
    assert.equal(await sgRepo.assertInTenant('attachment', 4, 'tenant-a'), true, 'a row from before tenants can be edited');
  });
  await withFakeSql(() => [], async () => {
    await assert.rejects(() => sgRepo.assertInTenant('assignment', 4, 'tenant-a'), /Not found/);
  });
});

test('the migration scopes groups per tenant and only backfills when one tenant exists', () => {
  const { SECURITY_GROUP_MIGRATIONS } = require('../src/services/securityGroupSchema');
  const sql = SECURITY_GROUP_MIGRATIONS.map(m => m.sql).join('\n');
  assert.match(sql, /ALTER TABLE sg_assignments ADD tenant_id/);
  assert.match(sql, /ALTER TABLE sg_groups ADD tenant_id/);
  assert.match(sql, /COUNT\(DISTINCT LOWER\(tenant_id\)\) FROM service_principals\) = 1/);
  assert.match(sql, /CREATE UNIQUE INDEX UX_sg_groups_identity ON sg_groups \(tenant_id, stream_id, project_role_id, environment_id\)/);
});

const GRANTS = [
  { workspace_id: 'w1', workspace_name: 'Sales', principal_type: 'User', display_name: 'Ann Lee', email: 'Ann@X.com', access_right: 'Viewer' },
  { workspace_id: 'w2', workspace_name: 'Finance', principal_type: 'User', display_name: 'Ann Lee', email: 'ann@x.com', access_right: 'Admin' },
  { workspace_id: 'w1', workspace_name: 'Sales', principal_type: 'User', display_name: 'Ben Ortiz', email: 'ben@x.com', access_right: 'Member' },
  { workspace_id: 'w1', workspace_name: 'Sales', principal_type: 'Group', display_name: 'BI Readers', email: null, access_right: 'Viewer' },
  { workspace_id: 'w2', workspace_name: 'Finance', principal_type: 'App', display_name: 'Scanner', email: null, access_right: 'Admin' },
];

test('people are the distinct users of the scan, unmapped ones treated as Other', () => {
  const people = sgPeople.buildPeople(GRANTS, [
    { id: 1, name: 'Ben Ortiz', email: 'ben@x.com', stream: 'DATA', projectRole: 'DE', environments: ['DEV'] },
    { id: 2, name: 'Cara Diaz', email: 'cara@x.com', stream: 'DATA', projectRole: 'PM', environments: ['PROD'] },
  ]);
  assert.deepEqual(people.map(p => [p.name, p.projectRole, p.mapped]), [
    ['Ann Lee', 'OTHER', false], ['Ben Ortiz', 'DE', true], ['Cara Diaz', 'PM', true],
  ], 'one row per person, unmapped first; groups and apps are not people');
  const ann = people[0];
  assert.deepEqual(ann.workspaces.map(w => [w.name, w.role]), [['Finance', 'Admin'], ['Sales', 'Viewer']]);
  assert.equal(ann.strongest, 'Admin');
  assert.equal(ann.projectRole, 'OTHER', 'Admin on a workspace does not make anyone an administrator in the plan');
  assert.equal(people[2].notInScan, true, 'mapped by hand, no workspace yet, still listed');
  assert.deepEqual(sgPeople.summarize(people), { total: 3, mapped: 2, other: 1, notInScan: 1 });
});

test('the overview ends on each group, its participants and whether its workspaces have it', () => {
  const overview = sgPeople.groupOverview([
    { id: 1, suggestedName: 'SG-DATA-DE-DEV', entraGroupId: 'g1', entraGroupName: 'SG Data DE Dev', members: [{ name: 'Ben' }], workspaces: [{ lastCheck: { state: 'present' } }] },
    { id: 2, suggestedName: 'SG-DATA-PM-PROD', members: [{ name: 'Cara' }], workspaces: [] },
    { id: 3, suggestedName: 'SG-DATA-OTHER-DEV', members: [], workspaces: [{ lastCheck: { state: 'missing' } }, { lastCheck: null }] },
    { id: 4, suggestedName: 'SG-X', members: [], workspaces: [{ lastCheck: null }] },
  ]);
  assert.deepEqual(overview.map(g => [g.name, g.status]), [
    ['SG Data DE Dev', 'verified'], ['SG-DATA-PM-PROD', 'not-attached'], ['SG-DATA-OTHER-DEV', 'problem'], ['SG-X', 'not-verified'],
  ]);
  assert.deepEqual(overview[0].participants, ['Ben']);
});

test('the page offers the tenant, the people with an editable role, and the group overview', async () => {
  const ejs = require('ejs');
  const sgMapping = require('../src/services/securityGroupMappingService');
  const securityGroups = require('../src/services/securityGroupGuideService');
  const people = sgPeople.buildPeople(GRANTS, []);
  const html = await ejs.renderFile('src/views/quality/securityGroups.ejs', {
    title: 'Security Groups', user: { name: 'T' }, currentUser: { name: 'T', email: 't@x.com' }, currentPath: '/quality/security-groups', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, error: null, tab: 'mapping',
    principles: securityGroups.PRINCIPLES, roleGroups: securityGroups.ROLE_GROUPS, tenantGroups: securityGroups.TENANT_GROUPS, antiPatterns: securityGroups.ANTI_PATTERNS,
    defaults: { prefix: securityGroups.DEFAULT_PREFIX, separator: securityGroups.DEFAULT_SEPARATOR, environments: securityGroups.DEFAULT_ENVIRONMENTS },
    plan: securityGroups.securityGroupPlan({}), sourceUrl: '#',
    projectRoles: sgMapping.PROJECT_ROLES, environments: sgMapping.ENVIRONMENTS, fabricRoles: ['Admin', 'Member', 'Contributor', 'Viewer'], rules: sgMapping.DEFAULT_RULES,
    assignments: [], groups: [],
    servicePrincipals: [{ id: 1, name: 'SoftwareOne' }, { id: 2, name: 'Contoso' }], tenantSp: { id: 2, name: 'Contoso' },
    people, peopleSummary: sgPeople.summarize(people), peopleRun: { id: 9, sp_name: 'Contoso', sp_run_number: 4 },
    groupOverview: [{ id: 1, name: 'SG-DATA-OTHER-DEV', linked: false, participants: ['Ann Lee'], workspaceCount: 0, verified: 0, problems: 0, unchecked: 0, status: 'not-attached' }],
  });
  assert.match(html, /<option value="2" selected>Contoso<\/option>/);
  assert.match(html, /People in Contoso/);
  assert.match(html, /Other · not mapped/);
  assert.match(html, /<option value="OTHER" selected>OTHER — Other<\/option>/);
  assert.match(html, /Not assigned to any workspace/);
  assert.match(html, /Security groups, participants and workspaces/);
  assert.match(html, /export\.csv\?spId=2/);
  assert.doesNotMatch(html, /id="sgSpSelect"/, 'one tenant picker for the whole page');
});

test('Security Groups refuses a tenant the user was not granted', async () => {
  const quality = require('../src/routes/quality');
  const dbService = require('../src/services/databaseService');
  const original = dbService.getServicePrincipals;
  dbService.getServicePrincipals = async () => [{ id: 1, name: 'A', tenant_id: 'TA' }, { id: 2, name: 'B', tenant_id: 'TB' }];
  try {
    const permissions = { isAdmin: false, tenantSections: { 1: ['security-groups'] } };
    const res = { locals: { permissions, globalRun: null } };
    await assert.rejects(() => quality._sgTenant({ permissions, query: { spId: '2' }, body: {} }, res), err => err.status === 403);
    const ok = await quality._sgTenant({ permissions, query: {}, body: {} }, res);
    assert.equal(ok.tenantId, 'ta');
    assert.deepEqual(ok.permitted.map(sp => sp.id), [1]);
  } finally {
    dbService.getServicePrincipals = original;
  }
});
