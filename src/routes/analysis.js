const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService, runWithApiReporter } = require('../services/powerbiService');
const {
  METRIC_DEFS, computeRunTotals, diffTotals, diffRunDetails,
} = require('../services/runMetricsService');

const activeAnalyses = new Map();

const MAX_PROGRESS_EVENTS = 25;
// How long without a progress update before the UI calls the run stalled.
const STALL_SECONDS = Number.parseInt(process.env.ANALYSIS_STALL_SECONDS || '90', 10);

// Every progress write goes through here so `updatedAt` is always accurate — it is
// what tells the UI the difference between "slow" and "hung".
function setProgress(progress, patch) {
  Object.assign(progress, patch);
  progress.updatedAt = Date.now();
}

function addProgressEvent(progress, level, message) {
  progress.events.push({ at: Date.now(), level, message });
  if (progress.events.length > MAX_PROGRESS_EVENTS) progress.events.shift();
  progress.updatedAt = Date.now();
}

// Turns raw API telemetry into counters plus a readable event log, so a run that
// is being throttled says so instead of just sitting at the same percentage.
function handleApiEvent(progress, event) {
  const counters = progress.counters;
  if (event.type === 'request') {
    counters.apiCalls += 1;
    // Requests are far too frequent to log individually; the counter moving is the
    // signal that the run is alive.
    progress.updatedAt = Date.now();
    return;
  }
  if (event.type === 'throttled') {
    counters.throttled += 1;
    counters.waitedMs += event.delayMs || 0;
    progress.throttledUntil = Date.now() + (event.delayMs || 0);
    const capped = event.cappedFrom
      ? ' (tenant asked for ' + Math.round(event.cappedFrom / 1000) + 's, capped)'
      : '';
    addProgressEvent(progress, 'warning',
      'Throttled by the API on ' + event.path + ' — waiting ' + Math.round((event.delayMs || 0) / 1000) + 's' + capped);
    return;
  }
  if (event.type === 'retry') {
    counters.retries += 1;
    counters.waitedMs += event.delayMs || 0;
    addProgressEvent(progress, 'warning',
      'HTTP ' + (event.status || '?') + ' on ' + event.path + ' — retry ' + event.attempt + ' in ' + Math.round((event.delayMs || 0) / 1000) + 's');
    return;
  }
  if (event.type === 'failure') {
    counters.failures += 1;
    addProgressEvent(progress, 'error',
      'Request failed on ' + event.path + (event.status ? ' (HTTP ' + event.status + ')' : '') + ': ' + (event.message || 'unknown error'));
  }
}

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
    const requestedSpId = Number.parseInt(req.body ? req.body.spId : null, 10);
    const sp = (Number.isFinite(requestedSpId) && sps.find(s => parseInt(s.id, 10) === requestedSpId)) || sps[0];

    const runId = await db.createAnalysisRun({
      spId: sp.id,
      spName: sp.name,
      tenantId: sp.tenant_id,
      runBy: req.user ? req.user.name : 'anonymous',
    });
    if (!runId) {
      return res.json({ success: false, message: 'Could not create the analysis run record in the database.' });
    }

    runAnalysis(runId, sp);
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
  const progress = activeAnalyses.get(runId);
  if (!progress) {
    return res.json({ status: 'unknown', progress: 0, message: '', events: [], counters: null });
  }

  const now = Date.now();
  const secondsSinceUpdate = Math.floor((now - (progress.updatedAt || now)) / 1000);
  const throttleRemaining = progress.throttledUntil && progress.throttledUntil > now
    ? Math.ceil((progress.throttledUntil - now) / 1000)
    : 0;

  res.json({
    ...progress,
    elapsedSeconds: Math.floor((now - (progress.startedAt || now)) / 1000),
    secondsSinceUpdate,
    throttleRemainingSeconds: throttleRemaining,
    // "Stalled" means nothing has moved, not even an API call — a run that is merely
    // waiting out a documented throttle is reported as throttled, not stalled.
    stalled: progress.status === 'running' && !throttleRemaining && secondsSinceUpdate >= STALL_SECONDS,
    stallThresholdSeconds: STALL_SECONDS,
  });
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
      // This page is bound to one run, so the global scan selector is locked to it.
      lockRunSelector: true,
      lockedRun: run,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

function parseRunResults(run) {
  if (!run || !run.results_json) return null;
  try { return JSON.parse(run.results_json); } catch { return null; }
}

