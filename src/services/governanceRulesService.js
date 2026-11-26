/**
 * The Governance Outcome: fixed rules over fixed query results.
 *
 * No generated text and no external service: every sentence the page shows is a
 * template below, and every number is a column from the queries or arithmetic on
 * them. Missing data is "Unknown", never 0 and never "Pass".
 *
 * Pure: no database, no clock (the caller passes generatedAt), no filesystem
 * except loadRules, which reads the rules file once.
 */

const fs = require('fs');
const path = require('path');
const { runLabel, runNumber } = require('./runLabelService');

const DEFAULT_RULES_FILE = path.join(__dirname, '..', 'config', 'governance-rules.json');
const STATUSES = ['Pass', 'Fail', 'Potential risk', 'Unknown'];
const SEVERITY_ORDER = { High: 0, Medium: 1, Low: 2 };
const STORAGE_UNITS_LABEL = 'units (likely bytes)';

const ITEM_TYPES = [
  { key: 'total_reports', label: 'Reports' },
  { key: 'total_datasets', label: 'Semantic models' },
  { key: 'total_dashboards', label: 'Dashboards' },
  { key: 'total_dataflows', label: 'Dataflows' },
  { key: 'total_lakehouses', label: 'Lakehouses' },
  { key: 'total_notebooks', label: 'Notebooks' },
  { key: 'total_pipelines', label: 'Pipelines' },
  { key: 'total_warehouses', label: 'Warehouses' },
];

const TREND_METRICS = [
  { key: 'total_workspaces', label: 'Workspaces' },
  { key: 'total_items', label: 'Items' },
  { key: 'total_warehouses', label: 'Warehouses' },
  { key: 'total_notebooks', label: 'Notebooks' },
  { key: 'total_pipelines', label: 'Pipelines' },
  { key: 'tenant_settings_total', label: 'Tenant settings' },
];

// ── Rules file ──

function validateRules(config) {
  if (!config || !Array.isArray(config.rules)) throw new Error('Governance rules: "rules" must be a list.');
  const t = config.thresholds || {};
  for (const key of ['adminSharePct', 'topWorkspacesItemSharePct', 'trendChangePct']) {
    if (!Number.isFinite(Number(t[key])) || Number(t[key]) < 0) throw new Error('Governance rules: threshold "' + key + '" must be a number of 0 or more.');
  }
  for (const rule of config.rules) {
    if (!rule.id || !rule.check) throw new Error('Governance rules: every rule needs an id and a check.');
    if (!(rule.severity in SEVERITY_ORDER)) throw new Error('Governance rules: ' + rule.id + ' has an unknown severity "' + rule.severity + '".');
    if (!STATUSES.includes(rule.statusIfHit) || rule.statusIfHit === 'Pass') throw new Error('Governance rules: ' + rule.id + ' must use Fail, Potential risk or Unknown when hit.');
    if (!CHECKS[rule.check]) throw new Error('Governance rules: ' + rule.id + ' uses an unknown check "' + rule.check + '".');
  }
  return config;
}

function loadRules(file) {
  const target = file || DEFAULT_RULES_FILE;
  return validateRules(JSON.parse(fs.readFileSync(target, 'utf8')));
}

// ── Small helpers ──

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round1(value) {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}

function iso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function pctChange(current, previous) {
  if (current === null || previous === null) return null;
  if (previous === 0) return null;
  return round1(((current - previous) / previous) * 100);
}

function flagged(workspaces, column) {
  return workspaces.filter(ws => Number(ws[column]) === 1);
}

function affectedList(rows, detail) {
  return rows.map(ws => ({ id: ws.workspace_id, name: ws.name || '(unnamed)', detail: detail ? detail(ws) : undefined }));
}

// ── Checks: each returns { evaluated, count, denominator, value?, detail, affected } ──

function workspaceFlagCheck(column, detail) {
  return ({ workspaces }) => {
    if (!workspaces.length) return { evaluated: false, reason: 'No workspaces of type Workspace in this scan.' };
    const hits = flagged(workspaces, column);
    return { evaluated: true, count: hits.length, denominator: workspaces.length, affected: affectedList(hits, detail) };
  };
}

