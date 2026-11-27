// ── Pages wait less on the database: pooled connections, cached completed runs ──
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const db = require('../src/services/databaseService');
const timing = require('../src/services/requestTimingService');

function fakeConnection(rowsFor = () => []) {
  const conn = new EventEmitter();
  conn.closed = false;
  conn.close = () => { conn.closed = true; };
  conn.execSql = (request) => {
    const rows = rowsFor(request.sqlTextOrProcedure || request.sql || '');
    setImmediate(() => {
      for (const row of rows) {
        request.emit('row', Object.entries(row).map(([colName, value]) => ({ metadata: { colName }, value })));
      }
      request.userCallback(null, rows.length);
    });
  };
  return conn;
}

function withPool(rowsFor, fn) {
  const opened = [];
  db._pool.reset();
  db._pool.useOpener(async () => { const conn = fakeConnection(rowsFor); opened.push(conn); return conn; });
  return Promise.resolve(fn(opened)).finally(() => { db._pool.reset(); db._pool.useOpener(null); });
}

test('a connection is reused instead of signing in to SQL for every query', async () => {
  await withPool(() => [{ id: 1 }], async (opened) => {
    for (let i = 0; i < 5; i += 1) {
      const conn = await db._sql.getConnection();
      await db._sql.execSql(conn, 'SELECT 1');
      conn.close();
    }
    assert.equal(opened.length, 1, 'five queries, one connection');
    assert.equal(db._pool.poolStats().reused, 4);
    assert.equal(opened[0].closed, false, 'returned to the pool, not closed');
  });
});

test('closing twice returns a connection once, and a broken one is never handed out again', async () => {
  await withPool(() => [], async (opened) => {
    const first = await db._sql.getConnection();
    first.close();
    first.close();
    assert.equal(db._pool.poolStats().idle, 1);
    const again = await db._sql.getConnection();
    again.emit('error', new Error('socket hang up'));
    again.close();
    assert.equal(opened[0].closed, true, 'the broken connection is really closed');
    const fresh = await db._sql.getConnection();
    assert.notEqual(fresh, opened[0]);
    fresh.close();
  });
});

test('callers wait for a free connection when all are in use, never sharing one', async () => {
  await withPool(() => [], async (opened) => {
    const held = [];
    for (let i = 0; i < db._pool.POOL_MAX; i += 1) held.push(await db._sql.getConnection());
    let served = null;
    const waiting = db._sql.getConnection().then(conn => { served = conn; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(served, null, 'no connection is shared between two callers');
    held[0].close();
    await waiting;
    assert.equal(served, opened[0]);
    assert.equal(opened.length, db._pool.POOL_MAX);
    held.slice(1).forEach(conn => conn.close());
    served.close();
  });
});

test('a completed run is read from the database once, and each caller gets its own copy', async () => {
  let reads = 0;
  await withPool((sql) => {
    if (/SELECT \* FROM analysis_runs/.test(sql)) { reads += 1; return [{ id: 5, status: 'completed', results_json: '{"workspaces":[]}' }]; }
    return [];
  }, async () => {
    const first = await db.getAnalysisRunById(5);
    first.status = 'changed by a caller';
    const second = await db.getAnalysisRunById(5);
    assert.equal(reads, 1, 'the second request did not download the scan again');
    assert.equal(second.status, 'completed', 'one caller cannot change what the next one sees');
    await db.updateAnalysisRun(5, { status: 'completed', resultsJson: '{}' });
    await db.getAnalysisRunById(5);
    assert.equal(reads, 2, 'a write drops the cached row');
  });
});

test('a run still in progress is never cached', async () => {
  let reads = 0;
  await withPool((sql) => {
    if (/SELECT \* FROM analysis_runs/.test(sql)) { reads += 1; return [{ id: 6, status: 'running', results_json: null }]; }
    return [];
  }, async () => {
    await db.getAnalysisRunById(6);
    await db.getAnalysisRunById(6);
    assert.equal(reads, 2);
  });
});

test('each response says how many queries it made and how long they took', async () => {
  await withPool(() => [], async () => {
    const headers = {};
    const listeners = {};
    const logged = [];
    const res = {
      headersSent: false,
      setHeader(name, value) { headers[name] = value; },
      writeHead() { return this; },
      on(event, fn) { listeners[event] = fn; },
    };
    const middleware = timing.middleware({ log: { warn: line => logged.push(line) } });
    await new Promise((resolve) => {
      middleware({ method: 'GET', originalUrl: '/workspaces?x=1' }, res, async () => {
        const conn = await db._sql.getConnection();
        await db._sql.execSql(conn, 'SELECT 1');
        await db._sql.execSql(conn, 'SELECT 2');
        conn.close();
        res.writeHead(200);
        resolve();
      });
    });
    assert.match(headers['Server-Timing'], /db;dur=[\d.]+;desc="2 queries"/);
    assert.match(headers['Server-Timing'], /app;dur=/);
    listeners.finish();
    assert.equal(logged.length, 0, 'a fast request is not logged');
  });
});