// Totals for a run, computing and storing them on first use. Runs created before
// the totals table existed are backfilled here rather than in a startup migration,
// which would have meant parsing every historic run's results_json at boot.
async function loadRunTotals(runId) {
  const stored = await db.getRunTotals(runId);
  if (stored) {
    const totals = {};
    for (const def of METRIC_DEFS) totals[def.key] = Number(stored[def.column]) || 0;
    return { totals, run: null, backfilled: false };
  }

  const run = await db.getAnalysisRunById(runId);
  const results = parseRunResults(run);
  if (!results) return { totals: null, run, backfilled: false };

  const totals = computeRunTotals(results);
  try {
    await db.saveRunTotals(
      runId,
      { tenantId: run.tenant_id, spId: run.sp_id, spName: run.sp_name, startedAt: run.started_at },
      totals
    );
  } catch (err) {
    console.warn('[Analysis] Could not backfill run totals for run', runId, err.message);
  }
  return { totals, run, backfilled: true };
}

// ── Run comparison (same tenant only) ──
router.get('/compare', async (req, res) => {
  try {
    const allRuns = await db.getAnalysisRuns();
    const completed = allRuns.filter(r => r.status === 'completed');

    const fromId = Number.parseInt(req.query.from, 10);
    const toId = Number.parseInt(req.query.to, 10);
    const base = {
      title: 'Compare Runs',
      user: req.user,
      runs: completed,
      fromRun: null,
      toRun: null,
      metrics: [],
      error: null,
      tenantSettingsComparable: true,
    };

    if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
      return res.render('analysis/compare', base);
    }
    if (fromId === toId) {
      return res.render('analysis/compare', { ...base, error: 'Pick two different runs to compare.' });
    }

    const [fromRun, toRun] = await Promise.all([
      db.getAnalysisRunById(fromId),
      db.getAnalysisRunById(toId),
    ]);
    if (!fromRun || !toRun) {
      return res.render('analysis/compare', { ...base, error: 'One of the selected runs no longer exists.' });
    }

    // Comparing across tenants would produce numbers that look like change but are
    // really two different estates, so it is refused rather than rendered.
    if ((fromRun.tenant_id || '') !== (toRun.tenant_id || '')) {
      return res.render('analysis/compare', {
        ...base,
        fromRun,
        toRun,
        error: 'These runs are from different tenants. Comparison is only available within a single tenant.',
      });
    }

    const [fromTotals, toTotals] = await Promise.all([loadRunTotals(fromId), loadRunTotals(toId)]);
    if (!fromTotals.totals || !toTotals.totals) {
      return res.render('analysis/compare', {
        ...base,
        fromRun,
        toRun,
        error: 'One of the selected runs has no stored results to compare.',
      });
    }

    // A run that predates tenant-settings capture stores zeroes, which would read
    // as "every setting removed". Drop those rows and say why instead.
    const tenantSettingsComparable = !!fromTotals.totals.tenantSettingsCaptured && !!toTotals.totals.tenantSettingsCaptured;
    res.render('analysis/compare', {
      ...base,
      fromRun,
      toRun,
      metrics: diffTotals(fromTotals.totals, toTotals.totals, {
        skipGroups: tenantSettingsComparable ? [] : ['tenantSettings'],
      }),
      tenantSettingsComparable,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// Detailed diff, loaded on demand — this is the expensive path that parses both runs.
router.get('/compare/details', async (req, res) => {
  try {
    const fromId = Number.parseInt(req.query.from, 10);
    const toId = Number.parseInt(req.query.to, 10);
    if (!Number.isInteger(fromId) || !Number.isInteger(toId) || fromId === toId) {
      return res.json({ success: false, message: 'Pick two different runs to compare.' });
    }

    const [fromRun, toRun] = await Promise.all([
      db.getAnalysisRunById(fromId),
      db.getAnalysisRunById(toId),
    ]);
    if (!fromRun || !toRun) return res.json({ success: false, message: 'One of the selected runs no longer exists.' });
    if ((fromRun.tenant_id || '') !== (toRun.tenant_id || '')) {
      return res.json({ success: false, message: 'Comparison is only available within a single tenant.' });
    }

    const fromResults = parseRunResults(fromRun);
    const toResults = parseRunResults(toRun);
    if (!fromResults || !toResults) return res.json({ success: false, message: 'One of the selected runs has no stored results.' });

    res.json({ success: true, details: diffRunDetails(fromResults, toResults) });
  } catch (err) {
    res.json({ success: false, message: err.message });
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
  const progress = {
    status: 'running',
    progress: 0,
    phase: 'Starting',
    message: 'Starting analysis...',
    detail: '',
    current: 0,
    total: 0,
    cancelRequested: false,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    throttledUntil: null,
    counters: { apiCalls: 0, retries: 0, throttled: 0, failures: 0, waitedMs: 0, skippedItems: 0 },
    events: [],
  };
  activeAnalyses.set(runId, progress);
  addProgressEvent(progress, 'info', 'Analysis started for ' + (sp.name || 'service principal'));

  // Everything below runs inside the reporter, so retries and throttling anywhere in
  // the Power BI client surface as run progress instead of silent delay.
  await runWithApiReporter(event => handleApiEvent(progress, event), async () => {
  try {
    const pbi = createPowerBIService(sp);

    setProgress(progress, { phase: 'Workspaces', message: 'Fetching workspaces...' });
    const workspaces = await pbi.getWorkspaces();
    ensureNotCancelled(progress);
    setProgress(progress, {
      total: workspaces.length,
      progress: 10,
      message: 'Found ' + workspaces.length + ' workspaces. Fetching all items...',
    });
    addProgressEvent(progress, 'info', 'Found ' + workspaces.length + ' workspaces');

    setProgress(progress, { phase: 'Items', message: 'Fetching all items via Fabric Admin API...' });
    const allItems = await pbi.getAllItems();
    ensureNotCancelled(progress);
    setProgress(progress, { progress: 40, message: 'Found ' + allItems.length + ' items. Processing...' });
    addProgressEvent(progress, 'info', 'Found ' + allItems.length + ' items');

    setProgress(progress, { phase: 'Capacities', message: 'Fetching capacities...' });
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

    setProgress(progress, { phase: 'Workspace details', message: 'Building workspace details...', progress: 60 });
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

    setProgress(progress, { phase: 'Workspace access', progress: 80, message: 'Fetching workspace users...' });
    const batchSize = 10;
    let usersFetched = 0;
    let userFetchFailures = 0;
    for (let i = 0; i < workspaces.length; i += batchSize) {
      ensureNotCancelled(progress);
      const batch = workspaces.slice(i, i + batchSize);
      setProgress(progress, { detail: 'Reading access for ' + batch.map(ws => ws.displayName || ws.name || ws.id).slice(0, 3).join(', ') + (batch.length > 3 ? ' and ' + (batch.length - 3) + ' more' : '') });
      const userResults = await Promise.allSettled(batch.map((ws) => pbi.getWorkspaceUsers(ws.id)));
      ensureNotCancelled(progress);
      userFetchFailures += userResults.filter(r => r.status === 'rejected').length;
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
      setProgress(progress, {
        current: usersFetched,
        progress: 80 + Math.round((usersFetched / Math.max(workspaces.length, 1)) * 10),
        message: 'Fetching users: ' + usersFetched + ' / ' + workspaces.length + ' workspaces...',
      });
    }
    if (userFetchFailures) {
      addProgressEvent(progress, 'warning', userFetchFailures + ' workspace(s) would not return their access list — usually missing permission');
    }

    // ── OneLake Storage Scan ──
    // The longest phase by far: one call per storage item. It reports the workspace
    // and item being read so a slow tenant looks slow rather than frozen.
    setProgress(progress, { phase: 'OneLake storage', progress: 90, message: 'Scanning OneLake storage sizes...' });
    let totalStorageSize = 0;
    let totalStorageFiles = 0;
    let storageScannedCount = 0;
    let storageItemsScanned = 0;
    let storageItemsSkipped = 0;

    const storageTypes = new Set([
      'Lakehouse', 'Warehouse', 'SQLDatabase', 'SemanticModel', 'Dataset',
      'Dataflow', 'DataflowGen2', 'KQLDatabase', 'Notebook',
      'Environment', 'EventStream', 'DataPipeline', 'SparkJobDefinition',
    ]);

    const totalStorageItems = workspaceDetails.reduce(
      (sum, wsDetail) => sum + (wsDetail.items || []).filter(it => storageTypes.has(it.type)).length,
      0
    );
    addProgressEvent(progress, 'info', 'Scanning storage for ' + totalStorageItems + ' item(s) across ' + workspaceDetails.length + ' workspaces');

    for (let i = 0; i < workspaceDetails.length; i++) {
      ensureNotCancelled(progress);
      const wsDetail = workspaceDetails[i];
      const storageItems = (wsDetail.items || []).filter(it => storageTypes.has(it.type));
      if (!storageItems.length) continue;

      let wsStorageSize = 0;
      let wsStorageFiles = 0;
      const wsItemSizes = {};

      for (const item of storageItems) {
        ensureNotCancelled(progress);
        setProgress(progress, {
          detail: wsDetail.name + ' → ' + (item.name || item.type || 'item') + ' (' + (storageItemsScanned + 1) + ' of ~' + totalStorageItems + ')',
        });
        try {
          const result = await pbi.getItemStorageSize(wsDetail.id, item.id);
          if (result.success && result.totalSize > 0) {
            wsItemSizes[item.id] = { size: result.totalSize, files: result.fileCount, name: item.name, type: item.type };
            wsStorageSize += result.totalSize;
            wsStorageFiles += result.fileCount;
          }
        } catch {
          // Items without OneLake storage or without permission are expected; they
          // are counted so a scan that skips everything is visibly different from
          // one that finds nothing.
          storageItemsSkipped += 1;
          progress.counters.skippedItems += 1;
        }
        storageItemsScanned += 1;
      }

      wsDetail.storageSize = wsStorageSize;
      wsDetail.storageFiles = wsStorageFiles;
      wsDetail.storageItems = wsItemSizes;

      if (wsStorageSize > 0) storageScannedCount++;
      totalStorageSize += wsStorageSize;
      totalStorageFiles += wsStorageFiles;

      setProgress(progress, {
        progress: 90 + Math.round(((i + 1) / workspaceDetails.length) * 10),
        message: 'Scanning storage: ' + (i + 1) + ' / ' + workspaceDetails.length + ' workspaces...',
      });
    }
    if (storageItemsSkipped) {
      addProgressEvent(progress, 'info', storageItemsSkipped + ' item(s) had no readable OneLake storage and were skipped');
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

    // Snapshot tenant settings with the run so they can be compared over time.
    // A service principal without Tenant.Read.All still produces a valid run; the
    // snapshot is simply absent, and comparisons say so rather than reporting the
    // settings as deleted.
    setProgress(progress, { phase: 'Tenant settings', message: 'Capturing tenant settings...', detail: '' });
    let tenantSettings = null;
    try {
      tenantSettings = await pbi.getTenantSettings();
      addProgressEvent(progress, 'info', 'Captured ' + tenantSettings.length + ' tenant setting(s)');
    } catch (tenantErr) {
      console.warn('[Analysis] Tenant settings not captured for run', runId, tenantErr.message);
      addProgressEvent(progress, 'warning', 'Tenant settings not captured: ' + tenantErr.message);
    }

    const analysisResults = { summary, workspaces: workspaceDetails };
    if (tenantSettings) analysisResults.tenantSettings = tenantSettings;
    const resultsJson = JSON.stringify(analysisResults);

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

    // Materialize the Governance Overview totals for this run so comparisons do not
    // have to parse results_json. Failing here must not fail an otherwise good run.
    try {
      await db.saveRunTotals(
        runId,
        { tenantId: sp.tenant_id, spId: sp.id, spName: sp.name, startedAt: new Date() },
        computeRunTotals(analysisResults)
      );
    } catch (totalsErr) {
      console.warn('[Analysis] Could not store run totals for run', runId, totalsErr.message);
    }

    setProgress(progress, {
      status: 'completed',
      progress: 100,
      phase: 'Complete',
      detail: '',
      message: 'Analysis complete!',
    });
    addProgressEvent(progress, 'info',
      'Finished in ' + Math.round((Date.now() - progress.startedAt) / 1000) + 's after ' + progress.counters.apiCalls + ' API call(s)');
  } catch (err) {
    const cancelled = !!err.isCancelled;
    setProgress(progress, {
      status: cancelled ? 'cancelled' : 'failed',
      phase: cancelled ? 'Cancelled' : 'Failed',
      message: cancelled ? 'Analysis cancelled.' : 'Error: ' + err.message,
    });
    addProgressEvent(progress, cancelled ? 'info' : 'error',
      cancelled ? 'Cancelled by user' : 'Run failed: ' + err.message);
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
  });

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