const CHECKS = {
  noDescription: workspaceFlagCheck('no_description'),
  noPipeline: workspaceFlagCheck('no_pipeline'),
  singlePrincipal: workspaceFlagCheck('single_principal', ws => num(ws.user_count) + ' principal'),
  empty: workspaceFlagCheck('is_empty'),

  adminShareOrNoGroups: ({ access }, t) => {
    if (!access.available) return { evaluated: false, reason: 'No completed tenant scan has access data.' };
    const share = access.adminSharePct;
    const hit = (share !== null && share > t.adminSharePct) || access.groupAssignments === 0;
    return {
      evaluated: true,
      count: hit ? access.adminAssignments : 0,
      denominator: access.totalAssignments,
      value: share,
      detail: 'Admin ' + (share === null ? 'Unknown' : share + '%') + ' of assignments (threshold ' + t.adminSharePct + '%); '
        + access.groupAssignments + ' group assignment' + (access.groupAssignments === 1 ? '' : 's') + '; access data from ' + access.label + '.',
      affected: [],
    };
  },

  duplicateCapacityMetrics: ({ workspaces }) => {
    if (!workspaces.length) return { evaluated: false, reason: 'No workspaces of type Workspace in this scan.' };
    const hits = flagged(workspaces, 'is_capacity_metrics');
    const hit = hits.length > 1;
    return { evaluated: true, count: hit ? hits.length : 0, denominator: workspaces.length, value: hits.length, detail: hits.length + ' Capacity Metrics workspace' + (hits.length === 1 ? '' : 's') + ' found.', affected: hit ? affectedList(hits) : [] };
  },

  topWorkspacesConcentration: ({ workspaces, totals }, t) => {
    if (!workspaces.length) return { evaluated: false, reason: 'No workspaces of type Workspace in this scan.' };
    const n = Math.max(1, Number(t.topWorkspacesCount) || 3);
    const top = workspaces.slice().sort((a, b) => (num(b.item_count) || 0) - (num(a.item_count) || 0)).slice(0, n);
    const topItems = top.reduce((sum, ws) => sum + (num(ws.item_count) || 0), 0);
    const totalItems = totals && num(totals.total_items) !== null ? num(totals.total_items) : workspaces.reduce((sum, ws) => sum + (num(ws.item_count) || 0), 0);
    if (!totalItems) return { evaluated: false, reason: 'No items recorded, so concentration cannot be measured.' };
    const share = round1((topItems / totalItems) * 100);
    const hit = share > t.topWorkspacesItemSharePct;
    return {
      evaluated: true,
      count: hit ? top.length : 0,
      denominator: workspaces.length,
      value: share,
      detail: 'Top ' + top.length + ' hold ' + topItems + ' of ' + totalItems + ' items (' + share + '%, threshold ' + t.topWorkspacesItemSharePct + '%).',
      affected: hit ? affectedList(top, ws => num(ws.item_count) + ' items') : [],
    };
  },

  skuMissingNoShared: ({ workspaces, totals }) => {
    if (!workspaces.length) return { evaluated: false, reason: 'No workspaces of type Workspace in this scan.' };
    const shared = totals ? num(totals.workspaces_on_shared_capacity) : null;
    if (shared === null) return { evaluated: false, reason: 'Totals for this scan were not stored.' };
    const missing = flagged(workspaces, 'no_sku');
    const hit = missing.length > 0 && shared === 0;
    return {
      evaluated: true,
      count: hit ? missing.length : 0,
      denominator: workspaces.length,
      detail: missing.length + ' without a recorded SKU; ' + shared + ' workspace' + (shared === 1 ? '' : 's') + ' on shared capacity.',
      affected: hit ? affectedList(missing) : [],
    };
  },

  trendChange: ({ trend }, t) => {
    if (trend.runs.length < 2) return { evaluated: false, reason: 'Needs at least two completed tenant scans with totals.' };
    const last = trend.runs[trend.runs.length - 1];
    const prev = trend.runs[trend.runs.length - 2];
    const hits = TREND_METRICS.filter(m => last.changes[m.key] && last.changes[m.key].hit);
    return {
      evaluated: true,
      count: hits.length,
      denominator: TREND_METRICS.length,
      detail: last.label + ' compared with ' + prev.label + ' (threshold ±' + t.trendChangePct + '%).',
      affected: hits.map(m => ({ id: m.key, name: m.label, detail: prev.values[m.key] + ' → ' + last.values[m.key] + ' (' + (last.changes[m.key].pct > 0 ? '+' : '') + last.changes[m.key].pct + '%)' })),
    };
  },
};

// ── Sections ──

