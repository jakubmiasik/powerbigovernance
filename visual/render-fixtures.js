#!/usr/bin/env node
// Renders Fabric Governance screens with a fixed, made-up tenant into
// visual/.out/*.html for the visual regression tests. Uses the real views,
// services and @podavo/ui assets; no database, no Fabric API, no server.
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, '.out');
fs.mkdirSync(out, { recursive: true });
const insightsSvc = require('../src/services/workspaceInsightsService');
const namingService = require('../src/services/namingConventionService');
const sections = require('../src/services/appSectionService');
const analysisScope = require('../src/services/analysisScopeService');

// Deterministic fixture tenant: the same 40 workspaces on every run.
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const names = ['Sales Analytics', 'Finance Reporting', 'Customer Insights', 'Operations Hub', 'Marketing Analytics', 'HR Analytics', 'Procurement BI', 'Supply Chain', 'IT Operations', 'Executive Dashboards', 'Data Engineering', 'Product Usage', 'Risk & Compliance', 'Treasury', 'Field Service', 'Retail Pricing', 'Logistics Control Tower', 'Quality Assurance', 'Legal Matters', 'Partner Portal', 'Sandbox Anna', 'Sandbox Tom', 'Archive 2019', 'Pilot Copilot', 'Energy Trading', 'Fleet Telemetry', 'Customer Churn ML', 'Warehouse Ops', 'Payroll', 'Budget Planning 2027', 'Store Performance', 'Audit Trail', 'Group Consolidation', 'Credit Control', 'ESG Reporting', 'Inventory Health', 'Web Analytics', 'Contact Center', 'Mobile App KPIs', 'Merchandising'];
const people = ['Ann Lee', 'Ben Ortiz', 'Chloe Diaz', 'Dev Patel', 'Eva Novak', 'Femi Ade', 'Gita Rao', 'Hugo Klein'];
const types = ['Report', 'SemanticModel', 'Lakehouse', 'Notebook', 'DataPipeline', 'Warehouse', 'Dashboard', 'Dataflow'];
const workspaces = names.map((name, i) => {
  const users = [];
  const nUsers = Math.floor(rnd() * 8);
  for (let u = 0; u < nUsers; u++) {
    const person = people[Math.floor(rnd() * people.length)];
    const role = u === 0 && rnd() > 0.25 ? 'Admin' : ['Member', 'Contributor', 'Viewer', 'Admin'][Math.floor(rnd() * 4)];
    users.push(rnd() > 0.8 ? { name: 'BI Readers', role, type: 'Group' } : { name: person, email: person.split(' ')[0].toLowerCase() + '@contoso.com', role, type: 'User' });
  }
  const items = [];
  const nItems = i % 9 === 0 ? 0 : Math.floor(rnd() * 25);
  const age = Math.floor(rnd() * 300);
  for (let k = 0; k < nItems; k++) {
    items.push({ id: name + k, name: (rnd() > 0.5 ? 'DE_LH_100_BRONZE_' : 'Item ') + k, type: types[Math.floor(rnd() * types.length)],
      lastUpdated: new Date(Date.parse('2026-11-20') - age * 864e5).toISOString(),
      creator: rnd() > 0.9 ? { name: 'Gone Person', upn: 'gone@contoso.com' } : { name: people[0], upn: 'ann@contoso.com' } });
  }
  const fabric = rnd() > 0.4;
  return { id: 'ws-' + i, name, state: i === 22 ? 'Inactive' : 'Active', users, items, licenseType: fabric ? 'Fabric' : 'Pro',
    capacityId: fabric ? 'cap-1' : null, capacitySku: fabric ? 'F64' : null, capacityName: fabric ? 'Fabric-Cap-East' : null,
    totalItems: nItems, reportCount: items.filter(x => x.type === 'Report').length, datasetCount: items.filter(x => x.type === 'SemanticModel').length,
    userCount: users.length, storageSize: fabric ? Math.floor(rnd() * 5e10) : 0, storageFiles: Math.floor(rnd() * 9000) };
});
const decorate = r => ({ ...r, scopeTag: analysisScope.scopeTag(r), scopeTagTitle: analysisScope.scopeTagTitle(r) });
const run = decorate({ id: 412, sp_name: 'Contoso Governance SP', tenant_id: '00000000-0000-4000-8000-000000000412', started_at: '2026-11-25T02:00:00Z', completed_at: '2026-11-25T02:41:00Z', total_workspaces: 40, total_reports: 212, status: 'completed', scope_kind: 'tenant' });
const shell = { currentUser: { name: 'Jordan Miller', email: 'jordan@contoso.com' }, user: { name: 'Jordan' }, availableRuns: [run], globalRun: run, selectedRunId: run.id,
  visibleSections: sections.APP_SECTIONS, permissions: { isAdmin: true }, navGroups: sections.NAV_GROUPS };
