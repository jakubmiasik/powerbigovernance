/**
 * Progress accounting for an analysis run.
 *
 * A run is long enough that the user is expected to leave it alone and come back,
 * so "how far along is it" has to be answerable from data rather than from a
 * percentage the run happened to assign itself. The run is therefore described as
 * an ordered list of phases, each with a unit count, and the overall figure is
 * derived from those counts.
 *
 * The module is deliberately free of database, API and clock dependencies — every
 * function takes the state (and, where time matters, `now`) so it can be tested
 * directly.
 */

// Weights are relative cost, measured by which phases actually dominate a run:
// one API call per storage item and one per artifact make those two phases the
// bulk of the wall clock, while the tenant-wide list calls are near-constant.
const PHASES = [
  { key: 'workspaces', label: 'Workspaces', weight: 2 },
  { key: 'items', label: 'Items', weight: 8 },
  { key: 'capacities', label: 'Capacities', weight: 1 },
  { key: 'pipelines', label: 'Deployment pipelines', weight: 1 },
  { key: 'workspaceDetails', label: 'Workspace details', weight: 2 },
  { key: 'access', label: 'Workspace access', weight: 8 },
  { key: 'storage', label: 'OneLake storage', weight: 40 },
  { key: 'details', label: 'Artifact details', weight: 30 },
  { key: 'tenantSettings', label: 'Tenant settings', weight: 3 },
  { key: 'save', label: 'Saving results', weight: 5 },
];

const TOTAL_WEIGHT = PHASES.reduce((sum, phase) => sum + phase.weight, 0);

// A phase whose size is not known up front (a single tenant-wide call) still has to
// contribute something between "not started" and "done", or the bar would sit still
// through it.
const UNSIZED_ACTIVE_FRACTION = 0.5;

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'];

// How long a persisted run may go without a heartbeat before it is treated as
// abandoned rather than slow. Generous on purpose: a single very slow API call must
// not be mistaken for a dead process.
const HEARTBEAT_STALE_SECONDS = Number.parseInt(process.env.ANALYSIS_HEARTBEAT_STALE_SECONDS || '900', 10);

function createProgress({ runId = null, spName = null, startedAt = Date.now() } = {}) {
  return {
    runId,
    spName,
    status: 'running',
    phase: 'Starting',
    phaseKey: null,
    message: 'Starting analysis...',
    detail: '',
    // Kept for the callers that still read them; the phase list is the real source.
    current: 0,
    total: 0,
    cancelRequested: false,
    startedAt,
    updatedAt: startedAt,
    throttledUntil: null,
    counters: { apiCalls: 0, retries: 0, throttled: 0, failures: 0, waitedMs: 0, skippedItems: 0 },
    events: [],
    phases: PHASES.map(phase => ({
      key: phase.key,
      label: phase.label,
      weight: phase.weight,
      state: 'pending',
      done: 0,
      // null means "size not known yet"; 0 means "known to be empty".
      total: null,
      note: null,
    })),
  };
}

function findPhase(state, key) {
  return (state.phases || []).find(phase => phase.key === key) || null;
}

function touch(state, now = Date.now()) {
  state.updatedAt = now;
}

/**
 * Marks a phase as the one in flight. Any earlier phase still marked active is
 * closed off, so a phase that returns early (an error swallowed by a `catch`)
 * cannot leave the run looking permanently stuck on it.
 */
function beginPhase(state, key, { total = null, message = null, now = Date.now() } = {}) {
  const target = findPhase(state, key);
  if (!target) return state;

  for (const phase of state.phases) {
    if (phase === target) break;
    if (phase.state === 'active' || phase.state === 'pending') {
      phase.state = phase.state === 'active' ? 'done' : 'skipped';
      if (phase.state === 'done' && phase.total !== null) phase.done = phase.total;
    }
  }

  target.state = 'active';
  if (total !== null) target.total = total;
  state.phaseKey = key;
  state.phase = target.label;
  if (message) state.message = message;
  state.detail = '';
  touch(state, now);
  return state;
}

