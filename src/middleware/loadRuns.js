const db = require('../services/databaseService');

const RUN_CACHE_TTL_MS = parseInt(process.env.RUN_CACHE_TTL_MS || '30000', 10);
let runCache = { expiresAt: 0, runs: [] };

async function getCompletedRuns() {
  const now = Date.now();
  if (runCache.expiresAt > now) {
    return runCache.runs;
  }

  const runs = await Promise.race([
    db.getAnalysisRuns(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 5000)),
  ]);
  const completedRuns = runs.filter(r => r.status === 'completed');
  runCache = { expiresAt: now + RUN_CACHE_TTL_MS, runs: completedRuns };
  return completedRuns;
}

async function loadRuns(req, res, next) {
  res.locals.currentUser = req.user;

  try {
    const completedRuns = await getCompletedRuns();
    res.locals.availableRuns = completedRuns;

    if (req.query.runId) {
      const parsedRunId = Number.parseInt(req.query.runId, 10);
      if (Number.isInteger(parsedRunId)) {
        req.session.selectedRunId = parsedRunId;
      }
    }

    const selectedRunId = req.session.selectedRunId;
    let selectedRun = null;
    if (selectedRunId) {
      selectedRun = completedRuns.find(r => r.id === selectedRunId);
    }
    if (!selectedRun && completedRuns.length > 0) {
      selectedRun = completedRuns[0];
    }

    res.locals.globalRun = selectedRun;
    res.locals.selectedRunId = selectedRun ? selectedRun.id : null;
  } catch {
    res.locals.availableRuns = [];
    res.locals.globalRun = null;
    res.locals.selectedRunId = null;
  }

  next();
}

function clearRunCache() {
  runCache = { expiresAt: 0, runs: [] };
}

module.exports = { loadRuns, clearRunCache };
