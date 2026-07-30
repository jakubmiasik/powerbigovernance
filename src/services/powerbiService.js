const axios = require('axios');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Connection: TediousConnection, Request: TediousRequest } = require('tedious');
const {
  getAccessTokenForSP, getFabricTokenForSP, getAzureManagementTokenForSP, getGraphTokenForSP, getOneLakeTokenForSP,
  getSqlTokenForSP,
} = require('./authService');

const PBI_BASE = 'https://api.powerbi.com/v1.0/myorg';
const PBI_ADMIN = PBI_BASE + '/admin';
const FABRIC_CORE = 'https://api.fabric.microsoft.com/v1';
const FABRIC_ADMIN = FABRIC_CORE + '/admin';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const ARM_BASE = 'https://management.azure.com';

// A throttled tenant can hold a single request for minutes. Cap how long one wait
// may block so a run reports slow progress instead of appearing frozen.
const MAX_RETRY_DELAY_MS = Number.parseInt(process.env.API_MAX_RETRY_DELAY_MS || '120000', 10);

// Carries a reporter through the whole call tree without threading a parameter
// into every request helper, so callers like the analysis run can see retries and
// throttling as they happen.
const apiContext = new AsyncLocalStorage();

function reportApiEvent(event) {
  const store = apiContext.getStore();
  if (store && typeof store.onApiEvent === 'function') {
    try {
      store.onApiEvent(event);
    } catch {
      // Telemetry must never break the request it is describing.
    }
  }
}

function runWithApiReporter(onApiEvent, fn) {
  return apiContext.run({ onApiEvent }, fn);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return url;
  }
}

