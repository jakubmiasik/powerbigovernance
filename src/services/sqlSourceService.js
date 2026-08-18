/**
 * Reading from a registered database that is not a Fabric item.
 *
 * Reconciliation is only useful if it can reach the systems the business actually
 * runs on, which are rarely all in Fabric. This connects to a SQL Server or Azure
 * SQL database over TDS — the protocol `tedious` already speaks for this app's own
 * database — using either Entra ID (the application's managed identity) or a SQL
 * login whose password is stored encrypted.
 *
 * Deliberately limited to SQL Server and Azure SQL: other engines need their own
 * wire protocol and driver, and quietly failing against a Postgres host would be
 * worse than saying up front that it is not supported.
 */

const { Connection, Request } = require('tedious');
const { DefaultAzureCredential } = require('@azure/identity');
const { buildSelectSql } = require('./reconciliationService');
const { decryptSecret } = require('./secretCryptoService');

const AUTH_MODES = [
  { key: 'entra', label: 'Entra ID (application identity)', description: 'Uses the identity this application runs as. The database must grant that identity read access.' },
  { key: 'sql', label: 'SQL login', description: 'A username and password held by the database itself. The password is stored encrypted.' },
];

const AUTH_MODE_KEYS = AUTH_MODES.map(mode => mode.key);

const CONNECT_TIMEOUT_MS = Number.parseInt(process.env.RECON_SQL_CONNECT_TIMEOUT_MS || '30000', 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.RECON_SQL_REQUEST_TIMEOUT_MS || '120000', 10);

let credential = null;
function getCredential() {
  if (!credential) credential = new DefaultAzureCredential();
  return credential;
}

/**
 * Turns a driver error into something an operator can act on. The raw messages are
 * accurate but say nothing about which of the several plausible causes applies.
 */
function explainSqlFailure(err, source) {
  const message = (err && err.message) || String(err);
  const server = source.connection_string || 'the server';

  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return 'Cannot resolve "' + server + '". Check the server name.';
  }
  if (/ETIMEDOUT|ESOCKET|ECONNREFUSED|timeout/i.test(message)) {
    return 'Could not reach "' + server + '". Check the port is open and, for Azure SQL, that this application\'s outbound address is allowed by the server firewall.';
  }
  if (/Login failed|password|18456/i.test(message)) {
    return source.auth_mode === 'sql'
      ? 'The database refused the SQL login. Check the username and password.'
      : 'The database refused this application\'s identity. Grant it read access to the database (CREATE USER FROM EXTERNAL PROVIDER, then db_datareader).';
  }
  if (/Cannot open database|4060/i.test(message)) {
    return 'The server accepted the connection but database "' + (source.database_name || '') + '" is not available to this identity.';
  }
  if (/Invalid object name/i.test(message)) {
    return message + ' — the table or view named in the rule does not exist in this database.';
  }
  return message;
}

function connectionConfig(source, token) {
  const config = {
    // The host is held in connection_string for every kind of source, so a Fabric
    // endpoint and a registered database are described the same way.
    server: source.connection_string,
    options: {
      database: source.database_name || undefined,
      encrypt: true,
      trustServerCertificate: false,
      requestTimeout: REQUEST_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      rowCollectionOnRequestCompletion: false,
    },
  };

  const port = Number.parseInt(source.sql_port, 10);
  if (Number.isFinite(port) && port > 0) config.options.port = port;

  if (source.auth_mode === 'sql') {
    const password = decryptSecret(source.sql_password);
    if (!source.sql_username || !password) {
      throw new Error('This source uses a SQL login but no username or password is stored for it.');
    }
    config.authentication = { type: 'default', options: { userName: source.sql_username, password } };
  } else {
    config.authentication = { type: 'azure-active-directory-access-token', options: { token } };
  }
  return config;
}

async function tokenFor(source) {
  if (source.auth_mode === 'sql') return null;
  const response = await getCredential().getToken('https://database.windows.net/.default');
  return response.token;
}

