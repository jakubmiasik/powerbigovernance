const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService } = require('../services/powerbiService');

const activeAnalyses = new Map();

function ensureNotCancelled(progress) {
  if (progress.cancelRequested) {
    const error = new Error('Analysis cancelled by user.');
    error.isCancelled = true;
    throw error;
  }
}

router.get('/', async (req, res) => {
  try {
    const [runs, servicePrincipals] = await Promise.all([
      db.getAnalysisRuns(),
      db.getServicePrincipals(),
    ]);
    res.render('analysis/index', {
      title: 'Run Analysis',
      user: req.user,
      runs,
      servicePrincipals,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.post('/run', async (req, res) => {
  try {
    const sps = await db.getServicePrincipals();
    if (sps.length === 0) return res.json({ success: false, message: 'No service principal configured. Go to Settings to add one.' });
    const sp = sps[0];

    const runId = await db.createAnalysisRun({
      spId: sp.id,
      spName: sp.name,
      tenantId: sp.tenant_id,
      runBy: req.user ? req.user.name : 'anonymous',
    });

    runAnalysis(runId, sp, {
      keyVaultDelegatedToken: req.session?.keyVaultDelegatedToken?.token || null,
      keyVaultAuthUrl: `/settings/kv/auth?spId=${encodeURIComponent(String(sp.id))}&returnTo=${encodeURIComponent('/analysis')}`,
    });
    res.json({ success: true, runId });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.post('/cancel/:runId', async (req, res) => {
  const runId = parseInt(req.params.runId);
  const progress = activeAnalyses.get(runId);
  if (!progress || progress.status !== 'running') {
    return res.json({ success: false, message: 'Analysis is not currently running.' });
  }

  progress.cancelRequested = true;
  progress.status = 'cancelling';
  progress.message = 'Cancellation requested...';
  res.json({ success: true });
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

async function runAnalysis(runId, sp, authOptions = {}) {
  const progress = { status: 'running', progress: 0, message: 'Starting analysis...', current: 0, total: 0, cancelRequested: false };
  activeAnalyses.set(runId, progress);

  try {
    const pbi = createPowerBIService(sp, authOptions);

    progress.message = 'Fetching workspaces...';
    const workspaces = await pbi.getWorkspaces();
    ensureNotCancelled(progress);
    progress.total = workspaces.length;
    progress.message = 'Found ' + workspaces.length + ' workspaces. Fetching all items...';
    progress.progress = 10;

    progress.message = 'Fetching all items via Fabric Admin API...';
    const allItems = await pbi.getAllItems();
    ensureNotCancelled(progress);
    progress.progress = 40;
    progress.message = 'Found ' + allItems.length + ' items. Processing...';

    const capacities = await pbi.getCapacities().catch(() => []);
    ensureNotCancelled(progress);

    // Build capacity lookup: id (lowercase) -> capacity details
    const capacityMap = new Map();
    for (const cap of capacities) {
      capacityMap.set((cap.id || '').toLowerCase(), cap);
    }

    // Get capacity SKU for a workspace
    function getCapacitySku(ws) {
      if (!ws.capacityId || ws.capacityId === '00000000-0000-0000-0000-000000000000') {
        return null;
      }
      const cap = capacityMap.get((ws.capacityId || '').toLowerCase());
      return cap ? cap.sku : null;
    }

    // License type helper based on capacity SKU
    function getLicenseType(sku) {
      if (!sku) return 'Pro';
      const s = sku.toUpperCase();
      if (s.startsWith('F') && s !== 'FREE') return 'Fabric';
      if (s === 'PPU') return 'Premium Per User';
      if (s.startsWith('P') || s.startsWith('EM') || s.startsWith('A')) return 'Premium';
      return 'Pro';
    }

    const fabricSkus = new Set(['F2', 'F4', 'F8', 'F16', 'F32', 'F64', 'F128', 'F256', 'F512', 'F1024', 'F2048', 'FT1']);
    const hasFabric = capacities.some((capacity) => fabricSkus.has(capacity.sku));

    const itemsByWorkspace = new Map();
    const allUsers = new Set();
    const itemTypeCounts = {};

    for (const item of allItems) {
      const workspaceId = item.workspaceId;
      if (!itemsByWorkspace.has(workspaceId)) {
        itemsByWorkspace.set(workspaceId, []);
      }
      itemsByWorkspace.get(workspaceId).push(item);
      itemTypeCounts[item.type || 'Unknown'] = (itemTypeCounts[item.type || 'Unknown'] || 0) + 1;

      if (item.creatorPrincipal) {
        const creator = item.creatorPrincipal;
        allUsers.add(creator.userDetails?.userPrincipalName || creator.displayName || creator.id);
      }
    }

    progress.message = 'Building workspace details...';
    progress.progress = 60;
    ensureNotCancelled(progress);

    const workspaceDetails = [];
    let totalReports = 0;
    let totalDatasets = 0;
    let totalDashboards = 0;
    let totalDataflows = 0;
    let totalLakehouses = 0;
    let totalNotebooks = 0;
    let totalPipelines = 0;
    let totalWarehouses = 0;

    for (const ws of workspaces) {
      ensureNotCancelled(progress);
      const wsItems = itemsByWorkspace.get(ws.id) || [];
      const reports = wsItems.filter((item) => ['Report', 'PaginatedReport'].includes(item.type));
      const datasets = wsItems.filter((item) => ['SemanticModel', 'Dataset'].includes(item.type));
      const dashboards = wsItems.filter((item) => item.type === 'Dashboard');
      const dataflows = wsItems.filter((item) => (item.type || '').toLowerCase().includes('dataflow') || (item.type || '').toLowerCase() === 'datagen2');
      const lakehouses = wsItems.filter((item) => item.type === 'Lakehouse');
      const notebooks = wsItems.filter((item) => item.type === 'Notebook');
      const pipelines = wsItems.filter((item) => item.type === 'DataPipeline');
      const warehouses = wsItems.filter((item) => item.type === 'Warehouse' || item.type === 'SQLDatabase');

      totalReports += reports.length;
      totalDatasets += datasets.length;
      totalDashboards += dashboards.length;
      totalDataflows += dataflows.length;
      totalLakehouses += lakehouses.length;
      totalNotebooks += notebooks.length;
      totalPipelines += pipelines.length;
      totalWarehouses += warehouses.length;

      const wsName = ws.displayName || ws.name || 'Unnamed';

      const wsSku = getCapacitySku(ws);
      const wsLicenseType = getLicenseType(wsSku);

      workspaceDetails.push({
        id: ws.id,
        name: wsName,
        state: ws.state,
        type: ws.type,
        capacityId: ws.capacityId,
        capacitySku: wsSku,
        licenseType: wsLicenseType,
        totalItems: wsItems.length,
        reportCount: reports.length,
        datasetCount: datasets.length,
        dashboardCount: dashboards.length,
        dataflowCount: dataflows.length,
        lakehouseCount: lakehouses.length,
        notebookCount: notebooks.length,
        pipelineCount: pipelines.length,
        warehouseCount: warehouses.length,
        items: wsItems.map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
          state: item.state,
          lastUpdated: item.lastUpdatedDate,
          creator: item.creatorPrincipal ? {
            name: item.creatorPrincipal.displayName,
            upn: item.creatorPrincipal.userDetails?.userPrincipalName,
            type: item.creatorPrincipal.type,
          } : null,
          description: item.description,
        })),
      });
    }

    progress.progress = 80;
    progress.message = 'Fetching workspace users...';
    const batchSize = 10;
    let usersFetched = 0;
    for (let i = 0; i < workspaces.length; i += batchSize) {
      ensureNotCancelled(progress);
      const batch = workspaces.slice(i, i + batchSize);
      const userResults = await Promise.allSettled(batch.map((ws) => pbi.getWorkspaceUsers(ws.id)));
      ensureNotCancelled(progress);
      for (let j = 0; j < userResults.length; j += 1) {
        if (userResults[j].status === 'fulfilled') {
          const users = userResults[j].value;
          const wsDetail = workspaceDetails.find((workspace) => workspace.id === batch[j].id);
          if (wsDetail) {
            wsDetail.userCount = users.length;
            wsDetail.users = users.map((user) => ({
              name: user.displayName,
              email: user.emailAddress,
              role: user.groupUserAccessRight,
              type: user.principalType,
            }));
          }
          users.forEach((user) => allUsers.add(user.emailAddress || user.displayName || user.identifier));
        }
      }
      usersFetched = Math.min(i + batchSize, workspaces.length);
      progress.current = usersFetched;
      progress.progress = 80 + Math.round((usersFetched / Math.max(workspaces.length, 1)) * 10);
      progress.message = 'Fetching users: ' + usersFetched + ' / ' + workspaces.length + ' workspaces...';
    }

    // ── OneLake Storage Scan ──
    progress.progress = 90;
    progress.message = 'Scanning OneLake storage sizes...';
    let totalStorageSize = 0;
    let totalStorageFiles = 0;
    let storageScannedCount = 0;

    const storageTypes = new Set([
      'Lakehouse', 'Warehouse', 'SQLDatabase', 'SemanticModel', 'Dataset',
      'Dataflow', 'DataflowGen2', 'KQLDatabase', 'Notebook',
      'Environment', 'EventStream', 'DataPipeline', 'SparkJobDefinition',
    ]);

    for (let i = 0; i < workspaceDetails.length; i++) {
      ensureNotCancelled(progress);
      const wsDetail = workspaceDetails[i];
      const storageItems = (wsDetail.items || []).filter(it => storageTypes.has(it.type));
      if (!storageItems.length) continue;

      let wsStorageSize = 0;
      let wsStorageFiles = 0;
      const wsItemSizes = {};

      for (const item of storageItems) {
        try {
          const result = await pbi.getItemStorageSize(wsDetail.id, item.id);
          if (result.success && result.totalSize > 0) {
            wsItemSizes[item.id] = { size: result.totalSize, files: result.fileCount, name: item.name, type: item.type };
            wsStorageSize += result.totalSize;
            wsStorageFiles += result.fileCount;
          }
        } catch { /* skip items that fail */ }
      }

      wsDetail.storageSize = wsStorageSize;
      wsDetail.storageFiles = wsStorageFiles;
      wsDetail.storageItems = wsItemSizes;

      if (wsStorageSize > 0) storageScannedCount++;
      totalStorageSize += wsStorageSize;
      totalStorageFiles += wsStorageFiles;

      progress.progress = 90 + Math.round(((i + 1) / workspaceDetails.length) * 10);
      progress.message = 'Scanning storage: ' + (i + 1) + ' / ' + workspaceDetails.length + ' workspaces...';
    }

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
      totalStorageSize,
      totalStorageFiles,
      storageScannedCount,
      hasFabric,
      itemTypeCounts,
      capacities: capacities.map((capacity) => ({
        id: capacity.id,
        displayName: capacity.displayName,
        sku: capacity.sku,
        state: capacity.state,
        region: capacity.region,
        admins: capacity.admins,
        capacityUserAccessRight: capacity.capacityUserAccessRight,
      })),
      workspacesByState: {},
      workspacesByType: {},
      workspacesByLicense: {},
      workspacesBySku: {},
      workspacesOnCapacity: 0,
      workspacesOnSharedCapacity: 0,
    };

    for (const ws of workspaces) {
      const state = ws.state || 'Active';
      const wsSku = getCapacitySku(ws);
      const licenseType = getLicenseType(wsSku);
      const skuLabel = wsSku || 'Shared (Pro)';
      summary.workspacesByState[state] = (summary.workspacesByState[state] || 0) + 1;
      summary.workspacesByType[licenseType] = (summary.workspacesByType[licenseType] || 0) + 1;
      summary.workspacesByLicense[licenseType] = (summary.workspacesByLicense[licenseType] || 0) + 1;
      summary.workspacesBySku[skuLabel] = (summary.workspacesBySku[skuLabel] || 0) + 1;
      if (ws.capacityId && ws.capacityId !== '00000000-0000-0000-0000-000000000000') {
        summary.workspacesOnCapacity += 1;
      } else {
        summary.workspacesOnSharedCapacity += 1;
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
    const cancelled = !!err.isCancelled;
    progress.status = cancelled ? 'cancelled' : 'failed';
    progress.message = cancelled ? 'Analysis cancelled.' : 'Error: ' + err.message;
    try {
      await db.updateAnalysisRun(runId, {
        status: cancelled ? 'cancelled' : 'failed',
        totalWorkspaces: 0,
        totalReports: 0,
        totalDatasets: 0,
        totalDashboards: 0,
        totalDataflows: 0,
        totalUsers: 0,
        resultsJson: JSON.stringify(cancelled ? { cancelled: true } : { error: err.message }),
      });
    } catch {
      // ignore
    }
  }

  setTimeout(() => activeAnalyses.delete(runId), 5 * 60 * 1000);
}

// Get workspace list for grant-access modal (from latest completed run)
router.get('/workspaces-for-grant', async (req, res) => {
  try {
    const runs = await db.getAnalysisRuns();
    const lastCompleted = runs.find(r => r.status === 'completed');
    if (!lastCompleted) return res.json({ success: false, message: 'No completed analysis run found. Run an analysis first.' });

    const run = await db.getAnalysisRunById(lastCompleted.id);
    if (!run || !run.results_json) return res.json({ success: false, message: 'No results available.' });

    const results = JSON.parse(run.results_json);
    // Try to get enterprise app object ID from a configured SP if available (used for grant access)
    const sps = await db.getServicePrincipals();
    const eaoid = (sps.length > 0) ? (sps[0].enterprise_app_object_id || '') : '';

    const workspaces = (results.workspaces || []).map(ws => ({
      id: ws.id, name: ws.name || ws.displayName || 'Unnamed', state: ws.state || 'Active',
    }));

    res.json({ success: true, workspaces, spObjectId: eaoid });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;

