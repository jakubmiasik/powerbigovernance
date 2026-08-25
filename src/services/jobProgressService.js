/**
 * Progress for work that outlives the request that started it.
 *
 * A bulk decision over a whole rule, or loading a large run's results, takes longer
 * than a browser will wait and longer than a person will stare at a spinner. Both
 * now start a job, return its id, and report where they have got to while they run.
 *
 * The registry is in this process's memory. That is the right trade for work that
 * is measured in seconds to a couple of minutes and is restarted by simply asking
 * again — unlike an analysis run, which can take an hour and therefore earns a
 * database-backed record. A job whose worker died is reported as interrupted rather
 * than left appearing to run.
 */

const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];

// How long a finished job stays readable, so a client that polls slowly still sees
// the outcome rather than "no such job".
const RETAIN_MS = Number.parseInt(process.env.JOB_RETAIN_MS || '600000', 10);

// A job with no heartbeat for this long is treated as abandoned.
const STALE_MS = Number.parseInt(process.env.JOB_STALE_MS || '120000', 10);

const jobs = new Map();
let sequence = 0;

function createJob({ kind, label, total = null, actor = null } = {}) {
  sequence += 1;
  const id = kind + '-' + Date.now().toString(36) + '-' + sequence;
  const now = Date.now();
  const job = {
    id,
    kind,
    label: label || kind,
    actor,
    status: 'running',
    message: 'Starting...',
    total,
    done: 0,
    // Counters the caller fills in; kept free-form so one job type can report
    // "updated / unchanged / skipped" and another "loaded".
    counters: {},
    problems: [],
    result: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  jobs.set(id, job);
  sweep(now);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function updateJob(job, patch = {}) {
  if (!job) return null;
  Object.assign(job, patch);
  job.updatedAt = Date.now();
  return job;
}

function advanceJob(job, by = 1, message = null) {
  if (!job) return null;
  job.done += by;
  if (job.total !== null && job.done > job.total) job.total = job.done;
  if (message) job.message = message;
  job.updatedAt = Date.now();
  return job;
}

function finishJob(job, { status = 'completed', message = null, result = null } = {}) {
  if (!job) return null;
  job.status = status;
  if (message) job.message = message;
  if (result !== null) job.result = result;
  job.finishedAt = Date.now();
  job.updatedAt = job.finishedAt;
  return job;
}

function isTerminal(status) {
  return TERMINAL.includes(status);
}

/** Drops finished jobs once nobody could reasonably still be polling them. */
function sweep(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > RETAIN_MS) jobs.delete(id);
  }
}

/**
 * The wire shape a client polls.
 *
 * A percentage is only reported once the total is known; a job that cannot know its
 * size in advance reports what it has done instead of inventing a denominator.
 */
function summarize(job, now = Date.now()) {
  if (!job) return null;

  const stale = !isTerminal(job.status) && now - job.updatedAt > STALE_MS;
  const status = stale ? 'interrupted' : job.status;
  const elapsedSeconds = Math.floor((now - job.startedAt) / 1000);
  const percent = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;

  // Extrapolate only once there is enough of the job behind us for the estimate to
  // mean something; a guess from the first few rows is worse than no guess.
  let etaSeconds = null;
  if (percent !== null && !isTerminal(status) && job.done > 0 && elapsedSeconds >= 3 && percent < 100) {
    etaSeconds = Math.max(0, Math.round((elapsedSeconds / job.done) * (job.total - job.done)));
  }

  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status,
    live: !isTerminal(status),
    message: stale ? 'This job stopped reporting progress. The application may have restarted.' : job.message,
    done: job.done,
    total: job.total,
    percent,
    counters: job.counters,
    problems: job.problems.slice(0, 50),
    problemCount: job.problems.length,
    result: job.result,
    elapsedSeconds,
    etaSeconds,
  };
}

/**
 * Runs `work` as a job, handing it the job so it can report progress.
 *
 * Returns as soon as the job is registered — the caller replies with the id and the
 * client polls. A throw inside the work marks the job failed rather than becoming an
 * unhandled rejection.
 */
function runJob(options, work) {
  const job = createJob(options);
  Promise.resolve()
    .then(() => work(job))
    .then(result => {
      if (!isTerminal(job.status)) finishJob(job, { status: 'completed', message: 'Finished.', result: result || job.result });
    })
    .catch(err => {
      finishJob(job, { status: 'failed', message: err.message });
    });
  return job;
}

module.exports = {
  RETAIN_MS,
  STALE_MS,
  createJob,
  getJob,
  updateJob,
  advanceJob,
  finishJob,
  isTerminal,
  summarize,
  runJob,
  _private: { jobs, sweep },
};
