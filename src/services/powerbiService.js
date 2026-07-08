const axios = require('axios');
const { getAccessTokenForSP } = require('./authService');

const PBI_BASE = 'https://api.powerbi.com/v1.0/myorg';
const PBI_ADMIN = `${PBI_BASE}/admin`;
const FABRIC_ADMIN = 'https://api.fabric.microsoft.com/v1/admin';

function createClient(token, baseURL, timeout = 30000) {
  return axios.create({
    baseURL,
    headers: { Authorization: 'Bearer ' + token },
    timeout,
  });
}

async function safeRequest(client, url, params = {}) {
  try {
    const response = await client.get(url, { params });
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    throw new Error(`API error (${status || 'unknown'}): ${message}`);
  }
}

// Paginate Fabric Admin endpoints that use continuationToken/continuationUri
async function fetchAllFabricItems(client, url, params = {}) {
  const allItems = [];
  let nextUrl = url;
  let nextParams = params;

  while (nextUrl) {
    const data = await safeRequest(client, nextUrl, nextParams);
    const items = data.itemEntities || data.value || [];
    allItems.push(...items);

    if (data.continuationUri) {
      // continuationUri is a full URL, extract path
      try {
        const parsed = new URL(data.continuationUri);
        nextUrl = parsed.pathname + parsed.search;
        nextParams = {};
      } catch {
        nextUrl = data.continuationUri;
        nextParams = {};
      }
    } else if (data.continuationToken) {
      nextParams = { ...params, continuationToken: data.continuationToken };
    } else {
      nextUrl = null;
    }
  }
  return allItems;
}

function createPowerBIService(spConfig) {
  let tokenPromise = null;

  async function getToken() {
    if (!tokenPromise) {
      tokenPromise = getAccessTokenForSP(spConfig);
      setTimeout(() => { tokenPromise = null; }, 50 * 60 * 1000);
    }
    return tokenPromise;
  }

  async function pbiClient() {
    return createClient(await getToken(), PBI_BASE);
  }

  async function pbiAdminClient() {
    return createClient(await getToken(), PBI_ADMIN, 60000);
  }

  async function fabricAdminClient() {
    return createClient(await getToken(), FABRIC_ADMIN, 60000);
  }

  // ── Workspaces (Fabric Admin API) ──
  async function getWorkspaces() {
    const client = await fabricAdminClient();
    const data = await safeRequest(client, '/workspaces');
    return data.workspaces || data.value || [];
  }

  // ── Items via Fabric Admin API ──
  async function getItemsByWorkspace(workspaceId) {
    const client = await fabricAdminClient();
    return fetchAllFabricItems(client, '/items', { workspaceId });
  }

  async function getItemsByType(type) {
    const client = await fabricAdminClient();
    return fetchAllFabricItems(client, '/items', { type });
  }

  async function getAllItems() {
    const client = await fabricAdminClient();
    return fetchAllFabricItems(client, '/items');
  }

  // ── Workspace users (Fabric Admin API) ──
  async function getWorkspaceUsers(workspaceId) {
    try {
      const client = await pbiAdminClient();
      const data = await safeRequest(client, `/groups/${workspaceId}/users`);
      return data.value || [];
    } catch {
      return [];
    }
  }

  // ── Workspace detail (Fabric Admin) ──
  async function getWorkspaceById(workspaceId) {
    try {
      const client = await fabricAdminClient();
      return await safeRequest(client, `/workspaces/${workspaceId}`);
    } catch {
      // Fallback to PBI API
      try {
        return await safeRequest(await pbiClient(), `/groups/${workspaceId}`);
      } catch {
        return { id: workspaceId, name: 'Workspace' };
      }
    }
  }

  // ── Dataset details (still via PBI API) ──
  async function getDatasetRefreshHistory(workspaceId, datasetId, top = 20) {
    try {
      const data = await safeRequest(
        await pbiClient(),
        `/groups/${workspaceId}/datasets/${datasetId}/refreshes`,
        { $top: top }
      );
      return data.value || [];
    } catch {
      return [];
    }
  }

  async function getDatasetDatasources(workspaceId, datasetId) {
    try {
      const data = await safeRequest(
        await pbiClient(),
        `/groups/${workspaceId}/datasets/${datasetId}/datasources`
      );
      return data.value || [];
    } catch {
      return [];
    }
  }

  async function getDatasetParameters(workspaceId, datasetId) {
    try {
      const data = await safeRequest(
        await pbiClient(),
        `/groups/${workspaceId}/datasets/${datasetId}/parameters`
      );
      return data.value || [];
    } catch {
      return [];
    }
  }

  // ── Dashboard tiles (still PBI API) ──
  async function getDashboardTiles(workspaceId, dashboardId) {
    try {
      const data = await safeRequest(
        await pbiClient(),
        `/groups/${workspaceId}/dashboards/${dashboardId}/tiles`
      );
      return data.value || [];
    } catch {
      return [];
    }
  }

  // ── Capacities ──
  async function getCapacities() {
    try {
      const data = await safeRequest(await pbiClient(), '/capacities');
      return data.value || [];
    } catch {
      return [];
    }
  }

  // ── Admin scanner (PBI Admin API) ──
  async function scanWorkspaces(workspaceIds) {
    const client = await pbiAdminClient();
    const body = { workspaces: workspaceIds };
    const params = {
      datasetExpressions: true,
      datasetSchema: true,
      datasourceDetails: true,
      getArtifactUsers: true,
    };
    const response = await client.post('/workspaces/getInfo', body, { params });
    return response.data;
  }

  async function getScanStatus(scanId) {
    return safeRequest(await pbiAdminClient(), `/workspaces/scanStatus/${scanId}`);
  }

  async function getScanResult(scanId) {
    return safeRequest(await pbiAdminClient(), `/workspaces/scanResult/${scanId}`);
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
    scanWorkspaces,
    getScanStatus,
    getScanResult,
  };
}

module.exports = { createPowerBIService };
