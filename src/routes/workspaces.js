const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService } = require('../services/powerbiService');

function categorizeItems(items) {
  const reports = [], datasets = [], dashboards = [], dataflows = [];
  const lakehouses = [], notebooks = [], pipelines = [], warehouses = [], others = [];

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

// Load workspace list from saved analysis (global run)
async function loadWorkspacesFromRun(res) {
  const globalRun = res.locals.globalRun;
  if (!globalRun) return null;

  const fullRun = await db.getAnalysisRunById(globalRun.id);
  try {
    const results = JSON.parse(fullRun.results_json);
    return results.workspaces || [];
  } catch { return null; }
}

router.get('/', async (req, res) => {
  try {
    const savedWorkspaces = await loadWorkspacesFromRun(res);

    if (savedWorkspaces) {
      // Use saved data
      const workspaces = savedWorkspaces.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const stats = { total: workspaces.length, byState: {}, byLicense: {}, bySku: {} };
      for (const ws of workspaces) {
        const state = ws.state || 'Active';
        const license = ws.licenseType || 'Pro';
        const sku = ws.capacitySku || 'Shared (Pro)';
        stats.byState[state] = (stats.byState[state] || 0) + 1;
        stats.byLicense[license] = (stats.byLicense[license] || 0) + 1;
        stats.bySku[sku] = (stats.bySku[sku] || 0) + 1;
      }
      return res.render('workspaces/list', {
        title: 'Workspaces', user: req.user, workspaces, stats, fromSavedData: true,
      });
    }

    // No saved data — show message
    res.render('workspaces/list', {
      title: 'Workspaces', user: req.user, workspaces: [],
      stats: { total: 0, byState: {}, byLicense: {}, bySku: {} }, fromSavedData: false,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const workspaceId = req.params.id;

    // Use saved analysis data from global run
    const savedWorkspaces = await loadWorkspacesFromRun(res);
    if (savedWorkspaces) {
      const savedWs = savedWorkspaces.find(w => w.id === workspaceId);
      if (savedWs) {
        const categorized = categorizeItems(savedWs.items || []);
        return res.render('workspaces/detail', {
          title: savedWs.name || 'Workspace', user: req.user,
          workspace: savedWs, items: savedWs.items || [], ...categorized,
          users: savedWs.users || [],
        });
      }
    }

    // Fallback to live API
    const sps = await db.getServicePrincipals();
    if (sps.length === 0) throw new Error('No service principal configured.');
    const pbi = createPowerBIService(sps[0]);
    const [workspace, items, users] = await Promise.all([
      pbi.getWorkspaceById(workspaceId),
      pbi.getItemsByWorkspace(workspaceId),
      pbi.getWorkspaceUsers(workspaceId),
    ]);
    const categorized = categorizeItems(items);
    const wsName = workspace.displayName || workspace.name || 'Workspace';

    res.render('workspaces/detail', {
      title: wsName, user: req.user,
      workspace: { ...workspace, name: wsName }, items, ...categorized, users,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/:workspaceId/datasets/:datasetId', async (req, res) => {
  try {
    const sps = await db.getServicePrincipals();
    if (sps.length === 0) throw new Error('No service principal configured.');
    const pbi = createPowerBIService(sps[0]);
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
    const sps = await db.getServicePrincipals();
    if (sps.length === 0) throw new Error('No service principal configured.');
    const pbi = createPowerBIService(sps[0]);
    const { workspaceId, dashboardId } = req.params;
    const tiles = await pbi.getDashboardTiles(workspaceId, dashboardId);
    res.render('workspaces/dashboard-detail', { title: 'Dashboard Tiles', user: req.user, workspaceId, dashboardId, tiles });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// ── Lineage: get item connections for graph visualization ──
// Uses PBI Scanner API with lineage=true to get full workspace lineage, then filters for the item
router.get('/:workspaceId/lineage/:itemId', async (req, res) => {
  try {
    const globalRun = res.locals.globalRun;
    let sp;
    if (globalRun && globalRun.sp_id) {
      sp = await db.getServicePrincipalById(globalRun.sp_id);
    }
    if (!sp) {
      const sps = await db.getServicePrincipals();
      if (sps.length === 0) return res.json({ success: false, message: 'No SP configured.' });
      sp = sps[0];
    }
    const pbi = createPowerBIService(sp);
    const { workspaceId, itemId } = req.params;
    const allLinks = await pbi.getWorkspaceLineage(workspaceId);
    // Filter connections related to this item (as source or target)
    const connections = allLinks.filter(l => l.sourceItemId === itemId || l.targetItemId === itemId);
    res.json({ success: true, connections });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
