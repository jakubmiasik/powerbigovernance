const { Connection, Request, TYPES } = require('tedious');
const { DefaultAzureCredential } = require('@azure/identity');
const { convertScheduleToUtc, normalizeTimezone } = require('./scheduleTimeService');
const { METRIC_DEFS } = require('./runMetricsService');
const { getConfig } = require('../config/settings');

const cfg = getConfig();
const SQL_SERVER = cfg.sql.server;
const SQL_DATABASE = cfg.sql.database;

let tokenCache = { token: null, expiresOn: null };
const credential = new DefaultAzureCredential();

async function getToken() {
  if (tokenCache.token && tokenCache.expiresOn && new Date() < new Date(tokenCache.expiresOn - 300000)) {
    return tokenCache.token;
  }
  const response = await credential.getToken('https://database.windows.net/.default');
  tokenCache = { token: response.token, expiresOn: response.expiresOnTimestamp };
  return response.token;
}

function getConnection() {
  return new Promise(async (resolve, reject) => {
    try {
      if (!SQL_SERVER || !SQL_DATABASE) {
        throw new Error('SQL_SERVER and SQL_DATABASE must be configured.');
      }
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

function collectErrorMessages(err, seen = new Set()) {
  if (!err || seen.has(err)) return [];
  seen.add(err);
  const messages = [];
  if (err.message) messages.push(err.message);
  if (err.info && err.info.message) messages.push(err.info.message);
  if (err.originalError) messages.push(...collectErrorMessages(err.originalError, seen));
  if (err.cause) messages.push(...collectErrorMessages(err.cause, seen));
  if (Array.isArray(err.precedingErrors)) {
    for (const preceding of err.precedingErrors) {
      messages.push(...collectErrorMessages(preceding, seen));
    }
  }
  return messages;
}

// Column names the server complained about, either because they do not exist in
// this database or because they reject the NULL we tried to write. Both cases can
// be recovered from by retrying the statement without that column.
function extractProblemColumns(err) {
  const columns = new Set();
  for (const message of collectErrorMessages(err)) {
    for (const match of message.matchAll(/Invalid column name '([^']+)'/g)) columns.add(match[1]);
    for (const match of message.matchAll(/Cannot insert the value NULL into column '([^']+)'/g)) columns.add(match[1]);
  }
  return [...columns];
}

function buildInsert(table, specs, { output } = {}) {
  const columns = specs.map(s => s.column).join(', ');
  const values = specs.map(s => '@' + s.param.name).join(', ');
  const outputClause = output ? ` OUTPUT ${output}` : '';
  return `INSERT INTO ${table} (${columns})${outputClause} VALUES (${values})`;
}

function buildUpdate(table, specs, where) {
  const assignments = specs.map(s => `${s.column}=@${s.param.name}`).join(', ');
  return `UPDATE ${table} SET ${assignments} WHERE ${where}`;
}

/**
 * Runs a statement built from `required` + `optional` column specs. Deployments of
 * this app have drifted schemas (columns added in later versions, legacy NOT NULL
 * columns), so when the server rejects an optional column we drop it and retry
 * instead of failing the whole write.
 */
async function execWithColumnFallback(conn, { required = [], optional = [], extraParams = [], build }) {
  let usable = [...optional];
  for (let attempt = 0; attempt <= optional.length; attempt += 1) {
    const specs = [...required, ...usable];
    if (!specs.length) return [];
    const sql = build(specs);
    const params = [...specs.map(s => s.param), ...extraParams];
    try {
      return await execSql(conn, sql, params);
    } catch (err) {
      const problems = extractProblemColumns(err).filter(name => usable.some(spec => spec.column === name));
      if (!problems.length) throw err;
      console.warn('[DB] Retrying statement without unsupported column(s):', problems.join(', '));
      usable = usable.filter(spec => !problems.includes(spec.column));
    }
  }
  throw new Error('Unable to execute statement after dropping unsupported columns.');
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
    const parsedSpId = Number.parseInt(spId, 10);
    // sp_id is NOT NULL in older deployments, so always write it when we know it.
    const rows = await execWithColumnFallback(conn, {
      required: [
        { column: 'sp_name', param: { name: 'spName', type: TYPES.NVarChar, value: spName } },
        { column: 'tenant_id', param: { name: 'tenantId', type: TYPES.NVarChar, value: tenantId } },
        { column: 'run_by', param: { name: 'runBy', type: TYPES.NVarChar, value: runBy } },
      ],
      optional: [
        { column: 'sp_id', param: { name: 'spId', type: TYPES.Int, value: Number.isFinite(parsedSpId) ? parsedSpId : null } },
        { column: 'status', param: { name: 'status', type: TYPES.NVarChar, value: 'running' } },
      ],
      build: specs => buildInsert('analysis_runs', specs, { output: 'INSERTED.id' }),
    });
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
    try {
      await execSql(conn, 'DELETE FROM analysis_run_totals WHERE run_id=@id', [
        { name: 'id', type: TYPES.Int, value: id },
      ]);
    } catch (err) {
      if (!(err.message || '').includes('Invalid object name')) throw err;
    }
    await execSql(conn, 'DELETE FROM analysis_runs WHERE id=@id', [
      { name: 'id', type: TYPES.Int, value: id },
    ]);
  } finally {
    conn.close();
  }
}

// Analysis run totals — the Governance Overview numbers, materialized per run so
// run-to-run comparison is a cheap read instead of parsing results_json twice.
const TOTALS_COLUMNS = METRIC_DEFS.map(def => ({ key: def.key, column: def.column }));

async function saveRunTotals(runId, { tenantId, spId, spName, startedAt }, totals) {
  const conn = await getConnection();
  try {
    const parsedSpId = Number.parseInt(spId, 10);
    await execSql(conn, 'DELETE FROM analysis_run_totals WHERE run_id=@runId', [
      { name: 'runId', type: TYPES.Int, value: runId },
    ]);
    await execWithColumnFallback(conn, {
      required: [
        { column: 'run_id', param: { name: 'runId', type: TYPES.Int, value: runId } },
        ...TOTALS_COLUMNS.map(({ key, column }) => ({
          column,
          param: { name: column, type: TYPES.BigInt, value: Number(totals[key]) || 0 },
        })),
      ],
      optional: [
        { column: 'tenant_id', param: { name: 'tenantId', type: TYPES.NVarChar, value: tenantId || null } },
        { column: 'sp_id', param: { name: 'spId', type: TYPES.Int, value: Number.isFinite(parsedSpId) ? parsedSpId : null } },
        { column: 'sp_name', param: { name: 'spName', type: TYPES.NVarChar, value: spName || null } },
        { column: 'run_started_at', param: { name: 'startedAt', type: TYPES.DateTime2, value: startedAt ? new Date(startedAt) : null } },
      ],
      build: specs => buildInsert('analysis_run_totals', specs),
    });
  } finally {
    conn.close();
  }
}

async function getRunTotals(runId) {
  const conn = await getConnection();
  try {
    const rows = await execSql(conn, 'SELECT * FROM analysis_run_totals WHERE run_id=@runId', [
      { name: 'runId', type: TYPES.Int, value: runId },
    ]);
    return rows[0] || null;
  } catch (err) {
    if (err.message && err.message.includes('Invalid object name')) return null;
    throw err;
  } finally {
    conn.close();
  }
}

// Runs that can legitimately be compared with each other: same tenant only.
async function getComparableRuns(tenantId) {
  const conn = await getConnection();
  try {
    return await execSql(
      conn,
      `SELECT id, sp_id, sp_name, tenant_id, status, started_at, completed_at, total_workspaces
       FROM analysis_runs
       WHERE status = 'completed' AND tenant_id = @tenantId
       ORDER BY started_at DESC`,
      [{ name: 'tenantId', type: TYPES.NVarChar, value: tenantId }]
    );
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
    const parsedSpId = Number.parseInt(schedule.spId, 10);
    // Everything is written in a single INSERT so a schema-drift problem can never
    // leave a half-written row behind (which used to surface as "saved but failed").
    const insertRows = await execWithColumnFallback(conn, {
      required: [
        { column: 'capacity_name', param: { name: 'name', type: TYPES.NVarChar, value: schedule.capacityName } },
        { column: 'subscription_id', param: { name: 'sub', type: TYPES.NVarChar, value: schedule.subscriptionId } },
        { column: 'resource_group', param: { name: 'rg', type: TYPES.NVarChar, value: schedule.resourceGroup } },
        { column: 'action', param: { name: 'action', type: TYPES.NVarChar, value: schedule.action } },
        { column: 'schedule_type', param: { name: 'type', type: TYPES.NVarChar, value: schedule.scheduleType } },
        { column: 'schedule_minute', param: { name: 'minute', type: TYPES.Int, value: schedule.minute != null ? schedule.minute : 0 } },
        { column: 'enabled', param: { name: 'enabled', type: TYPES.Bit, value: schedule.enabled !== false } },
      ],
      optional: [
        { column: 'schedule_hour', param: { name: 'hour', type: TYPES.Int, value: schedule.hour != null ? schedule.hour : null } },
        { column: 'schedule_day', param: { name: 'day', type: TYPES.NVarChar, value: schedule.day || null } },
        { column: 'timezone', param: { name: 'tz', type: TYPES.NVarChar, value: schedule.timezone || 'UTC' } },
        { column: 'schedule_hour_utc', param: { name: 'hourUtc', type: TYPES.Int, value: schedule.hourUtc != null ? schedule.hourUtc : null } },
        { column: 'schedule_minute_utc', param: { name: 'minuteUtc', type: TYPES.Int, value: schedule.minuteUtc != null ? schedule.minuteUtc : null } },
        { column: 'schedule_day_utc', param: { name: 'dayUtc', type: TYPES.NVarChar, value: schedule.dayUtc || null } },
        { column: 'sp_id', param: { name: 'spId', type: TYPES.Int, value: Number.isFinite(parsedSpId) ? parsedSpId : null } },
      ],
      build: specs => buildInsert('capacity_schedules', specs, { output: 'INSERTED.id' }),
    });
    const insertedId = insertRows && insertRows[0] ? parseInt(insertRows[0].id, 10) : null;
    return Number.isFinite(insertedId) ? insertedId : null;
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
    const required = [];
    const optional = [];
    if (fields.action !== undefined) required.push({ column: 'action', param: { name: 'action', type: TYPES.NVarChar, value: fields.action } });
    if (fields.scheduleType !== undefined) required.push({ column: 'schedule_type', param: { name: 'type', type: TYPES.NVarChar, value: fields.scheduleType } });
    if (fields.minute !== undefined) required.push({ column: 'schedule_minute', param: { name: 'minute', type: TYPES.Int, value: fields.minute } });
    if (fields.hour !== undefined) optional.push({ column: 'schedule_hour', param: { name: 'hour', type: TYPES.Int, value: fields.hour } });
    if (fields.day !== undefined) optional.push({ column: 'schedule_day', param: { name: 'day', type: TYPES.NVarChar, value: fields.day } });
    if (fields.timezone !== undefined) optional.push({ column: 'timezone', param: { name: 'tz', type: TYPES.NVarChar, value: fields.timezone } });
    if (fields.hourUtc !== undefined) optional.push({ column: 'schedule_hour_utc', param: { name: 'hourUtc', type: TYPES.Int, value: fields.hourUtc } });
    if (fields.minuteUtc !== undefined) optional.push({ column: 'schedule_minute_utc', param: { name: 'minuteUtc', type: TYPES.Int, value: fields.minuteUtc } });
    if (fields.dayUtc !== undefined) optional.push({ column: 'schedule_day_utc', param: { name: 'dayUtc', type: TYPES.NVarChar, value: fields.dayUtc } });
    if (fields.spId !== undefined) optional.push({ column: 'sp_id', param: { name: 'spId', type: TYPES.Int, value: fields.spId } });
    if (!required.length && !optional.length) return;

    // Single statement: either the whole edit lands or nothing does, so the UI never
    // reports a failure for a row that was in fact changed.
    await execWithColumnFallback(conn, {
      required,
      optional,
      extraParams: [{ name: 'id', type: TYPES.Int, value: id }],
      build: specs => buildUpdate('capacity_schedules', specs, 'id=@id'),
    });
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

// Last *completed* run per schedule. 'triggered' and 'error' rows are excluded so a
// failed attempt can still be retried, while a finished one is never repeated after
// a process restart (the in-memory dedupe map does not survive one).
async function getLastScheduleExecutions() {
  const conn = await getConnection();
  try {
    return await execSql(
      conn,
      `SELECT schedule_id, MAX(executed_at) AS last_executed_at
       FROM capacity_schedule_history
       WHERE schedule_id IS NOT NULL AND status IN ('success', 'skipped')
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
// Each migration statement runs on its own so a single failure (for example an
// ALTER blocked by an index) cannot skip every migration that comes after it.
async function runStatement(conn, label, sql) {
  try {
    await execSql(conn, sql);
    return true;
  } catch (err) {
    console.warn(`[DB] Migration step "${label}" skipped:`, err.message);
    return false;
  }
}

async function runMigrations() {
  let conn;
  try {
    // A serverless database that is resuming rejects the first connection; that must
    // not take the rest of startup (notably the scheduler) down with it.
    conn = await getConnection();
    // Create service principals table if missing
    await runStatement(conn, 'create service_principals', `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'service_principals') AND type = 'U')
      BEGIN
        CREATE TABLE service_principals (
          id INT IDENTITY(1,1) PRIMARY KEY,
          name NVARCHAR(255) NOT NULL,
          tenant_id NVARCHAR(100) NOT NULL,
          client_id NVARCHAR(100) NOT NULL,
          client_secret NVARCHAR(MAX) NULL,
          enterprise_app_object_id NVARCHAR(255) NULL,
          key_vault_name NVARCHAR(255) NULL,
          key_vault_secret_name NVARCHAR(255) NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        )
      END
    `);

    // Create analysis runs table if missing
    await runStatement(conn, 'create analysis_runs', `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'analysis_runs') AND type = 'U')
      BEGIN
        CREATE TABLE analysis_runs (
          id INT IDENTITY(1,1) PRIMARY KEY,
          sp_id INT NULL,
          sp_name NVARCHAR(255) NULL,
          tenant_id NVARCHAR(100) NULL,
          status NVARCHAR(20) NOT NULL DEFAULT 'running',
          total_workspaces INT NULL,
          total_reports INT NULL,
          total_datasets INT NULL,
          total_dashboards INT NULL,
          total_dataflows INT NULL,
          total_users INT NULL,
          results_json NVARCHAR(MAX) NULL,
          started_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          completed_at DATETIME2 NULL,
          run_by NVARCHAR(255) NULL
        )
      END
    `);
    await runStatement(conn, 'add analysis_runs.sp_id', `IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'analysis_runs') AND type = 'U') AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'analysis_runs') AND name = N'sp_id') ALTER TABLE analysis_runs ADD sp_id INT NULL`);
    // Older deployments created analysis_runs.sp_id as NOT NULL, which broke runs
    // started with a Managed Identity (no service principal row to reference).
    await runStatement(conn, 'relax analysis_runs.sp_id', `IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'analysis_runs') AND name = N'sp_id' AND is_nullable = 0) ALTER TABLE analysis_runs ALTER COLUMN sp_id INT NULL`);

    // Per-run snapshot of the Governance Overview totals, scoped by tenant so runs
    // are only ever compared within the same tenant.
    await runStatement(conn, 'create analysis_run_totals', `
      IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'analysis_run_totals') AND type = 'U')
      BEGIN
        CREATE TABLE analysis_run_totals (
          id INT IDENTITY(1,1) PRIMARY KEY,
          run_id INT NOT NULL,
          tenant_id NVARCHAR(100) NULL,
          sp_id INT NULL,
          sp_name NVARCHAR(255) NULL,
          run_started_at DATETIME2 NULL,
          ${METRIC_DEFS.map(def => `${def.column} BIGINT NOT NULL DEFAULT 0`).join(',\n          ')},
          captured_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE UNIQUE INDEX UX_analysis_run_totals_run ON analysis_run_totals (run_id);
        CREATE INDEX IX_analysis_run_totals_tenant ON analysis_run_totals (tenant_id, run_started_at DESC);
      END
    `);
    // Newer metrics are added as columns on existing installs.
    for (const def of METRIC_DEFS) {
      await runStatement(conn, `add analysis_run_totals.${def.column}`, `IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'analysis_run_totals') AND type = 'U') AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'analysis_run_totals') AND name = N'${def.column}') ALTER TABLE analysis_run_totals ADD ${def.column} BIGINT NOT NULL DEFAULT 0`);
    }

    // Create capacity schedules table if missing
    await runStatement(conn, 'create capacity_schedules', `
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
          schedule_hour_utc INT NULL,
          schedule_minute_utc INT NULL,
          schedule_day_utc NVARCHAR(20) NULL,
          sp_id INT NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        )
      END
    `);

    // Create capacity schedule history table if missing
    await runStatement(conn, 'create capacity_schedule_history', `
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
    await runStatement(conn, 'add capacity_schedule_history.schedule_id', `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedule_history') AND type = 'U')
      AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedule_history') AND name = N'schedule_id')
      BEGIN
        ALTER TABLE capacity_schedule_history ADD schedule_id INT NULL;
        CREATE INDEX IX_capacity_schedule_history_schedule_time
          ON capacity_schedule_history (schedule_id, executed_at DESC);
      END
    `);

    // Add enterprise_app_object_id column if missing
    await runStatement(conn, 'add service_principals.enterprise_app_object_id', `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'service_principals') AND name = N'enterprise_app_object_id') ALTER TABLE service_principals ADD enterprise_app_object_id NVARCHAR(255) NULL`);
    // Add timezone column to capacity_schedules if missing
    await runStatement(conn, 'add capacity_schedules.timezone', `IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U') AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'timezone') ALTER TABLE capacity_schedules ADD timezone NVARCHAR(100) NULL`);
    await runStatement(conn, 'add capacity_schedules.schedule_hour_utc', `IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U') AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'schedule_hour_utc') ALTER TABLE capacity_schedules ADD schedule_hour_utc INT NULL`);
    await runStatement(conn, 'add capacity_schedules.schedule_minute_utc', `IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U') AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'schedule_minute_utc') ALTER TABLE capacity_schedules ADD schedule_minute_utc INT NULL`);
    await runStatement(conn, 'add capacity_schedules.schedule_day_utc', `IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U') AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'schedule_day_utc') ALTER TABLE capacity_schedules ADD schedule_day_utc NVARCHAR(20) NULL`);
    // Columns the app legitimately writes NULL to (hourly schedules have no hour,
    // non-weekly schedules have no day). Older tables declared some of them NOT NULL,
    // which made saving a schedule fail even though the row itself was valid.
    for (const [column, definition] of [
      ['schedule_hour', 'INT'],
      ['schedule_minute', 'INT'],
      ['schedule_hour_utc', 'INT'],
      ['schedule_minute_utc', 'INT'],
      ['schedule_day', 'NVARCHAR(20)'],
      ['schedule_day_utc', 'NVARCHAR(20)'],
      ['timezone', 'NVARCHAR(100)'],
      ['sp_id', 'INT'],
      ['spd_id', 'INT'],
    ]) {
      await runStatement(conn, `relax capacity_schedules.${column}`, `IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'${column}' AND is_nullable = 0) ALTER TABLE capacity_schedules ALTER COLUMN ${column} ${definition} NULL`);
    }
    // Normalize legacy timezone labels like "Europe/Warsaw (CET)" to IANA IDs
    await runStatement(conn, 'normalize timezone labels', `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U')
      BEGIN
        UPDATE capacity_schedules
        SET timezone = LTRIM(RTRIM(LEFT(timezone, CHARINDEX('(', timezone) - 1)))
        WHERE timezone IS NOT NULL AND timezone LIKE '%(%';
        UPDATE capacity_schedules SET timezone = 'Europe/Warsaw' WHERE timezone IN ('CET', 'CEST');
        UPDATE capacity_schedules SET timezone = 'Europe/Helsinki' WHERE timezone = 'EET';
        UPDATE capacity_schedules SET timezone = 'America/New_York' WHERE timezone = 'ET';
        UPDATE capacity_schedules SET timezone = 'America/Chicago' WHERE timezone = 'CT';
        UPDATE capacity_schedules SET timezone = 'America/Denver' WHERE timezone = 'MT';
        UPDATE capacity_schedules SET timezone = 'America/Los_Angeles' WHERE timezone = 'PT';
      END
    `);
    // Add service principal reference to schedules if missing
    await runStatement(conn, 'add capacity_schedules.sp_id', `IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U') AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'sp_id') ALTER TABLE capacity_schedules ADD sp_id INT NULL`);
    // If legacy typo column exists, copy values into sp_id
    await runStatement(conn, 'backfill sp_id from legacy spd_id', `
      IF EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'capacity_schedules') AND type = 'U')
      AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'spd_id')
      AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'capacity_schedules') AND name = N'sp_id')
      BEGIN
        UPDATE capacity_schedules SET sp_id = COALESCE(sp_id, spd_id) WHERE spd_id IS NOT NULL;
      END
    `);
    // Backfill UTC schedule columns for existing rows
    let schedulesToBackfill = [];
    try {
      schedulesToBackfill = await execSql(conn, `
        SELECT id, schedule_type, schedule_hour, schedule_minute, schedule_day, timezone
        FROM capacity_schedules
        WHERE schedule_minute_utc IS NULL OR (schedule_type <> 'hourly' AND schedule_hour_utc IS NULL) OR schedule_day_utc IS NULL
      `);
    } catch (selectErr) {
      console.warn('[DB] Migration step "select schedules to backfill" skipped:', selectErr.message);
    }
    for (const s of schedulesToBackfill) {
      try {
        const normalizedTz = normalizeTimezone(s.timezone || 'UTC');
        const utc = convertScheduleToUtc({
          scheduleType: s.schedule_type,
          hour: s.schedule_hour,
          minute: s.schedule_minute,
          day: s.schedule_day,
          timezone: normalizedTz,
        });
        await execSql(conn, `
          UPDATE capacity_schedules
          SET timezone = @tz,
              schedule_hour_utc = @hourUtc,
              schedule_minute_utc = @minuteUtc,
              schedule_day_utc = @dayUtc
          WHERE id = @id
        `, [
          { name: 'id', type: TYPES.Int, value: s.id },
          { name: 'tz', type: TYPES.NVarChar, value: normalizedTz },
          { name: 'hourUtc', type: TYPES.Int, value: utc.scheduleHourUtc != null ? utc.scheduleHourUtc : null },
          { name: 'minuteUtc', type: TYPES.Int, value: utc.scheduleMinuteUtc != null ? utc.scheduleMinuteUtc : null },
          { name: 'dayUtc', type: TYPES.NVarChar, value: utc.scheduleDayUtc || null },
        ]);
      } catch (backfillErr) {
        console.warn('[DB] Schedule UTC backfill skipped for id', s.id, backfillErr.message);
      }
    }
    // Add Key Vault columns to service_principals if missing
    await runStatement(conn, 'add service_principals.key_vault_name', `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'service_principals') AND name = N'key_vault_name') ALTER TABLE service_principals ADD key_vault_name NVARCHAR(255) NULL`);
    await runStatement(conn, 'add service_principals.key_vault_secret_name', `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'service_principals') AND name = N'key_vault_secret_name') ALTER TABLE service_principals ADD key_vault_secret_name NVARCHAR(255) NULL`);
    // Make client_secret nullable (it may already be)
    await runStatement(conn, 'relax service_principals.client_secret', `IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'service_principals') AND name = N'client_secret' AND is_nullable = 0) ALTER TABLE service_principals ALTER COLUMN client_secret NVARCHAR(MAX) NULL`);
    console.log('[DB] Migrations complete.');
  } catch (err) {
    console.warn('[DB] Migration warning:', err.message);
  } finally {
    if (conn) conn.close();
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
  saveRunTotals,
  getRunTotals,
  getComparableRuns,
  getCapacitySchedules,
  saveCapacitySchedule,
  updateCapacitySchedule,
  deleteCapacitySchedule,
  toggleCapacitySchedule,
  logScheduleExecution,
  getScheduleHistory,
  getLastScheduleExecutions,
  _private: { buildInsert, buildUpdate, extractProblemColumns },
};
