/**
 * Compare runs: one implementation behind two doors.
 *
 *   Run Analysis → Compare runs   /analysis/compare            (pick any two scans)
 *   Overview → Since Last Scan    /governance/changes          (opens on the selected
 *                                                               scan against the same
 *                                                               principal's previous one)
 *
 * Scans are identified by service principal and that principal's scan number. The
 * internal id is only the value in the URL. A reader only ever sees, and can only
 * ever compare, scans of tenants they may see; the details endpoint checks the
 * same thing rather than trusting the page.
 */

const db = require('../services/databaseService');
const { METRIC_DEFS, computeRunTotals, diffTotals, diffRunDetails } = require('../services/runMetricsService');
const { scopeTag, scopeTagTitle, describeScope, scopeFromRow } = require('../services/analysisScopeService');
const { canUseSectionInTenant } = require('../services/permissionService');
const { runNumber, runLabel } = require('../services/runLabelService');

function parseRunResults(run) {
  if (!run || !run.results_json) return null;
  try { return JSON.parse(run.results_json); } catch { return null; }
}

// Totals for a run, computing and storing them on first use. Runs created before
// the totals table existed are backfilled here rather than in a startup migration,
// which would have meant parsing every historic run's results_json at boot.
async function loadRunTotals(runId) {
  const stored = await db.getRunTotals(runId);
  if (stored) {
    const totals = {};
    for (const def of METRIC_DEFS) totals[def.key] = Number(stored[def.column]) || 0;
    return { totals, run: null, backfilled: false };
  }

  const run = await db.getAnalysisRunById(runId);
  const results = parseRunResults(run);
  if (!results) return { totals: null, run, backfilled: false };

  const totals = computeRunTotals(results);
  try {
    await db.saveRunTotals(
      runId,
      { tenantId: run.tenant_id, spId: run.sp_id, spName: run.sp_name, startedAt: run.started_at },
      totals
    );
  } catch (err) {
    console.warn('[Analysis] Could not backfill run totals for run', runId, err.message);
  }
  return { totals, run, backfilled: true };
}

// ── Which scans, and which pair ──

function samePrincipal(a, b) {
  const x = a && a.sp_id !== undefined && a.sp_id !== null ? Number(a.sp_id) : null;
  const y = b && b.sp_id !== undefined && b.sp_id !== null ? Number(b.sp_id) : null;
  return x === y;
}

function scopeKeyOf(run) {
  const scope = scopeFromRow(run || {});
  if (scope.kind !== 'workspaces') return 'tenant';
  return 'ws:' + scope.workspaces.map(ws => String(ws.id).toLowerCase()).sort().join(',');
}

