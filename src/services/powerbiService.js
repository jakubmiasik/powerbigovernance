const axios = require('axios');
const { getAccessTokenForSP, getFabricTokenForSP } = require('./authService');

const PBI_BASE = 'https://api.powerbi.com/v1.0/myorg';
const PBI_ADMIN = PBI_BASE + '/admin';
const FABRIC_ADMIN = 'https://api.fabric.microsoft.com/v1/admin';

async function safeGet(token, url, params = {}) {
  try {
    const response = await axios.get(url, {
      headers: { Authorization: 'Bearer ' + token },
      params,
      timeout: 60000,
    });
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    throw new Error('API error (' + (status || 'unknown') + '): ' + message);
  }
}

async function safePost(token, url, body, params = {}) {
  try {
    const response = await axios.post(url, body, {
      headers: { Authorization: 'Bearer ' + token },
      params,
      timeout: 60000,
    });
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    throw new Error('API error (' + (status || 'unknown') + '): ' + message);
  }
}

async function safeDelete(token, url) {
  try {
    const response = await axios.delete(url, {
      headers: { Authorization: 'Bearer ' + token },
      timeout: 60000,
    });
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    throw new Error('API error (' + (status || 'unknown') + '): ' + message);
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

function createPowerBIService(spConfig) {
  let tokenPromise = null;
  let fabricTokenPromise = null;

  async function getToken() {
    if (!tokenPromise) {
      tokenPromise = getAccessTokenForSP(spConfig);
      setTimeout(() => { tokenPromise = null; }, 50 * 60 * 1000);
    }
    return tokenPromise;
  }

  // Separate token for Fabric Core API write operations (migration)
  async function getFabricToken() {
    if (!fabricTokenPromise) {
      fabricTokenPromise = getFabricTokenForSP(spConfig);
      setTimeout(() => { fabricTokenPromise = null; }, 50 * 60 * 1000);
    }
    return fabricTokenPromise;
  }

  // ── Workspaces: Fabric Admin API ──
  // GET https://api.fabric.microsoft.com/v1/admin/workspaces
  async function getWorkspaces() {
    const token = await getToken();
    const data = await safeGet(token, FABRIC_ADMIN + '/workspaces');
    return data.workspaces || data.value || [];
  }

  // ── Single workspace detail ──
  // GET https://api.fabric.microsoft.com/v1/admin/workspaces/{id}
  async function getWorkspaceById(workspaceId) {
    const token = await getToken();
    try {
      return await safeGet(token, FABRIC_ADMIN + '/workspaces/' + workspaceId);
    } catch {
      return { id: workspaceId, name: 'Workspace' };
    }
  }

  // ── Items by workspace: Fabric Admin API (paginated) ──
  // GET https://api.fabric.microsoft.com/v1/admin/items?workspaceId={id}
  async function getItemsByWorkspace(workspaceId) {
    const token = await getToken();
    return fetchAllPaged(token, FABRIC_ADMIN + '/items', { workspaceId });
  }

  // ── Items by type: Fabric Admin API (paginated) ──
  // GET https://api.fabric.microsoft.com/v1/admin/items?type={type}
  async function getItemsByType(type) {
    const token = await getToken();
    return fetchAllPaged(token, FABRIC_ADMIN + '/items', { type });
  }

  // ── All items: Fabric Admin API (paginated) ──
  // GET https://api.fabric.microsoft.com/v1/admin/items
  async function getAllItems() {
    const token = await getToken();
    return fetchAllPaged(token, FABRIC_ADMIN + '/items');
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

  // ── Item connections (lineage): Fabric Admin API ──
  // GET https://api.fabric.microsoft.com/v1/admin/items/{itemId}/connections
  async function getItemConnections(itemId) {
    const token = await getToken();
    try {
      const data = await safeGet(token, FABRIC_ADMIN + '/items/' + itemId + '/connections');
      return data.value || data || [];
    } catch { return []; }
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
    getItemConnections,
    assignToCapacity,
    unassignFromCapacity,
    addWorkspaceAdmin,
    removeWorkspaceUser,
  };
}

module.exports = { createPowerBIService };
