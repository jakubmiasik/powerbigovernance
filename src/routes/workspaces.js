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

// Get PBI service using first configured SP
async function getPbiService(req, res) {
  const globalRun = res ? res.locals.globalRun : null;
  let sp;
  if (globalRun && globalRun.sp_id) {
    sp = await db.getServicePrincipalById(globalRun.sp_id);
  }
  if (!sp) {
    const sps = await db.getServicePrincipals();
    if (sps.length === 0) throw new Error('No service principal configured. Go to Settings to add one.');
    sp = sps[0];
  }
  const keyVaultAuthUrl = `/settings/kv/auth?spId=${encodeURIComponent(String(sp.id))}&returnTo=${encodeURIComponent(req.originalUrl || '/workspaces')}`;
  return createPowerBIService(sp, {
    keyVaultDelegatedToken: req.session?.keyVaultDelegatedToken?.token || null,
    keyVaultAuthUrl,
  });
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
    const pbi = await getPbiService(req, res);
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
    const pbi = await getPbiService(req, res);
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
    const pbi = await getPbiService(req, res);
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
    const pbi = await getPbiService(req, res);
    const { workspaceId, itemId } = req.params;
    const allLinks = await pbi.getWorkspaceLineage(workspaceId);
    // Filter connections related to this item (as source or target)
    const connections = allLinks.filter(l => l.sourceItemId === itemId || l.targetItemId === itemId);
    res.json({ success: true, connections });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── OneLake Storage Size ──

// Get storage breakdown for a workspace
router.get('/:workspaceId/storage', async (req, res) => {
  try {
    const pbi = await getPbiService(req, res);
    const globalRun = res.locals.globalRun;

    // Get items for this workspace (from saved data or live API)
    let items = [];
    const savedWorkspaces = await loadWorkspacesFromRun(res);
    if (savedWorkspaces) {
      const ws = savedWorkspaces.find(w => w.id === req.params.workspaceId);
      if (ws && ws.items) items = ws.items;
    }
    if (!items.length) {
      try {
        items = await pbi.getItemsByWorkspace(req.params.workspaceId);
      } catch { /* no items available */ }
    }

    if (!items.length) {
      return res.json({ success: false, message: 'No items found in this workspace. Run an analysis first or ensure the SP has access.' });
    }

    const storage = await pbi.getWorkspaceStorageSize(req.params.workspaceId, items);

    // Save storage results back to analysis run if available
    if (globalRun && globalRun.id && savedWorkspaces) {
      try {
        const ws = savedWorkspaces.find(w => w.id === req.params.workspaceId);
        if (ws) {
          ws.storageSize = storage.totalSize;
          ws.storageFiles = storage.totalFiles;
          ws.storageItems = storage.items;
          // Recalculate totals
          const run = await db.getAnalysisRunById(globalRun.id);
          if (run && run.results_json) {
            const results = JSON.parse(run.results_json);
            const wsInResults = (results.workspaces || []).find(w => w.id === req.params.workspaceId);
            if (wsInResults) {
              wsInResults.storageSize = storage.totalSize;
              wsInResults.storageFiles = storage.totalFiles;
              wsInResults.storageItems = storage.items;
              // Update summary totals
              results.summary.totalStorageSize = (results.workspaces || []).reduce((s, w) => s + (w.storageSize || 0), 0);
              results.summary.totalStorageFiles = (results.workspaces || []).reduce((s, w) => s + (w.storageFiles || 0), 0);
              results.summary.storageScannedCount = (results.workspaces || []).filter(w => w.storageSize > 0).length;
              await db.updateAnalysisRun(globalRun.id, {
                status: run.status,
                totalWorkspaces: run.total_workspaces,
                totalReports: run.total_reports,
                totalDatasets: run.total_datasets,
                totalDashboards: run.total_dashboards,
                totalDataflows: run.total_dataflows,
                totalUsers: run.total_users,
                resultsJson: JSON.stringify(results),
              });
            }
          }
        }
      } catch (saveErr) {
        console.warn('[Storage] Failed to save custom storage results:', saveErr.message);
      }
    }

    res.json({
      success: true,
      totalSize: storage.totalSize,
      totalFiles: storage.totalFiles,
      items: storage.items,
      scannedItems: items.length,
      errorCount: (storage.errors || []).length,
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Get storage for a specific item
router.get('/:workspaceId/storage/:itemId', async (req, res) => {
  try {
    const pbi = await getPbiService(req, res);
    const result = await pbi.getItemStorageSize(req.params.workspaceId, req.params.itemId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Workspace Role Assignments (Fabric API) ──

// GET role assignments for a workspace
router.get('/:workspaceId/roles', async (req, res) => {
  try {
    const pbi = await getPbiService(req, res);
    const roles = await pbi.getRoleAssignments(req.params.workspaceId);
    res.json({ success: true, roles });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST add role assignment
router.post('/:workspaceId/roles', async (req, res) => {
  try {
    const { principalId, principalType, role } = req.body;
    if (!principalId || !principalType || !role) {
      return res.json({ success: false, message: 'Missing principalId, principalType, or role.' });
    }
    const pbi = await getPbiService(req, res);
    const result = await pbi.addRoleAssignment(req.params.workspaceId, principalId, principalType, role);
    res.json({ success: true, result });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// PATCH update role assignment
router.patch('/:workspaceId/roles/:roleAssignmentId', async (req, res) => {
  try {
    const { role } = req.body;
    if (!role) return res.json({ success: false, message: 'Missing role.' });
    const pbi = await getPbiService(req, res);
    const result = await pbi.updateRoleAssignment(req.params.workspaceId, req.params.roleAssignmentId, role);
    res.json({ success: true, result });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// DELETE role assignment
router.delete('/:workspaceId/roles/:roleAssignmentId', async (req, res) => {
  try {
    const pbi = await getPbiService(req, res);
    await pbi.deleteRoleAssignment(req.params.workspaceId, req.params.roleAssignmentId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Entra ID Search (Microsoft Graph API) ──

router.get('/:workspaceId/entra/search', async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q || q.length < 2) return res.json({ success: true, results: [] });
    const pbi = await getPbiService(req, res);

    let results = [];
    if (type === 'ServicePrincipal') {
      const spResults = await pbi.searchEntraServicePrincipals(q);
      results = spResults.map(s => ({ id: s.id, displayName: s.displayName, detail: s.appId, type: 'ServicePrincipal' }));
    } else if (type === 'Group') {
      const groups = await pbi.searchEntraGroups(q);
      results = groups.map(g => ({ id: g.id, displayName: g.displayName, detail: g.securityEnabled ? 'Security Group' : 'Distribution Group', type: 'Group' }));
    } else {
      // Default: search users
      const users = await pbi.searchEntraUsers(q);
      results = users.map(u => ({ id: u.id, displayName: u.displayName, detail: u.userPrincipalName || u.mail, type: 'User' }));
    }
    res.json({ success: true, results });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;


