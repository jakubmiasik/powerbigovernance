const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService } = require('../services/powerbiService');

async function getDefaultPBI() {
  const sps = await db.getServicePrincipals();
  if (sps.length === 0) throw new Error('No service principal configured. Go to Settings to add one.');
  return createPowerBIService(sps[0]);
}

// Categorize Fabric items by type
function categorizeItems(items) {
  const reports = [];
  const datasets = [];
  const dashboards = [];
  const dataflows = [];
  const lakehouses = [];
  const notebooks = [];
  const pipelines = [];
  const warehouses = [];
  const others = [];

  for (const item of items) {
    const t = (item.type || '').toLowerCase();
    if (t === 'report' || t === 'paginatedreport') reports.push(item);
    else if (t === 'semanticmodel' || t === 'dataset') datasets.push(item);
    else if (t === 'dashboard') dashboards.push(item);
    else if (t === 'dataflow' || t === 'dataflowgen2' || t === 'datagen2') dataflows.push(item);
    else if (t === 'lakehouse') lakehouses.push(item);
    else if (t === 'notebook') notebooks.push(item);
    else if (t === 'datapipeline') pipelines.push(item);
    else if (t === 'warehouse' || t === 'sqldatabase') warehouses.push(item);
    else others.push(item);
  }
  return { reports, datasets, dashboards, dataflows, lakehouses, notebooks, pipelines, warehouses, others };
}

router.get('/', async (req, res) => {
  try {
    const pbi = await getDefaultPBI();
    const workspaces = await pbi.getWorkspaces();
    workspaces.sort((a, b) => (a.displayName || a.name || '').localeCompare(b.displayName || b.name || ''));

    const stats = { total: workspaces.length, byState: {}, byType: {} };
    for (const ws of workspaces) {
      const state = ws.state || 'Active';
      const type = ws.type || 'Workspace';
      stats.byState[state] = (stats.byState[state] || 0) + 1;
      stats.byType[type] = (stats.byType[type] || 0) + 1;
    }
    res.render('workspaces/list', { title: 'Workspaces', user: req.user, workspaces, stats });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const workspaceId = req.params.id;

    // Try to use saved analysis data first
    const runs = await db.getAnalysisRuns();
    const latestRun = runs.find(r => r.status === 'completed');
    if (latestRun) {
      const fullRun = await db.getAnalysisRunById(latestRun.id);
      try {
        const results = JSON.parse(fullRun.results_json);
        const savedWs = (results.workspaces || []).find(w => w.id === workspaceId);
        if (savedWs) {
          const categorized = categorizeItems(savedWs.items || []);
          return res.render('workspaces/detail', {
            title: savedWs.name || 'Workspace',
            user: req.user,
            workspace: savedWs,
            items: savedWs.items || [],
            ...categorized,
            users: savedWs.users || [],
          });
        }
      } catch { /* fall through to live API */ }
    }

    // Fallback: fetch live from API
    const pbi = await getDefaultPBI();
    const [workspace, items, users] = await Promise.all([
      pbi.getWorkspaceById(workspaceId),
      pbi.getItemsByWorkspace(workspaceId),
      pbi.getWorkspaceUsers(workspaceId),
    ]);

    const categorized = categorizeItems(items);
    const wsName = workspace.displayName || workspace.name || 'Workspace';

    res.render('workspaces/detail', {
      title: wsName,
      user: req.user,
      workspace: { ...workspace, name: wsName },
      items,
      ...categorized,
      users,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/:workspaceId/datasets/:datasetId', async (req, res) => {
  try {
    const pbi = await getDefaultPBI();
    const { workspaceId, datasetId } = req.params;
    const [refreshHistory, datasources, parameters] = await Promise.all([
      pbi.getDatasetRefreshHistory(workspaceId, datasetId),
      pbi.getDatasetDatasources(workspaceId, datasetId),
      pbi.getDatasetParameters(workspaceId, datasetId),
    ]);
    res.render('workspaces/dataset-detail', { title: 'Dataset Details', user: req.user, workspaceId, datasetId, refreshHistory, datasources, parameters });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/:workspaceId/dashboards/:dashboardId', async (req, res) => {
  try {
    const pbi = await getDefaultPBI();
    const { workspaceId, dashboardId } = req.params;
    const tiles = await pbi.getDashboardTiles(workspaceId, dashboardId);
    res.render('workspaces/dashboard-detail', { title: 'Dashboard Tiles', user: req.user, workspaceId, dashboardId, tiles });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

module.exports = router;
