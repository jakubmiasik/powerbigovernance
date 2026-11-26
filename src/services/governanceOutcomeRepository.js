/**
 * Read-only data access for the Governance Outcome.
 *
 * Rules this module keeps, and that its tests check by reading its own source:
 * - SELECT only: no INSERT, UPDATE, DELETE, MERGE or DDL.
 * - Five tables only: analysis_runs, analysis_run_totals, analysis_workspaces,
 *   analysis_workspace_users, workspace_states. Never the table that holds
 *   service principal credentials.
 * - Every value is a parameter. Nothing from a request is concatenated into SQL.
 * - Every query is tied to @TenantId, directly or through analysis_runs, so one
 *   tenant's numbers can never be mixed into another's.
 * - Names and e-mail addresses of people are never read.
 */

const { Connection, TYPES } = require('tedious');
const { getConfig } = require('../config/settings');
const { _sql } = require('./databaseService');

let readerCredential = null;
let readerToken = { token: null, expiresOn: 0 };

/** Which database principal the outcome reads with, for the page to state. */
function connectionMode(config = getConfig()) {
  const g = (config.governance && config.governance.sql) || {};
  if (g.user && g.password) return 'sql-login';
  if (g.clientId) return 'managed-identity';
  return 'application';
}

async function readerAccessToken(clientId) {
  if (readerToken.token && Date.now() < readerToken.expiresOn - 300000) return readerToken.token;
  if (!readerCredential) {
    const { DefaultAzureCredential } = require('@azure/identity');
    readerCredential = new DefaultAzureCredential({ managedIdentityClientId: clientId });
  }
  const response = await readerCredential.getToken('https://database.windows.net/.default');
  readerToken = { token: response.token, expiresOn: response.expiresOnTimestamp };
  return response.token;
}

function openConnection() {
  const config = getConfig();
  const mode = connectionMode(config);
  if (mode === 'application') return _sql.getConnection();

  const g = config.governance.sql;
  const server = g.server || config.sql.server;
  const database = g.database || config.sql.database;
  return new Promise(async (resolve, reject) => {
    try {
      if (!server || !database) throw new Error('GOVERNANCE_SQL_SERVER/SQL_SERVER and GOVERNANCE_SQL_DATABASE/SQL_DATABASE must be configured.');
      const authentication = mode === 'sql-login'
        ? { type: 'default', options: { userName: g.user, password: g.password } }
        : { type: 'azure-active-directory-access-token', options: { token: await readerAccessToken(g.clientId) } };
      const conn = new Connection({
        server,
        authentication,
        options: { database, encrypt: true, trustServerCertificate: false, requestTimeout: 30000, readOnlyIntent: true },
      });
      conn.on('connect', err => (err ? reject(err) : resolve(conn)));
      conn.connect();
    } catch (err) {
      reject(err);
    }
  });
}

const tenantParam = tenantId => ({ name: 'TenantId', type: TYPES.NVarChar, value: tenantId });
const runParam = runId => ({ name: 'RunId', type: TYPES.Int, value: runId });

// The spec's queries, with one addition to Q3–Q5: a guard that the run belongs to
// the tenant, so a run id can never pull another tenant's workspaces even if a
// caller passed the wrong one.
const RUN_BELONGS_TO_TENANT = 'EXISTS (SELECT 1 FROM dbo.analysis_runs AS g WHERE g.id = @RunId AND g.tenant_id = @TenantId)';
const SAME_PRINCIPAL = '(r.sp_id = @SpId OR (r.sp_id IS NULL AND @SpId IS NULL))';

