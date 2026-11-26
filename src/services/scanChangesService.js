/**
 * What changed between two completed scans of the same tenant.
 *
 * Everything here is derived from the two stored scan documents: nothing is
 * fetched, estimated or carried over from elsewhere. Where a scan did not collect
 * something (storage, access lists), the answer is "not collected", never zero,
 * so a gap in the data cannot read as a quiet tenant.
 *
 * Pure: no database, no API, no clock. The route loads the runs and hands them in.
 */

const { computeWorkspaceInsights, FINDING_DEFS, isAdminRole, isPersonPrincipal, userDisplay } = require('./workspaceInsightsService');
const { scopeFromRow } = require('./analysisScopeService');
const { isGuestUpn } = require('./permissionService');

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const FINDING_BY_KEY = new Map(FINDING_DEFS.map(def => [def.key, def]));

// ── Choosing what to compare with ──

function tenantKeyOf(run) {
  if (!run) return '';
  if (run.tenant_id) return 'tenant:' + String(run.tenant_id).toLowerCase();
  if (run.sp_id !== null && run.sp_id !== undefined) return 'sp:' + run.sp_id;
  return '';
}

// Two runs only compare fairly when they looked at the same thing: a scan of three
// workspaces is not "the tenant lost 200 workspaces" against a whole-tenant scan.
function scopeKeyOf(run) {
  const scope = scopeFromRow(run || {});
  if (scope.kind !== 'workspaces') return 'tenant';
  return 'ws:' + scope.workspaces.map(ws => String(ws.id).toLowerCase()).sort().join(',');
}

