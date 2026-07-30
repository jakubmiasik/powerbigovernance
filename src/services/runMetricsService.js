// Pure helpers for run totals and run-to-run comparison.
//
// Totals are the same numbers the Governance Overview shows. They are stored per
// run in analysis_run_totals so comparing two runs is a two-row read instead of
// parsing two full results_json blobs; the detailed diff parses those blobs only
// when the user explicitly asks for it.

// Order matters: this drives both the stored columns and the comparison table.
const METRIC_DEFS = [
  { key: 'totalWorkspaces', column: 'total_workspaces', label: 'Workspaces', better: 'neutral' },
  { key: 'totalItems', column: 'total_items', label: 'Total Items', better: 'neutral' },
  { key: 'totalReports', column: 'total_reports', label: 'Reports', better: 'neutral' },
  { key: 'totalDatasets', column: 'total_datasets', label: 'Semantic Models', better: 'neutral' },
  { key: 'totalDashboards', column: 'total_dashboards', label: 'Dashboards', better: 'neutral' },
  { key: 'totalDataflows', column: 'total_dataflows', label: 'Dataflows', better: 'neutral' },
  { key: 'totalLakehouses', column: 'total_lakehouses', label: 'Lakehouses', better: 'neutral' },
  { key: 'totalNotebooks', column: 'total_notebooks', label: 'Notebooks', better: 'neutral' },
  { key: 'totalPipelines', column: 'total_pipelines', label: 'Pipelines', better: 'neutral' },
  { key: 'totalWarehouses', column: 'total_warehouses', label: 'Warehouses', better: 'neutral' },
  { key: 'totalUsers', column: 'total_users', label: 'Unique Users', better: 'neutral' },
  { key: 'creatorCount', column: 'creator_count', label: 'Creators', better: 'neutral' },
  { key: 'explorerCount', column: 'explorer_count', label: 'Explorers', better: 'neutral' },
  { key: 'capacityCount', column: 'capacity_count', label: 'Capacities', better: 'neutral' },
  { key: 'workspacesOnCapacity', column: 'workspaces_on_capacity', label: 'On Dedicated Capacity', better: 'neutral' },
  { key: 'workspacesOnSharedCapacity', column: 'workspaces_on_shared_capacity', label: 'On Shared Capacity', better: 'neutral' },
  { key: 'totalStorageSize', column: 'total_storage_size', label: 'OneLake Storage', format: 'bytes', better: 'neutral' },
  { key: 'totalStorageFiles', column: 'total_storage_files', label: 'Storage Files', better: 'neutral' },
  { key: 'storageScannedCount', column: 'storage_scanned_count', label: 'Workspaces With Data', better: 'neutral' },
];

function buildUser360(workspaces) {
  const userMap = new Map();

  function ensureUser(key, name, upn) {
    if (!userMap.has(key)) {
      userMap.set(key, { name: name || upn || 'Unknown', upn: upn || '', items: [], workspaces: [], workspaceKeys: new Set() });
    }
    return userMap.get(key);
  }

  for (const workspace of workspaces) {
    const workspaceName = workspace.name || 'Unnamed Workspace';
    for (const workspaceUser of workspace.users || []) {
      const userKey = (workspaceUser.email || workspaceUser.name || workspaceName).toLowerCase();
      const user = ensureUser(userKey, workspaceUser.name, workspaceUser.email);
      const workspaceKey = workspaceName + '::' + (workspaceUser.role || '');
      if (!user.workspaceKeys.has(workspaceKey)) {
        user.workspaceKeys.add(workspaceKey);
        user.workspaces.push({ name: workspaceName, role: workspaceUser.role || 'Unknown' });
      }
    }

    for (const item of workspace.items || []) {
      const creatorName = item.creator?.name || item.creator?.upn;
      const creatorUpn = item.creator?.upn || '';
      if (!creatorName && !creatorUpn) continue;
      const userKey = (creatorUpn || creatorName).toLowerCase();
      const user = ensureUser(userKey, creatorName, creatorUpn);
      user.items.push({ name: item.name || 'Unnamed', type: item.type || '-', workspace: workspaceName });
    }
  }

  return Array.from(userMap.values())
    .map(user => { delete user.workspaceKeys; return user; })
    .sort((a, b) => (a.name || a.upn || '').localeCompare(b.name || b.upn || ''));
}

