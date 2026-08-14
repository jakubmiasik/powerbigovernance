const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService } = require('../services/powerbiService');
const { getDelegatedAuthUrl } = require('../services/authService');
const { explainError } = require('../services/httpErrorService');
const pipelineService = require('../services/deploymentPipelineService');

function explainForResponse(err) {
  const info = explainError(err);
  if (!info) return {};
  return { status: info.status, statusTitle: info.title, explanation: info.explanation, hint: info.hint };
}

// Resolve the service principal the page is acting as. Mirrors the workspaces
// route: the SP tied to the globally selected run wins, otherwise the first one.
async function resolveSp(res) {
  const globalRun = res ? res.locals.globalRun : null;
  let sp;
  if (globalRun && globalRun.sp_id) sp = await db.getServicePrincipalById(globalRun.sp_id);
  if (!sp) {
    const sps = await db.getServicePrincipals();
    if (sps.length === 0) throw new Error('No service principal configured. Go to Settings to add one.');
    sp = sps[0];
  }
  return sp;
}

async function getPbiService(req, res) {
  const sp = await resolveSp(res);
  const keyVaultAuthUrl = `/settings/kv/auth?spId=${encodeURIComponent(String(sp.id))}&returnTo=${encodeURIComponent(req.originalUrl || '/pipelines')}`;
  const pbi = createPowerBIService(sp, {
    keyVaultDelegatedToken: req.session?.keyVaultDelegatedToken?.token || null,
    keyVaultAuthUrl,
  });
  return { pbi, sp };
}

function isAuthError(err) {
  const status = err && err.status;
  return status === 401 || status === 403;
}

// ── Page shell ──
router.get('/', async (req, res) => {
  let spName = null;
  let configError = null;
  try {
    const sp = await resolveSp(res);
    spName = sp.name || sp.client_id;
  } catch (err) {
    configError = err.message;
  }
  res.render('pipelines/list', {
    title: 'Deployment Pipelines',
    user: req.user,
    spName,
    configError,
    grantAuth: req.query.grantAuth || null,
    grantError: req.query.error || null,
  });
});

// ── Pipeline data + access probe ──
// Kept out of the page render because each pipeline needs its own users lookup,
// which is slow and rate limited; the page loads immediately and fills in.
router.get('/data', async (req, res) => {
  try {
    const { pbi, sp } = await getPbiService(req, res);
    const { pipelines, identifier } = await pipelineService.listPipelinesWithAccess(pbi, sp);
    res.json({
      pipelines,
      principalIdentifier: identifier,
      spName: sp.name || sp.client_id,
      granted: pipelines.filter((p) => p.access === 'granted').length,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, ...explainForResponse(err) });
  }
});

// ── Grant the service principal Admin on a pipeline ──
// The admin write API's support for app-only tokens is not documented, so try
// the service principal first and fall back to a delegated Fabric administrator
// token when the tenant rejects it.
router.post('/grant', async (req, res) => {
  const pipelineId = req.body && req.body.pipelineId;
  if (!pipelineId) return res.status(400).json({ error: 'A pipeline ID is required.' });

  try {
    const { pbi, sp } = await getPbiService(req, res);
    const identifier = pipelineService.principalIdentifier(sp);
    if (!identifier) {
      return res.status(400).json({
        error: 'This service principal has no enterprise application object ID recorded.',
        hint: 'Add the enterprise application (service principal) object ID in Settings, then try again.',
      });
    }

    const delegatedToken = req.session && req.session.pbiGrantToken;
    try {
      await pbi.grantDeploymentPipelineAccess(pipelineId, identifier,
        delegatedToken ? { delegatedToken } : {});
    } catch (err) {
      if (!isAuthError(err) || delegatedToken) throw err;
      const authUrl = '/pipelines/grant-auth?returnTo=' + encodeURIComponent('/pipelines');
      return res.json({
        success: false,
        requiresAdminAuth: true,
        authUrl,
        error: err.message,
        ...explainForResponse(err),
        message: 'Granting pipeline access needs a signed-in Fabric administrator. '
          + 'Sign in and the grant will be retried.',
      });
    }
    res.json({ success: true, pipelineId, identifier });
  } catch (err) {
    res.status(500).json({ error: err.message, ...explainForResponse(err) });
  }
});

// ── Delegated sign-in for the grant ──
// getDelegatedAuthUrl is async (MSAL builds the URL), so it must be awaited —
// redirecting to the unresolved promise sends the browser to "[object Promise]".
router.get('/grant-auth', async (req, res) => {
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/migrate/auth/callback`;
    res.redirect(await getDelegatedAuthUrl(redirectUri, 'grant-sp-pipelines'));
  } catch (err) {
    res.redirect('/pipelines?error=' + encodeURIComponent(err.message));
  }
});

// ── Delete pipelines ──
// DELETE /myorg/pipelines/{id} has no admin-scoped equivalent, so access is
// re-checked here rather than trusting whatever the browser last rendered.
router.post('/delete', async (req, res) => {
  const requested = Array.isArray(req.body && req.body.pipelines) ? req.body.pipelines : [];
  if (requested.length === 0) return res.status(400).json({ error: 'No pipelines were selected.' });

  try {
    const { pbi, sp } = await getPbiService(req, res);
    const identifier = pipelineService.principalIdentifier(sp);

    const allowed = [];
    const blocked = [];
    for (const pipeline of requested) {
      if (!pipeline || !pipeline.id) continue;
      try {
        const users = await pbi.getDeploymentPipelineUsers(pipeline.id);
        if (pipelineService.hasPrincipalAccess(users, identifier)) {
          allowed.push(pipeline);
        } else {
          blocked.push({
            id: pipeline.id,
            name: pipeline.name || pipeline.id,
            success: false,
            error: 'The service principal is not an Admin on this pipeline.',
            explanation: 'Deleting a deployment pipeline is only possible for a principal that is an '
              + 'Admin on that pipeline. Tenant administrator rights are not enough.',
            hint: 'Use "Grant access" on this pipeline first, then delete it.',
          });
        }
      } catch (err) {
        blocked.push({
          id: pipeline.id,
          name: pipeline.name || pipeline.id,
          success: false,
          error: err.message,
          ...explainForResponse(err),
        });
      }
    }

    const outcome = await pipelineService.deletePipelines(pbi, allowed);
    const results = [...outcome.results, ...blocked];
    res.json({
      results,
      deleted: outcome.deleted,
      failed: results.filter((r) => !r.success).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, ...explainForResponse(err) });
  }
});

module.exports = router;
