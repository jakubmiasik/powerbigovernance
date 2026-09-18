const db = require('./databaseService');
const { executeCapacityActionWithSp } = require('./capacityActionService');
const { normalizeTimezone } = require('./scheduleTimeService');
const { findDueSlot, isDueNow, getScheduleSlotKey } = require('./scheduleDueService');
const analysisSchedules = require('./analysisScheduleService');

// How far back a tick looks for a schedule that came due. On App Service the worker
// can be recycled or idled out for long stretches, so a 20 minute window silently
// dropped the whole day's action. Four hours keeps a missed pause useful (it still
// saves capacity cost) without replaying something from the previous day.
const CATCHUP_WINDOW_MINUTES = Math.max(0, parseInt(process.env.SCHEDULER_CATCHUP_MINUTES || '240', 10) || 0);
const TICK_INTERVAL_MS = Math.max(15000, parseInt(process.env.SCHEDULER_TICK_MS || '60000', 10) || 60000);
const KICK_THROTTLE_MS = Math.max(5000, parseInt(process.env.SCHEDULER_KICK_THROTTLE_MS || '15000', 10) || 15000);
const MAX_SLOT_ATTEMPTS = 3;

let schedulerStarted = false;
let schedulerTickInProgress = false;
let tickTimer = null;
let lastKickMs = 0;
// scheduleId -> { slotKey, attempts }
const triggeredSlots = new Map();

// Observability, so "nothing ran and there is no log to prove it" is diagnosable.
const status = {
  started: false,
  startedAt: null,
  tickIntervalMs: TICK_INTERVAL_MS,
  catchUpWindowMinutes: CATCHUP_WINDOW_MINUTES,
  tickCount: 0,
  lastTickAt: null,
  lastTickSource: null,
  lastTickDurationMs: null,
  schedulesLoaded: 0,
  enabledSchedules: 0,
  analysisSchedulesLoaded: 0,
  enabledAnalysisSchedules: 0,
  lastAnalysisAt: null,
  lastAnalysisSummary: null,
  lastDueAt: null,
  lastActionAt: null,
  lastActionSummary: null,
  lastError: null,
  lastErrorAt: null,
};

// The due-time logic — including the daylight-saving-correct catch-up walk — now
// lives in scheduleDueService, because analysis scans are scheduled too and the
// two must agree about what "daily at 07:00 Europe/Warsaw" means.

async function getServicePrincipalForSchedule(schedule) {
  const allSps = await db.getServicePrincipals();
  if (allSps.length === 0) return null;
  const preferredSpId = schedule.sp_id != null ? parseInt(schedule.sp_id, 10) : null;
  if (Number.isFinite(preferredSpId)) {
    const preferred = allSps.find(sp => parseInt(sp.id, 10) === preferredSpId);
    if (preferred) return preferred;
  }
  return allSps[0];
}

async function executeSchedule(schedule) {
  try {
    const sp = await getServicePrincipalForSchedule(schedule);
    if (!sp) {
      await db.logScheduleExecution(schedule.id, schedule.capacity_name, schedule.action, 'error', 'No service principal configured');
      return { status: 'error', message: 'No service principal configured' };
    }

    const result = await executeCapacityActionWithSp(sp, {
      subscriptionId: schedule.subscription_id,
      resourceGroup: schedule.resource_group,
      capacityName: schedule.capacity_name,
      action: schedule.action,
    });
    await db.logScheduleExecution(schedule.id, schedule.capacity_name, schedule.action, result.status, result.message);
    return result;
  } catch (err) {
    console.error(`[Scheduler] Error executing schedule ${schedule.id}:`, err.message);
    await db.logScheduleExecution(schedule.id, schedule.capacity_name, schedule.action, 'error', err.message);
    return { status: 'error', message: err.message };
  }
}

/**
 * The analysis half of a tick.
 *
 * It shares the timer rather than running its own: a second interval would mean a
 * second self-healing path, a second catch-up window and two things to explain
 * when nothing ran. The attempt keys are namespaced so a capacity schedule and an
 * analysis schedule with the same id cannot shadow each other.
 */
