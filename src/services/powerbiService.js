const axios = require('axios');
const { getAccessToken } = require('./authService');

const BASE_URL = 'https://api.powerbi.com/v1.0/myorg';
const ADMIN_URL = `${BASE_URL}/admin`;

async function apiClient() {
  const token = await getAccessToken();
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });
}

async function adminClient() {
  const token = await getAccessToken();
  return axios.create({
    baseURL: ADMIN_URL,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 60000,
  });
}

async function safeRequest(clientPromise, url, params = {}) {
  try {
    const client = await clientPromise;
    const response = await client.get(url, { params });
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.error?.message || err.message;
    throw new Error(`Power BI API error (${status || 'unknown'}): ${message}`);
  }
}

// ── Workspaces ──────────────────────────────────────────────────────────────

async function getWorkspaces({ useAdmin = false, top = 1000, filter = '' } = {}) {
  const params = { $top: top };
  if (filter) params.$filter = filter;

  if (useAdmin) {
    const data = await safeRequest(adminClient(), '/groups', params);
    return data.value || [];
  }
  const data = await safeRequest(apiClient(), '/groups', params);
  return data.value || [];
}

async function getWorkspaceById(workspaceId) {
  const data = await safeRequest(apiClient(), `/groups/${workspaceId}`);
  return data;
}

// ── Reports ─────────────────────────────────────────────────────────────────

async function getReports(workspaceId) {
  const data = await safeRequest(apiClient(), `/groups/${workspaceId}/reports`);
  return data.value || [];
}

async function getReportsAdmin({ top = 5000 } = {}) {
  const data = await safeRequest(adminClient(), '/reports', { $top: top });
  return data.value || [];
}

// ── Datasets ────────────────────────────────────────────────────────────────

async function getDatasets(workspaceId) {
  const data = await safeRequest(apiClient(), `/groups/${workspaceId}/datasets`);
  return data.value || [];
}

async function getDatasetsAdmin({ top = 5000 } = {}) {
  const data = await safeRequest(adminClient(), '/datasets', { $top: top });
  return data.value || [];
}

async function getDatasetRefreshHistory(workspaceId, datasetId, top = 20) {
  const data = await safeRequest(
    apiClient(),
    `/groups/${workspaceId}/datasets/${datasetId}/refreshes`,
    { $top: top }
  );
  return data.value || [];
}

async function getDatasetDatasources(workspaceId, datasetId) {
  const data = await safeRequest(
    apiClient(),
    `/groups/${workspaceId}/datasets/${datasetId}/datasources`
  );
  return data.value || [];
}

async function getDatasetParameters(workspaceId, datasetId) {
  try {
    const data = await safeRequest(
      apiClient(),
      `/groups/${workspaceId}/datasets/${datasetId}/parameters`
    );
    return data.value || [];
  } catch {
    return [];
  }
}

// ── Dashboards ──────────────────────────────────────────────────────────────

async function getDashboards(workspaceId) {
  const data = await safeRequest(apiClient(), `/groups/${workspaceId}/dashboards`);
  return data.value || [];
}

async function getDashboardTiles(workspaceId, dashboardId) {
  const data = await safeRequest(
    apiClient(),
    `/groups/${workspaceId}/dashboards/${dashboardId}/tiles`
  );
  return data.value || [];
}

// ── Dataflows ───────────────────────────────────────────────────────────────

async function getDataflows(workspaceId) {
  const data = await safeRequest(apiClient(), `/groups/${workspaceId}/dataflows`);
  return data.value || [];
}

async function getDataflowDatasources(workspaceId, dataflowId) {
  try {
    const data = await safeRequest(
      apiClient(),
      `/groups/${workspaceId}/dataflows/${dataflowId}/datasources`
    );
    return data.value || [];
  } catch {
    return [];
  }
}

// ── Users / Access ──────────────────────────────────────────────────────────

async function getWorkspaceUsers(workspaceId) {
  const data = await safeRequest(apiClient(), `/groups/${workspaceId}/users`);
  return data.value || [];
}

// ── Admin: Workspace scan (detailed metadata) ───────────────────────────────

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
  const data = await safeRequest(adminClient(), `/workspaces/scanStatus/${scanId}`);
  return data;
}

async function getScanResult(scanId) {
  const data = await safeRequest(adminClient(), `/workspaces/scanResult/${scanId}`);
  return data;
}

// ── Capacities ──────────────────────────────────────────────────────────────

async function getCapacities() {
  try {
    const data = await safeRequest(apiClient(), '/capacities');
    return data.value || [];
  } catch {
    return [];
  }
}

// ── Apps ─────────────────────────────────────────────────────────────────────

async function getAppsAdmin({ top = 1000 } = {}) {
  try {
    const data = await safeRequest(adminClient(), '/apps', { $top: top });
    return data.value || [];
  } catch {
    return [];
  }
}

module.exports = {
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