function buildAccess(accessRun, rows, runId) {
  if (!accessRun) return { available: false, runId: null, number: null, label: null, completedAt: null, isLatestRun: false };
  const byType = new Map();
  const rights = new Set();
  let total = 0;
  let admin = 0;
  let groups = 0;
  for (const row of rows || []) {
    const type = row.principal_type || 'Unknown';
    const right = row.access_right || 'Unknown';
    const n = num(row.assignments) || 0;
    total += n;
    if (right === 'Admin') admin += n;
    if (type === 'Group') groups += n;
    rights.add(right);
    const entry = byType.get(type) || { principalType: type, total: 0, distinctPrincipals: 0, byRight: {} };
    entry.total += n;
    entry.distinctPrincipals += num(row.distinct_principals) || 0;
    entry.byRight[right] = (entry.byRight[right] || 0) + n;
    byType.set(type, entry);
  }
  const rightOrder = ['Admin', 'Member', 'Contributor', 'Viewer'];
  return {
    available: true,
    runId: accessRun.access_run_id,
    spId: accessRun.sp_id === undefined ? null : accessRun.sp_id,
    number: runNumber(accessRun),
    label: runLabel({ ...accessRun, id: accessRun.access_run_id }),
    completedAt: iso(accessRun.access_completed_at),
    isLatestRun: accessRun.access_run_id === runId,
    totalAssignments: total,
    adminAssignments: admin,
    adminSharePct: total ? round1((admin / total) * 100) : null,
    groupAssignments: groups,
    rights: Array.from(rights).sort((a, b) => (rightOrder.indexOf(a) + 1 || 99) - (rightOrder.indexOf(b) + 1 || 99) || a.localeCompare(b)),
    byPrincipalType: Array.from(byType.values()).sort((a, b) => b.total - a.total),
  };
}

function buildTrend(rows, thresholdPct) {
  const runs = [];
  for (const row of rows || []) {
    const values = {};
    for (const m of TREND_METRICS) values[m.key] = num(row[m.key]);
    const prev = runs[runs.length - 1];
    const changes = {};
    for (const m of TREND_METRICS) {
      if (!prev) { changes[m.key] = null; continue; }
      const abs = values[m.key] === null || prev.values[m.key] === null ? null : values[m.key] - prev.values[m.key];
      const pct = pctChange(values[m.key], prev.values[m.key]);
      changes[m.key] = { abs, pct, hit: pct !== null && Math.abs(pct) > thresholdPct };
    }
    runs.push({ runId: row.run_id, number: runNumber(row), label: runLabel({ ...row, id: row.run_id }), completedAt: iso(row.completed_at), values, changes });
  }
  return { metrics: TREND_METRICS, thresholdPct, runs };
}

function buildKpis(totals) {
  const v = key => (totals ? num(totals[key]) : null);
  const scanned = v('storage_scanned_count');
  const raw = v('total_storage_size');
  const collected = scanned !== null && scanned > 0;
  return {
    workspaces: v('total_workspaces'),
    items: v('total_items'),
    users: v('total_users'),
    creators: v('creator_count'),
    explorers: v('explorer_count'),
    capacities: v('capacity_count'),
    workspacesOnCapacity: v('workspaces_on_capacity'),
    workspacesOnSharedCapacity: v('workspaces_on_shared_capacity'),
    settings: {
      total: v('tenant_settings_total'),
      enabled: v('tenant_settings_enabled'),
      disabled: v('tenant_settings_disabled'),
      groupScoped: v('tenant_settings_group_scoped'),
      delegated: v('tenant_settings_delegated'),
    },
    storage: {
      status: scanned === null ? 'Unknown' : (collected ? 'Collected' : 'Not collected'),
      raw: collected ? raw : null,
      unitsLabel: STORAGE_UNITS_LABEL,
      approxGb: collected && raw !== null ? round1(raw / (1024 ** 3)) : null,
      files: collected ? v('total_storage_files') : null,
      scannedWorkspaces: scanned,
    },
    capturedAt: totals ? iso(totals.captured_at) : null,
  };
}

function buildGaps({ run, totals, access, workspaces, trend, connectionMode, kpis }) {
  const gaps = [];
  if (!totals) gaps.push({ id: 'totals-missing', message: 'Totals were not stored for ' + runLabel({ ...run, id: run.run_id }) + ', so the KPI values show as Unknown.' });
  if (kpis.storage.status === 'Not collected') gaps.push({ id: 'storage-not-collected', message: 'Storage was not collected in this scan (storage_scanned_count = 0), so it shows as "Not collected".' });
  if (kpis.storage.status === 'Collected') gaps.push({ id: 'storage-units', message: 'Storage units are not confirmed: the raw value is shown as ' + STORAGE_UNITS_LABEL + ', and the GB figure is approximate.' });
  if (!access.available) gaps.push({ id: 'access-missing', message: 'No completed tenant scan has access data, so access is Unknown and F3 is not evaluated.' });
  else if (!access.isLatestRun) gaps.push({ id: 'access-older-run', message: 'Access data from ' + access.label + ' (' + (access.completedAt ? access.completedAt.replace('T', ' ').slice(0, 19) + ' UTC' : 'date unknown') + '); latest run has no access data.' });
  const noSku = flagged(workspaces, 'no_sku').length;
  if (noSku) gaps.push({ id: 'sku-not-recorded', message: noSku + ' workspace' + (noSku === 1 ? ' has' : 's have') + ' no capacity SKU recorded; shown as "(not recorded)".' });
  if (trend.runs.length < 2) gaps.push({ id: 'trend-short', message: 'Fewer than two completed tenant scans have totals, so there is no trend and T1 is not evaluated.' });
  if (connectionMode === 'application') gaps.push({ id: 'reader-not-configured', message: 'No dedicated read-only database login is configured; the outcome is read through the application\'s connection (see README: Governance Outcome).' });
  return gaps;
}