async function runAnalysisSchedules(now, source) {
  let schedules = [];
  try {
    schedules = await db.getAnalysisSchedules();
  } catch (err) {
    // A missing table on an un-migrated instance must not take the capacity
    // scheduler down with it.
    console.warn('[Scheduler] Could not read analysis schedules:', err.message);
    return;
  }
  status.analysisSchedulesLoaded = schedules.length;
  status.enabledAnalysisSchedules = schedules.filter(schedule => schedule.enabled).length;
  if (!schedules.length) return;

  const lastRuns = new Map();
  for (const row of await db.getLastAnalysisScheduleRuns().catch(() => [])) {
    const id = parseInt(row.schedule_id, 10);
    const executedAt = row.last_executed_at ? new Date(row.last_executed_at) : null;
    if (Number.isFinite(id) && executedAt && !Number.isNaN(executedAt.getTime())) {
      lastRuns.set(id, executedAt);
    }
  }

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    const scheduleId = parseInt(schedule.id, 10);
    if (!Number.isFinite(scheduleId)) continue;

    const timezone = normalizeTimezone(schedule.timezone || 'UTC');
    const due = findDueSlot(schedule, timezone, now, CATCHUP_WINDOW_MINUTES);
    if (!due) continue;

    const key = 'analysis:' + scheduleId;
    const attemptState = triggeredSlots.get(key);
    const attempts = attemptState && attemptState.slotKey === due.slotKey ? attemptState.attempts : 0;
    if (attempts >= MAX_SLOT_ATTEMPTS) continue;

    // The database is what stops a repeat across workers and restarts. A scan is
    // expensive enough that starting it twice is worth more than one guard.
    const lastRunAt = lastRuns.get(scheduleId);
    if (lastRunAt && lastRunAt.getTime() >= due.dueAt.getTime()) {
      triggeredSlots.set(key, { slotKey: due.slotKey, attempts: MAX_SLOT_ATTEMPTS });
      continue;
    }
    triggeredSlots.set(key, { slotKey: due.slotKey, attempts: attempts + 1 });

    const lateNote = due.minutesLate > 0 ? ` (catch-up, ${due.minutesLate} min late)` : '';
    console.log(`[Scheduler] Analysis schedule ${scheduleId} (${schedule.name}) due at ${due.slotKey} ${timezone}${lateNote}`);
    const result = await analysisSchedules.executeSchedule(schedule, { source: source || 'tick' });
    status.lastAnalysisAt = new Date().toISOString();
    status.lastAnalysisSummary = `${schedule.name}: ${result.status} — ${result.message}`;
    if (result.status !== 'error') {
      triggeredSlots.set(key, { slotKey: due.slotKey, attempts: MAX_SLOT_ATTEMPTS });
    }
  }
}

