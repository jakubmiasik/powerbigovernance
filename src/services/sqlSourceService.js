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

const { Connection, Request, TYPES } = require('tedious');
const { DefaultAzureCredential } = require('@azure/identity');
const { buildSelectSql, quoteIdentifier } = require('./reconciliationService');
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

/**
 * Runs a series of statements on one connection, in order, returning the rows of
 * each. Sequential because a tedious connection carries a single request at a time.
 */
function runStatements(config, statements) {
  return new Promise((resolve, reject) => {
    const connection = new Connection(config);
    const results = [];
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { connection.close(); } catch { /* already closing */ }
      if (err) reject(err); else resolve(value);
    };

    connection.on('connect', (err) => {
      if (err) return finish(err);

      const next = (index) => {
        if (index >= statements.length) return finish(null, results);
        const statement = statements[index];
        const rows = [];
        const request = new Request(statement.sql, (reqErr) => {
          if (reqErr) return finish(reqErr);
          results.push(rows);
          next(index + 1);
        });
        for (const param of statement.params || []) {
          request.addParameter(param.name, param.type, param.value);
        }
        request.on('row', (columns) => {
          const row = {};
          columns.forEach((col) => { row[col.metadata.colName] = col.value; });
          rows.push(row);
        });
        connection.execSql(request);
      };
      next(0);
    });
    connection.on('error', err => finish(err));
    connection.connect();
  });
}

/**
 * `token` overrides the identity used to connect. A Fabric warehouse is reached
 * with its tenant's service principal rather than this application's own identity,
 * and it speaks the same protocol, so the same connector serves both.
 */
async function execute(source, statements, { token } = {}) {
  if (!source.connection_string) {
    throw new Error('This source has no server recorded.');
  }
  const config = connectionConfig(source, token || await tokenFor(source));
  try {
    return await runStatements(config, statements);
  } catch (err) {
    throw new Error(explainSqlFailure(err, source));
  }
}

async function query(source, sql, options = {}) {
  const results = await execute(source, [{ sql }], options);
  return results[0] || [];
}

/** Reads the rows a planned rule needs, in the same shape as a Fabric endpoint. */
async function readRows(source, { dataset, selections, columns, rowLimit }, options = {}) {
  return query(source, buildSelectSql({ dataset, selections, columns, rowLimit }), options);
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

// ── Writing ──

/**
 * Whether a registered source can be written to.
 *
 * A Fabric **lakehouse** SQL analytics endpoint is read-only — it serves queries
 * over Delta tables that Spark and pipelines own, and no amount of permission makes
 * it accept an INSERT. A Fabric **warehouse** does accept one, as does any
 * registered SQL Server or Azure SQL database. Saying this at the point of choosing
 * a destination is far better than letting a run get as far as writing and fail.
 */
function describeWritability(source) {
  if (!source) return { writable: false, reason: 'No destination selected.' };
  const itemType = String(source.item_type || '').toLowerCase();
  if (itemType === 'lakehouse') {
    return {
      writable: false,
      reason: 'A lakehouse SQL analytics endpoint is read-only. Choose a Fabric warehouse, or a registered SQL Server or Azure SQL database, as the destination.',
    };
  }
  return { writable: true, reason: null };
}

// Everything is written as a string except numbers, dates and booleans, which keep
// their type. Golden values come from heterogeneous systems, so a permissive column
// type is the honest default rather than guessing a schema that later rejects a row.
function parameterFor(name, value) {
  if (value === null || value === undefined) return { name, type: TYPES.NVarChar, value: null };
  if (typeof value === 'number') return { name, type: TYPES.Float, value };
  if (typeof value === 'boolean') return { name, type: TYPES.Bit, value };
  if (value instanceof Date) return { name, type: TYPES.DateTime2, value };
  return { name, type: TYPES.NVarChar, value: String(value) };
}

/**
 * A parameterised multi-row INSERT. Values never reach the statement as text, and
 * batches are bounded because SQL Server caps a request at 2100 parameters.
 */
function buildInsertStatements(table, columns, rows, { batchSize } = {}) {
  if (!columns.length) throw new Error('No columns to write.');
  const maxRowsPerBatch = Math.max(1, Math.min(
    Number(batchSize) || Math.floor(2000 / columns.length),
    Math.floor(2000 / columns.length)
  ));

  const quotedTable = quoteIdentifier(table);
  const quotedColumns = columns.map(quoteIdentifier).join(', ');
  const statements = [];

  for (let start = 0; start < rows.length; start += maxRowsPerBatch) {
    const batch = rows.slice(start, start + maxRowsPerBatch);
    const params = [];
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        const name = 'p' + rowIndex + '_' + columnIndex;
        params.push(parameterFor(name, row[column]));
        return '@' + name;
      });
      return '(' + placeholders.join(', ') + ')';
    });
    statements.push({
      sql: 'INSERT INTO ' + quotedTable + ' (' + quotedColumns + ') VALUES ' + tuples.join(', '),
      params,
    });
  }
  return statements;
}

/** `CREATE TABLE IF NOT EXISTS` in the form SQL Server actually accepts. */
function buildCreateTableSql(table, columns) {
  const quotedTable = quoteIdentifier(table);
  const definitions = columns.map(column => quoteIdentifier(column) + ' NVARCHAR(4000) NULL').join(',\n  ');
  return "IF OBJECT_ID(N'" + String(table).replace(/'/g, "''") + "', 'U') IS NULL\n"
    + 'CREATE TABLE ' + quotedTable + ' (\n  ' + definitions + '\n)';
}

/**
 * Writes rows to a destination table.
 *
 * `replace` empties the table first, which is what publishing a freshly mastered
 * set means; `append` adds to what is there. The delete and the inserts run on one
 * connection, in order, so a `replace` cannot leave the table empty because a later
 * batch failed to connect.
 */
async function writeRows(source, { table, columns, rows, mode = 'replace', createIfMissing = false }, options = {}) {
  const writability = describeWritability(source);
  if (!writability.writable) throw new Error(writability.reason);
  if (!rows.length && mode !== 'replace') return { written: 0 };

  const statements = [];
  if (createIfMissing) statements.push({ sql: buildCreateTableSql(table, columns) });
  if (mode === 'replace') statements.push({ sql: 'DELETE FROM ' + quoteIdentifier(table) });
  statements.push(...buildInsertStatements(table, columns, rows));

  await execute(source, statements, options);
  return { written: rows.length };
}

module.exports = {
  AUTH_MODES,
  AUTH_MODE_KEYS,
  describeWritability,
  buildInsertStatements,
  buildCreateTableSql,
  writeRows,
  execute,
  query,
  readRows,
  readSchema,
  shapeSchemaRows,
  testConnection,
  explainSqlFailure,
  _private: { connectionConfig },
};
