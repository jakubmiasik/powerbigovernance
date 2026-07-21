const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');

function normalizeArtifactType(type) {
  return (type || 'all').trim().toLowerCase();
}

function matchesArtifactType(item, requestedType) {
  const normalizedRequest = normalizeArtifactType(requestedType);
  const normalizedType = (item.type || '').toLowerCase();

  if (normalizedRequest === 'all') return true;
  if (normalizedRequest === 'report') return normalizedType === 'report' || normalizedType === 'paginatedreport';
  if (normalizedRequest === 'semanticmodel' || normalizedRequest === 'dataset') return normalizedType === 'semanticmodel' || normalizedType === 'dataset';
  if (normalizedRequest === 'dashboard') return normalizedType === 'dashboard';
  if (normalizedRequest === 'dataflow') return normalizedType.includes('dataflow') || normalizedType === 'datagen2';
  if (normalizedRequest === 'lakehouse') return normalizedType === 'lakehouse';
  if (normalizedRequest === 'notebook') return normalizedType === 'notebook';
  if (normalizedRequest === 'datapipeline' || normalizedRequest === 'pipeline') return normalizedType === 'datapipeline';
  if (normalizedRequest === 'warehouse') return normalizedType === 'warehouse' || normalizedType === 'sqldatabase';
  if (normalizedRequest === 'other') {
    return !matchesArtifactType(item, 'report')
      && !matchesArtifactType(item, 'semanticmodel')
      && !matchesArtifactType(item, 'dashboard')
      && !matchesArtifactType(item, 'dataflow')
      && !matchesArtifactType(item, 'lakehouse')
      && !matchesArtifactType(item, 'notebook')
      && !matchesArtifactType(item, 'datapipeline')
      && !matchesArtifactType(item, 'warehouse');
  }
  return normalizedType === normalizedRequest;
}

function artifactTypeLabel(type) {
  const normalized = normalizeArtifactType(type);
  const labels = {
    all: 'All', report: 'Report', semanticmodel: 'Semantic Model', dataset: 'Semantic Model',
    dashboard: 'Dashboard', dataflow: 'Dataflow', lakehouse: 'Lakehouse', notebook: 'Notebook',
    datapipeline: 'Data Pipeline', pipeline: 'Data Pipeline', warehouse: 'Warehouse', other: 'Other',
  };
  return labels[normalized] || type || 'All';
}

// Load results for the globally selected run
async function loadGlobalResults(res) {
  const globalRun = res.locals.globalRun;
  if (!globalRun) return { run: null, results: null };

  const fullRun = await db.getAnalysisRunById(globalRun.id);
  let results = null;
  try { results = fullRun.results_json ? JSON.parse(fullRun.results_json) : null; } catch { results = null; }
  return { run: fullRun, results };
}

function buildUser360(workspaces) {
  const userMap = new Map();

  function ensureUser(key, name, upn) {
    if (!userMap.has(key)) {
      userMap.set(key, { name: name || upn || 'Unknown', upn: upn || '', items: [], workspaces: [], workspaceKeys: new Set() });
    }
    return userMap.get(key);
  }

  for (const workspace of workspaces) {
    const workspaceName = workspace.name || 'Unnamed Workspace';
    for (const workspaceUser of workspace.users || []) {
      const userKey = (workspaceUser.email || workspaceUser.name || workspaceName).toLowerCase();
      const user = ensureUser(userKey, workspaceUser.name, workspaceUser.email);
      const workspaceKey = workspaceName + '::' + (workspaceUser.role || '');
      if (!user.workspaceKeys.has(workspaceKey)) {
        user.workspaceKeys.add(workspaceKey);
        user.workspaces.push({ name: workspaceName, role: workspaceUser.role || 'Unknown' });
      }
    }

    for (const item of workspace.items || []) {
      const creatorName = item.creator?.name || item.creator?.upn;
      const creatorUpn = item.creator?.upn || '';
      if (!creatorName && !creatorUpn) continue;
      const userKey = (creatorUpn || creatorName).toLowerCase();
      const user = ensureUser(userKey, creatorName, creatorUpn);
      user.items.push({ name: item.name || 'Unnamed', type: item.type || '-', workspace: workspaceName });
    }
  }

  return Array.from(userMap.values())
    .map(user => { delete user.workspaceKeys; return user; })
    .sort((a, b) => (a.name || a.upn || '').localeCompare(b.name || b.upn || ''));
}

