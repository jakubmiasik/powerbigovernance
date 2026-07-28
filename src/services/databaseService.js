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

function isColumnMissingError(err, columnName) {
  return !!(err && err.message && err.message.includes(`Invalid column name '${columnName}'`));
}

// Service Principals CRUD
async function getServicePrincipals() {
  const conn = await getConnection();
  try {
    return await execSql(conn, 'SELECT id, name, tenant_id, client_id, client_secret, enterprise_app_object_id, key_vault_name, key_vault_secret_name, created_at, updated_at FROM service_principals ORDER BY name');
  } finally {
    conn.close();
  }
}

async function getServicePrincipalById(id) {
  const conn = await getConnection();
  try {
    const rows = await execSql(conn, 'SELECT id, name, tenant_id, client_id, client_secret, enterprise_app_object_id, key_vault_name, key_vault_secret_name FROM service_principals WHERE id = @id', [
      { name: 'id', type: TYPES.Int, value: id },
    ]);
    return rows[0] || null;
  } finally {
    conn.close();
  }
}

async function saveServicePrincipal({ id, name, tenantId, clientId, clientSecret, enterpriseAppObjectId, keyVaultName, keyVaultSecretName }) {
  const conn = await getConnection();
  try {
    if (id) {
      await execSql(
        conn,
        `UPDATE service_principals SET name=@name, tenant_id=@tenantId, client_id=@clientId, client_secret=@clientSecret, enterprise_app_object_id=@eaoid, key_vault_name=@kvName, key_vault_secret_name=@kvSecret, updated_at=GETUTCDATE() WHERE id=@id`,
        [
          { name: 'id', type: TYPES.Int, value: id },
          { name: 'name', type: TYPES.NVarChar, value: name },
          { name: 'tenantId', type: TYPES.NVarChar, value: tenantId },
          { name: 'clientId', type: TYPES.NVarChar, value: clientId },
          { name: 'clientSecret', type: TYPES.NVarChar, value: clientSecret || null },
          { name: 'eaoid', type: TYPES.NVarChar, value: enterpriseAppObjectId || null },
          { name: 'kvName', type: TYPES.NVarChar, value: keyVaultName || null },
          { name: 'kvSecret', type: TYPES.NVarChar, value: keyVaultSecretName || null },
        ]
      );
    } else {
      await execSql(
        conn,
        `INSERT INTO service_principals (name, tenant_id, client_id, client_secret, enterprise_app_object_id, key_vault_name, key_vault_secret_name) VALUES (@name, @tenantId, @clientId, @clientSecret, @eaoid, @kvName, @kvSecret)`,
        [
          { name: 'name', type: TYPES.NVarChar, value: name },
          { name: 'tenantId', type: TYPES.NVarChar, value: tenantId },
          { name: 'clientId', type: TYPES.NVarChar, value: clientId },
          { name: 'clientSecret', type: TYPES.NVarChar, value: clientSecret || null },
          { name: 'eaoid', type: TYPES.NVarChar, value: enterpriseAppObjectId || null },
          { name: 'kvName', type: TYPES.NVarChar, value: keyVaultName || null },
          { name: 'kvSecret', type: TYPES.NVarChar, value: keyVaultSecretName || null },
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
      // sp_id is nullable — pass NULL when using Managed Identity
      `INSERT INTO analysis_runs (sp_name, tenant_id, run_by) OUTPUT INSERTED.id VALUES (@spName, @tenantId, @runBy)`,
      [
        { name: 'spName', type: TYPES.NVarChar, value: spName },
        { name: 'tenantId', type: TYPES.NVarChar, value: tenantId },
        { name: 'runBy', type: TYPES.NVarChar, value: runBy },
      ]
    );
    return rows[0] ? rows[0].id : null;
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
    return await execSql(conn, 'SELECT id, sp_id, sp_name, tenant_id, status, total_workspaces, total_reports, total_datasets, total_dashboards, total_dataflows, total_users, started_at, completed_at, run_by FROM analysis_runs ORDER BY started_at DESC');
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

// Capacity Schedules
async function getCapacitySchedules() {
  const conn = await getConnection();
  try {
    return await execSql(conn, 'SELECT * FROM capacity_schedules ORDER BY capacity_name, action');
  } catch (err) {
    // Table may not exist yet
    if (err.message && err.message.includes('Invalid object name')) return [];
    throw err;
  } finally {
    conn.close();
  }
}

async function saveCapacitySchedule(schedule) {
  const conn = await getConnection();
  try {
    const baseParams = [
      { name: 'name', type: TYPES.NVarChar, value: schedule.capacityName },
      { name: 'sub', type: TYPES.NVarChar, value: schedule.subscriptionId },
      { name: 'rg', type: TYPES.NVarChar, value: schedule.resourceGroup },
      { name: 'action', type: TYPES.NVarChar, value: schedule.action },
      { name: 'type', type: TYPES.NVarChar, value: schedule.scheduleType },
      { name: 'hour', type: TYPES.Int, value: schedule.hour != null ? schedule.hour : null },
      { name: 'minute', type: TYPES.Int, value: schedule.minute != null ? schedule.minute : null },
      { name: 'day', type: TYPES.NVarChar, value: schedule.day || null },
      { name: 'enabled', type: TYPES.Bit, value: schedule.enabled !== false },
      { name: 'tz', type: TYPES.NVarChar, value: schedule.timezone || 'UTC' },
    ];
    try {
      await execSql(conn, `INSERT INTO capacity_schedules (capacity_name, subscription_id, resource_group, action, schedule_type, schedule_hour, schedule_minute, schedule_day, enabled, timezone, sp_id)
        VALUES (@name, @sub, @rg, @action, @type, @hour, @minute, @day, @enabled, @tz, @spId)`, [
        ...baseParams,
        { name: 'spId', type: TYPES.Int, value: schedule.spId != null ? schedule.spId : null },
      ]);
    } catch (err) {
      if (isColumnMissingError(err, 'sp_id') || isColumnMissingError(err, 'spd_id')) {
        await execSql(conn, `INSERT INTO capacity_schedules (capacity_name, subscription_id, resource_group, action, schedule_type, schedule_hour, schedule_minute, schedule_day, enabled, timezone)
          VALUES (@name, @sub, @rg, @action, @type, @hour, @minute, @day, @enabled, @tz)`, baseParams);
      } else {
        throw err;
      }
    }
  } finally {
    conn.close();
  }
}

async function deleteCapacitySchedule(id) {
  const conn = await getConnection();
  try {
    await execSql(conn, 'DELETE FROM capacity_schedules WHERE id=@id', [
      { name: 'id', type: TYPES.Int, value: id },
    ]);
  } finally {
    conn.close();
  }
}

async function toggleCapacitySchedule(id, enabled) {
  const conn = await getConnection();
  try {
    await execSql(conn, 'UPDATE capacity_schedules SET enabled=@enabled WHERE id=@id', [
      { name: 'id', type: TYPES.Int, value: id },
      { name: 'enabled', type: TYPES.Bit, value: enabled },
    ]);
  } finally {
    conn.close();
  }
}

async function updateCapacitySchedule(id, fields) {
  const conn = await getConnection();
  try {
    const sets = [];
    const params = [{ name: 'id', type: TYPES.Int, value: id }];
    if (fields.action !== undefined) { sets.push('action=@action'); params.push({ name: 'action', type: TYPES.NVarChar, value: fields.action }); }
    if (fields.scheduleType !== undefined) { sets.push('schedule_type=@type'); params.push({ name: 'type', type: TYPES.NVarChar, value: fields.scheduleType }); }
    if (fields.hour !== undefined) { sets.push('schedule_hour=@hour'); params.push({ name: 'hour', type: TYPES.Int, value: fields.hour }); }
    if (fields.minute !== undefined) { sets.push('schedule_minute=@minute'); params.push({ name: 'minute', type: TYPES.Int, value: fields.minute }); }
    if (fields.day !== undefined) { sets.push('schedule_day=@day'); params.push({ name: 'day', type: TYPES.NVarChar, value: fields.day }); }
    if (fields.timezone !== undefined) { sets.push('timezone=@tz'); params.push({ name: 'tz', type: TYPES.NVarChar, value: fields.timezone }); }
    if (sets.length === 0) return;
    const baseSets = sets.slice();
    const baseParams = params.slice();
    if (fields.spId !== undefined) { sets.push('sp_id=@spId'); params.push({ name: 'spId', type: TYPES.Int, value: fields.spId }); }
    try {
      await execSql(conn, 'UPDATE capacity_schedules SET ' + sets.join(', ') + ' WHERE id=@id', params);
    } catch (err) {
      if ((isColumnMissingError(err, 'sp_id') || isColumnMissingError(err, 'spd_id')) && fields.spId !== undefined) {
        await execSql(conn, 'UPDATE capacity_schedules SET ' + baseSets.join(', ') + ' WHERE id=@id', baseParams);
      } else {
        throw err;
      }
    }
  } finally {
    conn.close();
  }
}

// Schedule execution history
async function logScheduleExecution(scheduleId, capacityName, action, status, message) {
  const conn = await getConnection();
  try {
    await execSql(conn, `INSERT INTO capacity_schedule_history (schedule_id, capacity_name, action, status, message, executed_at)
      VALUES (@sid, @name, @action, @status, @msg, GETUTCDATE())`, [
      { name: 'sid', type: TYPES.Int, value: scheduleId },
      { name: 'name', type: TYPES.NVarChar, value: capacityName },
      { name: 'action', type: TYPES.NVarChar, value: action },
      { name: 'status', type: TYPES.NVarChar, value: status },
      { name: 'msg', type: TYPES.NVarChar, value: message || null },
    ]);
  } catch (err) {
    if (err.message && err.message.includes('Invalid object name')) {
      console.warn('[DB] capacity_schedule_history table not found, skipping log');
    } else {
      console.error('[DB] Error logging schedule execution:', err.message);
    }
  } finally {
    conn.close();
  }
}

async function getScheduleHistory(capacityName, days) {
  days = days || 5;
  const conn = await getConnection();
  try {
    return await execSql(conn,
      `SELECT TOP 50 * FROM capacity_schedule_history
       WHERE capacity_name=@name AND executed_at >= DATEADD(day, -@days, GETUTCDATE())
       ORDER BY executed_at DESC`,
      [
        { name: 'name', type: TYPES.NVarChar, value: capacityName },
        { name: 'days', type: TYPES.Int, value: days },
      ]);
  } catch (err) {
    if (err.message && err.message.includes('Invalid object name')) return [];
    throw err;
  } finally {
    conn.close();
  }
}

async function getLastScheduleExecutions() {
  const conn = await getConnection();
  try {
    return await execSql(
      conn,
      `SELECT schedule_id, MAX(executed_at) AS last_executed_at
       FROM capacity_schedule_history
       GROUP BY schedule_id`
    );
  } catch (err) {
    if (err.message && (err.message.includes('Invalid object name') || err.message.includes('Invalid column name'))) return [];
    throw err;
  } finally {
    conn.close();
  }
}

// Auto-migration: ensure schema is up to date
async function runMigrations() {
  const conn = await getConnection();
  try {
    // Create capacity schedules table if missing
    await execSql(conn, `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U')
      BEGIN
        CREATE TABLE capacity_schedules (
          id INT IDENTITY(1,1) PRIMARY KEY,
          capacity_name NVARCHAR(255) NOT NULL,
          subscription_id NVARCHAR(100) NOT NULL,
          resource_group NVARCHAR(255) NOT NULL,
          action NVARCHAR(20) NOT NULL,
          schedule_type NVARCHAR(20) NOT NULL,
          schedule_hour INT NULL,
          schedule_minute INT NULL,
          schedule_day NVARCHAR(20) NULL,
          enabled BIT NOT NULL DEFAULT 1,
          timezone NVARCHAR(100) NULL,
          sp_id INT NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        )
      END
    `);

    // Create capacity schedule history table if missing
    await execSql(conn, `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedule_history') AND type = 'U')
      BEGIN
        CREATE TABLE capacity_schedule_history (
          id INT IDENTITY(1,1) PRIMARY KEY,
          schedule_id INT NULL,
          capacity_name NVARCHAR(255) NOT NULL,
          action NVARCHAR(20) NOT NULL,
          status NVARCHAR(20) NOT NULL,
          message NVARCHAR(2000) NULL,
          executed_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_capacity_schedule_history_capacity_time
          ON capacity_schedule_history (capacity_name, executed_at DESC);
        CREATE INDEX IX_capacity_schedule_history_schedule_time
          ON capacity_schedule_history (schedule_id, executed_at DESC);
      END
    `);
    // Backward compatibility: add missing schedule_id to older history tables
    await execSql(conn, `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedule_history') AND type = 'U')
      AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedule_history') AND name = N'schedule_id')
      BEGIN
        ALTER TABLE capacity_schedule_history ADD schedule_id INT NULL;
        CREATE INDEX IX_capacity_schedule_history_schedule_time
          ON capacity_schedule_history (schedule_id, executed_at DESC);
      END
    `);

    // Add enterprise_app_object_id column if missing
    await execSql(conn, `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'service_principals') AND name = N'enterprise_app_object_id') ALTER TABLE service_principals ADD enterprise_app_object_id NVARCHAR(255) NULL`);
    // Add timezone column to capacity_schedules if missing
    await execSql(conn, `IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U') AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'timezone') ALTER TABLE capacity_schedules ADD timezone NVARCHAR(100) NULL`);
    // Add service principal reference to schedules if missing
    await execSql(conn, `IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U') AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'sp_id') ALTER TABLE capacity_schedules ADD sp_id INT NULL`);
    // If legacy typo column exists, copy values into sp_id
    await execSql(conn, `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U')
      AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'spd_id')
      AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'sp_id')
      BEGIN
        UPDATE capacity_schedules SET sp_id = COALESCE(sp_id, spd_id) WHERE spd_id IS NOT NULL;
      END
    `);
    // Add Key Vault columns to service_principals if missing
    await execSql(conn, `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'service_principals') AND name = N'key_vault_name') ALTER TABLE service_principals ADD key_vault_name NVARCHAR(255) NULL`);
    await execSql(conn, `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'service_principals') AND name = N'key_vault_secret_name') ALTER TABLE service_principals ADD key_vault_secret_name NVARCHAR(255) NULL`);
    // Make client_secret nullable (it may already be)
    await execSql(conn, `IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'service_principals') AND name = N'client_secret' AND is_nullable = 0) ALTER TABLE service_principals ALTER COLUMN client_secret NVARCHAR(MAX) NULL`).catch(() => {});
    console.log('[DB] Migrations complete.');
  } catch (err) {
    console.warn('[DB] Migration warning:', err.message);
  } finally {
    conn.close();
  }
}

module.exports = {
  runMigrations,
  getServicePrincipals,
  getServicePrincipalById,
  saveServicePrincipal,
  deleteServicePrincipal,
  createAnalysisRun,
  updateAnalysisRun,
  getAnalysisRuns,
  getAnalysisRunById,
  deleteAnalysisRun,
  getCapacitySchedules,
  saveCapacitySchedule,
  updateCapacitySchedule,
  deleteCapacitySchedule,
  toggleCapacitySchedule,
  logScheduleExecution,
  getScheduleHistory,
  getLastScheduleExecutions,
};