function setPhaseTotal(state, key, total, now = Date.now()) {
  const target = findPhase(state, key);
  if (!target) return state;
  target.total = Math.max(0, Number(total) || 0);
  touch(state, now);
  return state;
}

function advancePhase(state, key, { done = null, increment = 0, detail = null, message = null, now = Date.now() } = {}) {
  const target = findPhase(state, key);
  if (!target) return state;
  if (done !== null) target.done = Math.max(0, Number(done) || 0);
  else if (increment) target.done += increment;
  if (target.total !== null && target.done > target.total) target.total = target.done;
  if (detail !== null) state.detail = detail;
  if (message !== null) state.message = message;
  touch(state, now);
  return state;
}

function completePhase(state, key, { note = null, now = Date.now() } = {}) {
  const target = findPhase(state, key);
  if (!target) return state;
  target.state = 'done';
  if (target.total === null) target.total = target.done;
  else target.done = target.total;
  if (note) target.note = note;
  touch(state, now);
  return state;
}

function skipPhase(state, key, { note = null, now = Date.now() } = {}) {
  const target = findPhase(state, key);
  if (!target) return state;
  target.state = 'skipped';
  if (target.total === null) target.total = 0;
  if (note) target.note = note;
  touch(state, now);
  return state;
}

function phaseFraction(phase) {
  if (phase.state === 'done' || phase.state === 'skipped') return 1;
  if (phase.state === 'pending') return 0;
  if (phase.total === null) return UNSIZED_ACTIVE_FRACTION;
  if (phase.total === 0) return 1;
  return Math.min(1, phase.done / phase.total);
}

/** Weighted completion across all phases, 0-100. */
function overallPercent(state) {
  if (!state || !Array.isArray(state.phases)) return 0;
  const weighted = state.phases.reduce((sum, phase) => sum + phase.weight * phaseFraction(phase), 0);
  const total = state.phases.reduce((sum, phase) => sum + phase.weight, 0) || TOTAL_WEIGHT;
  const percent = Math.round((weighted / total) * 100);
  // A run that is still going must never read 100%, or "done" and "nearly done"
  // become indistinguishable — which is exactly the confusion this replaces.
  if (state.status === 'running' || state.status === 'cancelling') return Math.min(99, percent);
  if (state.status === 'completed') return 100;
  return percent;
}

/** Countable work across sized phases: what has been done and what is left. */
function unitTotals(state) {
  let done = 0;
  let total = 0;
  for (const phase of state.phases || []) {
    if (phase.total === null) continue;
    total += phase.total;
    done += phase.state === 'done' || phase.state === 'skipped' ? phase.total : Math.min(phase.done, phase.total);
  }
  return { done, total, remaining: Math.max(0, total - done) };
}

/**
 * Seconds still expected, extrapolated from elapsed time and weighted completion.
 * Withheld early in a run, where the estimate would swing wildly and be worse than
 * saying nothing.
 */
