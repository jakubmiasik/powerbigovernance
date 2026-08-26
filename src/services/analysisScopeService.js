/**
 * What an analysis run covers.
 *
 * A scan used to mean the whole tenant, always. On a large tenant that is hours of
 * API calls to answer a question about three workspaces, and it is the reason
 * scanning was something people did rarely rather than something they scheduled.
 *
 * A scoped run is a smaller, faster, honest answer — as long as nothing downstream
 * mistakes it for the full picture. That is the risk this module exists to manage:
 * every run carries its scope, and readers that need a tenant-wide view can ask
 * for one rather than taking whatever ran last.
 *
 * Pure: no database, no API, no clock.
 */

const SCOPE_KIND = { TENANT: 'tenant', WORKSPACES: 'workspaces' };

/**
 * A scope from whatever the form, the API or a stored row supplied.
 *
 * Selecting no workspaces is deliberately *not* an empty scan: a scan of nothing
 * is never what anyone meant, and silently producing one would look like a scan
 * that found an empty tenant. It falls back to the whole tenant.
 */
function normalizeScope(input) {
  const source = input || {};
  const kind = String(source.kind || source.scopeKind || source.scope || '').trim().toLowerCase();

  const rawIds = source.workspaceIds || source.workspaces || [];
  const list = Array.isArray(rawIds) ? rawIds : [rawIds];

  const seen = new Set();
  const workspaces = [];
  for (const entry of list) {
    const id = String((entry && entry.id !== undefined ? entry.id : entry) || '').trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    workspaces.push({ id, name: (entry && entry.name) || (source.workspaceNames || {})[id] || null });
  }

  if (kind !== SCOPE_KIND.WORKSPACES || !workspaces.length) {
    return { kind: SCOPE_KIND.TENANT, workspaces: [] };
  }
  return { kind: SCOPE_KIND.WORKSPACES, workspaces };
}

/**
 * Whether the caller *asked* for workspace scoping, regardless of what they then
 * selected.
 *
 * `normalizeScope` falls back to the whole tenant when the list is empty, which is
 * right for reading a stored row but wrong for validating a request: someone who
 * chose "selected workspaces" and ticked nothing must be told, not quietly given a
 * tenant-wide scan — least of all on a nightly schedule.
 */
function requestedWorkspaceScope(input) {
  const source = input || {};
  const kind = String(source.kind || source.scopeKind || source.scope || '').trim().toLowerCase();
  return kind === SCOPE_KIND.WORKSPACES;
}

/** The scope stored on a run or a schedule row, back into the shape above. */
function scopeFromRow(row) {
  if (!row) return { kind: SCOPE_KIND.TENANT, workspaces: [] };
  let workspaces = [];
  const stored = row.scope_workspaces !== undefined ? row.scope_workspaces : row.scopeWorkspaces;
  if (typeof stored === 'string' && stored.trim()) {
    try { workspaces = JSON.parse(stored); } catch { workspaces = []; }
  } else if (Array.isArray(stored)) {
    workspaces = stored;
  }
  return normalizeScope({
    kind: row.scope_kind !== undefined ? row.scope_kind : row.scopeKind,
    workspaceIds: workspaces,
  });
}

/** The scope as it is stored: a kind, and the chosen workspaces as a document. */
function scopeToRow(scope) {
  const normalized = normalizeScope(scope);
  return {
    scopeKind: normalized.kind,
    // The names are denormalised deliberately. A workspace deleted between runs
    // still has to be nameable in the run history, and by then there is nothing
    // left to look it up in.
    scopeWorkspaces: normalized.kind === SCOPE_KIND.WORKSPACES ? JSON.stringify(normalized.workspaces) : null,
  };
}

function workspaceIdOf(workspace) {
  return String((workspace && (workspace.id || workspace.workspaceId)) || '').trim();
}

function workspaceNameOf(workspace) {
  return (workspace && (workspace.displayName || workspace.name)) || null;
}

/**
 * Narrows the tenant's workspaces to the scope.
 *
 * Reports the requested workspaces it could not find rather than quietly scanning
 * fewer than asked: a scheduled scoped run whose workspace was deleted, renamed
 * away or moved out of the principal's reach would otherwise keep succeeding while
 * silently covering less every week.
 */
function applyScope(workspaces, scope) {
  const normalized = normalizeScope(scope);
  const all = Array.isArray(workspaces) ? workspaces : [];
  if (normalized.kind === SCOPE_KIND.TENANT) {
    return { selected: all, missing: [], scope: normalized };
  }

  const byId = new Map(all.map(workspace => [workspaceIdOf(workspace).toLowerCase(), workspace]));
  const selected = [];
  const missing = [];
  for (const wanted of normalized.workspaces) {
    const found = byId.get(wanted.id.toLowerCase());
    if (found) selected.push(found);
    else missing.push(wanted);
  }
  return { selected, missing, scope: normalized };
}

/** Items narrowed to the same workspaces, so totals describe what was scanned. */
function filterItemsToScope(items, selectedWorkspaces) {
  const wanted = new Set((selectedWorkspaces || []).map(workspace => workspaceIdOf(workspace).toLowerCase()));
  return (items || []).filter(item => wanted.has(String(item.workspaceId || '').toLowerCase()));
}

/** How a scope reads on a page: short, and never ambiguous about coverage. */
function describeScope(scope, { limit = 3 } = {}) {
  const normalized = normalizeScope(scope);
  if (normalized.kind === SCOPE_KIND.TENANT) return 'Whole tenant';

  const names = normalized.workspaces.map(workspace => workspace.name || workspace.id);
  const shown = names.slice(0, limit).join(', ');
  const rest = names.length - Math.min(limit, names.length);
  return normalized.workspaces.length + ' workspace' + (normalized.workspaces.length === 1 ? '' : 's')
    + ': ' + shown + (rest > 0 ? ' and ' + rest + ' more' : '');
}

function isTenantWide(row) {
  return scopeFromRow(row).kind === SCOPE_KIND.TENANT;
}

/**
 * The most recent completed run that covered the whole tenant.
 *
 * Anything reasoning about the tenant as a whole — which workspaces have no
 * administrator, what the estate contains — must not read a run that only covered
 * three workspaces. It would not be wrong about those three; it would be wrong
 * about everything else, and silently.
 *
 * Runs recorded before scopes existed have no scope column and are treated as
 * tenant-wide, which is what they were.
 */
function pickTenantWideRun(runs) {
  const completed = (runs || []).filter(run => run.status === 'completed');
  return completed.find(isTenantWide) || null;
}

module.exports = {
  SCOPE_KIND,
  normalizeScope,
  requestedWorkspaceScope,
  scopeFromRow,
  scopeToRow,
  applyScope,
  filterItemsToScope,
  describeScope,
  isTenantWide,
  pickTenantWideRun,
};