/** Runs one statement and returns its rows. One connection per query, closed always. */
function runQuery(config, sql) {
  return new Promise((resolve, reject) => {
    const connection = new Connection(config);
    const rows = [];
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { connection.close(); } catch { /* already closing */ }
      if (err) reject(err); else resolve(value);
    };

    connection.on('connect', (err) => {
      if (err) return finish(err);
      const request = new Request(sql, (reqErr) => {
        if (reqErr) return finish(reqErr);
        finish(null, rows);
      });
      request.on('row', (columns) => {
        const row = {};
        columns.forEach((col) => { row[col.metadata.colName] = col.value; });
        rows.push(row);
      });
      connection.execSql(request);
    });
    connection.on('error', err => finish(err));
    connection.connect();
  });
}

async function query(source, sql) {
  if (!source.connection_string) {
    throw new Error('This source has no server recorded.');
  }
  const config = connectionConfig(source, await tokenFor(source));
  try {
    return await runQuery(config, sql);
  } catch (err) {
    throw new Error(explainSqlFailure(err, source));
  }
}

/** Reads the rows a planned rule needs, in the same shape as a Fabric endpoint. */
async function readRows(source, { dataset, selections, columns, rowLimit }) {
  return query(source, buildSelectSql({ dataset, selections, columns, rowLimit }));
}

/**
 * The tables, views and columns the source exposes, in the shape the rule form
 * expects. Read once at registration and stored, so picking fields for a rule does
 * not open a connection to the business system every time.
 */
async function readSchema(source) {
  const rows = await query(source, `
    SELECT t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_TYPE,
           c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.ORDINAL_POSITION,
           c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE
    FROM INFORMATION_SCHEMA.TABLES t
    LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
      ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
    ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION
  `);
  return shapeSchemaRows(rows);
}

/**
 * INFORMATION_SCHEMA rows → the dataset/field list the rule form renders. Split out
 * from the query so the reshaping can be tested without a database.
 */
function shapeSchemaRows(rows) {
  const datasets = new Map();
  for (const row of rows || []) {
    const qualified = row.TABLE_SCHEMA + '.' + row.TABLE_NAME;
    if (!datasets.has(qualified)) {
      datasets.set(qualified, {
        name: qualified,
        kind: /view/i.test(row.TABLE_TYPE || '') ? 'View' : 'Table',
        fields: [],
      });
    }
    if (!row.COLUMN_NAME) continue;

    let dataType = row.DATA_TYPE;
    if (row.CHARACTER_MAXIMUM_LENGTH) {
      dataType += '(' + (row.CHARACTER_MAXIMUM_LENGTH === -1 ? 'max' : row.CHARACTER_MAXIMUM_LENGTH) + ')';
    } else if (row.NUMERIC_PRECISION && row.NUMERIC_SCALE !== null && row.NUMERIC_SCALE !== undefined) {
      dataType += '(' + row.NUMERIC_PRECISION + ',' + row.NUMERIC_SCALE + ')';
    }
    datasets.get(qualified).fields.push({
      name: row.COLUMN_NAME,
      dataType,
      nullable: String(row.IS_NULLABLE).toUpperCase() === 'YES',
    });
  }
  return [...datasets.values()];
}

/**
 * Confirms the source is reachable and readable before it is registered, so a
 * connection problem surfaces while the person who can fix it is still looking at
 * the form rather than during a control run weeks later.
 */
async function testConnection(source) {
  const rows = await query(source, 'SELECT DB_NAME() AS db, SUSER_SNAME() AS login, @@VERSION AS version');
  const row = rows[0] || {};
  return {
    database: row.db || source.database_name,
    login: row.login || null,
    version: (row.version || '').split('\n')[0].trim(),
  };
}

module.exports = {
  AUTH_MODES,
  AUTH_MODE_KEYS,
  readRows,
  readSchema,
  shapeSchemaRows,
  testConnection,
  explainSqlFailure,
  _private: { connectionConfig },
};
