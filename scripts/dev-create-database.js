#!/usr/bin/env node
/**
 * Local development only: creates the database in the dev container's SQL Server,
 * waiting for the server to accept connections first. The app's own migrations
 * create the tables when it starts.
 */
const { Connection, Request, TYPES } = require('tedious');

const server = process.env.SQL_SERVER;
const database = process.env.SQL_DATABASE;
const user = process.env.SQL_USER;
const password = process.env.SQL_PASSWORD;

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Connection({
      server,
      authentication: { type: 'default', options: { userName: user, password } },
      options: { database: 'master', encrypt: true, trustServerCertificate: true, port: Number(process.env.SQL_PORT || 1433) },
    });
    conn.on('connect', err => (err ? reject(err) : resolve(conn)));
    conn.connect();
  });
}

async function main() {
  if (!server || !database || !user || !password) {
    console.log('[dev-db] SQL_SERVER, SQL_DATABASE, SQL_USER and SQL_PASSWORD are not all set; nothing to do.');
    return;
  }
  let conn;
  for (let attempt = 1; attempt <= 30 && !conn; attempt += 1) {
    try { conn = await connect(); } catch (err) {
      if (attempt === 30) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  await new Promise((resolve, reject) => {
    const request = new Request(`IF DB_ID(@db) IS NULL
BEGIN
  DECLARE @sql NVARCHAR(400) = N'CREATE DATABASE ' + QUOTENAME(@db);
  EXEC sp_executesql @sql;
END`, err => (err ? reject(err) : resolve()));
    request.addParameter('db', TYPES.NVarChar, database);
    conn.execSql(request);
  });
  conn.close();
  console.log('[dev-db] Database ' + database + ' is ready. Start the app with: npm start');
}

main().catch(err => { console.error('[dev-db]', err.message); process.exit(1); });
