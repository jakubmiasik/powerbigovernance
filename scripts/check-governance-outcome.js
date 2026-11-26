#!/usr/bin/env node
/**
 * Generates the Governance Outcome against the configured database and prints the
 * figures the acceptance tests name. Read-only: the same queries the page uses.
 *
 *   node scripts/check-governance-outcome.js [tenantId] [--acceptance] [--json]
 *
 * --acceptance compares with the agreed SoftwareOne figures and exits 1 on a mismatch.
 * Those figures name scans by their internal id (37, 36, ...); the page names them
 * by principal and that principal's scan number, which this script also prints.
 */
const { getConfig } = require('../src/config/settings');
const { getOutcome } = require('../src/services/governanceOutcomeService');

const ACCEPTANCE = {
  runId: 37,
  completedAt: '2026-11-26 09:52:30 UTC',
  kpis: { workspaces: 63, items: 578, users: 27, creators: 17, explorers: 10, capacities: 11 },
  itemTypes: { Reports: 45, 'Semantic models': 94, Dashboards: 0, Dataflows: 6, Lakehouses: 48, Notebooks: 104, Pipelines: 76, Warehouses: 67 },
  settings: { total: 189, enabled: 120, disabled: 69, groupScoped: 3, delegated: 21 },
  workspacesByType: { Workspace: 37, AdminWorkspace: 1, Personal: 25 },
  skus: { F8: [12, 407], F2: [16, null], '(not recorded)': [9, null] },
  findings: { F1: '37/37', F2: '37/37', F4: '1/37', F5: '2/37' },
  hits: ['F3', 'F6', 'F7', 'T1'],
  access: { runId: 36, total: 108, admin: 96, adminShare: 88.9, user: 65, app: 43, group: 0 },
  trendRuns: [24, 28, 29, 36, 37],
  deletions: 28,
  storage: 'Not collected',
};

function utc(iso) { return iso ? iso.replace('T', ' ').slice(0, 19) + ' UTC' : 'Unknown'; }

async function main() {
  const args = process.argv.slice(2);
  const tenantId = (args.find(a => !a.startsWith('--')) || getConfig().governance.tenantId).toLowerCase();
  const result = await getOutcome(tenantId, { force: true, trigger: 'on-demand' });
  if (result.status !== 200) {
    console.error(result.status + ': ' + result.message);
    process.exit(1);
  }
  const o = result.outcome;
  if (args.includes('--json')) { console.log(JSON.stringify(o, null, 2)); return; }

  const actual = {
    runId: o.run.id,
    scan: o.run.label,
    completedAt: utc(o.run.completedAt),
    kpis: { workspaces: o.kpis.workspaces, items: o.kpis.items, users: o.kpis.users, creators: o.kpis.creators, explorers: o.kpis.explorers, capacities: o.kpis.capacities },
    itemTypes: Object.fromEntries(o.itemTypes.map(t => [t.label, t.value])),
    settings: o.kpis.settings,
    workspacesByType: Object.fromEntries(o.workspacesByType.map(t => [t.type, t.workspaces])),
    skus: Object.fromEntries(o.skus.map(s => [s.sku, [s.workspaces, s.items]])),
    findings: Object.fromEntries(o.findings.map(f => [f.id, f.count === null ? 'Unknown' : f.count + '/' + f.denominator])),
    statuses: Object.fromEntries(o.findings.map(f => [f.id, f.status])),
    access: o.access.available ? {
      runId: o.access.runId, scan: o.access.label, total: o.access.totalAssignments, admin: o.access.adminAssignments, adminShare: o.access.adminSharePct,
      user: (o.access.byPrincipalType.find(t => t.principalType === 'User') || { total: 0 }).total,
      app: (o.access.byPrincipalType.find(t => t.principalType === 'App') || { total: 0 }).total,
      group: o.access.groupAssignments,
    } : null,
    trendRuns: o.trend.runs.map(r => r.runId),
    trendScans: o.trend.runs.map(r => r.label),
    deletions: o.deletions.length,
    storage: o.kpis.storage.status,
    gaps: o.gaps.map(g => g.message),
  };
  console.log('Tenant ' + o.tenant.name + ' (' + o.tenant.id + ') · read with: ' + o.meta.connectionMode);
  console.log(JSON.stringify(actual, null, 2));

  if (!args.includes('--acceptance')) return;
  const problems = [];
  const same = (label, want, got) => { if (JSON.stringify(want) !== JSON.stringify(got)) problems.push(label + ': expected ' + JSON.stringify(want) + ', got ' + JSON.stringify(got)); };
  same('run', ACCEPTANCE.runId, actual.runId);
  same('completed', ACCEPTANCE.completedAt, actual.completedAt);
  same('kpis', ACCEPTANCE.kpis, actual.kpis);
  same('item types', ACCEPTANCE.itemTypes, actual.itemTypes);
  same('settings', ACCEPTANCE.settings, actual.settings);
  for (const [type, n] of Object.entries(ACCEPTANCE.workspacesByType)) same('workspaces of type ' + type, n, actual.workspacesByType[type]);
  for (const [sku, [ws, items]] of Object.entries(ACCEPTANCE.skus)) {
    same('SKU ' + sku + ' workspaces', ws, (actual.skus[sku] || [])[0]);
    if (items !== null) same('SKU ' + sku + ' items', items, (actual.skus[sku] || [])[1]);
  }
  for (const [id, ratio] of Object.entries(ACCEPTANCE.findings)) same(id, ratio, actual.findings[id]);
  for (const id of ACCEPTANCE.hits) if (actual.statuses[id] === 'Pass' || actual.statuses[id] === 'Unknown') problems.push(id + ' should be hit, is ' + actual.statuses[id]);
  const { scan: _accessScan, ...accessFigures } = actual.access || {};
  same('access', ACCEPTANCE.access, actual.access ? accessFigures : null);
  same('trend runs', ACCEPTANCE.trendRuns, actual.trendRuns);
  same('deletions', ACCEPTANCE.deletions, actual.deletions);
  same('storage', ACCEPTANCE.storage, actual.storage);
  if (!actual.gaps.some(g => g.startsWith('Access data from ' + (actual.access && actual.access.scan)))) problems.push('the "access data from an earlier scan" banner is missing');

  if (problems.length) {
    console.error('\nAcceptance: ' + problems.length + ' mismatch(es)\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  console.log('\nAcceptance: all figures match.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