function estimateRemainingSeconds(state, now = Date.now()) {
  if (state.status !== 'running' && state.status !== 'cancelling') return null;
  const elapsed = (now - timestamp(state.startedAt, now)) / 1000;
  if (elapsed < 20) return null;
  const fraction = overallPercent(state) / 100;
  if (fraction < 0.05) return null;
  return Math.max(0, Math.round(elapsed / fraction - elapsed));
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * The wire shape the UI polls. `stalled` and `throttled` are kept apart on purpose:
 * a run waiting out a documented rate limit is behaving correctly, and calling that
 * "stalled" trains people to ignore the warning that matters.
 */
// `|| now` would treat a zero timestamp as "missing"; timestamps are only ever
// absent, never meaningfully falsy.
function timestamp(value, fallback) {
  return value === null || value === undefined ? fallback : value;
}

function summarize(state, { now = Date.now(), stallSeconds = 90 } = {}) {
  const secondsSinceUpdate = Math.floor((now - timestamp(state.updatedAt, now)) / 1000);
  const throttleRemaining = state.throttledUntil && state.throttledUntil > now
    ? Math.ceil((state.throttledUntil - now) / 1000)
    : 0;
  const units = unitTotals(state);
  const active = state.phaseKey ? findPhase(state, state.phaseKey) : null;
  const live = state.status === 'running' || state.status === 'cancelling';

  return {
    runId: state.runId,
    status: state.status,
    progress: overallPercent(state),
    phase: state.phase,
    phaseKey: state.phaseKey,
    message: state.message,
    detail: state.detail,
    phases: (state.phases || []).map(phase => ({
      key: phase.key,
      label: phase.label,
      state: phase.state,
      done: phase.done,
      total: phase.total,
      note: phase.note,
    })),
    phaseDone: active ? active.done : 0,
    phaseTotal: active ? active.total : null,
    unitsDone: units.done,
    unitsTotal: units.total,
    unitsRemaining: units.remaining,
    counters: state.counters,
    events: state.events || [],
    elapsedSeconds: Math.floor((now - timestamp(state.startedAt, now)) / 1000),
    secondsSinceUpdate,
    etaSeconds: estimateRemainingSeconds(state, now),
    throttleRemainingSeconds: throttleRemaining,
    stalled: live && !throttleRemaining && secondsSinceUpdate >= stallSeconds,
    stallThresholdSeconds: stallSeconds,
    live,
  };
}

/**
 * Rebuilds a summary from a persisted snapshot, for a run this process is not the
 * one executing — a different worker, or the same one after a restart.
 *
 * A snapshot that says "running" but has not been written to in a long time is
 * reported as `interrupted`, because the process that owned it is gone. Saying
 * "unknown" there, as the in-memory-only version did, left the user with a run that
 * appeared to be going forever.
 */
function fromSnapshot(snapshot, { now = Date.now(), stallSeconds = 90, staleSeconds = HEARTBEAT_STALE_SECONDS } = {}) {
  if (!snapshot) return null;
  const state = createProgress({
    runId: snapshot.runId,
    startedAt: timestamp(snapshot.startedAt, now),
  });
  Object.assign(state, {
    status: snapshot.status || 'running',
    phase: snapshot.phase || 'Starting',
    phaseKey: snapshot.phaseKey || null,
    message: snapshot.message || '',
    detail: snapshot.detail || '',
    updatedAt: timestamp(snapshot.updatedAt, now),
    counters: snapshot.counters || state.counters,
    events: snapshot.events || [],
    throttledUntil: snapshot.throttledUntil || null,
  });
  if (Array.isArray(snapshot.phases) && snapshot.phases.length) {
    for (const phase of state.phases) {
      const stored = snapshot.phases.find(p => p.key === phase.key);
      if (!stored) continue;
      phase.state = stored.state || phase.state;
      phase.done = Number(stored.done) || 0;
      phase.total = stored.total === null || stored.total === undefined ? null : Number(stored.total);
      phase.note = stored.note || null;
    }
  }

  const staleFor = Math.floor((now - timestamp(snapshot.updatedAt, now)) / 1000);
  if (!isTerminal(state.status) && staleFor >= staleSeconds) {
    state.status = 'interrupted';
    state.message = 'This run stopped reporting progress ' + Math.round(staleFor / 60) +
      ' minute(s) ago. The application most likely restarted while it was in flight.';
  }

  return { ...summarize(state, { now, stallSeconds }), fromSnapshot: true };
}

/** The persisted shape — small enough to write every few seconds. */
function toSnapshot(state) {
  return {
    runId: state.runId,
    status: state.status,
    phase: state.phase,
    phaseKey: state.phaseKey,
    message: state.message,
    detail: state.detail,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    throttledUntil: state.throttledUntil,
    counters: state.counters,
    events: state.events,
    phases: (state.phases || []).map(phase => ({
      key: phase.key,
      state: phase.state,
      done: phase.done,
      total: phase.total,
      note: phase.note,
    })),
  };
}

module.exports = {
  PHASES,
  HEARTBEAT_STALE_SECONDS,
  createProgress,
  findPhase,
  beginPhase,
  setPhaseTotal,
  advancePhase,
  completePhase,
  skipPhase,
  overallPercent,
  unitTotals,
  estimateRemainingSeconds,
  isTerminal,
  summarize,
  fromSnapshot,
  toSnapshot,
};
