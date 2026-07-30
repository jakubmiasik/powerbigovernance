const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService } = require('../services/powerbiService');
const { computeWorkspaceInsights, FINDING_DEFS } = require('../services/workspaceInsightsService');

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
async function getPbiService(res) {
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
  return createPowerBIService(sp);
}

// Resolve which run a page should read from. An explicit ?runId= wins over the
// globally selected scan, so drilling into a workspace from one run's results
// always shows that run's data rather than whatever scan is selected globally.
async function resolveRun(req, res) {
  const requestedId = Number.parseInt(req.query.runId, 10);
  if (Number.isInteger(requestedId)) {
    const requested = await db.getAnalysisRunById(requestedId);
    if (requested) return { run: requested, explicit: true };
  }
  const globalRun = res.locals.globalRun;
  if (!globalRun) return { run: null, explicit: false };
  return { run: await db.getAnalysisRunById(globalRun.id), explicit: false };
}

function parseRunWorkspaces(run) {
  if (!run || !run.results_json) return null;
  try {
    const results = JSON.parse(run.results_json);
    return results.workspaces || [];
  } catch { return null; }
}

// Load workspace list from saved analysis
async function loadWorkspacesFromRun(res, req) {
  const { run } = req ? await resolveRun(req, res) : { run: null };
  if (run) return parseRunWorkspaces(run);

  const globalRun = res.locals.globalRun;
  if (!globalRun) return null;
  return parseRunWorkspaces(await db.getAnalysisRunById(globalRun.id));
}

