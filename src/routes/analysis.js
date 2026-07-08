const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService } = require('../services/powerbiService');

const activeAnalyses = new Map();

router.get('/', async (req, res) => {
  try {
    const [servicePrincipals, runs] = await Promise.all([
      db.getServicePrincipals(),
      db.getAnalysisRuns(),
    ]);
    res.render('analysis/index', {
      title: 'Run Analysis',
      user: req.user,
      servicePrincipals,
      runs,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.post('/run', async (req, res) => {
  const spId = parseInt(req.body.spId);
  try {
    const sp = await db.getServicePrincipalById(spId);
    if (!sp) return res.json({ success: false, message: 'Service principal not found.' });

    const runId = await db.createAnalysisRun({
      spId: sp.id,
      spName: sp.name,
      tenantId: sp.tenant_id,
      runBy: req.user?.name || 'anonymous',
    });

    runAnalysis(runId, sp);
    res.json({ success: true, runId });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.get('/progress/:runId', (req, res) => {
  const runId = parseInt(req.params.runId);
  const progress = activeAnalyses.get(runId) || { status: 'unknown', progress: 0, message: '' };
  res.json(progress);
});

router.get('/results/:runId', async (req, res) => {
  try {
    const run = await db.getAnalysisRunById(parseInt(req.params.runId));
    if (!run) return res.status(404).json({ error: 'Run not found' });

    let results = null;
    if (run.results_json) {
      try { results = JSON.parse(run.results_json); } catch { results = null; }
    }

    res.render('analysis/results', {
      title: 'Analysis Results',
      user: req.user,
      run,
      results,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.post('/delete/:runId', async (req, res) => {
  try {
    await db.deleteAnalysisRun(parseInt(req.params.runId));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

async function runAnalysis(runId, sp) {
  const progress = { status: 'running', progress: 0, message: 'Starting analysis...', current: 0, total: 0 };
  activeAnalyses.set(runId, progress);

  try {
    const pbi = createPowerBIService(sp);

    // Step 1: Get all workspaces via Fabric Admin API
    progress.message = 'Fetching workspaces...';
    const workspaces = await pbi.getWorkspaces();
    progress.total = workspaces.length;
    progress.message = `Found ${workspaces.length} workspaces. Fetching all items...`;
    progress.progress = 10;

    // Step 2: Get ALL items across tenant via Fabric Admin API (single call, paginated)
    progress.message = 'Fetching all items via Fabric Admin API...';
    const allItems = await pbi.getAllItems();
    progress.progress = 40;
    progress.message = `Found ${allItems.length} items. Processing...`;

    // Step 3: Get capacities
    const capacities = await pbi.getCapacities().catch(() => []);
    const fabricSkus = new Set(['F2', 'F4', 'F8', 'F16', 'F32', 'F64', 'F128', 'F256', 'F512', 'F1024', 'F2048', 'FT1']);
    const hasFabric = capacities.some(c => fabricSkus.has(c.sku));

    // Step 4: Group items by workspace
    const itemsByWorkspace = new Map();
    const allUsers = new Set();
    const itemTypeCounts = {};

    for (const item of allItems) {
      const wsId = item.workspaceId;
      if (!itemsByWorkspace.has(wsId)) {
        itemsByWorkspace.set(wsId, []);
      }
      itemsByWorkspace.get(wsId).push(item);

      const t = (item.type || 'Unknown').toLowerCase();
      itemTypeCounts[item.type || 'Unknown'] = (itemTypeCounts[item.type || 'Unknown'] || 0) + 1;

      if (item.creatorPrincipal) {
        const creator = item.creatorPrincipal;
        allUsers.add(creator.userDetails?.userPrincipalName || creator.displayName || creator.id);
      }
    }

    // Step 5: Build workspace details
    progress.message = 'Building workspace details...';
    progress.progress = 60;

    const workspaceDetails = [];
    let totalReports = 0, totalDatasets = 0, totalDashboards = 0, totalDataflows = 0;
    let totalLakehouses = 0, totalNotebooks = 0, totalPipelines = 0, totalWarehouses = 0;

    for (const ws of workspaces) {
      const wsItems = itemsByWorkspace.get(ws.id) || [];
      const reports = wsItems.filter(i => ['Report', 'PaginatedReport'].includes(i.type));
      const datasets = wsItems.filter(i => ['SemanticModel', 'Dataset'].includes(i.type));
      const dashboards = wsItems.filter(i => i.type === 'Dashboard');
      const dataflows = wsItems.filter(i => (i.type || '').toLowerCase().includes('dataflow'));
      const lakehouses = wsItems.filter(i => i.type === 'Lakehouse');
      const notebooks = wsItems.filter(i => i.type === 'Notebook');
      const pipelines = wsItems.filter(i => i.type === 'DataPipeline');
      const warehouses = wsItems.filter(i => i.type === 'Warehouse' || i.type === 'SQLDatabase');

      totalReports += reports.length;
      totalDatasets += datasets.length;
      totalDashboards += dashboards.length;
      totalDataflows += dataflows.length;
      totalLakehouses += lakehouses.length;
      totalNotebooks += notebooks.length;
      totalPipelines += pipelines.length;
      totalWarehouses += warehouses.length;

      const wsName = ws.displayName || ws.name || 'Unnamed';

      workspaceDetails.push({
        id: ws.id,
        name: wsName,
        state: ws.state,
        type: ws.type,
        capacityId: ws.capacityId,
        totalItems: wsItems.length,
        reportCount: reports.length,
        datasetCount: datasets.length,
        dashboardCount: dashboards.length,
        dataflowCount: dataflows.length,
        lakehouseCount: lakehouses.length,
        notebookCount: notebooks.length,
        pipelineCount: pipelines.length,
        warehouseCount: warehouses.length,
        items: wsItems.map(i => ({
          id: i.id,
          name: i.name,
          type: i.type,
          state: i.state,
          lastUpdated: i.lastUpdatedDate,
          creator: i.creatorPrincipal ? {
            name: i.creatorPrincipal.displayName,
            upn: i.creatorPrincipal.userDetails?.userPrincipalName,
            type: i.creatorPrincipal.type,
          } : null,
          description: i.description,
        })),
      });
    }

    progress.progress = 80;

    // Step 6: Fetch workspace users in batches
    progress.message = 'Fetching workspace users...';
    const batchSize = 10;
    let usersFetched = 0;
    for (let i = 0; i < workspaces.length; i += batchSize) {
      const batch = workspaces.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(ws => pbi.getWorkspaceUsers(ws.id))
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          const users = results[j].value;
          const wsDetail = workspaceDetails.find(w => w.id === batch[j].id);
          if (wsDetail) {
            wsDetail.userCount = users.length;
            wsDetail.users = users.map(u => ({
              name: u.displayName,
              email: u.emailAddress,
              role: u.groupUserAccessRight,
              type: u.principalType,
            }));
          }
          users.forEach(u => allUsers.add(u.emailAddress || u.displayName || u.identifier));
        }
      }
      usersFetched = Math.min(i + batchSize, workspaces.length);
      progress.current = usersFetched;
      progress.progress = 80 + Math.round((usersFetched / workspaces.length) * 20);
      progress.message = `Fetching users: ${usersFetched} / ${workspaces.length} workspaces...`;
    }

    // Build summary
    const summary = {
      totalWorkspaces: workspaces.length,
      totalItems: allItems.length,
      totalReports,
      totalDatasets,
      totalDashboards,
      totalDataflows,
      totalLakehouses,
      totalNotebooks,
      totalPipelines,
      totalWarehouses,
      totalUsers: allUsers.size,
      hasFabric,
      itemTypeCounts,
      capacities: capacities.map(c => ({ displayName: c.displayName, sku: c.sku, state: c.state, region: c.region })),
      workspacesByState: {},
      workspacesByType: {},
      workspacesOnCapacity: 0,
      workspacesOnSharedCapacity: 0,
    };

    for (const ws of workspaces) {
      const state = ws.state || 'Active';
      const type = ws.type || 'Workspace';
      summary.workspacesByState[state] = (summary.workspacesByState[state] || 0) + 1;
      summary.workspacesByType[type] = (summary.workspacesByType[type] || 0) + 1;
      if (ws.capacityId && ws.capacityId !== '00000000-0000-0000-0000-000000000000') {
        summary.workspacesOnCapacity++;
      } else {
        summary.workspacesOnSharedCapacity++;
      }
    }

    const resultsJson = JSON.stringify({ summary, workspaces: workspaceDetails });

    await db.updateAnalysisRun(runId, {
      status: 'completed',
      totalWorkspaces: workspaces.length,
      totalReports,
      totalDatasets,
      totalDashboards,
      totalDataflows,
      totalUsers: allUsers.size,
      resultsJson,
    });

    progress.status = 'completed';
    progress.progress = 100;
    progress.message = 'Analysis complete!';
  } catch (err) {
    progress.status = 'failed';
    progress.message = `Error: ${err.message}`;
    try {
      await db.updateAnalysisRun(runId, {
        status: 'failed',
        totalWorkspaces: 0, totalReports: 0, totalDatasets: 0,
        totalDashboards: 0, totalDataflows: 0, totalUsers: 0,
        resultsJson: JSON.stringify({ error: err.message }),
      });
    } catch { /* ignore */ }
  }

  setTimeout(() => activeAnalyses.delete(runId), 5 * 60 * 1000);
}

module.exports = router;
