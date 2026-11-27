/**
 * How long a request spent in the database, and how many queries it made.
 *
 * Every response carries a Server-Timing header (visible in the browser's
 * developer tools, Network → Timing), and a request slower than
 * SLOW_REQUEST_MS is logged with its query count, so a slow page can be traced
 * to its queries without a profiler.
 */

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();
const SLOW_REQUEST_MS = Number.parseInt(process.env.SLOW_REQUEST_MS || '1500', 10);

function recordQuery(ms) {
  const timing = storage.getStore();
  if (!timing) return;
  timing.queries += 1;
  timing.dbMs += ms;
}

function recordCacheHit() {
  const timing = storage.getStore();
  if (timing) timing.cacheHits += 1;
}

function current() {
  return storage.getStore() || null;
}

function middleware({ log = console } = {}) {
  return function requestTiming(req, res, next) {
    const timing = { started: process.hrtime.bigint(), queries: 0, dbMs: 0, cacheHits: 0 };
    // Set before the headers go out: writeHead is the last moment to add one.
    const writeHead = res.writeHead;
    res.writeHead = function timedWriteHead(...args) {
      const total = Number(process.hrtime.bigint() - timing.started) / 1e6;
      if (!res.headersSent && typeof res.setHeader === 'function') {
        try {
          res.setHeader('Server-Timing',
            `db;dur=${timing.dbMs.toFixed(1)};desc="${timing.queries} queries", cache;desc="${timing.cacheHits} hits", app;dur=${total.toFixed(1)}`);
        } catch { /* headers already sent */ }
      }
      return writeHead.apply(this, args);
    };
    if (typeof res.on === 'function') {
      res.on('finish', () => {
        const total = Number(process.hrtime.bigint() - timing.started) / 1e6;
        if (total >= SLOW_REQUEST_MS) {
          log.warn(`[Slow] ${req.method} ${(req.originalUrl || req.url || '').split('?')[0]} ${Math.round(total)} ms`
            + ` — ${timing.queries} queries, ${Math.round(timing.dbMs)} ms in SQL, ${timing.cacheHits} cache hits`);
        }
      });
    }
    storage.run(timing, next);
  };
}

module.exports = { middleware, recordQuery, recordCacheHit, current, SLOW_REQUEST_MS };