function startedAt(run) {
  const t = run && run.started_at ? new Date(run.started_at).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

// Within one principal the scan number is the order; started_at only breaks the
// tie for runs a database has not numbered yet.
function orderWithinPrincipal(a, b) {
  const na = runNumber(a);
  const nb = runNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return startedAt(a) - startedAt(b);
}

/** Completed scans the reader may compare (optionally: only where they hold `section`). */
function comparableRuns(permissions, runs, section) {
  return (runs || [])
    .filter(run => run && (!run.status || run.status === 'completed'))
    .filter(run => !section || (permissions && permissions.isAdmin) || canUseSectionInTenant(permissions, section, run.sp_id))
    .slice()
    .sort((a, b) => String(a.tenant_id || '').localeCompare(String(b.tenant_id || ''))
      || String(a.sp_name || '').localeCompare(String(b.sp_name || ''))
      || orderWithinPrincipal(b, a));
}

/** The same principal's scan just before this one, of the same scope. */
function previousOfPrincipal(run, runs) {
  if (!run) return null;
  const key = scopeKeyOf(run);
  const earlier = (runs || []).filter(other => other.id !== run.id
    && samePrincipal(other, run)
    && (other.tenant_id || '') === (run.tenant_id || '')
    && scopeKeyOf(other) === key
    && orderWithinPrincipal(other, run) < 0);
  earlier.sort(orderWithinPrincipal);
  return earlier[earlier.length - 1] || null;
}

/** The pair Since Last Scan opens on: the selected scan (else the latest) and its predecessor. */
function defaultPair(runs, selectedRun) {
  const selected = selectedRun ? runs.find(run => run.id === selectedRun.id) : null;
  const to = selected || runs.slice().sort((a, b) => startedAt(b) - startedAt(a))[0] || null;
  return { to, from: previousOfPrincipal(to, runs) };
}

// ── Handlers ──

function comparePage({ basePath, detailsPath, section = null, title, subtitle, backHref = null, defaultToLatest = false }) {
  return async (req, res) => {
    try {
      const runs = comparableRuns(req.permissions || res.locals.permissions, res.locals.availableRuns || [], section);
      let fromId = Number.parseInt(req.query.from, 10);
      let toId = Number.parseInt(req.query.to, 10);
      let notice = null;

      if (defaultToLatest && !Number.isInteger(fromId) && !Number.isInteger(toId)) {
        const pair = defaultPair(runs, res.locals.globalRun);
        if (pair.to) toId = pair.to.id;
        if (pair.from) fromId = pair.from.id;
        else if (pair.to) notice = runLabel(pair.to) + ' is the first ' + (scopeKeyOf(pair.to) === 'tenant' ? 'whole-tenant' : 'scoped') + ' scan of this principal, so there is nothing earlier to compare it with yet.';
      }

      const base = {
        title, user: req.user, runs,
        scopeTag, scopeTagTitle, describeScope, scopeFromRow,
        fromRun: null, toRun: null, metrics: [], error: null, notice,
        tenantSettingsComparable: true,
        compare: { basePath, detailsPath, title, subtitle, backHref },
      };

      if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
        if (Number.isInteger(toId)) base.toRun = runs.find(run => run.id === toId) || null;
        return res.render('analysis/compare', base);
      }
      if (fromId === toId) {
        return res.render('analysis/compare', { ...base, error: 'Pick two different scans to compare.' });
      }
      // Only scans in the reader's list can be compared, whatever the URL says.
      if (!runs.some(run => run.id === fromId) || !runs.some(run => run.id === toId)) {
        return res.status(403).render('analysis/compare', { ...base, error: 'You do not have access to one of those scans.' });
      }

      const [fromRun, toRun] = await Promise.all([db.getAnalysisRunMeta(fromId), db.getAnalysisRunMeta(toId)]);
      if (!fromRun || !toRun) {
        return res.render('analysis/compare', { ...base, error: 'One of the selected scans no longer exists.' });
      }

      // Comparing across tenants would produce numbers that look like change but are
      // really two different estates, so it is refused rather than rendered.
      if ((fromRun.tenant_id || '') !== (toRun.tenant_id || '')) {
        return res.render('analysis/compare', {
          ...base, fromRun, toRun,
          error: 'These scans are from different tenants. Comparison is only available within a single tenant.',
        });
      }

      const [fromTotals, toTotals] = await Promise.all([loadRunTotals(fromId), loadRunTotals(toId)]);
      if (!fromTotals.totals || !toTotals.totals) {
        return res.render('analysis/compare', { ...base, fromRun, toRun, error: 'One of the selected scans has no stored results to compare.' });
      }

      // A run that predates tenant-settings capture stores zeroes, which would read
      // as "every setting removed". Drop those rows and say why instead.
      const tenantSettingsComparable = !!fromTotals.totals.tenantSettingsCaptured && !!toTotals.totals.tenantSettingsCaptured;
      res.render('analysis/compare', {
        ...base, fromRun, toRun,
        metrics: diffTotals(fromTotals.totals, toTotals.totals, { skipGroups: tenantSettingsComparable ? [] : ['tenantSettings'] }),
        tenantSettingsComparable,
      });
    } catch (err) {
      res.render('error', { title: 'Error', user: req.user, message: err.message });
    }
  };
}

function compareDetails({ section = null } = {}) {
  return async (req, res) => {
    try {
      const fromId = Number.parseInt(req.query.from, 10);
      const toId = Number.parseInt(req.query.to, 10);
      if (!Number.isInteger(fromId) || !Number.isInteger(toId) || fromId === toId) {
        return res.json({ success: false, message: 'Pick two different scans to compare.' });
      }
      const runs = comparableRuns(req.permissions || res.locals.permissions, res.locals.availableRuns || [], section);
      if (!runs.some(run => run.id === fromId) || !runs.some(run => run.id === toId)) {
        return res.status(403).json({ success: false, message: 'You do not have access to one of those scans.' });
      }

      const [fromRun, toRun] = await Promise.all([db.getAnalysisRunById(fromId), db.getAnalysisRunById(toId)]);
      if (!fromRun || !toRun) return res.json({ success: false, message: 'One of the selected scans no longer exists.' });
      if ((fromRun.tenant_id || '') !== (toRun.tenant_id || '')) {
        return res.json({ success: false, message: 'Comparison is only available within a single tenant.' });
      }

      const fromResults = parseRunResults(fromRun);
      const toResults = parseRunResults(toRun);
      if (!fromResults || !toResults) return res.json({ success: false, message: 'One of the selected scans has no stored results.' });

      res.json({ success: true, details: diffRunDetails(fromResults, toResults) });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  };
}

module.exports = {
  parseRunResults,
  loadRunTotals,
  comparableRuns,
  previousOfPrincipal,
  defaultPair,
  comparePage,
  compareDetails,
};