const SQL = {
  latestRun: `
SELECT TOP (1) r.id AS run_id, r.sp_id, r.sp_run_number, r.tenant_id, r.sp_name, r.status,
       r.started_at, r.completed_at, r.run_by, r.scope_kind
FROM dbo.analysis_runs AS r
WHERE r.tenant_id = @TenantId AND r.status = N'completed' AND r.scope_kind = N'tenant'
ORDER BY r.completed_at DESC;`,

  totals: `
SELECT t.total_workspaces, t.total_items, t.total_reports, t.total_datasets,
       t.total_dashboards, t.total_dataflows, t.total_lakehouses, t.total_notebooks,
       t.total_pipelines, t.total_warehouses, t.total_users, t.creator_count,
       t.explorer_count, t.capacity_count, t.workspaces_on_capacity,
       t.workspaces_on_shared_capacity, t.total_storage_size, t.total_storage_files,
       t.storage_scanned_count, t.tenant_settings_total, t.tenant_settings_enabled,
       t.tenant_settings_disabled, t.tenant_settings_group_scoped,
       t.tenant_settings_delegated, t.captured_at
FROM dbo.analysis_run_totals AS t
WHERE t.run_id = @RunId AND t.tenant_id = @TenantId;`,

  workspacesByType: `
SELECT w.type, COUNT(DISTINCT w.workspace_id) AS workspaces
FROM dbo.analysis_workspaces AS w
WHERE w.run_id = @RunId AND ${RUN_BELONGS_TO_TENANT}
GROUP BY w.type;`,

  skuDistribution: `
SELECT COALESCE(w.capacity_sku, N'(not recorded)') AS sku,
       COUNT(DISTINCT w.workspace_id) AS workspaces,
       SUM(w.item_count) AS items,
       CAST(100.0 * SUM(w.item_count) / NULLIF(SUM(SUM(w.item_count)) OVER (), 0) AS decimal(5,1)) AS pct_items
FROM dbo.analysis_workspaces AS w
WHERE w.run_id = @RunId AND w.type = N'Workspace' AND ${RUN_BELONGS_TO_TENANT}
GROUP BY COALESCE(w.capacity_sku, N'(not recorded)');`,

  workspaceFlags: `
SELECT w.workspace_id, w.name, w.capacity_sku, w.item_count, w.user_count,
  CASE WHEN NULLIF(LTRIM(RTRIM(w.description)), N'') IS NULL THEN 1 ELSE 0 END AS no_description,
  CASE WHEN w.pipeline_name IS NULL THEN 1 ELSE 0 END AS no_pipeline,
  CASE WHEN w.item_count = 0 THEN 1 ELSE 0 END AS is_empty,
  CASE WHEN w.user_count = 1 THEN 1 ELSE 0 END AS single_principal,
  CASE WHEN w.capacity_sku IS NULL THEN 1 ELSE 0 END AS no_sku,
  CASE WHEN w.name LIKE N'Microsoft Fabric Capacity Metrics%' THEN 1 ELSE 0 END AS is_capacity_metrics
FROM dbo.analysis_workspaces AS w
WHERE w.run_id = @RunId AND w.type = N'Workspace' AND ${RUN_BELONGS_TO_TENANT}
ORDER BY w.item_count DESC;`,

  // Q6, in two statements so the access run's date can be returned even when it
  // has rows to group, and its absence can be told apart from an empty result.
  // Scans are identified by principal and that principal's number, so the fallback
  // is the same principal's latest scan with access data, by number.
  accessRun: `
SELECT TOP (1) r.id AS access_run_id, r.sp_id, r.sp_name, r.sp_run_number, r.completed_at AS access_completed_at
FROM dbo.analysis_runs AS r
WHERE r.tenant_id = @TenantId AND r.status = N'completed' AND r.scope_kind = N'tenant'
  AND ${SAME_PRINCIPAL}
  AND EXISTS (SELECT 1 FROM dbo.analysis_workspace_users AS u WHERE u.run_id = r.id)
ORDER BY r.sp_run_number DESC, r.completed_at DESC;`,

  accessSummary: `
SELECT u.principal_type, u.access_right,
       COUNT(*) AS assignments, COUNT(DISTINCT u.principal_id) AS distinct_principals
FROM dbo.analysis_workspace_users AS u
WHERE u.run_id = @AccessRunId
  AND EXISTS (SELECT 1 FROM dbo.analysis_runs AS g WHERE g.id = @AccessRunId AND g.tenant_id = @TenantId)
GROUP BY u.principal_type, u.access_right;`,

  // Q7 within the latest scan's principal, in that principal's scan order: a
  // change is only measured between two scans of the same principal.
  trend: `
SELECT r.id AS run_id, r.sp_id, r.sp_name, r.sp_run_number, r.completed_at, t.total_workspaces, t.total_items,
       t.total_warehouses, t.total_notebooks, t.total_pipelines, t.tenant_settings_total
FROM dbo.analysis_runs AS r
JOIN dbo.analysis_run_totals AS t ON t.run_id = r.id
WHERE r.tenant_id = @TenantId AND r.status = N'completed' AND r.scope_kind = N'tenant'
  AND ${SAME_PRINCIPAL}
ORDER BY r.sp_run_number, r.completed_at;`,

  deletions: `
SELECT s.workspace_name, s.state, s.deleted_at, s.run_id, r.sp_id, r.sp_name, r.sp_run_number
FROM dbo.workspace_states AS s
JOIN dbo.analysis_runs AS r ON r.id = s.run_id
WHERE r.tenant_id = @TenantId AND s.state = N'Deleted'
ORDER BY s.deleted_at DESC;`,
};

async function withConnection(fn) {
  const conn = await openConnection();
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

/** Q1 only: cheap, and enough to know whether a cached outcome is still current. */
async function latestRun(tenantId) {
  return withConnection(async conn => {
    const rows = await _sql.execSql(conn, SQL.latestRun, [tenantParam(tenantId)]);
    return rows[0] || null;
  });
}

/**
 * Q2–Q8 for one scan of one tenant, on one connection. `run` is Q1's row: its id
 * is only the join key; its principal decides which scans the access fallback and
 * the trend may use.
 */
async function readOutcomeData(tenantId, latest) {
  const runId = latest.run_id;
  const spParam = { name: 'SpId', type: TYPES.Int, value: latest.sp_id === null || latest.sp_id === undefined ? null : Number(latest.sp_id) };
  return withConnection(async conn => {
    const run = [tenantParam(tenantId), runParam(runId)];
    const totals = (await _sql.execSql(conn, SQL.totals, run))[0] || null;
    const workspacesByType = await _sql.execSql(conn, SQL.workspacesByType, run);
    const skus = await _sql.execSql(conn, SQL.skuDistribution, run);
    const workspaces = await _sql.execSql(conn, SQL.workspaceFlags, run);
    const accessRun = (await _sql.execSql(conn, SQL.accessRun, [tenantParam(tenantId), spParam]))[0] || null;
    const access = accessRun
      ? await _sql.execSql(conn, SQL.accessSummary, [tenantParam(tenantId), { name: 'AccessRunId', type: TYPES.Int, value: accessRun.access_run_id }])
      : [];
    const trend = await _sql.execSql(conn, SQL.trend, [tenantParam(tenantId), spParam]);
    const deletions = await _sql.execSql(conn, SQL.deletions, [tenantParam(tenantId)]);
    return { totals, workspacesByType, skus, workspaces, accessRun, access, trend, deletions };
  });
}

module.exports = { SQL, connectionMode, latestRun, readOutcomeData };