function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Flat metric snapshot for one run's parsed results_json.
function computeRunTotals(results) {
  const summary = (results && results.summary) || {};
  const workspaces = (results && results.workspaces) || [];
  const users = buildUser360(workspaces);
  const creatorCount = users.filter(user => (user.items || []).length > 0).length;

  return {
    totalWorkspaces: toCount(summary.totalWorkspaces),
    totalItems: toCount(summary.totalItems),
    totalReports: toCount(summary.totalReports),
    totalDatasets: toCount(summary.totalDatasets),
    totalDashboards: toCount(summary.totalDashboards),
    totalDataflows: toCount(summary.totalDataflows),
    totalLakehouses: toCount(summary.totalLakehouses),
    totalNotebooks: toCount(summary.totalNotebooks),
    totalPipelines: toCount(summary.totalPipelines),
    totalWarehouses: toCount(summary.totalWarehouses),
    totalUsers: toCount(summary.totalUsers),
    creatorCount,
    explorerCount: users.length - creatorCount,
    capacityCount: (summary.capacities || []).length,
    workspacesOnCapacity: toCount(summary.workspacesOnCapacity),
    workspacesOnSharedCapacity: toCount(summary.workspacesOnSharedCapacity),
    totalStorageSize: toCount(summary.totalStorageSize),
    totalStorageFiles: toCount(summary.totalStorageFiles),
    storageScannedCount: toCount(summary.storageScannedCount),
  };
}

// Side-by-side metric rows for the summary-level comparison.
function diffTotals(fromTotals, toTotals) {
  const from = fromTotals || {};
  const to = toTotals || {};
  return METRIC_DEFS.map(def => {
    const before = toCount(from[def.key]);
    const after = toCount(to[def.key]);
    const delta = after - before;
    return {
      key: def.key,
      label: def.label,
      format: def.format || 'number',
      from: before,
      to: after,
      delta,
      changed: delta !== 0,
      percent: before === 0 ? (after === 0 ? 0 : null) : Math.round((delta / before) * 1000) / 10,
    };
  });
}

function indexById(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    if (entry && entry.id) map.set(entry.id, entry);
  }
  return map;
}

function workspaceLabel(workspace) {
  return (workspace && (workspace.name || workspace.displayName)) || 'Unnamed';
}

const WORKSPACE_COUNT_FIELDS = [
  ['totalItems', 'Items'],
  ['reportCount', 'Reports'],
  ['datasetCount', 'Semantic Models'],
  ['dashboardCount', 'Dashboards'],
  ['dataflowCount', 'Dataflows'],
  ['lakehouseCount', 'Lakehouses'],
  ['notebookCount', 'Notebooks'],
  ['pipelineCount', 'Pipelines'],
  ['warehouseCount', 'Warehouses'],
  ['userCount', 'Users'],
];

function userKeyOf(user) {
  return ((user && (user.email || user.name)) || '').toLowerCase();
}

function diffWorkspaceUsers(fromWorkspace, toWorkspace) {
  const fromUsers = new Map();
  for (const user of fromWorkspace.users || []) {
    const key = userKeyOf(user);
    if (key) fromUsers.set(key, user);
  }
  const toUsers = new Map();
  for (const user of toWorkspace.users || []) {
    const key = userKeyOf(user);
    if (key) toUsers.set(key, user);
  }

  const added = [];
  const removed = [];
  const roleChanged = [];

  for (const [key, user] of toUsers) {
    if (!fromUsers.has(key)) {
      added.push({ name: user.name || user.email || 'Unknown', email: user.email || '', role: user.role || '-' });
    } else {
      const before = fromUsers.get(key);
      if ((before.role || '') !== (user.role || '')) {
        roleChanged.push({
          name: user.name || user.email || 'Unknown',
          email: user.email || '',
          from: before.role || '-',
          to: user.role || '-',
        });
      }
    }
  }
  for (const [key, user] of fromUsers) {
    if (!toUsers.has(key)) {
      removed.push({ name: user.name || user.email || 'Unknown', email: user.email || '', role: user.role || '-' });
    }
  }

  return { added, removed, roleChanged };
}

/**
 * Detailed diff between two runs' parsed results. Computed on demand — this walks
 * every workspace and item in both runs, which is why it is not part of the
 * summary-level comparison.
 *
 * `itemSampleLimit` caps the per-list item churn samples; counts are always exact.
 */