const naming = { ...namingService.DEFAULT_CONVENTION, enabled: true };
const insights = insightsSvc.computeWorkspaceInsights({ workspaces }, { namingConvention: naming, referenceDate: run.completed_at });
const summary = { totalWorkspaces: 40, workspacesByState: { Active: 39, Inactive: 1 }, workspacesBySku: { F64: 24, 'Shared (Pro)': 16 },
  capacities: [{ state: 'Active' }, { state: 'Active' }, { state: 'Suspended' }], totalStorageSize: workspaces.reduce((a, w) => a + w.storageSize, 0),
  storageScannedCount: 24, totalStorageFiles: 120000, totalItems: 512, totalReports: 212, totalDatasets: 98, totalDashboards: 12, totalDataflows: 9,
  totalLakehouses: 30, totalNotebooks: 41, totalPipelines: 22, totalWarehouses: 6, totalUsers: 188, workspacesOnCapacity: 24, workspacesOnSharedCapacity: 16 };

// Local assets by file URL; CDN assets (Bootstrap, Lucide) load as in production.
const fileUrl = p => url.pathToFileURL(path.join(root, p)).href;
function localise(html) {
  return html
    .replace('/podavo-ui/css/podavo.css', fileUrl('packages/podavo-ui/css/podavo.css'))
    .replace('/podavo-ui/css/bootstrap-bridge.css', fileUrl('packages/podavo-ui/css/bootstrap-bridge.css'))
    .replace('href="/css/style.css"', 'href="' + fileUrl('src/public/css/style.css') + '"')
    .replace('src="/podavo-ui/js/podavo.js"', 'src="' + fileUrl('packages/podavo-ui/js/podavo.js') + '"')
    .replace('src="/js/icon-map.js"', 'src="' + fileUrl('src/public/js/icon-map.js') + '"')
    .replace('src="/js/app.js"', 'src="' + fileUrl('src/public/js/app.js') + '"')
    .replace("fetch('/governance/tenant-settings/data')", "Promise.resolve({ json: () => ({ success: true, total: 142, enabled: 97, disabled: 45, securityGroupScoped: 31, delegated: 8, groups: [{ name: 'Export and sharing settings', total: 30, enabled: 21 }] }) })");
}
const workspaceContext = Object.fromEntries(workspaces.map(w => {
  const admins = w.users.filter(u => insightsSvc.isAdminRole(u.role) && insightsSvc.isPersonPrincipal(u));
  return [w.id, { owner: admins[0] ? admins[0].name : null, groupCount: w.users.filter(insightsSvc.isGroupPrincipal).length,
    peopleCount: w.users.filter(insightsSvc.isPersonPrincipal).length, usersRead: w.users.length > 0, capacityName: w.capacityName }];
}));
const pages = {
  triage: ['src/views/workspaces/list.ejs', { ...shell, title: 'Workspaces', currentPath: '/workspaces', breadcrumb: [{ label: 'Workspaces', href: '/workspaces' }],
    fromSavedData: true, run, insights, findingDefs: insightsSvc.FINDING_DEFS, namingPattern: namingService.describeConvention(naming), workspaceContext, reportCount: 212 }],
  overview: ['src/views/governance/overview.ejs', { ...shell, title: 'Governance Overview', currentPath: '/governance', breadcrumb: [{ label: 'Governance Overview', href: '/governance' }],
    governance: summary, workspaces, run, noData: false, creatorCount: 61, explorerCount: 127, insights, findingDefs: insightsSvc.FINDING_DEFS }],
  'no-access': ['src/views/no-access.ejs', { ...shell, title: 'No access', currentPath: '/mdm', breadcrumb: [{ label: 'Master Data', href: '/mdm' }],
    section: sections.getSection('mdm'), message: null, permissions: { isAdmin: false, isKnown: false }, visibleSections: sections.APP_SECTIONS.slice(0, 4) }],
};
(async () => {
  for (const [name, [view, data]] of Object.entries(pages)) {
    const html = await ejs.renderFile(path.join(root, view), data);
    fs.writeFileSync(path.join(out, name + '.html'), localise(html));
  }
  console.log('Rendered ' + Object.keys(pages).length + ' screens to ' + path.relative(root, out));
})().catch(err => { console.error(err); process.exit(1); });
