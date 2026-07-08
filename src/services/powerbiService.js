const axios = require('axios');
const { getAccessTokenForSP } = require('./authService');

const BASE_URL = 'https://api.powerbi.com/v1.0/myorg';
const ADMIN_URL = `${BASE_URL}/admin`;

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
    const message = err.response?.data?.error?.message || err.message;
    throw new Error(`Power BI API error (${status || 'unknown'}): ${message}`);
  }
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

  async function apiClient() {
    const token = await getToken();
    return createClient(token, BASE_URL);
  }

  async function adminClient() {
    const token = await getToken();
    return createClient(token, ADMIN_URL, 60000);
  }

  async function getWorkspaces({ useAdmin = false, top = 5000, filter = '' } = {}) {
    const params = { $top: top };
    if (filter) params.$filter = filter;
    if (useAdmin) {
      const data = await safeRequest(await adminClient(), '/groups', params);
      return data.value || [];
    }
    const data = await safeRequest(await apiClient(), '/groups', params);
    return data.value || [];
  }

  async function getWorkspaceById(workspaceId) {
    return safeRequest(await apiClient(), `/groups/${workspaceId}`);
  }

  async function getReports(workspaceId) {
    const data = await safeRequest(await apiClient(), `/groups/${workspaceId}/reports`);
    return data.value || [];
  }

  async function getReportsAdmin({ top = 5000 } = {}) {
    const data = await safeRequest(await adminClient(), '/reports', { $top: top });
    return data.value || [];
  }

  async function getDatasets(workspaceId) {
    const data = await safeRequest(await apiClient(), `/groups/${workspaceId}/datasets`);
    return data.value || [];
  }

  async function getDatasetsAdmin({ top = 5000 } = {}) {
    const data = await safeRequest(await adminClient(), '/datasets', { $top: top });
    return data.value || [];
  }

  async function getDatasetRefreshHistory(workspaceId, datasetId, top = 20) {
    const data = await safeRequest(
      await apiClient(),
      `/groups/${workspaceId}/datasets/${datasetId}/refreshes`,
      { $top: top }
    );
    return data.value || [];
  }

  async function getDatasetDatasources(workspaceId, datasetId) {
    const data = await safeRequest(
      await apiClient(),
      `/groups/${workspaceId}/datasets/${datasetId}/datasources`
    );
    return data.value || [];
  }

  async function getDatasetParameters(workspaceId, datasetId) {
    try {
      const data = await safeRequest(
        await apiClient(),
        `/groups/${workspaceId}/datasets/${datasetId}/parameters`
      );
      return data.value || [];
    } catch {
      return [];
    }
  }

  async function getDashboards(workspaceId) {
    const data = await safeRequest(await apiClient(), `/groups/${workspaceId}/dashboards`);
    return data.value || [];
  }

  async function getDashboardTiles(workspaceId, dashboardId) {
    const data = await safeRequest(
      await apiClient(),
      `/groups/${workspaceId}/dashboards/${dashboardId}/tiles`
    );
    return data.value || [];
  }

  async function getDataflows(workspaceId) {
    const data = await safeRequest(await apiClient(), `/groups/${workspaceId}/dataflows`);
    return data.value || [];
  }

  async function getDataflowDatasources(workspaceId, dataflowId) {
    try {
      const data = await safeRequest(
        await apiClient(),
        `/groups/${workspaceId}/dataflows/${dataflowId}/datasources`
      );
      return data.value || [];
    } catch {
      return [];
    }
  }

  async function getWorkspaceUsers(workspaceId) {
    const data = await safeRequest(await apiClient(), `/groups/${workspaceId}/users`);
    return data.value || [];
  }

  async function scanWorkspaces(workspaceIds) {
    const client = await adminClient();
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
    return safeRequest(await adminClient(), `/workspaces/scanStatus/${scanId}`);
  }

  async function getScanResult(scanId) {
    return safeRequest(await adminClient(), `/workspaces/scanResult/${scanId}`);
  }

  async function getCapacities() {
    try {
      const data = await safeRequest(await apiClient(), '/capacities');
      return data.value || [];
    } catch {
      return [];
    }
  }

  async function getAppsAdmin({ top = 1000 } = {}) {
    try {
      const data = await safeRequest(await adminClient(), '/apps', { $top: top });
      return data.value || [];
    } catch {
      return [];
    }
  }

  return {
    getWorkspaces,
    getWorkspaceById,
    getReports,
    getReportsAdmin,
    getDatasets,
    getDatasetsAdmin,
    getDatasetRefreshHistory,
    getDatasetDatasources,
    getDatasetParameters,
    getDashboards,
    getDashboardTiles,
    getDataflows,
    getDataflowDatasources,
    getWorkspaceUsers,
    scanWorkspaces,
    getScanStatus,
    getScanResult,
    getCapacities,
    getAppsAdmin,
  };
}

module.exports = { createPowerBIService };
