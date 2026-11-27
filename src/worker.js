/**
 * The scan worker: runs queued scans outside the web process.
 *
 * Start it with `npm run worker` next to the web app, and set
 * ANALYSIS_WORKER_MODE=external on both. The web app then only queues scans; this
 * process claims them one at a time from SQL, runs them, and reports progress to
 * the same tables the pages already read. A web restart or a deployment no longer
 * touches a running scan, and a worker that stops mid-scan leaves a run that is
 * marked interrupted and queued once more.
 *
 * Cancelling works through the stored status: the page marks the run
 * 'cancelling', and the worker checks it while the scan runs.
 */

const os = require('os');

const CANCEL_CHECK_MS = 15000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One pass: tidy abandoned runs, then claim and run at most one queued scan.
 * Returns the id of the run it ran, or null when the queue was empty.
 */
async function runOnce(deps) {
  const { db, runAnalysis, activeAnalyses, workerId, staleSeconds, maxAttempts, log = console } = deps;

  try {
    const interrupted = await db.markInterruptedRuns(staleSeconds);
    if (interrupted.length) log.warn('[Worker] Marked abandoned run(s) as interrupted:', interrupted.join(', '));
    const requeued = await db.requeueInterruptedRuns(maxAttempts);
    if (requeued.length) log.warn('[Worker] Queued interrupted run(s) again:', requeued.join(', '));
  } catch (err) {
    log.warn('[Worker] Could not reconcile abandoned runs:', err.message);
  }

  const claimed = await db.claimQueuedRun(workerId);
  if (!claimed) return null;
  if (deps.onClaim) deps.onClaim(claimed.id);

  const sp = await db.getServicePrincipalById(claimed.sp_id);
  if (!sp) {
    await db.updateAnalysisRun(claimed.id, {
      status: 'failed', resultsJson: JSON.stringify({ error: 'The service principal for this scan no longer exists.' }),
    });
    return claimed.id;
  }

  log.log('[Worker] Running scan', claimed.id, 'for', sp.name, '(attempt ' + (claimed.attempts || 1) + ')');
  const scope = {
    kind: claimed.scope_kind || 'tenant',
    workspaceIds: (() => { try { return JSON.parse(claimed.scope_workspaces || '[]'); } catch { return []; } })(),
  };

  // Hears a cancel request made on the page and passes it to the running scan.
  const watcher = setInterval(async () => {
    try {
      if ((await db.getRunStatus(claimed.id)) === 'cancelling') {
        const progress = activeAnalyses.get(claimed.id);
        if (progress && !progress.cancelRequested) {
          progress.cancelRequested = true;
          progress.status = 'cancelling';
          progress.message = 'Cancellation requested...';
        }
      }
    } catch { /* the next check tries again */ }
  }, deps.cancelCheckMs || CANCEL_CHECK_MS);
  if (watcher.unref) watcher.unref();

  try {
    await runAnalysis(claimed.id, sp, {}, scope);
  } finally {
    clearInterval(watcher);
  }
  return claimed.id;
}

// What /health reports, so a host (App Service, Container Apps) can see the
// worker is alive and when it last looked at the queue.
const state = { startedAt: new Date().toISOString(), lastPollAt: null, lastRunId: null, lastError: null, running: null };

async function runWorker(deps) {
  const { pollMs = 10000, shouldStop = () => false, log = console } = deps;
  log.log('[Worker] Scan worker', deps.workerId, 'started; checking the queue every', Math.round(pollMs / 1000), 's');
  while (!shouldStop()) {
    let ran = null;
    state.lastPollAt = new Date().toISOString();
    try {
      ran = await runOnce({ ...deps, onClaim: (id) => { state.running = id; } });
      state.lastError = null;
      if (ran) state.lastRunId = ran;
    } catch (err) {
      state.lastError = err.message;
      log.warn('[Worker] Queue check failed:', err.message);
    } finally {
      state.running = null;
    }
    // Straight on to the next run when there was one; otherwise wait.
    if (!ran) await sleep(pollMs);
  }
}

/** A minimal HTTP endpoint, only when the host gives the process a port. */
function startHealthServer(port) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const healthy = req.url.split('?')[0] === '/health';
    res.writeHead(healthy ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthy ? { status: 'healthy', role: 'scan-worker', ...state } : { error: 'not found' }));
  });
  server.listen(port, '0.0.0.0');
  return server;
}

if (require.main === module) {
  require('dotenv').config();
  if (process.env.PORT) startHealthServer(Number.parseInt(process.env.PORT, 10));
  const db = require('./services/databaseService');
  const { HEARTBEAT_STALE_SECONDS } = require('./services/runProgressService');
  const { getConfig } = require('./config/settings');
  const analysis = require('./routes/analysis');
  const config = getConfig();
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      // The run in progress is left to finish its current step; if the process is
      // killed first, the run is marked interrupted and queued again.
      console.warn('[Worker] Stopping after the current scan (' + signal + ').');
      stopping = true;
    });
  }
  require('./services/authService').onCredentialExpiry((id, expiresOn, source) => db.recordCredentialExpiry(id, expiresOn, source));
  db.runMigrations()
    .catch(err => console.warn('[Worker] Migrations failed:', err.message))
    .then(() => runWorker({
      db,
      runAnalysis: analysis._runAnalysis,
      activeAnalyses: analysis._activeAnalyses,
      workerId: os.hostname() + ':' + process.pid,
      staleSeconds: HEARTBEAT_STALE_SECONDS,
      maxAttempts: config.analysis.maxAttempts,
      pollMs: config.analysis.workerPollMs,
      shouldStop: () => stopping,
    }))
    .then(() => process.exit(0));
}

module.exports = { runOnce, runWorker, startHealthServer, _state: state };
