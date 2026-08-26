/**
 * Workspace access: who can reach what, and granting the service principal what
 * it is missing.
 *
 * The two belong on one page. Granting a principal access without seeing the
 * access model is how a service account ends up Admin on every workspace in the
 * tenant, and reviewing access without being able to act on it is a report
 * nobody comes back to.
 */

const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const analysisModel = require('../services/analysisModelRepository');
const {
  buildAccessOverview, markServicePrincipalAccess,
  ACCESS_LEVELS, PRINCIPAL_TYPES, accessLevel, principalTypeLabel,
} = require('../services/workspaceAccessService');
const { pickTenantWideRun, isTenantWide, scopeFromRow, describeScope } = require('../services/analysisScopeService');

/**
 * The run the access picture is read from.
 *
 * Access is a point-in-time observation, not live state — it is whatever the scan
 * saw. Saying which run, and when it ran, is the difference between a report
 * somebody can act on and one they have to distrust.
 */
async function resolveRun(requestedId) {
  const runs = (await db.getAnalysisRuns()).filter(run => run.status === 'completed');
  if (!runs.length) return { runs: [], run: null };

  const wanted = Number.parseInt(requestedId, 10);
  if (Number.isFinite(wanted)) {
    const asked = runs.find(candidate => Number(candidate.id) === wanted);
    if (asked) return { runs, run: asked };
  }

  // The default has to be a whole-tenant scan. Every figure on this page is about
  // the tenant — how many workspaces nobody administers, who holds admin anywhere —
  // and a scan of three workspaces would not be wrong about those three, it would
  // be wrong about everything else and silently. A scoped run is only the default
  // when there is no tenant-wide one to prefer, and the page says so.
  return { runs, run: pickTenantWideRun(runs) || runs[0] };
}

/**
 * The access grants a run recorded.
 *
 * Indexed rows are the query path. A run scanned before indexing existed has
 * none, so it falls back to the stored document — an older run should still be
 * readable rather than presenting as a tenant with nobody in it.
 */
async function loadAccess(runId) {
  const workspaces = await analysisModel.listRunWorkspaces(runId).catch(() => []);
  const grants = await analysisModel.listRunAccess(runId).catch(() => []);
  if (workspaces.length || grants.length) {
    return { overview: buildAccessOverview({ workspaces, grants }), indexed: true };
  }

  const run = await db.getAnalysisRunById(runId);
  let results = null;
  try { results = run && run.results_json ? JSON.parse(run.results_json) : null; } catch { results = null; }
  if (!results) return { overview: buildAccessOverview({}), indexed: false };

  const shaped = analysisModel.shapeRun(runId, results);
  return {
    overview: buildAccessOverview({
      workspaces: shaped.workspaces,
      grants: shaped.users.map(user => ({
        workspace_id: user.workspaceId, principal_id: user.principalId,
        principal_type: user.principalType, display_name: user.displayName,
        email: user.email, access_right: user.accessRight,
      })),
    }),
    indexed: false,
  };
}

router.get('/', async (req, res) => {
  const base = {
    title: 'Grant Access', user: req.user, hideRunSelector: true,
    accessLevels: ACCESS_LEVELS, principalTypes: PRINCIPAL_TYPES,
    accessLevel, principalTypeLabel, describeScope, scopeFromRow,
    grantAuth: req.query.grantAuth === 'success',
    partialScope: false,
  };
  try {
    const { runs, run } = await resolveRun(req.query.accessRunId);
    const servicePrincipals = await db.getServicePrincipals();

    if (!run) {
      return res.render('access/index', {
        ...base, runs: [], run: null, servicePrincipals,
        overview: buildAccessOverview({}), indexed: false, error: null,
      });
    }

    const { overview, indexed } = await loadAccess(run.id);
    res.render('access/index', {
      ...base, runs, run, servicePrincipals, overview, indexed,
      // A scoped scan covers what it covers. Saying so is the difference between a
      // partial picture and a wrong one.
      partialScope: !isTenantWide(run),
      error: null,
    });
  } catch (err) {
    res.render('access/index', {
      ...base, runs: [], run: null, servicePrincipals: [],
      overview: buildAccessOverview({}), indexed: false, error: err.message,
    });
  }
});

/**
 * The workspaces to offer in the grant dialog, each saying whether the chosen
 * service principal is already in it.
 *
 * The old dialog listed every workspace with nothing said about which already had
 * the principal, so the safe action — add it only where it is missing — meant
 * checking each one by hand first.
 */
router.get('/workspaces', async (req, res) => {
  try {
    const { run } = await resolveRun(req.query.accessRunId);
    if (!run) return res.json({ success: false, message: 'No completed analysis run found. Run an analysis first.' });

    const spId = Number.parseInt(req.query.spId, 10);
    const servicePrincipals = await db.getServicePrincipals();
    const sp = servicePrincipals.find(candidate => Number(candidate.id) === spId) || servicePrincipals[0] || null;
    const objectId = sp ? sp.enterprise_app_object_id : null;

    const { overview } = await loadAccess(run.id);
    const workspaces = markServicePrincipalAccess(overview, objectId);
    res.json({
      success: true,
      runId: run.id,
      // Without the object id nothing can be matched, and every workspace would
      // wrongly look as though the principal were absent. Say so instead.
      objectIdKnown: !!objectId,
      missing: objectId ? workspaces.filter(workspace => !workspace.hasAccess).length : null,
      workspaces,
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
