// Builds the per-artifact detail view. Shared by the analysis run, which collects
// details for every item up front, and by the details endpoint, which fills in
// anything the run did not capture.
//
// Every section is fetched independently: a permission gap on one still returns
// the rest, and the sections that failed are reported rather than silently missing.

// Turns a raw TDS failure into something actionable. Workspace roles already grant
// SQL access, so a login failure here usually means the service principal has no
// role on the workspace at all rather than a missing database-level grant.
function describeSqlEndpointError(message, endpoint) {
  const text = String(message || '');
  if (/Cannot open database/i.test(text)) {
    return text + ' — the endpoint was reached but database "' + endpoint.database + '" was not found under it.';
  }
  if (/Login failed|not associated with a trusted|principal/i.test(text)) {
    return text + ' — the service principal reached the endpoint but was refused. Check it holds a workspace role (Admin, Member, Contributor or Viewer) on this workspace.';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|connection failed/i.test(text)) {
    return text + ' — could not reach ' + endpoint.connectionString + '. Outbound TCP 1433 must be open from the app.';
  }
  return text;
}

// Item types worth a deep read. Everything else still gets metadata and OneLake
// content, which is cheap; this list is what drives the type-specific sections.
const DETAILED_TYPES = new Set([
  'lakehouse', 'warehouse', 'semanticmodel', 'dataset', 'dashboard',
]);

function hasDetailSections(type) {
  return DETAILED_TYPES.has((type || '').toLowerCase());
}

/**
 * Assemble the detail sections for one artifact.
 *
 * `resolveName` maps an item id to a display name so ids embedded in responses
 * (a dashboard tile's report and model, for example) can be shown by name.
 */
async function buildItemDetails(pbi, {
  workspaceId,
  itemId,
  itemType = '',
  itemName = 'Item',
  workspaceName = null,
  resolveName = () => null,
  includeOneLake = true,
}) {
  const sections = [];
  const warnings = [];
  const type = (itemType || '').toLowerCase();

  const item = {
    id: itemId,
    name: itemName || 'Item',
    type: itemType || '',
    workspaceId,
    workspaceName: workspaceName || null,
    description: null,
  };

  const labelFor = (id) => {
    if (!id) return '-';
    return resolveName(id) || id;
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

  if (type === 'lakehouse' || type === 'warehouse') {
    await section('SQL endpoint', 'hdd-network', 'sqlendpoint', async () => {
      const endpoint = await pbi.getSqlEndpointInfo(workspaceId, itemId, itemType);
      if (!endpoint) return { kind: 'note', note: 'No SQL analytics endpoint is exposed for this item.' };

      // A lakehouse endpoint is provisioned asynchronously; querying one that is
      // still building fails in a way that looks like an access problem.
      const status = (endpoint.provisioningStatus || '').toLowerCase();
      if (status && status !== 'success' && status !== 'succeeded') {
        return {
          kind: 'note',
          note: 'The SQL analytics endpoint is not ready yet (provisioning status: ' + endpoint.provisioningStatus + '). Try again once provisioning completes.',
        };
      }

      let schema = [];
      let schemaError = null;
      try {
        schema = await pbi.getSqlEndpointSchema(endpoint);
      } catch (err) {
        schemaError = describeSqlEndpointError(err.message, endpoint);
      }

      // One collapsible group per table, columns underneath, rather than repeating
      // the table name on every column row.
      const groups = schema.map(table => ({
        key: table.schema + '.' + table.name,
        label: table.schema + '.' + table.name,
        badges: [{ text: table.type === 'VIEW' ? 'View' : 'Table', color: table.type === 'VIEW' ? 'info' : 'secondary' }],
        meta: table.columns.length + ' column' + (table.columns.length === 1 ? '' : 's'),
        rows: table.columns.map(column => [column.name, column.dataType, column.nullable ? 'Yes' : 'No']),
        emptyText: 'No columns reported for this table.',
      }));

      if (schemaError) warnings.push('SQL endpoint schema: ' + schemaError);

      const columnCount = groups.reduce((sum, group) => sum + group.rows.length, 0);
      return {
        kind: 'tree',
        summary: endpoint.connectionString +
          (schema.length ? ' · ' + schema.length + ' table(s), ' + columnCount + ' column(s)' : ''),
        columns: ['Column', 'Data type', 'Nullable'],
        groups,
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

  if (includeOneLake) {
    await section('OneLake content', 'hdd', 'onelake', async () => {
      const breakdown = await pbi.getOneLakeBreakdown(workspaceId, itemId, 20);
      if (!breakdown.totalFiles && !breakdown.folders.length) {
        return { kind: 'note', note: 'No OneLake content is stored for this item.' };
      }
      // Grouped by top-level area (Tables/, Files/) with folders underneath.
      const byArea = new Map();
      for (const folder of breakdown.folders) {
        const area = folder.area || 'Other';
        if (!byArea.has(area)) byArea.set(area, []);
        byArea.get(area).push(folder);
      }

      const groups = [...byArea.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([area, folders]) => {
          const files = folders.reduce((sum, f) => sum + f.files, 0);
          const size = folders.reduce((sum, f) => sum + f.size, 0);
          return {
            key: area,
            label: area,
            badges: [{ text: folders.length + ' folder' + (folders.length === 1 ? '' : 's'), color: 'secondary' }],
            meta: files + ' file(s)',
            sizeBytes: size,
            rows: folders.map(f => [f.folder, f.files, f.size]),
            emptyText: 'No folders under this area.',
          };
        });

      return {
        kind: 'tree',
        summary: breakdown.totalFiles + ' file(s)',
        columns: ['Folder', 'Files', 'Size (bytes)'],
        groups,
        emptyText: 'No OneLake folders found.',
      };
    });
  }

  return { item, sections, warnings };
}

module.exports = {
  buildItemDetails,
  describeSqlEndpointError,
  hasDetailSections,
  DETAILED_TYPES,
};