router.get('/', async (req, res) => {
  try {
    const { run, results } = await loadGlobalResults(res);

    if (!run || !results || !results.summary) {
      return res.render('governance/overview', {
        title: 'Governance Overview', user: req.user,
        governance: null, workspaces: [], run: null,
        noData: true,
        creatorCount: 0, explorerCount: 0,
      });
    }

    const allWorkspaces = results.workspaces || [];
    const users = buildUser360(allWorkspaces);
    const creatorCount = users.filter(u => (u.items || []).length > 0).length;
    const explorerCount = users.length - creatorCount;

    res.render('governance/overview', {
      title: 'Governance Overview', user: req.user,
      governance: results.summary, workspaces: allWorkspaces, run,
      noData: false,
      creatorCount, explorerCount,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/users', async (req, res) => {
  try {
    const { run, results } = await loadGlobalResults(res);
    if (!run || !results) return res.redirect('/governance');

    const users = buildUser360(results.workspaces || []);
    res.render('governance/users', {
      title: 'Governance Users', user: req.user,
      users, totalUsers: users.length, run,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/artifacts', async (req, res) => {
  try {
    const requestedType = req.query.type || 'all';
    const { run, results } = await loadGlobalResults(res);
    if (!run || !results) return res.redirect('/governance');

    const artifacts = [];
    for (const workspace of results.workspaces || []) {
      for (const item of workspace.items || []) {
        if (!matchesArtifactType(item, requestedType)) continue;
        artifacts.push({
          type: item.type || '-', name: item.name || 'Unnamed',
          workspace: workspace.name || 'Unnamed Workspace',
          creator: item.creator?.upn || item.creator?.name || '-',
          lastUpdated: item.lastUpdated, description: item.description, state: item.state,
        });
      }
    }
    artifacts.sort((a, b) => (a.workspace || '').localeCompare(b.workspace || '') || (a.name || '').localeCompare(b.name || ''));

    res.render('governance/artifacts', {
      title: 'Governance Artifacts', user: req.user,
      artifactType: artifactTypeLabel(requestedType),
      artifacts, totalCount: artifacts.length, run,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// Grant SP access to workspaces (batch) — requires delegated user token
const { createPowerBIService } = require('../services/powerbiService');
const { getDelegatedAuthUrl, acquireDelegatedToken } = require('../services/authService');
const axios = require('axios');

// OAuth flow for granting SP access (same as migration)
router.get('/grant-auth', async (req, res) => {
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/governance/grant-auth/callback`;
    const authUrl = await getDelegatedAuthUrl(redirectUri, 'grant-sp');
    res.redirect(authUrl);
  } catch (err) {
    res.redirect('/analysis?error=' + encodeURIComponent(err.message));
  }
});

router.get('/grant-auth/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) throw new Error('No authorization code received.');
    const redirectUri = `${req.protocol}://${req.get('host')}/governance/grant-auth/callback`;
    const token = await acquireDelegatedToken(code, redirectUri);
    req.session.pbiGrantToken = token;
    res.redirect('/analysis?grantAuth=success');
  } catch (err) {
    res.redirect('/analysis?error=' + encodeURIComponent(err.message));
  }
});

router.get('/grant-auth/status', (req, res) => {
  res.json({ authenticated: !!req.session.pbiGrantToken });
});

router.post('/grant-sp-access', async (req, res) => {
  try {
    const { workspaceIds } = req.body;
    if (!workspaceIds || !workspaceIds.length) {
      return res.json({ success: false, message: 'No workspaces selected.' });
    }

    const token = req.session.pbiGrantToken;
    if (!token) {
      return res.json({ success: false, message: 'Not authorized. Click "Authorize as Power BI Admin" first.' });
    }

    const sps = await db.getServicePrincipals();
    if (!sps.length) return res.json({ success: false, message: 'No service principal configured.' });
    const sp = sps[0];

    if (!sp.enterprise_app_object_id) {
      return res.json({ success: false, message: 'Enterprise Application Object ID not configured. Go to Settings to add it.' });
    }

    const results = [];
    for (const wsId of workspaceIds) {
      try {
        await axios.post(
          `https://api.powerbi.com/v1.0/myorg/admin/groups/${wsId}/users`,
          {
            groupUserAccessRight: 'Admin',
            identifier: sp.enterprise_app_object_id,
            principalType: 'App',
          },
          { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        results.push({ workspaceId: wsId, success: true });
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
        results.push({ workspaceId: wsId, success: false, error: msg });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    res.json({
      success: true,
      message: `Granted access to ${successCount} workspace(s).${failCount > 0 ? ` ${failCount} failed.` : ''}`,
      results,
    });
  } catch (err) {
    if (err.message && err.message.includes('token')) {
      req.session.pbiGrantToken = null;
    }
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
