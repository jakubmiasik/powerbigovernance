/**
 * Generating, caching and authorising the Governance Outcome.
 *
 * The outcome is cached per (tenant, service principal + scan number). Q1 is read on every request to learn
 * the tenant's latest completed tenant scan, so a new scan makes the cached
 * outcome stale without anyone having to clear it. It is generated:
 *   - right after a whole-tenant scan completes (the scan's last step),
 *   - on demand, from the Regenerate button,
 *   - on first view, when nothing is cached (after a restart, say).
 * All three produce the same result for the same data: fixed queries, fixed rules.
 */

const { getConfig } = require('../config/settings');
const repository = require('./governanceOutcomeRepository');
const { loadRules, buildOutcome } = require('./governanceRulesService');
const { canUseSectionInTenant } = require('./permissionService');

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const cache = new Map();
const inFlight = new Map();

function normalizeTenantId(value) {
  const id = String(value || '').trim().toLowerCase();
  return TENANT_ID_PATTERN.test(id) ? id : null;
}

/**
 * Tenants this reader may see the outcome for, from the scans they can already
 * see. A tenant is allowed when the reader may use Governance Overview for the
 * service principal that scanned it (administrators: every tenant with a scan).
 * Derived from analysis_runs, so the credentials table is never needed.
 */
function allowedTenants(permissions, runs) {
  const tenants = new Map();
  for (const run of runs || []) {
    const id = normalizeTenantId(run.tenant_id);
    if (!id) continue;
    const allowed = (permissions && permissions.isAdmin) || canUseSectionInTenant(permissions, 'governance', run.sp_id);
    if (!allowed) continue;
    const at = new Date(run.completed_at || run.started_at || 0).getTime();
    const known = tenants.get(id);
    if (!known || at > known.at) tenants.set(id, { id, name: run.sp_name || id, at });
  }
  return Array.from(tenants.values())
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** The tenant to show: the one asked for, else the configured default, else the selected scan's. */
function pickTenant(requested, allowed, { defaultTenantId, selectedRun } = {}) {
  const wanted = normalizeTenantId(requested);
  if (requested !== undefined && requested !== null && requested !== '') {
    if (!wanted) return { error: 400, message: 'tenantId must be a tenant GUID.' };
    return allowed.some(t => t.id === wanted) ? { tenantId: wanted } : { error: 403, message: 'You do not have access to that tenant.' };
  }
  const fallback = normalizeTenantId(defaultTenantId);
  if (fallback && allowed.some(t => t.id === fallback)) return { tenantId: fallback };
  const selected = selectedRun ? normalizeTenantId(selectedRun.tenant_id) : null;
  if (selected && allowed.some(t => t.id === selected)) return { tenantId: selected };
  if (allowed.length) return { tenantId: allowed[0].id };
  return { error: 403, message: 'You do not have access to any tenant with a completed scan.' };
}

// Keyed by tenant and the scan's principal + number; the internal id only stands
// in for a scan that a not-yet-migrated database has not numbered.
function cacheKey(tenantId, run) {
  const number = run.sp_run_number !== undefined && run.sp_run_number !== null ? run.sp_run_number : 'id' + run.run_id;
  return tenantId + '|' + (run.sp_id === undefined || run.sp_id === null ? 'mi' : run.sp_id) + '|' + number;
}

function freshEnough(entry, ttlMs) {
  return entry && (!(ttlMs > 0) || Date.now() - entry.storedAt < ttlMs);
}

/**
 * The outcome for a tenant's latest completed tenant scan.
 * Returns { status: 200, outcome, cached } or { status: 404, message }.
 */
async function getOutcome(tenantId, { force = false, trigger = 'on-demand', repo = repository, now = () => new Date() } = {}) {
  const id = normalizeTenantId(tenantId);
  if (!id) return { status: 400, message: 'tenantId must be a tenant GUID.' };

  const run = await repo.latestRun(id);
  if (!run) return { status: 404, message: 'No completed tenant scan' };
  // Q1 filters by tenant; this is a second lock on the same door.
  if (normalizeTenantId(run.tenant_id) !== id) throw new Error('Governance outcome: the latest run does not belong to the requested tenant.');

  const key = cacheKey(id, run);
  const config = getConfig();
  if (!force && freshEnough(cache.get(key), config.governance.cacheTtlMs)) {
    return { status: 200, outcome: cache.get(key).outcome, cached: true };
  }
  if (!force && inFlight.has(key)) return { status: 200, outcome: await inFlight.get(key), cached: false };

  const work = (async () => {
    const rules = loadRules(config.governance.rulesFile || undefined);
    const data = await repo.readOutcomeData(id, run);
    const outcome = buildOutcome({ run, data, rules, connectionMode: repository.connectionMode(config), generatedAt: now(), trigger });
    for (const existing of cache.keys()) if (existing.startsWith(id + '|')) cache.delete(existing);
    cache.set(key, { outcome, storedAt: Date.now() });
    return outcome;
  })();
  inFlight.set(key, work);
  try {
    return { status: 200, outcome: await work, cached: false };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * The scan's last step. Only a completed whole-tenant scan changes the outcome;
 * a scoped scan is not what Q1 reads. Never throws: a scan that finished is not
 * failed by its summary.
 */
async function generateAfterScan(tenantId, { scopeKind = 'tenant', repo } = {}) {
  if (scopeKind && scopeKind !== 'tenant') return { generated: false, reason: 'scoped scan' };
  try {
    const result = await getOutcome(tenantId, { force: true, trigger: 'after-scan', repo });
    if (result.status !== 200) return { generated: false, reason: result.message };
    const s = result.outcome.summary;
    return { generated: true, runId: result.outcome.run.id, summary: s };
  } catch (err) {
    return { generated: false, reason: err.message };
  }
}

function clearCache() {
  cache.clear();
}

module.exports = { normalizeTenantId, allowedTenants, pickTenant, getOutcome, generateAfterScan, clearCache };