function diffRunDetails(fromResults, toResults, { itemSampleLimit = 500 } = {}) {
  const fromWorkspaces = indexById((fromResults && fromResults.workspaces) || []);
  const toWorkspaces = indexById((toResults && toResults.workspaces) || []);

  const addedWorkspaces = [];
  const removedWorkspaces = [];
  const changedWorkspaces = [];
  const capacityMoves = [];
  const accessChanges = [];
  const addedItems = [];
  const removedItems = [];
  let addedItemCount = 0;
  let removedItemCount = 0;

  for (const [id, workspace] of toWorkspaces) {
    if (fromWorkspaces.has(id)) continue;
    addedWorkspaces.push({
      id,
      name: workspaceLabel(workspace),
      state: workspace.state || '-',
      totalItems: toCount(workspace.totalItems),
      licenseType: workspace.licenseType || '-',
    });
    for (const item of workspace.items || []) {
      addedItemCount += 1;
      if (addedItems.length < itemSampleLimit) {
        addedItems.push({ workspace: workspaceLabel(workspace), name: item.name || 'Unnamed', type: item.type || '-' });
      }
    }
  }

  for (const [id, workspace] of fromWorkspaces) {
    if (toWorkspaces.has(id)) continue;
    removedWorkspaces.push({
      id,
      name: workspaceLabel(workspace),
      state: workspace.state || '-',
      totalItems: toCount(workspace.totalItems),
      licenseType: workspace.licenseType || '-',
    });
    for (const item of workspace.items || []) {
      removedItemCount += 1;
      if (removedItems.length < itemSampleLimit) {
        removedItems.push({ workspace: workspaceLabel(workspace), name: item.name || 'Unnamed', type: item.type || '-' });
      }
    }
  }

  for (const [id, toWorkspace] of toWorkspaces) {
    const fromWorkspace = fromWorkspaces.get(id);
    if (!fromWorkspace) continue;

    const changes = [];
    for (const [field, label] of WORKSPACE_COUNT_FIELDS) {
      const before = toCount(fromWorkspace[field]);
      const after = toCount(toWorkspace[field]);
      if (before !== after) changes.push({ field: label, from: before, to: after, delta: after - before });
    }
    if ((fromWorkspace.state || '') !== (toWorkspace.state || '')) {
      changes.push({ field: 'State', from: fromWorkspace.state || '-', to: toWorkspace.state || '-', delta: null });
    }
    if (changes.length) {
      changedWorkspaces.push({ id, name: workspaceLabel(toWorkspace), changes });
    }

    const skuChanged = (fromWorkspace.capacitySku || '') !== (toWorkspace.capacitySku || '');
    const capacityChanged = (fromWorkspace.capacityId || '') !== (toWorkspace.capacityId || '');
    const licenseChanged = (fromWorkspace.licenseType || '') !== (toWorkspace.licenseType || '');
    if (skuChanged || capacityChanged || licenseChanged) {
      capacityMoves.push({
        id,
        name: workspaceLabel(toWorkspace),
        fromSku: fromWorkspace.capacitySku || '-',
        toSku: toWorkspace.capacitySku || '-',
        fromLicense: fromWorkspace.licenseType || '-',
        toLicense: toWorkspace.licenseType || '-',
        fromCapacityId: fromWorkspace.capacityId || '',
        toCapacityId: toWorkspace.capacityId || '',
      });
    }

    const userDiff = diffWorkspaceUsers(fromWorkspace, toWorkspace);
    if (userDiff.added.length || userDiff.removed.length || userDiff.roleChanged.length) {
      accessChanges.push({ id, name: workspaceLabel(toWorkspace), ...userDiff });
    }

    const fromItems = indexById(fromWorkspace.items || []);
    const toItems = indexById(toWorkspace.items || []);
    for (const [itemId, item] of toItems) {
      if (fromItems.has(itemId)) continue;
      addedItemCount += 1;
      if (addedItems.length < itemSampleLimit) {
        addedItems.push({ workspace: workspaceLabel(toWorkspace), name: item.name || 'Unnamed', type: item.type || '-' });
      }
    }
    for (const [itemId, item] of fromItems) {
      if (toItems.has(itemId)) continue;
      removedItemCount += 1;
      if (removedItems.length < itemSampleLimit) {
        removedItems.push({ workspace: workspaceLabel(fromWorkspace), name: item.name || 'Unnamed', type: item.type || '-' });
      }
    }
  }

  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  addedWorkspaces.sort(byName);
  removedWorkspaces.sort(byName);
  changedWorkspaces.sort(byName);
  capacityMoves.sort(byName);
  accessChanges.sort(byName);

  return {
    workspaces: { added: addedWorkspaces, removed: removedWorkspaces, changed: changedWorkspaces },
    capacityMoves,
    accessChanges,
    items: {
      addedCount: addedItemCount,
      removedCount: removedItemCount,
      added: addedItems,
      removed: removedItems,
      truncated: addedItemCount > addedItems.length || removedItemCount > removedItems.length,
    },
  };
}

module.exports = {
  METRIC_DEFS,
  buildUser360,
  computeRunTotals,
  diffTotals,
  diffRunDetails,
};
