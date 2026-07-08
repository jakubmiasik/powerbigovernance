const express = require('express');
const router = express.Router();
const pbi = require('../services/powerbiService');

router.get('/', async (req, res) => {
  try {
    const useAdmin = req.query.mode === 'admin';
    const workspaces = await pbi.getWorkspaces({ useAdmin });

    // Sort by name
    workspaces.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Compute stats
    const stats = {
      total: workspaces.length,
      byState: {},
      byType: {},
    };
    for (const ws of workspaces) {
      const state = ws.state || 'Unknown';
      const type = ws.type || 'Unknown';
      stats.byState[state] = (stats.byState[state] || 0) + 1;
      stats.byType[type] = (stats.byType[type] || 0) + 1;
    }

    res.render('workspaces/list', {
      title: 'Workspaces',
      user: req.user,
      workspaces,
      stats,
      useAdmin,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const workspaceId = req.params.id;
    const tab = req.query.tab || 'overview';

    // Fetch workspace details and all artifacts in parallel
    const [reports, datasets, dashboards, dataflows, users] = await Promise.all([
      pbi.getReports(workspaceId),
      pbi.getDatasets(workspaceId),
      pbi.getDashboards(workspaceId),
      pbi.getDataflows(workspaceId),
      pbi.getWorkspaceUsers(workspaceId),
    ]);

    // Try to get workspace info
    let workspace;
    try {
      workspace = await pbi.getWorkspaceById(workspaceId);
    } catch {
      workspace = { id: workspaceId, name: 'Workspace' };
    }

    res.render('workspaces/detail', {
      title: workspace.name || 'Workspace Details',
      user: req.user,
      workspace,
      reports,
      datasets,
      dashboards,
      dataflows,
      users,
      tab,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// Dataset details (refresh history + datasources)
router.get('/:workspaceId/datasets/:datasetId', async (req, res) => {
  try {
    const { workspaceId, datasetId } = req.params;

    const [refreshHistory, datasources, parameters] = await Promise.all([
      pbi.getDatasetRefreshHistory(workspaceId, datasetId),
      pbi.getDatasetDatasources(workspaceId, datasetId),
      pbi.getDatasetParameters(workspaceId, datasetId),
    ]);

    res.render('workspaces/dataset-detail', {
      title: 'Dataset Details',
      user: req.user,
      workspaceId,
      datasetId,
      refreshHistory,
      datasources,
      parameters,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// Dashboard tiles
router.get('/:workspaceId/dashboards/:dashboardId', async (req, res) => {
  try {
    const { workspaceId, dashboardId } = req.params;
    const tiles = await pbi.getDashboardTiles(workspaceId, dashboardId);

    res.render('workspaces/dashboard-detail', {
      title: 'Dashboard Tiles',
      user: req.user,
      workspaceId,
      dashboardId,
      tiles,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

module.exports = router;
