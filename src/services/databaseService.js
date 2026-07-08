const { Connection, Request, TYPES } = require('tedious');
const { DefaultAzureCredential } = require('@azure/identity');

const SQL_SERVER = process.env.SQL_SERVER || 'sql-ydpx5q.database.windows.net';
const SQL_DATABASE = process.env.SQL_DATABASE || 'pbigovernance';

let tokenCache = { token: null, expiresOn: null };

async function getToken() {
  if (tokenCache.token && tokenCache.expiresOn && new Date() < new Date(tokenCache.expiresOn - 300000)) {
    return tokenCache.token;
  }
  const credential = new DefaultAzureCredential();
  const response = await credential.getToken('https://database.windows.net/.default');
  tokenCache = { token: response.token, expiresOn: response.expiresOnTimestamp };
  return response.token;
}

function getConnection() {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getToken();
      const config = {
        server: SQL_SERVER,
        authentication: {
          type: 'azure-active-directory-access-token',
          options: { token },
        },
        options: {
          database: SQL_DATABASE,
          encrypt: true,
          trustServerCertificate: false,
          requestTimeout: 30000,
        },
      };
      const conn = new Connection(config);
      conn.on('connect', (err) => {
        if (err) reject(err);
        else resolve(conn);
      });
      conn.connect();
    } catch (err) {
      reject(err);
    }
  });
}

function execSql(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const request = new Request(sql, (err, rowCount) => {
      if (err) reject(err);
      else resolve(rows);
    });
    for (const p of params) {
      request.addParameter(p.name, p.type, p.value);
    }
    request.on('row', (columns) => {
      const row = {};
      columns.forEach((col) => {
        row[col.metadata.colName] = col.value;
      });
      rows.push(row);
    });
    conn.execSql(request);
  });
}

// Service Principals CRUD
async function getServicePrincipals() {
  const conn = await getConnection();
  try {
    return await execSql(conn, 'SELECT id, name, tenant_id, client_id, client_secret, created_at, updated_at FROM service_principals ORDER BY name');
  } finally {
    conn.close();
  }
}

async function getServicePrincipalById(id) {
  const conn = await getConnection();
  try {
    const rows = await execSql(conn, 'SELECT id, name, tenant_id, client_id, client_secret FROM service_principals WHERE id = @id', [
      { name: 'id', type: TYPES.Int, value: id },
    ]);
    return rows[0] || null;
  } finally {
    conn.close();
  }
}

async function saveServicePrincipal({ id, name, tenantId, clientId, clientSecret }) {
  const conn = await getConnection();
  try {
    if (id) {
      await execSql(
        conn,
        `UPDATE service_principals SET name=@name, tenant_id=@tenantId, client_id=@clientId, client_secret=@clientSecret, updated_at=GETUTCDATE() WHERE id=@id`,
        [
          { name: 'id', type: TYPES.Int, value: id },
          { name: 'name', type: TYPES.NVarChar, value: name },
          { name: 'tenantId', type: TYPES.NVarChar, value: tenantId },
          { name: 'clientId', type: TYPES.NVarChar, value: clientId },
          { name: 'clientSecret', type: TYPES.NVarChar, value: clientSecret },
        ]
      );
    } else {
      await execSql(
        conn,
        `INSERT INTO service_principals (name, tenant_id, client_id, client_secret) VALUES (@name, @tenantId, @clientId, @clientSecret)`,
        [
          { name: 'name', type: TYPES.NVarChar, value: name },
          { name: 'tenantId', type: TYPES.NVarChar, value: tenantId },
          { name: 'clientId', type: TYPES.NVarChar, value: clientId },
          { name: 'clientSecret', type: TYPES.NVarChar, value: clientSecret },
        ]
      );
    }
  } finally {
    conn.close();
  }
}

async function deleteServicePrincipal(id) {
  const conn = await getConnection();
  try {
    await execSql(conn, 'DELETE FROM service_principals WHERE id=@id', [
      { name: 'id', type: TYPES.Int, value: id },
    ]);
  } finally {
    conn.close();
  }
}

// Analysis runs
async function createAnalysisRun({ spId, spName, tenantId, runBy }) {
  const conn = await getConnection();
  try {
    const rows = await execSql(
      conn,
      `INSERT INTO analysis_runs (sp_id, sp_name, tenant_id, run_by) OUTPUT INSERTED.id VALUES (@spId, @spName, @tenantId, @runBy)`,
      [
        { name: 'spId', type: TYPES.Int, value: spId },
        { name: 'spName', type: TYPES.NVarChar, value: spName },
        { name: 'tenantId', type: TYPES.NVarChar, value: tenantId },
        { name: 'runBy', type: TYPES.NVarChar, value: runBy },
      ]
    );
    return rows[0]?.id;
  } finally {
    conn.close();
  }
}

async function updateAnalysisRun(id, data) {
  const conn = await getConnection();
  try {
    await execSql(
      conn,
      `UPDATE analysis_runs SET status=@status, total_workspaces=@tw, total_reports=@tr, total_datasets=@td, total_dashboards=@tda, total_dataflows=@tdf, total_users=@tu, results_json=@results, completed_at=GETUTCDATE() WHERE id=@id`,
      [
        { name: 'id', type: TYPES.Int, value: id },
        { name: 'status', type: TYPES.NVarChar, value: data.status },
        { name: 'tw', type: TYPES.Int, value: data.totalWorkspaces || 0 },
        { name: 'tr', type: TYPES.Int, value: data.totalReports || 0 },
        { name: 'td', type: TYPES.Int, value: data.totalDatasets || 0 },
        { name: 'tda', type: TYPES.Int, value: data.totalDashboards || 0 },
        { name: 'tdf', type: TYPES.Int, value: data.totalDataflows || 0 },
        { name: 'tu', type: TYPES.Int, value: data.totalUsers || 0 },
        { name: 'results', type: TYPES.NVarChar, value: data.resultsJson },
      ]
    );
  } finally {
    conn.close();
  }
}

async function getAnalysisRuns() {
  const conn = await getConnection();
  try {
    return await execSql(conn, 'SELECT id, sp_name, tenant_id, status, total_workspaces, total_reports, total_datasets, total_dashboards, total_dataflows, total_users, started_at, completed_at, run_by FROM analysis_runs ORDER BY started_at DESC');
  } finally {
    conn.close();
  }
}

async function getAnalysisRunById(id) {
  const conn = await getConnection();
  try {
    const rows = await execSql(conn, 'SELECT * FROM analysis_runs WHERE id=@id', [
      { name: 'id', type: TYPES.Int, value: id },
    ]);
    return rows[0] || null;
  } finally {
    conn.close();
  }
}

async function deleteAnalysisRun(id) {
  const conn = await getConnection();
  try {
    await execSql(conn, 'DELETE FROM analysis_runs WHERE id=@id', [
      { name: 'id', type: TYPES.Int, value: id },
    ]);
  } finally {
    conn.close();
  }
}

module.exports = {
  getServicePrincipals,
  getServicePrincipalById,
  saveServicePrincipal,
  deleteServicePrincipal,
  createAnalysisRun,
  updateAnalysisRun,
  getAnalysisRuns,
  getAnalysisRunById,
  deleteAnalysisRun,
};