// Workspace triage: rank workspaces by what needs attention rather than listing
// them alphabetically, which Governance Overview already does.
router.get('/', async (req, res) => {
  try {
    const { run } = await resolveRun(req, res);
    const savedWorkspaces = parseRunWorkspaces(run);

    const staleDays = Number.parseInt(req.query.staleDays, 10);
    const overSharedUsers = Number.parseInt(req.query.overSharedUsers, 10);

    if (!savedWorkspaces) {
      return res.render('workspaces/list', {
        title: 'Workspaces', user: req.user, fromSavedData: false, run: null,
        insights: computeWorkspaceInsights(null, {}),
        findingDefs: FINDING_DEFS,
      });
    }

    const insights = computeWorkspaceInsights({ workspaces: savedWorkspaces }, {
      staleDays: Number.isFinite(staleDays) ? staleDays : Number.parseInt(process.env.WORKSPACE_STALE_DAYS, 10),
      overSharedUsers: Number.isFinite(overSharedUsers) ? overSharedUsers : Number.parseInt(process.env.WORKSPACE_OVERSHARED_USERS, 10),
      // Staleness is measured against when the scan ran, not today, so an old run
      // keeps reporting what it reported at the time.
      referenceDate: run ? (run.completed_at || run.started_at) : null,
    });

    res.render('workspaces/list', {
      title: 'Workspaces', user: req.user, fromSavedData: true, run,
      insights,
      findingDefs: FINDING_DEFS,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const workspaceId = req.params.id;

    // Use saved analysis data — from the run named in ?runId= when there is one
    const { run: sourceRun, explicit } = await resolveRun(req, res);
    const savedWorkspaces = parseRunWorkspaces(sourceRun);
    if (savedWorkspaces) {
      const savedWs = savedWorkspaces.find(w => w.id === workspaceId);
      if (savedWs) {
        const categorized = categorizeItems(savedWs.items || []);
        return res.render('workspaces/detail', {
          title: savedWs.name || 'Workspace', user: req.user,
          workspace: savedWs, items: savedWs.items || [], ...categorized,
          users: savedWs.users || [],
          sourceRun,
          lockRunSelector: explicit,
          lockedRun: explicit ? sourceRun : null,
        });
      }
    }

    // Fallback to live API
    const pbi = await getPbiService(res);
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
    const pbi = await getPbiService(res);
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
    const pbi = await getPbiService(res);
    const { workspaceId, dashboardId } = req.params;
    const tiles = await pbi.getDashboardTiles(workspaceId, dashboardId);
    res.render('workspaces/dashboard-detail', { title: 'Dashboard Tiles', user: req.user, workspaceId, dashboardId, tiles });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// ── Lineage: get item connections for graph visualization ──
// Uses PBI Scanner API with lineage=true to get full workspace lineage, then filters for the item
// Index every item in the selected run so lineage endpoints outside the scanned
// workspace can still be shown by name rather than as a bare GUID.
async function buildRunItemIndex(req, res) {
  const index = new Map();
  try {
    const { run } = await resolveRun(req, res);
    for (const workspace of parseRunWorkspaces(run) || []) {
      for (const item of workspace.items || []) {
        if (item.id) {
          index.set(item.id, { name: item.name || null, type: item.type || null, workspaceName: workspace.name || null, workspaceId: workspace.id || null });
        }
      }
    }
  } catch {
    // A missing run just means fewer names resolved.
  }
  return index;
}

router.get('/:workspaceId/lineage/:itemId', async (req, res) => {
  try {
    const pbi = await getPbiService(res);
    const { workspaceId, itemId } = req.params;
    const allLinks = await pbi.getWorkspaceLineage(workspaceId);
    // Filter connections related to this item (as source or target)
    const related = allLinks.filter(l => l.sourceItemId === itemId || l.targetItemId === itemId);

    const runIndex = await buildRunItemIndex(req, res);
    const enrich = (endpoint, fallbackId) => {
      const base = endpoint || { id: fallbackId, name: null, type: null, workspaceId: null, workspaceName: null };
      const known = runIndex.get(base.id);
      return {
        id: base.id,
        name: base.name || (known && known.name) || base.id,
        type: base.type || (known && known.type) || '',
        workspaceId: base.workspaceId || (known && known.workspaceId) || null,
        workspaceName: base.workspaceName || (known && known.workspaceName) || null,
        resolved: !!(base.name || (known && known.name)),
      };
    };

    const connections = related.map(link => {
      const source = enrich(link.source, link.sourceItemId);
      const target = enrich(link.target, link.targetItemId);
      return {
        ...link,
        source,
        target,
        sourceItemDisplayName: source.name,
        targetItemDisplayName: target.name,
        sourceItemType: source.type,
        targetItemType: target.type,
      };
    });

    res.json({ success: true, connections });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Item details ──
// One endpoint for every artifact type. Results are cached in the database so
// opening an artifact repeatedly does not re-read the APIs; ?refresh=1 forces a
// fresh read.
router.get('/:workspaceId/items/:itemId/details', async (req, res) => {
  const { workspaceId, itemId } = req.params;
  const requestedType = (req.query.type || '').toString();
  const forceRefresh = req.query.refresh === '1';

  try {
    if (!forceRefresh) {
      const cached = await db.getItemDetailsCache(workspaceId, itemId);
      if (cached && cached.payload) {
        try {
          const payload = JSON.parse(cached.payload);
          return res.json({ ...payload, success: true, fromCache: true, cachedAt: cached.fetched_at });
        } catch {
          // Unreadable cache row: fall through and rebuild it.
        }
      }
    }

    const pbi = await getPbiService(res);
    const sections = [];
    const warnings = [];
    const type = requestedType.toLowerCase();

    const runIndex = await buildRunItemIndex(req, res);
    const known = runIndex.get(itemId) || {};
    // Resolving ids to names is the whole point of showing details, so every
    // id-shaped field below is looked up in the run index before being rendered.
    const nameFor = id => {
      const entry = runIndex.get(id);
      return entry && entry.name ? entry.name : null;
    };
    const labelFor = (id) => {
      if (!id) return '-';
      const name = nameFor(id);
      return name ? name : id;
    };

    const item = {
      id: itemId,
      name: (req.query.name || known.name || 'Item').toString(),
      type: requestedType || known.type || '',
      workspaceId,
      workspaceName: known.workspaceName || null,
      description: null,
    };

    async function section(title, icon, key, loader) {
      try {
        const result = await loader();
        if (result) sections.push({ key, title, icon, ...result });
      } catch (err) {
        warnings.push(title + ': ' + err.message);
      }
    }

    await section('Item metadata', 'info-circle', 'metadata', async () => {
      const detail = await pbi.getItemDetail(workspaceId, itemId);
      if (!detail) return null;
      if (detail.displayName) item.name = detail.displayName;
      if (detail.description) item.description = detail.description;
      if (detail.type) item.type = detail.type;
      return {
        kind: 'keyvalue',
        rows: [
          { label: 'Name', value: detail.displayName || item.name || '-' },
          { label: 'Type', value: detail.type || item.type || '-' },
          { label: 'Workspace', value: item.workspaceName || workspaceId },
          { label: 'Description', value: detail.description || '-' },
          { label: 'Item ID', value: detail.id || itemId, mono: true },
          { label: 'Workspace ID', value: detail.workspaceId || workspaceId, mono: true },
        ],
      };
    });

    if (type === 'lakehouse') {
      await section('Tables', 'table', 'tables', async () => {
        const tables = await pbi.getLakehouseTables(workspaceId, itemId);
        return {
          kind: 'table',
          columns: ['Name', 'Type', 'Format', 'Location'],
          rows: tables.map(t => [t.name || '-', t.type || '-', t.format || '-', t.location || '-']),
          emptyText: 'No tables found in this lakehouse.',
        };
      });
    }

    // Lakehouses and warehouses expose a SQL analytics endpoint; its schema is the
    // closest thing to "tables and attributes" this app can report.
    if (type === 'lakehouse' || type === 'warehouse') {
      await section('SQL endpoint', 'hdd-network', 'sqlendpoint', async () => {
        const endpoint = await pbi.getSqlEndpointInfo(workspaceId, itemId, requestedType);
        if (!endpoint) return { kind: 'note', note: 'No SQL analytics endpoint is exposed for this item.' };

        let schema = [];
        let schemaError = null;
        try {
          schema = await pbi.getSqlEndpointSchema(endpoint);
        } catch (err) {
          schemaError = err.message;
        }

        const rows = [];
        for (const table of schema) {
          for (const column of table.columns) {
            rows.push([table.schema + '.' + table.name, table.type === 'VIEW' ? 'View' : 'Table', column.name, column.dataType, column.nullable ? 'Yes' : 'No']);
          }
          if (!table.columns.length) rows.push([table.schema + '.' + table.name, table.type === 'VIEW' ? 'View' : 'Table', '-', '-', '-']);
        }

        if (schemaError) {
          warnings.push('SQL endpoint schema: ' + schemaError);
        }

        return {
          kind: 'table',
          summary: endpoint.connectionString + (schema.length ? ' · ' + schema.length + ' table(s)' : ''),
          columns: ['Table', 'Kind', 'Column', 'Data type', 'Nullable'],
          rows,
          emptyText: schemaError
            ? 'The endpoint is available but its schema could not be read.'
            : 'The SQL endpoint reports no tables.',
        };
      });
    }

    if (type === 'semanticmodel' || type === 'dataset') {
      await section('Data sources', 'plug', 'datasources', async () => {
        const sources = await pbi.getDatasetDatasources(workspaceId, itemId);
        return {
          kind: 'table',
          columns: ['Type', 'Connection', 'Database / Path'],
          rows: (sources || []).map(s => [
            s.datasourceType || '-',
            s.connectionDetails ? (s.connectionDetails.server || s.connectionDetails.url || s.connectionDetails.path || '-') : '-',
            s.connectionDetails ? (s.connectionDetails.database || s.connectionDetails.domain || '-') : '-',
          ]),
          emptyText: 'No data sources reported.',
        };
      });
      await section('Parameters', 'sliders', 'parameters', async () => {
        const parameters = await pbi.getDatasetParameters(workspaceId, itemId);
        return {
          kind: 'table',
          columns: ['Name', 'Type', 'Current value', 'Required'],
          rows: (parameters || []).map(p => [p.name || '-', p.type || '-', p.currentValue || '-', p.isRequired ? 'Yes' : 'No']),
          emptyText: 'No parameters defined.',
        };
      });
      await section('Recent refreshes', 'arrow-repeat', 'refreshes', async () => {
        const refreshes = await pbi.getDatasetRefreshHistory(workspaceId, itemId, 10);
        return {
          kind: 'table',
          columns: ['Status', 'Type', 'Start', 'End'],
          rows: (refreshes || []).map(r => [
            r.status || '-',
            r.refreshType || '-',
            r.startTime ? new Date(r.startTime).toLocaleString() : '-',
            r.endTime ? new Date(r.endTime).toLocaleString() : '-',
          ]),
          emptyText: 'No refresh history available.',
        };
      });
    }

    if (type === 'dashboard') {
      await section('Tiles', 'grid-1x2', 'tiles', async () => {
        const tiles = await pbi.getDashboardTiles(workspaceId, itemId);
        return {
          kind: 'table',
          columns: ['Title', 'Report', 'Semantic model'],
          // Tiles reference their report and model by id; show the names instead.
          rows: (tiles || []).map(t => [t.title || t.subTitle || '-', labelFor(t.reportId), labelFor(t.datasetId)]),
          emptyText: 'No tiles on this dashboard.',
        };
      });
    }

    await section('OneLake content', 'hdd', 'onelake', async () => {
      const breakdown = await pbi.getOneLakeBreakdown(workspaceId, itemId, 20);
      if (!breakdown.totalFiles && !breakdown.folders.length) {
        return { kind: 'note', note: 'No OneLake content is stored for this item.' };
      }
      return {
        kind: 'table',
        summary: breakdown.totalFiles + ' file(s)',
        columns: ['Folder', 'Area', 'Files', 'Size (bytes)'],
        rows: breakdown.folders.map(f => [f.folder, f.area, f.files, f.size]),
        emptyText: 'No OneLake folders found.',
      };
    });

    const payload = { item, sections, warnings };
    await db.saveItemDetailsCache({
      workspaceId,
      itemId,
      itemType: item.type,
      itemName: item.name,
      payload: JSON.stringify(payload),
    });

    res.json({ ...payload, success: true, fromCache: false, cachedAt: new Date().toISOString() });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── OneLake Storage Size ──

// Get storage breakdown for a workspace
router.get('/:workspaceId/storage', async (req, res) => {
  try {
    const pbi = await getPbiService(res);
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
    const pbi = await getPbiService(res);
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
    const pbi = await getPbiService(res);
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
    const pbi = await getPbiService(res);
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
    const pbi = await getPbiService(res);
    const result = await pbi.updateRoleAssignment(req.params.workspaceId, req.params.roleAssignmentId, role);
    res.json({ success: true, result });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// DELETE role assignment
router.delete('/:workspaceId/roles/:roleAssignmentId', async (req, res) => {
  try {
    const pbi = await getPbiService(res);
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
    const pbi = await getPbiService(res);

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



