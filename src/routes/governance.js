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

    // Get SP enterprise object ID for access check
    const sps = await db.getServicePrincipals();
    const spEnterpriseObjectId = (sps.length > 0 && sps[0].enterprise_app_object_id) ? sps[0].enterprise_app_object_id : '';

    if (!run || !results || !results.summary) {
      return res.render('governance/overview', {
        title: 'Governance Overview', user: req.user,
        governance: null, workspaces: [], run: null,
        noData: true,
        creatorCount: 0, explorerCount: 0,
        spEnterpriseObjectId,
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
      spEnterpriseObjectId,
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

// Grant SP access to workspaces (batch)
const { createPowerBIService } = require('../services/powerbiService');
router.post('/grant-sp-access', async (req, res) => {
  try {
    const { workspaceIds } = req.body;
    if (!workspaceIds || !workspaceIds.length) {
      return res.json({ success: false, message: 'No workspaces selected.' });
    }

    const sps = await db.getServicePrincipals();
    if (!sps.length) return res.json({ success: false, message: 'No service principal configured.' });
    const sp = sps[0];

    if (!sp.enterprise_app_object_id) {
      return res.json({ success: false, message: 'Enterprise Application Object ID not configured. Go to Settings to add it.' });
    }

    const pbi = createPowerBIService(sp);
    const results = [];
    for (const wsId of workspaceIds) {
      try {
        await pbi.addWorkspaceAdmin(wsId, sp.enterprise_app_object_id, 'App');
        results.push({ workspaceId: wsId, success: true });
      } catch (err) {
        results.push({ workspaceId: wsId, success: false, error: err.message });
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
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
