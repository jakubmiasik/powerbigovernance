const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService } = require('../services/powerbiService');

async function getDefaultPBI() {
  const sps = await db.getServicePrincipals();
  if (sps.length === 0) throw new Error('No service principal configured. Go to Settings to add one.');
  return createPowerBIService(sps[0]);
}

router.get('/', async (req, res) => {
  try {
    const pbi = await getDefaultPBI();
    const useAdmin = req.query.mode === 'admin';
    const workspaces = await pbi.getWorkspaces({ useAdmin });
    workspaces.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const stats = { total: workspaces.length, byState: {}, byType: {} };
    for (const ws of workspaces) {
      const state = ws.state || 'Unknown';
      const type = ws.type || 'Unknown';
      stats.byState[state] = (stats.byState[state] || 0) + 1;
      stats.byType[type] = (stats.byType[type] || 0) + 1;
    }
    res.render('workspaces/list', { title: 'Workspaces', user: req.user, workspaces, stats, useAdmin });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const pbi = await getDefaultPBI();
    const workspaceId = req.params.id;
    const tab = req.query.tab || 'overview';
    const [reports, datasets, dashboards, dataflows, users] = await Promise.all([
      pbi.getReports(workspaceId),
      pbi.getDatasets(workspaceId),
      pbi.getDashboards(workspaceId),
      pbi.getDataflows(workspaceId),
      pbi.getWorkspaceUsers(workspaceId),
    ]);
    let workspace;
    try { workspace = await pbi.getWorkspaceById(workspaceId); } catch { workspace = { id: workspaceId, name: 'Workspace' }; }
    res.render('workspaces/detail', { title: workspace.name || 'Workspace Details', user: req.user, workspace, reports, datasets, dashboards, dataflows, users, tab });
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
