const cron = require('node-cron');
const db = require('./databaseService');
const { executeCapacityActionWithSp } = require('./capacityActionService');
const { normalizeTimezone, getTimeInTimezone } = require('./scheduleTimeService');

// How far back a tick looks for a schedule that came due. Without this, a single
// missed minute (restart, idle worker, slow tick) silently skipped the action until
// the next day.
const CATCHUP_WINDOW_MINUTES = Math.max(0, parseInt(process.env.SCHEDULER_CATCHUP_MINUTES || '20', 10) || 0);
const MAX_SLOT_ATTEMPTS = 3;

let schedulerStarted = false;
let schedulerTickInProgress = false;
let lastKickMs = 0;
// scheduleId -> { slotKey, attempts }
const triggeredSlots = new Map();

function getDateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getScheduleMinute(schedule) {
  const minute = parseInt(schedule.schedule_minute, 10);
  return Number.isFinite(minute) ? minute : 0;
}

function getScheduleHour(schedule) {
  const hour = parseInt(schedule.schedule_hour, 10);
  return Number.isFinite(hour) ? hour : 0;
}

function isDueNow(schedule, nowLocal) {
  const type = schedule.schedule_type;
  const minute = getScheduleMinute(schedule);
  const hour = getScheduleHour(schedule);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  if (nowLocal.minute !== minute) return false;
  if (type === 'hourly') return true;
  if (nowLocal.hour !== hour) return false;
  if (type === 'daily') return true;
  if (type === 'weekdays') return nowLocal.dayOfWeek >= 1 && nowLocal.dayOfWeek <= 5;
  if (type === 'weekly') return dayNames[nowLocal.dayOfWeek] === schedule.schedule_day;
  return false;
}

function getScheduleSlotKey(schedule, nowLocal) {
  if (!isDueNow(schedule, nowLocal)) return null;
  const dateKey = getDateKey(nowLocal);
  const hour = String(nowLocal.hour).padStart(2, '0');
  const minute = String(nowLocal.minute).padStart(2, '0');
  if (schedule.schedule_type === 'hourly') return `${dateKey}T${hour}:${minute}`;
  return `${dateKey}T${hour}:${minute}`;
}

function truncateToMinute(date) {
  return new Date(Math.floor(date.getTime() / 60000) * 60000);
}

/**
 * Most recent minute within the catch-up window at which `schedule` was due,
 * or null if it was not due at all. Walking back minute by minute (rather than
 * computing the slot arithmetically) keeps DST transitions correct, because each
 * candidate instant is re-resolved in the schedule's own timezone.
 */
function findDueSlot(schedule, timezone, now, windowMinutes) {
  for (let minutesBack = 0; minutesBack <= windowMinutes; minutesBack += 1) {
    const candidate = truncateToMinute(new Date(now.getTime() - minutesBack * 60000));
    const local = getTimeInTimezone(timezone, candidate);
    const slotKey = getScheduleSlotKey(schedule, local);
    if (slotKey) return { slotKey, dueAt: candidate, minutesLate: minutesBack };
  }
  return null;
}

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

async function runSchedulerTick(source) {
  if (schedulerTickInProgress) return;
  schedulerTickInProgress = true;
  try {
    const schedules = await db.getCapacitySchedules();
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
      await db.logScheduleExecution(
        schedule.id,
        schedule.capacity_name,
        schedule.action,
        'triggered',
        `Scheduler matched ${schedule.schedule_type} schedule at ${due.slotKey} ${timezone} via ${source || 'tick'}${lateNote}`
      );
      const result = await executeSchedule(schedule);
      // Successful and skipped runs are recorded in history, so the database check
      // above blocks a repeat; failures stay retryable until MAX_SLOT_ATTEMPTS.
      if (result.status !== 'error') {
        triggeredSlots.set(scheduleId, { slotKey: due.slotKey, attempts: MAX_SLOT_ATTEMPTS });
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error checking schedules:', err.message);
  } finally {
    schedulerTickInProgress = false;
  }
}

function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  console.log('[Scheduler] Capacity scheduler started');
  cron.schedule('* * * * *', () => runSchedulerTick('cron'));
  runSchedulerTick('startup');
}

function kickScheduler() {
  if (!schedulerStarted) return;
  const nowMs = Date.now();
  if (nowMs - lastKickMs < 15000) return;
  lastKickMs = nowMs;
  runSchedulerTick('request');
}

module.exports = {
  startScheduler,
  kickScheduler,
  _private: { getScheduleSlotKey, isDueNow, executeSchedule, findDueSlot },
};