/**
 * The whole outcome for one tenant and one run.
 *
 * `data` is what the repository returned; `run` is Q1's row. Every query was
 * already tied to the tenant, and this function only ever sees that tenant's rows.
 */
function buildOutcome({ run, data, rules, connectionMode = 'application', generatedAt, trigger = 'on-demand' }) {
  const t = { ...rules.thresholds };
  for (const key of Object.keys(t)) t[key] = Number(t[key]);
  const totals = data.totals || null;
  const workspaces = data.workspaces || [];
  const access = buildAccess(data.accessRun, data.access, run.run_id);
  const trend = buildTrend(data.trend, t.trendChangePct);
  const kpis = buildKpis(totals);
  const dataTimestamp = iso(run.completed_at);
  // A scan is named by its principal and that principal's number; run_id is only the join key.
  const scanRef = { spId: run.sp_id === undefined ? null : run.sp_id, principal: run.sp_name || null, number: runNumber(run), label: runLabel({ ...run, id: run.run_id }) };

  const context = { workspaces, totals, access, trend };
  const findings = rules.rules.map(rule => {
    const result = CHECKS[rule.check](context, t);
    const base = { id: rule.id, title: rule.title, category: rule.category, severity: rule.severity, runId: run.run_id, scan: scanRef, dataTimestamp };
    if (!result.evaluated) return { ...base, status: 'Unknown', count: null, denominator: null, value: null, detail: result.reason, affected: [] };
    return {
      ...base,
      status: result.count === 0 ? 'Pass' : rule.statusIfHit,
      count: result.count,
      denominator: result.denominator === undefined ? null : result.denominator,
      value: result.value === undefined ? null : result.value,
      detail: result.detail || null,
      affected: result.affected || [],
    };
  }).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id, 'en', { numeric: true }));

  const workspacesByType = (data.workspacesByType || [])
    .map(row => ({ type: row.type || '(not recorded)', workspaces: num(row.workspaces) }))
    .sort((a, b) => (b.workspaces || 0) - (a.workspaces || 0) || a.type.localeCompare(b.type));
  const skus = (data.skus || [])
    .map(row => ({ sku: row.sku || '(not recorded)', workspaces: num(row.workspaces), items: num(row.items), pctItems: num(row.pct_items) }))
    .sort((a, b) => (b.workspaces || 0) - (a.workspaces || 0) || a.sku.localeCompare(b.sku));

  return {
    tenant: { id: String(run.tenant_id || '').toLowerCase(), name: run.sp_name || null },
    run: { id: run.run_id, spId: scanRef.spId, principal: scanRef.principal, number: scanRef.number, label: scanRef.label, status: run.status, scopeKind: run.scope_kind, startedAt: iso(run.started_at), completedAt: dataTimestamp, runBy: run.run_by || null },
    dataAsOf: dataTimestamp,
    kpis,
    itemTypes: ITEM_TYPES.map(type => ({ key: type.key, label: type.label, value: totals ? num(totals[type.key]) : null })),
    workspacesByType,
    skus,
    findings,
    summary: {
      potentialRisk: findings.filter(f => f.status === 'Potential risk').length,
      fail: findings.filter(f => f.status === 'Fail').length,
      unknown: findings.filter(f => f.status === 'Unknown').length,
      pass: findings.filter(f => f.status === 'Pass').length,
    },
    access,
    trend,
    deletions: (data.deletions || []).map(row => ({ workspaceName: row.workspace_name || '(unnamed)', state: row.state, deletedAt: iso(row.deleted_at), runId: row.run_id, scan: row.run_id ? runLabel({ ...row, id: row.run_id }) : null })),
    gaps: buildGaps({ run, totals, access, workspaces, trend, connectionMode, kpis }),
    meta: { generatedAt: iso(generatedAt), trigger, connectionMode, rulesVersion: rules.version || null, thresholds: t },
  };
}

module.exports = {
  STATUSES,
  ITEM_TYPES,
  TREND_METRICS,
  STORAGE_UNITS_LABEL,
  DEFAULT_RULES_FILE,
  CHECKS,
  loadRules,
  validateRules,
  pctChange,
  buildAccess,
  buildTrend,
  buildKpis,
  buildOutcome,
};
