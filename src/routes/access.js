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
  buildAccessOverview, markServicePrincipalAccess, missingServicePrincipalAccess,
  ACCESS_LEVELS, PRINCIPAL_TYPES, FABRIC_ROLES, accessLevel, principalTypeLabel,
  classifyWorkspacePersonal, isPersonalWorkspace, isRetiredWorkspace,
} = require('../services/workspaceAccessService');
const powerbi = require('../services/powerbiService');

// Somebody else's guide to which security groups a Fabric tenant needs and what
// each one should hold. Linked rather than restated: the roles this page grants
// are only useful if the groups being granted them were designed first.
const ROLES_GUIDE_URL = 'https://qubexon-pl.github.io/fabricrolesassigment/';

// Looked up on each call rather than destructured once, so a test can substitute
// it. Destructuring captures the function at load, which means a stub set
// afterwards is ignored and the check reaches for a real Azure token instead.
const createPowerBIService = (...args) => powerbi.createPowerBIService(...args);
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
  // A grant interrupted by the administrator sign-in is handed back to the page so
  // it can finish on its own. Read once and cleared: a refresh must not repeat it.
  const pendingGrant = req.session ? req.session.pendingGrant || null : null;
  if (req.session) delete req.session.pendingGrant;

  const base = {
    title: 'Grant Access', user: req.user, hideRunSelector: true,
    accessLevels: ACCESS_LEVELS, principalTypes: PRINCIPAL_TYPES, fabricRoles: FABRIC_ROLES,
    accessLevel, principalTypeLabel, describeScope, scopeFromRow,
    grantAuth: req.query.grantAuth === 'success',
    // Only resumed on the way back from a successful sign-in. A stash left behind
    // by an abandoned attempt is dropped rather than acted on later.
    pendingGrant: req.query.grantAuth === 'success' ? pendingGrant : null,
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

/**
 * Which workspaces the service principal cannot reach — asked live, not read from
 * a scan.
 *
 * A scan reads the admin API, so it sees every workspace in the tenant whether the
 * principal is a member or not. It can say who the scan *observed* holding access,
 * which is what the tables below the grant section are for; it cannot say what the
 * principal can reach right now, and a grant made since the last scan would not
 * show up at all.
 *
 * The check is the difference between every workspace in the tenant and the ones
 * the principal itself can see: two API calls, whatever the size of the tenant.
 */
router.post('/check', async (req, res) => {
  try {
    const servicePrincipals = await db.getServicePrincipals();
    if (!servicePrincipals.length) {
      return res.json({ success: false, message: 'No service principal configured.' });
    }
    const wanted = Number.parseInt(req.body ? req.body.spId : null, 10);
    const sp = (Number.isFinite(wanted) && servicePrincipals.find(candidate => Number(candidate.id) === wanted))
      || servicePrincipals[0];

    const pbi = createPowerBIService(sp);
    // Sequential rather than together: the second call reuses the token the first
    // one acquired, and issuing both at once just fetches it twice.
    const all = await pbi.getWorkspaces();
    const reachable = await pbi.getMyWorkspaces();
    const result = missingServicePrincipalAccess(all, reachable);

    res.json({
      success: true,
      checkedAt: new Date().toISOString(),
      servicePrincipal: sp.name,
      // Granting needs the object id, and without one nothing can be added. Say so
      // now rather than after the operator has chosen forty workspaces.
      objectIdKnown: !!sp.enterprise_app_object_id,
      ...result,
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Granting a user or a security group a role ──
//
// Different question from the section above, and a different mechanism. Adding
// the *service principal* to a workspace is an admin-API operation performed on
// behalf of a signed-in administrator. Adding *anyone else* is an ordinary
// workspace role assignment, which the service principal can make itself — but
// only where it is a workspace Admin, because that is what the Fabric role
// assignment APIs require.

/**
 * The service principal a request is about, and a Power BI client for it.
 *
 * Key Vault-backed principals need the operator's own token to read the secret,
 * so it is passed through the same way the workspace pages do; without it the
 * client cannot authenticate and the failure looks like a permissions problem.
 */
async function resolveServicePrincipal(requestedId) {
  const servicePrincipals = await db.getServicePrincipals();
  if (!servicePrincipals.length) return null;
  const wanted = Number.parseInt(requestedId, 10);
  return (Number.isFinite(wanted) && servicePrincipals.find(candidate => Number(candidate.id) === wanted))
    || servicePrincipals[0];
}

function clientFor(req, sp) {
  const keyVaultAuthUrl = '/settings/kv/auth?spId=' + encodeURIComponent(String(sp.id))
    + '&returnTo=' + encodeURIComponent(req.originalUrl || '/settings/access/roles');
  return createPowerBIService(sp, {
    keyVaultDelegatedToken: (req.session && req.session.keyVaultDelegatedToken && req.session.keyVaultDelegatedToken.token) || null,
    keyVaultAuthUrl,
  });
}

router.get('/roles', async (req, res) => {
  const base = {
    title: 'Grant Workspace Roles', user: req.user, hideRunSelector: true,
    accessLevels: ACCESS_LEVELS, fabricRoles: FABRIC_ROLES,
    rolesGuideUrl: ROLES_GUIDE_URL,
    workspaceId: req.query.workspaceId || null,
  };
  try {
    const servicePrincipals = await db.getServicePrincipals();
    res.render('access/roles', { ...base, servicePrincipals, error: null });
  } catch (err) {
    res.render('access/roles', { ...base, servicePrincipals: [], error: err.message });
  }
});

/**
 * The workspaces a role can be granted in.
 *
 * Reachability is asked live — one call — because a scan reads the admin APIs and
 * so sees every workspace whether the principal is a member or not. Whether the
 * principal is *Admin* there is not in that answer, so the last scan is used to
 * mark the likely ones and the role list itself settles it: listing role
 * assignments requires workspace Admin, so a workspace that answers is one this
 * principal can manage.
 */
router.get('/roles/candidates', async (req, res) => {
  try {
    const sp = await resolveServicePrincipal(req.query.spId);
    if (!sp) return res.json({ success: false, message: 'No service principal configured.' });

    const pbi = clientFor(req, sp);
    const reachable = await pbi.getMyWorkspaces();

    // Roles the last scan observed for this principal, used only to sort the ones
    // it is Admin of to the top. Missing scan, missing object id or an unindexed
    // run all degrade to "unknown", never to a wrong claim.
    const scanRole = new Map();
    const objectId = String(sp.enterprise_app_object_id || '').trim().toLowerCase();
    if (objectId) {
      try {
        const { run } = await resolveRun(req.query.accessRunId);
        if (run) {
          const { overview } = await loadAccess(run.id);
          for (const workspace of overview.workspaces) {
            const grant = workspace.grants.find(g => String(g.principalId || '').toLowerCase() === objectId);
            if (grant) scanRole.set(String(workspace.workspaceId).toLowerCase(), grant.accessRight);
          }
        }
      } catch { /* the live list is still useful without it */ }
    }

    const workspaces = (reachable || [])
      .filter(workspace => !isPersonalWorkspace(workspace) && !isRetiredWorkspace(workspace))
      .map(workspace => {
        const id = workspace.id || workspace.workspaceId;
        const name = workspace.displayName || workspace.name || '(unnamed)';
        return {
          id,
          name,
          scanRole: scanRole.get(String(id).toLowerCase()) || null,
          personal: classifyWorkspacePersonal({ name, type: workspace.type }),
        };
      })
      .sort((a, b) =>
        (b.scanRole === 'admin' ? 1 : 0) - (a.scanRole === 'admin' ? 1 : 0)
        || String(a.name).localeCompare(String(b.name)));

    res.json({
      success: true,
      servicePrincipal: sp.name,
      // Said plainly, because "0 admin workspaces" from a stale scan and "we did
      // not look" are different answers and only one of them is a problem.
      rolesFromScan: scanRole.size > 0,
      adminByScan: workspaces.filter(workspace => workspace.scanRole === 'admin').length,
      workspaces,
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/**
 * Who holds which role in one workspace, live.
 *
 * Doubles as the permission check: the Fabric API only lists role assignments to a
 * workspace Admin, so a failure here is the answer to "can this principal manage
 * roles at all", and is reported as that rather than as a bare 403.
 */
router.get('/roles/:workspaceId/assignments', async (req, res) => {
  try {
    const sp = await resolveServicePrincipal(req.query.spId);
    if (!sp) return res.json({ success: false, message: 'No service principal configured.' });
    const pbi = clientFor(req, sp);
    const assignments = await pbi.getRoleAssignments(req.params.workspaceId);
    res.json({ success: true, canManage: true, assignments: assignments.map(shapeAssignment) });
  } catch (err) {
    const status = err && err.response ? err.response.status : null;
    if (status === 401 || status === 403) {
      return res.json({
        success: false,
        canManage: false,
        message: 'This service principal is not an Admin of that workspace, so it cannot see or change who has access '
          + 'to it. Grant it the Admin role there first — the section above adds it as Admin.',
      });
    }
    res.json({ success: false, message: err.message });
  }
});

function shapeAssignment(assignment) {
  const principal = (assignment && assignment.principal) || {};
  return {
    id: assignment.id,
    role: assignment.role,
    principalId: principal.id || null,
    principalType: principal.type || null,
    displayName: principal.displayName || null,
    // The API nests the identifier differently per principal type.
    detail: (principal.userDetails && principal.userDetails.userPrincipalName)
      || (principal.groupDetails && principal.groupDetails.email)
      || (principal.servicePrincipalDetails && principal.servicePrincipalDetails.aadAppId)
      || null,
  };
}

/** Grants one principal one role in one workspace. */
router.post('/roles/:workspaceId', async (req, res) => {
  try {
    const body = req.body || {};
    const principalId = String(body.principalId || '').trim();
    const principalType = String(body.principalType || '').trim();
    const role = String(body.role || '').trim();

    if (!principalId || !principalType || !role) {
      return res.json({ success: false, message: 'Pick a user or group and a role first.' });
    }
    if (!FABRIC_ROLES.some(candidate => candidate.key === role)) {
      return res.json({ success: false, message: 'Unknown role: ' + role });
    }

    const sp = await resolveServicePrincipal(body.spId);
    if (!sp) return res.json({ success: false, message: 'No service principal configured.' });

    const pbi = clientFor(req, sp);
    await pbi.addRoleAssignment(req.params.workspaceId, principalId, principalType, role);
    res.json({ success: true, message: role + ' granted.' });
  } catch (err) {
    const status = err && err.response ? err.response.status : null;
    if (status === 409) {
      return res.json({ success: false, message: 'That principal already has a role in this workspace. Remove it first to change the role.' });
    }
    if (status === 401 || status === 403) {
      return res.json({ success: false, message: 'The service principal is not an Admin of this workspace, so it cannot grant access there.' });
    }
    res.json({ success: false, message: err.message });
  }
});

/** Removes one role assignment. */
router.delete('/roles/:workspaceId/:assignmentId', async (req, res) => {
  try {
    const sp = await resolveServicePrincipal(req.query.spId);
    if (!sp) return res.json({ success: false, message: 'No service principal configured.' });
    const pbi = clientFor(req, sp);
    await pbi.deleteRoleAssignment(req.params.workspaceId, req.params.assignmentId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/** Finds a user, security group or service principal in Entra ID. */
router.get('/roles/entra/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    const type = String(req.query.type || 'User').trim();
    if (query.length < 2) return res.json({ success: true, results: [] });

    const sp = await resolveServicePrincipal(req.query.spId);
    if (!sp) return res.json({ success: false, message: 'No service principal configured.' });
    const pbi = clientFor(req, sp);

    let results = [];
    if (type === 'Group') {
      results = (await pbi.searchEntraGroups(query)).map(group => ({
        id: group.id, displayName: group.displayName, type: 'Group',
        detail: group.securityEnabled ? 'Security group' : 'Distribution or Microsoft 365 group',
        // Fabric does accept these, so the choice stays open — but a mail group's
        // membership is maintained for delivering mail, not for granting access,
        // and the two drift apart. Marked, not blocked.
        usable: true,
        warning: group.securityEnabled ? null : 'Prefer a security group',
      }));
    } else if (type === 'ServicePrincipal') {
      results = (await pbi.searchEntraServicePrincipals(query)).map(principal => ({
        id: principal.id, displayName: principal.displayName, type: 'ServicePrincipal',
        detail: principal.appId, usable: true,
      }));
    } else {
      results = (await pbi.searchEntraUsers(query)).map(user => ({
        id: user.id, displayName: user.displayName, type: 'User',
        detail: user.userPrincipalName || user.mail, usable: true,
      }));
    }
    res.json({ success: true, results });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/**
 * Remembers a grant that has to wait for an administrator sign-in.
 *
 * Without this the operator picks workspaces, is sent away to authorize, comes
 * back to an empty page and has to pick them all again — the second time being
 * the only one that does anything.
 */
router.post('/pending', (req, res) => {
  const body = req.body || {};
  const workspaceIds = (Array.isArray(body.workspaceIds) ? body.workspaceIds : [])
    .map(id => String(id || '').trim())
    .filter(Boolean);

  if (!req.session) return res.json({ success: false, message: 'No session to remember the selection in.' });
  if (!workspaceIds.length) {
    delete req.session.pendingGrant;
    return res.json({ success: true, stored: 0 });
  }

  req.session.pendingGrant = { spId: body.spId || null, workspaceIds };
  res.json({ success: true, stored: workspaceIds.length });
});

module.exports = router;
