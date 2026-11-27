#!/usr/bin/env node
/**
 * Creates the database users the deployment's managed identities sign in as.
 *
 * Bicep can create a managed identity but cannot create a user for it inside an
 * Azure SQL database, so this runs after provisioning (azd postprovision hook),
 * signed in as whoever runs the deployment — an Entra admin of the server.
 *
 *  - The Governance Outcome reader: SELECT on exactly five tables, an explicit
 *    DENY on the credential table, nothing else. This is what makes the outcome's
 *    least-privilege setup the default rather than a manual step.
 *  - The scan worker, when one is deployed: read and write, as the web app has.
 *
 * Idempotent: safe to run on every deployment. Identifiers are validated and
 * quoted with QUOTENAME; nothing is concatenated from input unchecked.
 *
 * Environment (azd sets the outputs automatically):
 *   SQL_SERVER, SQL_DATABASE                  the database
 *   GOVERNANCE_READER_IDENTITY_NAME           user-assigned identity of the reader
 *   SCAN_WORKER_NAME                          the worker app (optional)
 *   SQL_SETUP_DRY_RUN=1                       print the statements only
 */

const READER_TABLES = ['analysis_runs', 'analysis_run_totals', 'analysis_workspaces', 'analysis_workspace_users', 'workspace_states'];
const CREDENTIAL_TABLE = 'service_principals';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function checkName(name, what) {
  if (!NAME.test(String(name || ''))) throw new Error(what + ' "' + name + '" is not a valid identity name.');
  return name;
}

/** The statements, each with the parameters it takes. Pure, so it can be tested. */
function plan({ readerName, workerName }) {
  const steps = [];
  const createUser = (name) => ({
    label: 'create user ' + name,
    sql: `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @name)
BEGIN
  DECLARE @create NVARCHAR(400) = N'CREATE USER ' + QUOTENAME(@name) + N' FROM EXTERNAL PROVIDER';
  EXEC sp_executesql @create;
END`,
    name,
  });

  if (readerName) {
    checkName(readerName, 'Reader identity');
    steps.push(createUser(readerName));
    for (const table of READER_TABLES) {
      steps.push({
        label: 'grant SELECT on ' + table + ' to ' + readerName,
        sql: `IF OBJECT_ID(N'dbo.${table}', N'U') IS NOT NULL
BEGIN
  DECLARE @grant NVARCHAR(400) = N'GRANT SELECT ON dbo.${table} TO ' + QUOTENAME(@name);
  EXEC sp_executesql @grant;
END`,
        name: readerName,
      });
    }
    steps.push({
      label: 'deny the credential table to ' + readerName,
      sql: `IF OBJECT_ID(N'dbo.${CREDENTIAL_TABLE}', N'U') IS NOT NULL
BEGIN
  DECLARE @deny NVARCHAR(400) = N'DENY SELECT ON dbo.${CREDENTIAL_TABLE} TO ' + QUOTENAME(@name);
  EXEC sp_executesql @deny;
END`,
      name: readerName,
    });
  }

  if (workerName) {
    checkName(workerName, 'Worker app');
    steps.push(createUser(workerName));
    for (const role of ['db_datareader', 'db_datawriter', 'db_ddladmin']) {
      steps.push({
        label: 'add ' + workerName + ' to ' + role,
        sql: `IF ISNULL(IS_ROLEMEMBER(N'${role}', @name), 0) = 0
BEGIN
  DECLARE @role NVARCHAR(400) = N'ALTER ROLE ${role} ADD MEMBER ' + QUOTENAME(@name);
  EXEC sp_executesql @role;
END`,
        name: workerName,
      });
    }
  }
  return steps;
}

async function connect(server, database) {
  const { Connection } = require('tedious');
  const { DefaultAzureCredential } = require('@azure/identity');
  const token = await new DefaultAzureCredential().getToken('https://database.windows.net/.default');
  return new Promise((resolve, reject) => {
    const conn = new Connection({
      server,
      authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
      options: { database, encrypt: true, trustServerCertificate: false, requestTimeout: 60000 },
    });
    conn.on('connect', err => (err ? reject(err) : resolve(conn)));
    conn.connect();
  });
}

function exec(conn, step) {
  const { Request, TYPES } = require('tedious');
  return new Promise((resolve, reject) => {
    const request = new Request(step.sql, err => (err ? reject(new Error(step.label + ': ' + err.message)) : resolve()));
    request.addParameter('name', TYPES.NVarChar, step.name);
    conn.execSql(request);
  });
}

async function main(env = process.env) {
  const readerName = env.GOVERNANCE_READER_IDENTITY_NAME || '';
  const workerName = env.SCAN_WORKER_NAME || '';
  if (!readerName && !workerName) {
    console.log('[setup-sql] Nothing to set up: no reader identity or scan worker in this deployment.');
    return;
  }
  const steps = plan({ readerName, workerName });
  if (env.SQL_SETUP_DRY_RUN === '1') {
    steps.forEach(step => console.log('-- ' + step.label + ' (@name = ' + step.name + ')\n' + step.sql + '\n'));
    return;
  }
  if (!env.SQL_SERVER || !env.SQL_DATABASE) {
    console.warn('[setup-sql] SQL_SERVER and SQL_DATABASE are not set, so the database users were not created. Set them (azd env set) and run: npm run setup:sql');
    return;
  }
  const conn = await connect(env.SQL_SERVER, env.SQL_DATABASE);
  try {
    for (const step of steps) {
      await exec(conn, step);
      console.log('[setup-sql] ' + step.label);
    }
  } finally {
    conn.close();
  }
}

if (require.main === module) {
  main().catch(err => {
    // A deployment must not fail over this: the app runs on its own connection
    // until the reader exists, and says so on Home.
    console.warn('[setup-sql] Could not set up database users:', err.message);
    console.warn('[setup-sql] Sign in as an Entra admin of the SQL server and run: npm run setup:sql');
  });
}

module.exports = { plan, READER_TABLES, CREDENTIAL_TABLE };
