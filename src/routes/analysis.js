const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService } = require('../services/powerbiService');

// In-memory store for active analysis progress
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

// Start analysis
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

    // Start analysis in background
    runAnalysis(runId, sp);

    res.json({ success: true, runId });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Get analysis progress
router.get('/progress/:runId', (req, res) => {
  const runId = parseInt(req.params.runId);
  const progress = activeAnalyses.get(runId) || { status: 'unknown', progress: 0, message: '' };
  res.json(progress);
});

// Get analysis results
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

// Delete a run
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

    // Step 1: Get all workspaces
    progress.message = 'Fetching workspaces...';
    const workspaces = await pbi.getWorkspaces({ useAdmin: true }).catch(() => pbi.getWorkspaces());
    progress.total = workspaces.length;
    progress.message = `Found ${workspaces.length} workspaces. Scanning...`;

    // Step 2: Get capacities
    const capacities = await pbi.getCapacities().catch(() => []);

    // Check for Fabric capacities
    const fabricSkus = new Set(['F2', 'F4', 'F8', 'F16', 'F32', 'F64', 'F128', 'F256', 'F512', 'F1024', 'F2048', 'FT1']);
    const hasFabric = capacities.some(c => fabricSkus.has(c.sku));

    // Step 3: Scan each workspace
    const workspaceDetails = [];
    const allUsers = new Set();
    let totalReports = 0, totalDatasets = 0, totalDashboards = 0, totalDataflows = 0;

    // Process in batches of 5
    const batchSize = 5;
    for (let i = 0; i < workspaces.length; i += batchSize) {
      const batch = workspaces.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(async (ws) => {
          const [reports, datasets, dashboards, dataflows, users] = await Promise.all([
            pbi.getReports(ws.id).catch(() => []),
            pbi.getDatasets(ws.id).catch(() => []),
            pbi.getDashboards(ws.id).catch(() => []),
            pbi.getDataflows(ws.id).catch(() => []),
            pbi.getWorkspaceUsers(ws.id).catch(() => []),
          ]);
          return { ws, reports, datasets, dashboards, dataflows, users };
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          const { ws, reports, datasets, dashboards, dataflows, users } = result.value;
          totalReports += reports.length;
          totalDatasets += datasets.length;
          totalDashboards += dashboards.length;
          totalDataflows += dataflows.length;
          users.forEach(u => allUsers.add(u.emailAddress || u.displayName || u.identifier));

          workspaceDetails.push({
            id: ws.id,
            name: ws.name,
            state: ws.state,
            type: ws.type,
            capacityId: ws.capacityId,
            isOnDedicatedCapacity: ws.isOnDedicatedCapacity,
            reportCount: reports.length,
            datasetCount: datasets.length,
            dashboardCount: dashboards.length,
            dataflowCount: dataflows.length,
            userCount: users.length,
            users: users.map(u => ({
              name: u.displayName,
              email: u.emailAddress,
              role: u.groupUserAccessRight,
              type: u.principalType,
            })),
            reports: reports.map(r => ({ id: r.id, name: r.name, webUrl: r.webUrl })),
            datasets: datasets.map(d => ({ id: d.id, name: d.name, isRefreshable: d.isRefreshable, configuredBy: d.configuredBy })),
            dashboards: dashboards.map(d => ({ id: d.id, displayName: d.displayName })),
            dataflows: dataflows.map(d => ({ objectId: d.objectId, name: d.name })),
          });
        } else {
          const ws = batch[batchResults.indexOf(result)];
          workspaceDetails.push({
            id: ws?.id, name: ws?.name, state: ws?.state, type: ws?.type,
            reportCount: 0, datasetCount: 0, dashboardCount: 0, dataflowCount: 0, userCount: 0,
            users: [], reports: [], datasets: [], dashboards: [], dataflows: [],
            error: result.reason?.message,
          });
        }
      }

      progress.current = Math.min(i + batchSize, workspaces.length);
      progress.progress = Math.round((progress.current / workspaces.length) * 100);
      progress.message = `Scanned ${progress.current} of ${workspaces.length} workspaces...`;
    }

    // Step 4: If Fabric, try scanner API for extra metadata
    let scanResults = null;
    if (hasFabric && workspaces.length > 0) {
      progress.message = 'Running Fabric workspace scanner...';
      try {
        const wsIds = workspaces.slice(0, 100).map(w => w.id);
        const scanResponse = await pbi.scanWorkspaces(wsIds);
        if (scanResponse.id) {
          // Poll for scan completion
          for (let attempt = 0; attempt < 30; attempt++) {
            await new Promise(r => setTimeout(r, 2000));
            const status = await pbi.getScanStatus(scanResponse.id);
            if (status.status === 'Succeeded') {
              scanResults = await pbi.getScanResult(scanResponse.id);
              break;
            }
            if (status.status === 'Failed') break;
          }
        }
      } catch {
        // Scanner API not available, continue without it
      }
    }

    // Build summary
    const summary = {
      totalWorkspaces: workspaces.length,
      totalReports,
      totalDatasets,
      totalDashboards,
      totalDataflows,
      totalUsers: allUsers.size,
      hasFabric,
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

    const resultsJson = JSON.stringify({ summary, workspaces: workspaceDetails, scanResults });

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

  // Clean up progress after 5 minutes
  setTimeout(() => activeAnalyses.delete(runId), 5 * 60 * 1000);
}

module.exports = router;