function getRetryDelay(err, attempt) {
  const status = err.response?.status;
  if (![408, 429, 500, 502, 503, 504].includes(status)) return null;
  const retryAfter = Number.parseInt(err.response?.headers?.['retry-after'], 10);
  if (Number.isInteger(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
  }
  return Math.min(1000 * Math.pow(2, attempt), 10000);
}

async function withRetry(operation, context = {}) {
  const path = context.url ? describeUrl(context.url) : 'request';
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await operation();
      reportApiEvent({ type: 'request', path });
      return result;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const delay = getRetryDelay(err, attempt);
      if (delay === null || attempt === 2) {
        reportApiEvent({
          type: 'failure',
          path,
          status,
          message: err.response?.data?.error?.message || err.message,
          retriedOut: delay !== null,
        });
        break;
      }
      const retryAfter = Number.parseInt(err.response?.headers?.['retry-after'], 10);
      reportApiEvent({
        type: status === 429 ? 'throttled' : 'retry',
        path,
        status,
        delayMs: delay,
        attempt: attempt + 1,
        // A tenant-supplied Retry-After longer than the cap is worth saying out loud.
        cappedFrom: Number.isInteger(retryAfter) && retryAfter * 1000 > delay ? retryAfter * 1000 : null,
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

function buildApiError(err) {
  const status = err.response?.status;
  const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
  return new Error('API error (' + (status || 'unknown') + '): ' + message);
}

async function safeGet(token, url, params = {}) {
  try {
    const response = await withRetry(() => axios.get(url, {
      headers: { Authorization: 'Bearer ' + token },
      params,
      timeout: 60000,
    }), { url });
    return response.data;
  } catch (err) {
    throw buildApiError(err);
  }
}

async function safePost(token, url, body, params = {}) {
  try {
    const response = await withRetry(() => axios.post(url, body, {
      headers: { Authorization: 'Bearer ' + token },
      params,
      timeout: 60000,
    }), { url });
    return response.data;
  } catch (err) {
    throw buildApiError(err);
  }
}

async function safeDelete(token, url) {
  try {
    const response = await withRetry(() => axios.delete(url, {
      headers: { Authorization: 'Bearer ' + token },
      timeout: 60000,
    }), { url });
    return response.data;
  } catch (err) {
    throw buildApiError(err);
  }
}

async function safePatch(token, url, body) {
  try {
    const response = await withRetry(() => axios.patch(url, body, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 60000,
    }), { url });
    return response.data;
  } catch (err) {
    throw buildApiError(err);
  }
}

// Paginate Fabric Admin endpoints using continuationUri
async function fetchAllPaged(token, url, params = {}) {
  const allItems = [];
  let nextUrl = url;
  let nextParams = params;

  while (nextUrl) {
    const data = await safeGet(token, nextUrl, nextParams);
    const items = data.itemEntities || data.value || [];
    allItems.push(...items);

    if (data.continuationUri) {
      // continuationUri is an absolute URL
      nextUrl = data.continuationUri;
      nextParams = {};
    } else if (data.continuationToken) {
      nextParams = { ...params, continuationToken: data.continuationToken };
    } else {
      nextUrl = null;
    }
  }
  return allItems;
}


// Runs one read-only query against a Fabric SQL analytics endpoint over TDS.
// tedious is already a dependency (Azure SQL), so this adds no new package.
function querySqlEndpoint(server, database, token, sql) {
  return new Promise((resolve, reject) => {
    const connection = new TediousConnection({
      server,
      authentication: { type: 'azure-active-directory-access-token', options: { token } },
      options: {
        database,
        encrypt: true,
        trustServerCertificate: false,
        requestTimeout: 60000,
        connectTimeout: 30000,
        rowCollectionOnRequestCompletion: false,
      },
    });

    const rows = [];
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { connection.close(); } catch { /* already closing */ }
      if (err) reject(err); else resolve(value);
    };

    connection.on('connect', (err) => {
      if (err) return finish(new Error('SQL endpoint connection failed: ' + err.message));
      const request = new TediousRequest(sql, (reqErr) => {
        if (reqErr) return finish(new Error('SQL endpoint query failed: ' + reqErr.message));
        finish(null, rows);
      });
      request.on('row', (columns) => {
        const row = {};
        columns.forEach((col) => { row[col.metadata.colName] = col.value; });
        rows.push(row);
      });
      connection.execSql(request);
    });
    connection.on('error', (err) => finish(new Error('SQL endpoint error: ' + err.message)));
    connection.connect();
  });
}

function createPowerBIService(spConfig) {
  let tokenPromise = null;
  let fabricTokenPromise = null;
  let fabricApiAvailable = null; // null = unknown, true/false = tested

  async function getToken() {
    if (!tokenPromise) {
      tokenPromise = getAccessTokenForSP(spConfig).catch(err => {
        tokenPromise = null;
        throw err;
      });
      setTimeout(() => { tokenPromise = null; }, 50 * 60 * 1000);
    }
    return tokenPromise;
  }

  // Separate token for Fabric Core API write operations (migration)
  async function getFabricToken() {
    if (!fabricTokenPromise) {
      fabricTokenPromise = getFabricTokenForSP(spConfig).catch(err => {
        fabricTokenPromise = null;
        throw err;
      });
      setTimeout(() => { fabricTokenPromise = null; }, 50 * 60 * 1000);
    }
    return fabricTokenPromise;
  }

  // Try Fabric Admin API; if it fails, mark as unavailable and skip future attempts
  async function tryFabricGet(path, params) {
    if (fabricApiAvailable === false) return null;
    try {
      const token = await getFabricToken();
      const data = await safeGet(token, FABRIC_ADMIN + path, params || {});
      fabricApiAvailable = true;
      return data;
    } catch {
      fabricApiAvailable = false;
      return null;
    }
  }

  // ── Workspaces: try Fabric Admin API first, fallback to PBI Admin API ──
  async function getWorkspaces() {
    const fabricData = await tryFabricGet('/workspaces');
    if (fabricData) return fabricData.workspaces || fabricData.value || [];
    // Fallback: PBI Admin API
    const pbiToken = await getToken();
    const data = await safeGet(pbiToken, PBI_ADMIN + '/groups', { $top: 5000 });
    return data.value || [];
  }

  // ── Single workspace detail ──
  async function getWorkspaceById(workspaceId) {
    const fabricData = await tryFabricGet('/workspaces/' + workspaceId);
    if (fabricData && fabricData.id) return fabricData;
    try {
      const pbiToken = await getToken();
      return await safeGet(pbiToken, PBI_ADMIN + '/groups/' + workspaceId);
    } catch {
      return { id: workspaceId, name: 'Workspace' };
    }
  }

  // ── Items: try Fabric Admin API, fallback to PBI Admin API ──
  async function getItemsByWorkspace(workspaceId) {
    if (fabricApiAvailable !== false) {
      try {
        const token = await getFabricToken();
        const items = await fetchAllPaged(token, FABRIC_ADMIN + '/items', { workspaceId });
        fabricApiAvailable = true;
        return items;
      } catch { fabricApiAvailable = false; }
    }
    // PBI fallback: get reports + datasets + dashboards individually
    const pbiToken = await getToken();
    const items = [];
    try {
      const r = await safeGet(pbiToken, PBI_ADMIN + '/groups/' + workspaceId + '/reports');
      (r.value || []).forEach(i => items.push({ ...i, type: 'Report', workspaceId }));
    } catch {}
    try {
      const d = await safeGet(pbiToken, PBI_ADMIN + '/groups/' + workspaceId + '/datasets');
      (d.value || []).forEach(i => items.push({ ...i, type: 'SemanticModel', workspaceId }));
    } catch {}
    try {
      const db = await safeGet(pbiToken, PBI_ADMIN + '/groups/' + workspaceId + '/dashboards');
      (db.value || []).forEach(i => items.push({ ...i, type: 'Dashboard', workspaceId }));
    } catch {}
    return items;
  }

  async function getItemsByType(type) {
    if (fabricApiAvailable !== false) {
      try {
        const token = await getFabricToken();
        const items = await fetchAllPaged(token, FABRIC_ADMIN + '/items', { type });
        fabricApiAvailable = true;
        return items;
      } catch { fabricApiAvailable = false; }
    }
    return [];
  }

  async function getAllItems() {
    if (fabricApiAvailable !== false) {
      try {
        const token = await getFabricToken();
        const items = await fetchAllPaged(token, FABRIC_ADMIN + '/items');
        fabricApiAvailable = true;
        return items;
      } catch { fabricApiAvailable = false; }
    }
    return [];
  }

  // ── Workspace users: PBI Admin API ──
  // GET https://api.powerbi.com/v1.0/myorg/admin/groups/{id}/users
  async function getWorkspaceUsers(workspaceId) {
    const token = await getToken();
    try {
      const data = await safeGet(token, PBI_ADMIN + '/groups/' + workspaceId + '/users');
      return data.value || [];
    } catch {
      return [];
    }
  }

  // ── Dataset refresh history: PBI API ──
  async function getDatasetRefreshHistory(workspaceId, datasetId, top) {
    const token = await getToken();
    try {
      const data = await safeGet(token,
        PBI_BASE + '/groups/' + workspaceId + '/datasets/' + datasetId + '/refreshes',
        { $top: top || 20 });
      return data.value || [];
    } catch { return []; }
  }

  // ── Dataset datasources: PBI API ──
  async function getDatasetDatasources(workspaceId, datasetId) {
    const token = await getToken();
    try {
      const data = await safeGet(token,
        PBI_BASE + '/groups/' + workspaceId + '/datasets/' + datasetId + '/datasources');
      return data.value || [];
    } catch { return []; }
  }

  // ── Dataset parameters: PBI API ──
  async function getDatasetParameters(workspaceId, datasetId) {
    const token = await getToken();
    try {
      const data = await safeGet(token,
        PBI_BASE + '/groups/' + workspaceId + '/datasets/' + datasetId + '/parameters');
      return data.value || [];
    } catch { return []; }
  }

  // ── Dashboard tiles: PBI API ──
  async function getDashboardTiles(workspaceId, dashboardId) {
    const token = await getToken();
    try {
      const data = await safeGet(token,
        PBI_BASE + '/groups/' + workspaceId + '/dashboards/' + dashboardId + '/tiles');
      return data.value || [];
    } catch { return []; }
  }

  // ── Capacities: PBI Admin API ──
  // GET https://api.powerbi.com/v1.0/myorg/admin/capacities
  async function getCapacities() {
    const token = await getToken();
    try {
      const data = await safeGet(token, PBI_ADMIN + '/capacities');
      return data.value || [];
    } catch {
      // Fallback to non-admin endpoint
      try {
        const data = await safeGet(token, PBI_BASE + '/capacities');
        return data.value || [];
      } catch { return []; }
    }
  }

  // ── Item detail: Fabric Core API ──
  // GET /v1/workspaces/{workspaceId}/items/{itemId}
  async function getItemDetail(workspaceId, itemId) {
    const token = await getFabricToken();
    return safeGet(token, FABRIC_CORE + '/workspaces/' + workspaceId + '/items/' + itemId);
  }

  // ── Lakehouse tables: Fabric Core API ──
  // GET /v1/workspaces/{workspaceId}/lakehouses/{lakehouseId}/tables
  async function getLakehouseTables(workspaceId, lakehouseId) {
    const token = await getFabricToken();
    const data = await safeGet(token, FABRIC_CORE + '/workspaces/' + workspaceId + '/lakehouses/' + lakehouseId + '/tables');
    return data.data || data.value || [];
  }

  // ── OneLake content breakdown ──
  // Groups the flat OneLake path listing into the folders a user recognises
  // (Tables/<name>, Files/<name>) with per-folder size and file counts.
  async function getOneLakeBreakdown(workspaceId, itemId, maxPages) {
    const paths = await listOneLakePaths(workspaceId, itemId, null, maxPages || 20);
    const folders = new Map();
    let totalSize = 0;
    let totalFiles = 0;

    for (const entry of paths) {
      const size = Number.parseInt(entry.contentLength, 10) || 0;
      const isDirectory = entry.isDirectory === true || entry.isDirectory === 'true';
      if (!isDirectory) {
        totalSize += size;
        totalFiles += 1;
      }

      const segments = String(entry.name || '').split('/').filter(Boolean);
      if (!segments.length) continue;
      // Tables/foo/part.parquet and Files/bar/x.csv both roll up to their second segment.
      const area = segments[0];
      const folder = segments.length > 1 ? segments[0] + '/' + segments[1] : segments[0];
      if (!folders.has(folder)) folders.set(folder, { folder, area, files: 0, size: 0 });
      const bucket = folders.get(folder);
      if (!isDirectory) {
        bucket.files += 1;
        bucket.size += size;
      }
    }

    return {
      totalSize,
      totalFiles,
      folders: [...folders.values()].sort((a, b) => b.size - a.size || a.folder.localeCompare(b.folder)),
    };
  }

  // ── SQL analytics endpoint ──
  // Lakehouses and warehouses expose a read-only SQL endpoint. Its connection
  // string comes from the item's own Fabric route; the schema then comes from
  // querying INFORMATION_SCHEMA over TDS with a SQL-scoped token.
  async function getSqlEndpointInfo(workspaceId, itemId, itemType) {
    const token = await getFabricToken();
    const type = (itemType || '').toLowerCase();
    const route = type === 'warehouse' ? 'warehouses' : type === 'lakehouse' ? 'lakehouses' : null;
    if (!route) return null;

    const detail = await safeGet(token, FABRIC_CORE + '/workspaces/' + workspaceId + '/' + route + '/' + itemId);
    const properties = detail.properties || {};
    const sqlProps = properties.sqlEndpointProperties || {};
    const connectionString = sqlProps.connectionString || properties.connectionString || null;
    if (!connectionString) return null;

    return {
      connectionString,
      // The TDS database is named after the item, not after the SQL endpoint's own
      // item id — connecting by GUID fails with an error that reads like a
      // permission problem.
      database: detail.displayName || itemId,
      endpointItemId: sqlProps.id || null,
      provisioningStatus: sqlProps.provisioningStatus || properties.provisioningStatus || null,
      itemType: detail.type || itemType,
    };
  }

  // Tables and columns behind a SQL analytics endpoint, read over TDS.
  //
  // Workspace roles map to SQL permissions, so a service principal with a workspace
  // role (Admin, Member, Contributor, Viewer) can read this — no separate database
  // grant is needed. Failures are classified below so a genuine access problem is
  // distinguishable from an endpoint that is simply not ready.
  async function getSqlEndpointSchema(endpoint) {
    const token = await getSqlTokenForSP(spConfig);
    const rows = await querySqlEndpoint(endpoint.connectionString, endpoint.database, token, `
      SELECT t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_TYPE,
             c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.ORDINAL_POSITION,
             c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE
      FROM INFORMATION_SCHEMA.TABLES t
      LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
        ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
      ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION
    `);

    const tables = new Map();
    for (const row of rows) {
      const key = row.TABLE_SCHEMA + '.' + row.TABLE_NAME;
      if (!tables.has(key)) {
        tables.set(key, { schema: row.TABLE_SCHEMA, name: row.TABLE_NAME, type: row.TABLE_TYPE, columns: [] });
      }
      if (row.COLUMN_NAME) {
        let dataType = row.DATA_TYPE;
        if (row.CHARACTER_MAXIMUM_LENGTH) dataType += '(' + (row.CHARACTER_MAXIMUM_LENGTH === -1 ? 'max' : row.CHARACTER_MAXIMUM_LENGTH) + ')';
        else if (row.NUMERIC_PRECISION && row.NUMERIC_SCALE !== null && row.NUMERIC_SCALE !== undefined) {
          dataType += '(' + row.NUMERIC_PRECISION + ',' + row.NUMERIC_SCALE + ')';
        }
        tables.get(key).columns.push({
          name: row.COLUMN_NAME,
          dataType,
          nullable: row.IS_NULLABLE === 'YES',
          position: row.ORDINAL_POSITION,
        });
      }
    }
    return [...tables.values()].sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
  }

  // ── Tenant settings: Fabric Admin API ──
  // GET https://api.fabric.microsoft.com/v1/admin/tenantsettings
  // Needs Tenant.Read.All (or Tenant.ReadWrite.All) on the service principal.
  // Errors are propagated rather than swallowed: a permission problem here is
  // something the operator needs to see, not an empty list.
  async function getTenantSettings() {
    const token = await getFabricToken();
    const data = await safeGet(token, FABRIC_ADMIN + '/tenantsettings');
    return data.tenantSettings || data.value || [];
  }

  // ── Admin scanner: PBI Admin API ──
  async function scanWorkspaces(workspaceIds) {
    const token = await getToken();
    return safePost(token, PBI_ADMIN + '/workspaces/getInfo',
      { workspaces: workspaceIds },
      { datasetExpressions: true, datasetSchema: true, datasourceDetails: true, getArtifactUsers: true });
  }

  async function getScanStatus(scanId) {
    const token = await getToken();
    return safeGet(token, PBI_ADMIN + '/workspaces/scanStatus/' + scanId);
  }

  async function getScanResult(scanId) {
    const token = await getToken();
    return safeGet(token, PBI_ADMIN + '/workspaces/scanResult/' + scanId);
  }

  // ── Workspace role assignments for migration ──
  // Add SP as Admin to workspace using Power BI Admin API (doesn't require existing membership)
  async function addWorkspaceAdmin(workspaceId, principalId, principalType) {
    const token = await getToken();
    return safePost(token,
      PBI_ADMIN + '/groups/' + workspaceId + '/users',
      { identifier: principalId, groupUserAccessRight: 'Admin', principalType: principalType || 'App' });
  }

  // Remove SP from workspace using Power BI Admin API
  async function removeWorkspaceUser(workspaceId, principalId) {
    const token = await getToken();
    return safeDelete(token,
      PBI_ADMIN + '/groups/' + workspaceId + '/users/' + principalId);
  }

  // ── Assign workspace to capacity: Fabric Core API ──
  // POST https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/assignToCapacity
  async function assignToCapacity(workspaceId, capacityId) {
    const token = await getFabricToken();
    return safePost(token,
      'https://api.fabric.microsoft.com/v1/workspaces/' + workspaceId + '/assignToCapacity',
      { capacityId });
  }

  // ── Unassign workspace from capacity (move to shared/Pro) ──
  // POST https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/unassignFromCapacity
  async function unassignFromCapacity(workspaceId) {
    const token = await getFabricToken();
    return safePost(token,
      'https://api.fabric.microsoft.com/v1/workspaces/' + workspaceId + '/unassignFromCapacity',
      {});
  }

  // ── Item lineage: use Power BI Admin scanner API with lineage ──
  // Fetches lineage for a workspace by calling getInfo with lineage=true
  async function getWorkspaceLineage(workspaceId) {
    const token = await getToken();
    try {
      // Trigger scan with lineage for this workspace
      const scanResp = await safePost(token, PBI_ADMIN + '/workspaces/getInfo',
        { workspaces: [workspaceId] },
        { lineage: true });
      const scanId = scanResp.id;
      // Poll for completion (max 30s)
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const status = await safeGet(token, PBI_ADMIN + '/workspaces/scanStatus/' + scanId);
        if (status.status === 'Succeeded') {
          const result = await safeGet(token, PBI_ADMIN + '/workspaces/scanResult/' + scanId);
          // Extract lineage from datasets (upstreamDataflows, upstreamDatasets)
          const ws = (result.workspaces || [])[0];
          if (!ws) return [];
          const workspaceName = ws.name || ws.displayName || '';

          // The scan reports upstream items by id only. Resolving them here is what
          // turns the graph from a wall of GUIDs into readable names.
          const nameIndex = new Map();
          const addToIndex = (id, name, type) => {
            if (id && !nameIndex.has(id)) nameIndex.set(id, { name: name || null, type });
          };
          for (const d of ws.datasets || []) addToIndex(d.id, d.name, 'SemanticModel');
          for (const d of ws.dataflows || []) addToIndex(d.objectId || d.id, d.name, 'Dataflow');
          for (const r of ws.reports || []) addToIndex(r.id, r.name, 'Report');
          for (const d of ws.dashboards || []) addToIndex(d.id, d.displayName || d.name, 'Dashboard');

          const endpoint = (id, fallbackName, type, sameWorkspace) => {
            const known = nameIndex.get(id);
            return {
              id,
              name: (known && known.name) || fallbackName || null,
              type: (known && known.type) || type,
              workspaceId: sameWorkspace ? ws.id || workspaceId : null,
              workspaceName: sameWorkspace ? workspaceName : null,
            };
          };

          const lineageLinks = [];
          const push = (source, target) => {
            lineageLinks.push({
              // Legacy field names kept so existing callers keep working.
              sourceItemId: source.id,
              sourceItemDisplayName: source.name || source.id,
              sourceItemType: source.type,
              targetItemId: target.id,
              targetItemDisplayName: target.name || target.id,
              targetItemType: target.type,
              source,
              target,
            });
          };

          // Datasets have upstreamDataflows and upstreamDatasets
          for (const ds of ws.datasets || []) {
            const dsEndpoint = endpoint(ds.id, ds.name, 'SemanticModel', true);
            for (const udf of ds.upstreamDataflows || []) {
              const upstreamId = udf.targetDataflowId;
              const sameWorkspace = !udf.groupId || udf.groupId === ws.id;
              push(endpoint(upstreamId, null, 'Dataflow', sameWorkspace), dsEndpoint);
            }
            for (const uds of ds.upstreamDatasets || []) {
              const sameWorkspace = !uds.groupId || uds.groupId === ws.id;
              push(endpoint(uds.datasetId, null, 'SemanticModel', sameWorkspace), dsEndpoint);
            }
          }
          // Reports have datasetId (link to dataset)
          for (const r of ws.reports || []) {
            if (r.datasetId) {
              push(endpoint(r.datasetId, null, 'SemanticModel', true), endpoint(r.id, r.name, 'Report', true));
            }
          }
          // Dashboards have tiles with datasetId
          for (const d of ws.dashboards || []) {
            const dsIds = new Set();
            for (const t of d.tiles || []) {
              if (t.datasetId && !dsIds.has(t.datasetId)) {
                dsIds.add(t.datasetId);
                push(endpoint(t.datasetId, null, 'SemanticModel', true), endpoint(d.id, d.displayName || d.name, 'Dashboard', true));
              }
            }
          }
          return lineageLinks;
        }
        if (status.status === 'Failed') return [];
      }
      return [];
    } catch { return []; }
  }

  // ── Azure Management API: Capacity operations (pause/resume/details) ──
  async function getArmToken() {
    return getAzureManagementTokenForSP(spConfig);
  }

  // List all Fabric capacities in the subscription via ARM
  async function listArmCapacities(subscriptionId) {
    const token = await getArmToken();
    const url = `${ARM_BASE}/subscriptions/${subscriptionId}/providers/Microsoft.Fabric/capacities?api-version=2023-11-01`;
    const data = await safeGet(token, url);
    return data.value || [];
  }

  // Get capacity details from ARM
  async function getArmCapacityDetail(subscriptionId, resourceGroup, capacityName) {
    const token = await getArmToken();
    const url = `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Fabric/capacities/${capacityName}?api-version=2023-11-01`;
    return safeGet(token, url);
  }

  // Suspend (pause) a capacity
  async function suspendCapacity(subscriptionId, resourceGroup, capacityName) {
    const token = await getArmToken();
    const url = `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Fabric/capacities/${capacityName}/suspend?api-version=2023-11-01`;
    return safePost(token, url, {});
  }

  // Resume a capacity
  async function resumeCapacity(subscriptionId, resourceGroup, capacityName) {
    const token = await getArmToken();
    const url = `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Fabric/capacities/${capacityName}/resume?api-version=2023-11-01`;
    return safePost(token, url, {});
  }

  // ── Workspace Role Assignments: Fabric Core API ──
  async function getRoleAssignments(workspaceId) {
    const token = await getFabricToken();
    const all = [];
    let url = `${FABRIC_CORE}/workspaces/${workspaceId}/roleAssignments`;
    while (url) {
      const data = await safeGet(token, url);
      all.push(...(data.value || []));
      url = data.continuationUri || null;
    }
    return all;
  }

  async function addRoleAssignment(workspaceId, principalId, principalType, role) {
    const token = await getFabricToken();
    return safePost(token, `${FABRIC_CORE}/workspaces/${workspaceId}/roleAssignments`, {
      principal: { id: principalId, type: principalType },
      role,
    });
  }

  async function updateRoleAssignment(workspaceId, roleAssignmentId, role) {
    const token = await getFabricToken();
    return safePatch(token, `${FABRIC_CORE}/workspaces/${workspaceId}/roleAssignments/${roleAssignmentId}`, { role });
  }

  async function deleteRoleAssignment(workspaceId, roleAssignmentId) {
    const token = await getFabricToken();
    return safeDelete(token, `${FABRIC_CORE}/workspaces/${workspaceId}/roleAssignments/${roleAssignmentId}`);
  }

  // ── Microsoft Graph API: search users and service principals ──
  let graphTokenPromise = null;
  async function getGraphToken() {
    if (!graphTokenPromise) {
      graphTokenPromise = getGraphTokenForSP(spConfig).catch(err => {
        graphTokenPromise = null;
        throw err;
      });
      setTimeout(() => { graphTokenPromise = null; }, 50 * 60 * 1000);
    }
    return graphTokenPromise;
  }

  async function searchEntraUsers(query) {
    const token = await getGraphToken();
    const filter = `startswith(displayName,'${query}') or startswith(userPrincipalName,'${query}')`;
    const data = await safeGet(token, `${GRAPH_BASE}/users`, {
      $filter: filter,
      $select: 'id,displayName,userPrincipalName,mail',
      $top: 15,
    });
    return data.value || [];
  }

  async function searchEntraServicePrincipals(query) {
    const token = await getGraphToken();
    const filter = `startswith(displayName,'${query}')`;
    const data = await safeGet(token, `${GRAPH_BASE}/servicePrincipals`, {
      $filter: filter,
      $select: 'id,displayName,appId,servicePrincipalType',
      $top: 15,
    });
    return data.value || [];
  }

  async function searchEntraGroups(query) {
    const token = await getGraphToken();
    const filter = `startswith(displayName,'${query}')`;
    const data = await safeGet(token, `${GRAPH_BASE}/groups`, {
      $filter: filter,
      $select: 'id,displayName,mailEnabled,securityEnabled',
      $top: 15,
    });
    return data.value || [];
  }

  // ── OneLake Storage Size: ADLS Gen2 compatible API ──
  const ONELAKE_DFS = 'https://onelake.dfs.fabric.microsoft.com';
  let onelakeTokenPromise = null;

  async function getOneLakeToken() {
    if (!onelakeTokenPromise) {
      onelakeTokenPromise = getOneLakeTokenForSP(spConfig).catch(err => {
        onelakeTokenPromise = null;
        throw err;
      });
      setTimeout(() => { onelakeTokenPromise = null; }, 50 * 60 * 1000);
    }
    return onelakeTokenPromise;
  }

  // List all paths for a specific item in OneLake via ADLS Gen2
  async function listOneLakePaths(workspaceId, itemId, directory, maxPages) {
    const token = await getOneLakeToken();
    const allPaths = [];
    let continuation = null;
    let pages = 0;
    const limit = maxPages || 50;

    do {
      // OneLake requires: /{workspaceId}/{itemId}?resource=filesystem&recursive=true
      const url = `${ONELAKE_DFS}/${workspaceId}/${itemId}`;
      const queryParams = new URLSearchParams();
      queryParams.set('resource', 'filesystem');
      queryParams.set('recursive', 'true');
      if (directory) queryParams.set('directory', directory);
      if (continuation) queryParams.set('continuation', continuation);

      try {
        const response = await axios.get(url + '?' + queryParams.toString(), {
          headers: { Authorization: 'Bearer ' + token },
          timeout: 120000,
        });

        const paths = response.data.paths || [];
        allPaths.push(...paths);
        continuation = response.headers['x-ms-continuation'] || null;
      } catch (err) {
        const status = err.response?.status;
        const errBody = err.response?.data;
        let errMsg = err.message;
        if (errBody) {
          if (typeof errBody === 'string') {
            const match = errBody.match(/<Message>(.*?)<\/Message>/s);
            errMsg = match ? match[1] : errBody.substring(0, 500);
          } else if (errBody.error) {
            errMsg = errBody.error.message || errBody.error.code || JSON.stringify(errBody.error);
          } else if (errBody.Message) {
            errMsg = errBody.Message;
          } else {
            errMsg = JSON.stringify(errBody).substring(0, 500);
          }
        }
        throw new Error(`OneLake API error (${status || 'unknown'}): ${errMsg}`);
      }
      pages++;
    } while (continuation && pages < limit);

    return allPaths;
  }

  // Get storage size for a single item
  async function getItemStorageSize(workspaceId, itemId) {
    try {
      const paths = await listOneLakePaths(workspaceId, itemId, null, 20);
      let totalSize = 0;
      let fileCount = 0;
      for (const p of paths) {
        if (p.contentLength) {
          totalSize += parseInt(p.contentLength, 10);
          fileCount++;
        }
      }
      return { itemId, totalSize, fileCount, success: true };
    } catch (err) {
      return { itemId, totalSize: 0, fileCount: 0, success: false, error: err.message };
    }
  }

  // Get storage breakdown for workspace — iterates over items that store data in OneLake
  // Items must be passed in (from saved analysis or API)
  async function getWorkspaceStorageSize(workspaceId, items) {
    const storageTypes = new Set([
      'lakehouse', 'warehouse', 'sqldatabase', 'semanticmodel', 'dataset',
      'dataflow', 'dataflowgen2', 'datagen2', 'kqldatabase', 'notebook',
      'environment', 'eventstream', 'datapipeline', 'sparkjobdefinition',
    ]);

    const itemSizes = {};
    let totalSize = 0;
    let totalFiles = 0;
    const errors = [];

    for (const item of (items || [])) {
      const itemType = (item.type || '').toLowerCase();
      if (!storageTypes.has(itemType)) continue;

      const itemId = item.id;
      if (!itemId) continue;

      try {
        const result = await getItemStorageSize(workspaceId, itemId);
        if (result.success && result.totalSize > 0) {
          itemSizes[itemId] = {
            size: result.totalSize,
            files: result.fileCount,
            name: item.displayName || item.name || itemId,
            type: item.type || 'Unknown',
          };
          totalSize += result.totalSize;
          totalFiles += result.fileCount;
        }
      } catch {
        // Skip items that fail (no OneLake storage, permissions, etc.)
        errors.push(itemId);
      }
    }

    return { totalSize, totalFiles, items: itemSizes, errors };
  }

  return {
    getWorkspaces,
    getWorkspaceById,
    getItemsByWorkspace,
    getItemsByType,
    getAllItems,
    getWorkspaceUsers,
    getDatasetRefreshHistory,
    getDatasetDatasources,
    getDatasetParameters,
    getDashboardTiles,
    getCapacities,
    getTenantSettings,
    getItemDetail,
    getLakehouseTables,
    getOneLakeBreakdown,
    getSqlEndpointInfo,
    getSqlEndpointSchema,
    scanWorkspaces,
    getScanStatus,
    getScanResult,
    getItemConnections: getWorkspaceLineage,
    getWorkspaceLineage,
    listArmCapacities,
    getArmCapacityDetail,
    suspendCapacity,
    resumeCapacity,
    assignToCapacity,
    unassignFromCapacity,
    addWorkspaceAdmin,
    removeWorkspaceUser,
    getRoleAssignments,
    addRoleAssignment,
    updateRoleAssignment,
    deleteRoleAssignment,
    searchEntraUsers,
    searchEntraServicePrincipals,
    searchEntraGroups,
    getItemStorageSize,
    getWorkspaceStorageSize,
  };
}

module.exports = { createPowerBIService, runWithApiReporter, _private: { withRetry, getRetryDelay, MAX_RETRY_DELAY_MS } };