function timeOf(run) {
  const value = run && (run.started_at || run.completed_at);
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Earlier completed runs of the same tenant and scope, newest first. */
function comparableRuns(run, runs) {
  const tenant = tenantKeyOf(run);
  if (!run || !tenant) return [];
  const scope = scopeKeyOf(run);
  const at = timeOf(run);
  return (runs || [])
    .filter(other => other && other.id !== run.id
      && (!other.status || other.status === 'completed')
      && tenantKeyOf(other) === tenant
      && scopeKeyOf(other) === scope
      && timeOf(other) < at)
    .sort((a, b) => timeOf(b) - timeOf(a));
}

function previousRun(run, runs) {
  return comparableRuns(run, runs)[0] || null;
}

// ── Small helpers ──

function workspacesOf(results) {
  return (results && Array.isArray(results.workspaces)) ? results.workspaces : [];
}

function indexBy(list, keyFn) {
  const map = new Map();
  for (const entry of list || []) {
    const key = keyFn(entry);
    if (key !== null && key !== undefined && key !== '') map.set(String(key), entry);
  }
  return map;
}

function stamp(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function delta(now, before) {
  if (now === null || now === undefined || before === null || before === undefined) return null;
  return now - before;
}

function creatorKey(creator) {
  if (!creator) return '';
  if (typeof creator === 'string') return creator.trim().toLowerCase();
  return String(creator.upn || creator.name || '').trim().toLowerCase();
}

function accessKey(user) {
  return String((user && (user.email || user.name)) || '').trim().toLowerCase();
}

function isGuestUser(user) {
  return isPersonPrincipal(user) && isGuestUpn(user && user.email);
}

// Storage is optional in a scan. A scan that measured nothing must say so rather
// than report an empty tenant.
function storageCollected(results) {
  if (!results) return false;
  const summary = results.summary || {};
  if (count(summary.storageScannedCount) > 0 || count(summary.totalStorageSize) > 0) return true;
  return workspacesOf(results).some(ws => count(ws.storageSize) > 0);
}

function totalStorage(results) {
  return workspacesOf(results).reduce((sum, ws) => sum + count(ws.storageSize), 0);
}

function guestKeys(results) {
  const keys = new Set();
  for (const ws of workspacesOf(results)) {
    for (const user of ws.users || []) if (isGuestUser(user)) keys.add(accessKey(user));
  }
  keys.delete('');
  return keys;
}

function peopleWithAccess(results) {
  const keys = new Set();
  for (const ws of workspacesOf(results)) {
    for (const user of ws.users || []) if (isPersonPrincipal(user)) keys.add(accessKey(user));
  }
  keys.delete('');
  return keys;
}

function itemCount(results) {
  return workspacesOf(results).reduce((sum, ws) => sum + (ws.items || []).length, 0);
}

// ── Findings ──

function findingsByWorkspace(insights) {
  const map = new Map();
  for (const ws of (insights && insights.workspaces) || []) {
    map.set(String(ws.id), new Set((ws.findings || []).map(f => f.key)));
  }
  return map;
}

function ownersOf(workspace) {
  return (workspace && workspace.users ? workspace.users : [])
    .filter(user => isAdminRole(user.role) && isPersonPrincipal(user))
    .map(userDisplay);
}

/**
 * Every finding in the newer scan, marked new or still open, plus the ones the
 * newer scan no longer raises. A workspace that has gone entirely is reported as
 * removed inventory, not as a fixed finding: nobody fixed anything.
 */
function compareFindings(toInsights, fromInsights, toResults, hasBaseline) {
  const toById = indexBy(workspacesOf(toResults), ws => ws.id);
  const before = fromInsights ? findingsByWorkspace(fromInsights) : new Map();
  const rows = [];

  for (const ws of (toInsights && toInsights.workspaces) || []) {
    if (ws.state === 'Deleted') continue;
    const had = before.get(String(ws.id));
    for (const finding of ws.findings || []) {
      rows.push({
        key: finding.key,
        label: finding.label,
        severity: finding.severity,
        detail: finding.detail || '',
        description: (FINDING_BY_KEY.get(finding.key) || {}).description || '',
        workspaceId: ws.id,
        workspaceName: ws.name,
        totalItems: ws.totalItems,
        owners: ownersOf(toById.get(String(ws.id))),
        status: hasBaseline && !(had && had.has(finding.key)) ? 'new' : 'open',
      });
    }
  }

  const now = findingsByWorkspace(toInsights);
  for (const ws of (fromInsights && fromInsights.workspaces) || []) {
    if (!now.has(String(ws.id))) continue;
    const still = now.get(String(ws.id));
    for (const finding of ws.findings || []) {
      if (still.has(finding.key)) continue;
      rows.push({
        key: finding.key,
        label: finding.label,
        severity: finding.severity,
        detail: finding.detail || '',
        description: (FINDING_BY_KEY.get(finding.key) || {}).description || '',
        workspaceId: ws.id,
        workspaceName: (toById.get(String(ws.id)) || {}).name || ws.name,
        totalItems: ws.totalItems,
        owners: ownersOf(toById.get(String(ws.id))),
        status: 'resolved',
      });
    }
  }

  const statusRank = { new: 0, open: 1, resolved: 2 };
  rows.sort((a, b) => statusRank[a.status] - statusRank[b.status]
    || (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
    || (b.totalItems || 0) - (a.totalItems || 0)
    || String(a.workspaceName).localeCompare(String(b.workspaceName)));

  const tally = { new: 0, open: 0, resolved: 0, high: 0, medium: 0, low: 0 };
  for (const row of rows) {
    tally[row.status] += 1;
    if (row.status !== 'resolved') tally[row.severity] = (tally[row.severity] || 0) + 1;
  }
  return { rows, tally };
}

// ── Inventory ──

function compareInventory(toResults, fromResults) {
  const toWs = indexBy(workspacesOf(toResults), ws => ws.id);
  const fromWs = indexBy(workspacesOf(fromResults), ws => ws.id);
  const byType = new Map();
  const typeRow = type => {
    const key = type || 'Unknown';
    if (!byType.has(key)) byType.set(key, { type: key, now: 0, added: 0, removed: 0, updated: 0 });
    return byType.get(key);
  };

  const workspaces = { now: toWs.size, added: 0, removed: 0 };
  for (const id of toWs.keys()) if (fromResults && !fromWs.has(id)) workspaces.added += 1;
  for (const id of fromWs.keys()) if (!toWs.has(id)) workspaces.removed += 1;

  const fromItems = new Map();
  for (const ws of fromWs.values()) for (const item of ws.items || []) fromItems.set(ws.id + '/' + item.id, item);
  const seen = new Set();
  for (const ws of toWs.values()) {
    for (const item of ws.items || []) {
      const key = ws.id + '/' + item.id;
      seen.add(key);
      const row = typeRow(item.type);
      row.now += 1;
      if (!fromResults) continue;
      const old = fromItems.get(key);
      if (!old) row.added += 1;
      else if (stamp(old.lastUpdated) && stamp(item.lastUpdated) && stamp(old.lastUpdated) !== stamp(item.lastUpdated)) row.updated += 1;
    }
  }
  for (const [key, item] of fromItems) if (!seen.has(key)) typeRow(item.type).removed += 1;

  const types = Array.from(byType.values())
    .sort((a, b) => (b.added + b.removed + b.updated) - (a.added + a.removed + a.updated) || b.now - a.now || a.type.localeCompare(b.type));
  const totals = types.reduce((sum, row) => ({
    now: sum.now + row.now, added: sum.added + row.added, removed: sum.removed + row.removed, updated: sum.updated + row.updated,
  }), { now: 0, added: 0, removed: 0, updated: 0 });
  return { workspaces, types, totals };
}

// ── People ──

/**
 * Who made things, and who gained or lost access.
 *
 * The scan records an item's creator and when it was last updated, not who
 * updated it. "Updated" here is therefore an item someone created that changed
 * between the two scans, credited to its creator, and labelled as such.
 */
function comparePeople(toResults, fromResults, { limit = 15 } = {}) {
  const fromItems = new Map();
  for (const ws of workspacesOf(fromResults)) for (const item of ws.items || []) fromItems.set(ws.id + '/' + item.id, item);

  const people = new Map();
  const person = (key, name, upn) => {
    if (!people.has(key)) people.set(key, { key, name: name || upn || 'Unknown', upn: upn || '', guest: isGuestUpn(upn), items: 0, newItems: 0, updatedItems: 0, workspaces: new Set(), adminOf: new Set(), types: new Map() });
    return people.get(key);
  };

  for (const ws of workspacesOf(toResults)) {
    for (const user of ws.users || []) {
      if (!isPersonPrincipal(user)) continue;
      const key = accessKey(user);
      if (!key) continue;
      const entry = person(key, user.name, user.email);
      entry.workspaces.add(String(ws.id));
      if (isAdminRole(user.role)) entry.adminOf.add(String(ws.id));
    }
    for (const item of ws.items || []) {
      const key = creatorKey(item.creator);
      if (!key) continue;
      const creator = typeof item.creator === 'string' ? { name: item.creator } : item.creator;
      const entry = person(key, creator.name, creator.upn);
      entry.items += 1;
      entry.types.set(item.type || 'Unknown', (entry.types.get(item.type || 'Unknown') || 0) + 1);
      if (!fromResults) continue;
      const old = fromItems.get(ws.id + '/' + item.id);
      if (!old) entry.newItems += 1;
      else if (stamp(old.lastUpdated) && stamp(item.lastUpdated) && stamp(old.lastUpdated) !== stamp(item.lastUpdated)) entry.updatedItems += 1;
    }
  }

  const all = Array.from(people.values()).map(entry => ({
    key: entry.key,
    name: entry.name,
    upn: entry.upn,
    guest: entry.guest,
    items: entry.items,
    newItems: entry.newItems,
    updatedItems: entry.updatedItems,
    workspaces: entry.workspaces.size,
    adminOf: entry.adminOf.size,
    topTypes: Array.from(entry.types.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([type, n]) => ({ type, n })),
  }));

  const creators = all.filter(p => p.items > 0);
  const active = creators.filter(p => p.newItems + p.updatedItems > 0)
    .sort((a, b) => (b.newItems + b.updatedItems) - (a.newItems + a.updatedItems) || b.items - a.items || a.name.localeCompare(b.name));
  const byItems = creators.slice().sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));

  // Items per person, bucketed: who carries the estate is a governance question in
  // its own right (a leaver who created 400 items is a different risk from one who made 2).
  const buckets = [
    { label: '1', min: 1, max: 1 },
    { label: '2–9', min: 2, max: 9 },
    { label: '10–49', min: 10, max: 49 },
    { label: '50+', min: 50, max: Infinity },
  ].map(b => ({ label: b.label, people: creators.filter(p => p.items >= b.min && p.items <= b.max).length }));
  const totalItems = creators.reduce((sum, p) => sum + p.items, 0);
  const topTenShare = totalItems ? byItems.slice(0, 10).reduce((sum, p) => sum + p.items, 0) / totalItems : null;

  // Access granted or withdrawn between the scans, per person and workspace.
  const access = { granted: [], removed: [], roleChanged: [] };
  if (fromResults) {
    const fromWs = indexBy(workspacesOf(fromResults), ws => ws.id);
    for (const ws of workspacesOf(toResults)) {
      const old = fromWs.get(String(ws.id));
      if (!old || ws.usersReadable === false || old.usersReadable === false) continue;
      const before = indexBy(old.users || [], accessKey);
      const after = indexBy(ws.users || [], accessKey);
      for (const [key, user] of after) {
        const was = before.get(key);
        const row = { name: userDisplay(user), email: user.email || '', type: user.type || 'User', guest: isGuestUser(user), workspaceId: ws.id, workspaceName: ws.name || 'Unnamed', role: user.role || '-' };
        if (!was) access.granted.push(row);
        else if ((was.role || '') !== (user.role || '')) access.roleChanged.push({ ...row, fromRole: was.role || '-' });
      }
      for (const [key, user] of before) {
        if (after.has(key)) continue;
        access.removed.push({ name: userDisplay(user), email: user.email || '', type: user.type || 'User', guest: isGuestUser(user), workspaceId: ws.id, workspaceName: ws.name || 'Unnamed', role: user.role || '-' });
      }
    }
    const order = (a, b) => (b.guest - a.guest) || (isAdminRole(b.role) - isAdminRole(a.role)) || a.workspaceName.localeCompare(b.workspaceName) || a.name.localeCompare(b.name);
    access.granted.sort(order);
    access.removed.sort(order);
    access.roleChanged.sort(order);
  }

  return {
    peopleWithAccess: all.filter(p => p.workspaces > 0).length,
    creatorCount: creators.length,
    active: active.slice(0, limit),
    activeCount: active.length,
    topCreators: byItems.slice(0, limit),
    buckets,
    topTenShare,
    access: {
      granted: access.granted.slice(0, 50), grantedCount: access.granted.length,
      removed: access.removed.slice(0, 50), removedCount: access.removed.length,
      roleChanged: access.roleChanged.slice(0, 50), roleChangedCount: access.roleChanged.length,
      guestsGranted: access.granted.filter(r => r.guest).length,
    },
  };
}

// ── Storage ──

function compareStorage(toResults, fromResults, { limit = 10 } = {}) {
  const collected = storageCollected(toResults);
  if (!collected) return { collected: false };
  const before = fromResults && storageCollected(fromResults) ? indexBy(workspacesOf(fromResults), ws => ws.id) : null;

  const workspaces = workspacesOf(toResults)
    .map(ws => {
      const size = count(ws.storageSize);
      const old = before ? before.get(String(ws.id)) : null;
      return {
        id: ws.id,
        name: ws.name || 'Unnamed',
        size,
        files: count(ws.storageFiles),
        change: before ? size - (old ? count(old.storageSize) : 0) : null,
        capacitySku: ws.capacitySku || null,
      };
    })
    .filter(ws => ws.size > 0 || (ws.change !== null && ws.change !== 0));

  const total = totalStorage(toResults);
  const byType = new Map();
  const largestItems = [];
  for (const ws of workspacesOf(toResults)) {
    for (const [itemId, entry] of Object.entries(ws.storageItems || {})) {
      const size = count(entry && entry.size);
      if (!size) continue;
      const type = (entry && entry.type) || 'Unknown';
      const row = byType.get(type) || { type, size: 0, items: 0 };
      row.size += size;
      row.items += 1;
      byType.set(type, row);
      largestItems.push({ id: itemId, name: (entry && entry.name) || 'Unnamed', type, size, workspaceId: ws.id, workspaceName: ws.name || 'Unnamed' });
    }
  }
  largestItems.sort((a, b) => b.size - a.size);

  return {
    collected: true,
    total,
    files: workspacesOf(toResults).reduce((sum, ws) => sum + count(ws.storageFiles), 0),
    change: before ? total - totalStorage(fromResults) : null,
    baselineCollected: !!before,
    largest: workspaces.slice().sort((a, b) => b.size - a.size).slice(0, limit)
      .map(ws => ({ ...ws, share: total ? ws.size / total : 0 })),
    growing: before ? workspaces.filter(ws => ws.change > 0).sort((a, b) => b.change - a.change).slice(0, limit) : [],
    byType: Array.from(byType.values()).sort((a, b) => b.size - a.size).map(row => ({ ...row, share: total ? row.size / total : 0 })),
    largestItems: largestItems.slice(0, limit),
  };
}

// ── Trend and tenants (from the stored per-scan totals) ──

const TREND_METRICS = [
  { column: 'total_workspaces', label: 'Workspaces' },
  { column: 'total_items', label: 'Items' },
  { column: 'total_users', label: 'People with access' },
  { column: 'creator_count', label: 'Creators' },
  { column: 'total_storage_size', label: 'OneLake storage', format: 'bytes', optional: true },
];

/**
 * A line per metric across the stored totals, oldest first. Only scans that were
 * actually taken are plotted: no interpolation, no smoothing, no gap filling.
 */
function buildTrends(totalsRows, { width = 120, height = 36, pad = 3 } = {}) {
  const rows = (totalsRows || []).filter(Boolean)
    .slice().sort((a, b) => new Date(a.run_started_at || 0) - new Date(b.run_started_at || 0));
  if (rows.length < 2) return { available: false, scans: rows.length, metrics: [] };
  const step = (width - pad * 2) / (rows.length - 1);
  const metrics = [];
  for (const def of TREND_METRICS) {
    const values = rows.map(row => count(row[def.column]));
    if (def.optional && values.every(v => v === 0)) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    metrics.push({
      label: def.label,
      format: def.format || 'number',
      first: values[0],
      last: values[values.length - 1],
      change: values[values.length - 1] - values[values.length - 2],
      values,
      points: values.map((v, i) => (pad + i * step).toFixed(1) + ',' + (height - pad - ((v - min) / range) * (height - pad * 2)).toFixed(1)).join(' '),
    });
  }
  return {
    available: true,
    scans: rows.length,
    from: rows[0].run_started_at || null,
    to: rows[rows.length - 1].run_started_at || null,
    runIds: rows.map(row => row.run_id),
    metrics,
  };
}

/**
 * The latest and previous whole-tenant scan of every tenant the reader may see,
 * from stored totals. A tenant with one scan shows its numbers without a change.
 */
function latestPerTenant(runs) {
  const groups = new Map();
  for (const run of runs || []) {
    if (run.status && run.status !== 'completed') continue;
    if (scopeKeyOf(run) !== 'tenant') continue;
    const key = tenantKeyOf(run);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return Array.from(groups.values()).map(list => {
    list.sort((a, b) => timeOf(b) - timeOf(a));
    return { latest: list[0], previous: list[1] || null };
  });
}

function compareTenants(pairs, totalsByRunId) {
  const columns = [
    ['workspaces', 'total_workspaces'], ['items', 'total_items'], ['people', 'total_users'],
    ['creators', 'creator_count'], ['storage', 'total_storage_size'],
  ];
  return (pairs || []).map(({ latest, previous }) => {
    const now = totalsByRunId.get(latest.id) || null;
    const was = previous ? totalsByRunId.get(previous.id) || null : null;
    const row = { runId: latest.id, name: latest.sp_name || latest.tenant_id || 'Tenant', spId: latest.sp_id, scannedAt: latest.completed_at || latest.started_at, totalsAvailable: !!now };
    for (const [key, column] of columns) {
      row[key] = now ? count(now[column]) : null;
      row[key + 'Change'] = now && was ? count(now[column]) - count(was[column]) : null;
    }
    if (row.storage === 0) { row.storage = null; row.storageChange = null; }
    return row;
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// ── The whole page ──

function buildScanChanges({ toResults, fromResults = null, toRun, fromRun = null, insightsOptions = {} }) {
  const hasBaseline = !!fromResults;
  const toInsights = computeWorkspaceInsights(toResults, { ...insightsOptions, referenceDate: toRun && (toRun.completed_at || toRun.started_at) });
  const fromInsights = hasBaseline
    ? computeWorkspaceInsights(fromResults, { ...insightsOptions, referenceDate: fromRun && (fromRun.completed_at || fromRun.started_at) })
    : null;

  const findings = compareFindings(toInsights, fromInsights, toResults, hasBaseline);
  const inventory = compareInventory(toResults, fromResults);
  const people = comparePeople(toResults, fromResults);
  const storage = compareStorage(toResults, fromResults);

  const guestsNow = guestKeys(toResults).size;
  const accessReadable = workspacesOf(toResults).some(ws => (ws.users || []).length > 0);

  const summary = {
    needAttention: { now: toInsights.flaggedCount, change: hasBaseline ? delta(toInsights.flaggedCount, fromInsights.flaggedCount) : null, total: toInsights.totalCount },
    newFindings: hasBaseline ? findings.tally.new : null,
    resolvedFindings: hasBaseline ? findings.tally.resolved : null,
    guests: accessReadable ? { now: guestsNow, change: hasBaseline ? delta(guestsNow, guestKeys(fromResults).size) : null } : null,
    people: accessReadable ? { now: peopleWithAccess(toResults).size, change: hasBaseline ? delta(peopleWithAccess(toResults).size, peopleWithAccess(fromResults).size) : null } : null,
    items: { now: itemCount(toResults), added: hasBaseline ? inventory.totals.added : null, removed: hasBaseline ? inventory.totals.removed : null, updated: hasBaseline ? inventory.totals.updated : null },
    storage: storage.collected ? { now: storage.total, change: storage.change } : null,
  };

  return {
    hasBaseline,
    summary,
    findings,
    inventory,
    people,
    storage,
    checks: {
      namingConventionEnabled: toInsights.namingConventionEnabled,
      orphanDetectionAvailable: toInsights.orphanDetectionAvailable,
      thresholds: toInsights.thresholds,
    },
  };
}

module.exports = {
  tenantKeyOf,
  scopeKeyOf,
  comparableRuns,
  previousRun,
  compareFindings,
  compareInventory,
  comparePeople,
  compareStorage,
  buildTrends,
  latestPerTenant,
  compareTenants,
  buildScanChanges,
  TREND_METRICS,
};