async function runSchedulerTick(source) {
  if (schedulerTickInProgress) return;
  schedulerTickInProgress = true;
  const tickStartedAt = Date.now();
  status.tickCount += 1;
  status.lastTickAt = new Date().toISOString();
  status.lastTickSource = source || 'tick';
  try {
    const schedules = await db.getCapacitySchedules();
    status.schedulesLoaded = schedules.length;
    status.enabledSchedules = schedules.filter(s => s.enabled).length;
    if (!schedules.length) return;

    // Completed runs recorded in the database, so a restart mid-window does not
    // replay an action that already happened.
    const lastExecutions = new Map();
    for (const row of await db.getLastScheduleExecutions()) {
      const id = parseInt(row.schedule_id, 10);
      const executedAt = row.last_executed_at ? new Date(row.last_executed_at) : null;
      if (Number.isFinite(id) && executedAt && !Number.isNaN(executedAt.getTime())) {
        lastExecutions.set(id, executedAt);
      }
    }

    const now = new Date();
    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      const scheduleId = parseInt(schedule.id, 10);
      if (!Number.isFinite(scheduleId)) continue;

      const timezone = normalizeTimezone(schedule.timezone || 'UTC');
      const due = findDueSlot(schedule, timezone, now, CATCHUP_WINDOW_MINUTES);
      if (!due) continue;

      status.lastDueAt = new Date().toISOString();

      const attemptState = triggeredSlots.get(scheduleId);
      const attempts = attemptState && attemptState.slotKey === due.slotKey ? attemptState.attempts : 0;
      if (attempts >= MAX_SLOT_ATTEMPTS) continue;

      const lastExecutedAt = lastExecutions.get(scheduleId);
      if (lastExecutedAt && lastExecutedAt.getTime() >= due.dueAt.getTime()) {
        triggeredSlots.set(scheduleId, { slotKey: due.slotKey, attempts: MAX_SLOT_ATTEMPTS });
        continue;
      }
      triggeredSlots.set(scheduleId, { slotKey: due.slotKey, attempts: attempts + 1 });

      const lateNote = due.minutesLate > 0 ? ` (catch-up, ${due.minutesLate} min late)` : '';
      console.log(`[Scheduler] Schedule ${schedule.id} (${schedule.action} ${schedule.capacity_name}) due at ${due.slotKey} ${timezone}${lateNote}`);
      await db.logScheduleExecution(
        schedule.id,
        schedule.capacity_name,
        schedule.action,
        'triggered',
        `Scheduler matched ${schedule.schedule_type} schedule at ${due.slotKey} ${timezone} via ${source || 'tick'}${lateNote}`
      );
      const result = await executeSchedule(schedule);
      status.lastActionAt = new Date().toISOString();
      status.lastActionSummary = `${schedule.action} ${schedule.capacity_name}: ${result.status} — ${result.message}`;
      // Successful and skipped runs are recorded in history, so the database check
      // above blocks a repeat; failures stay retryable until MAX_SLOT_ATTEMPTS.
      if (result.status !== 'error') {
        triggeredSlots.set(scheduleId, { slotKey: due.slotKey, attempts: MAX_SLOT_ATTEMPTS });
      }
    }

    await runAnalysisSchedules(now, source);
  } catch (err) {
    status.lastError = err.message;
    status.lastErrorAt = new Date().toISOString();
    console.error('[Scheduler] Error checking schedules:', err.message);
  } finally {
    status.lastTickDurationMs = Date.now() - tickStartedAt;
    schedulerTickInProgress = false;
  }
}

function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  status.started = true;
  status.startedAt = new Date().toISOString();
  console.log(`[Scheduler] Scheduler started for capacity actions and analysis scans (tick ${TICK_INTERVAL_MS}ms, catch-up ${CATCHUP_WINDOW_MINUTES} min)`);
  // A plain interval rather than a cron expression: the tick is "every minute"
  // either way, and this keeps the cron parser out of the critical path.
  tickTimer = setInterval(() => runSchedulerTick('timer'), TICK_INTERVAL_MS);
  if (typeof tickTimer.unref === 'function') tickTimer.unref();
  runSchedulerTick('startup');
}

function stopScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  schedulerStarted = false;
  status.started = false;
}

function kickScheduler() {
  // Self-healing: if bootstrap failed or was never reached, incoming traffic starts
  // the scheduler rather than leaving the instance permanently idle.
  if (!schedulerStarted) {
    startScheduler();
    return;
  }
  const nowMs = Date.now();
  if (nowMs - lastKickMs < KICK_THROTTLE_MS) return;
  lastKickMs = nowMs;
  runSchedulerTick('request');
}

// Manual run behind the "Run scheduler now" diagnostic action; bypasses the kick
// throttle so an operator gets an immediate answer.
async function runSchedulerNow() {
  if (!schedulerStarted) startScheduler();
  await runSchedulerTick('manual');
  return getSchedulerStatus();
}

function getSchedulerStatus() {
  return { ...status, tickInProgress: schedulerTickInProgress };
}

module.exports = {
  startScheduler,
  stopScheduler,
  kickScheduler,
  runSchedulerNow,
  getSchedulerStatus,
  _private: { getScheduleSlotKey, isDueNow, executeSchedule, findDueSlot, runSchedulerTick, runAnalysisSchedules },
};
