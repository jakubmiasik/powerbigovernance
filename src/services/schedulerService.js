const cron = require('node-cron');
const db = require('./databaseService');
const { executeCapacityActionWithSp } = require('./capacityActionService');
const { normalizeTimezone, getTimeInTimezone } = require('./scheduleTimeService');

let schedulerStarted = false;
let schedulerTickInProgress = false;
let lastKickMs = 0;
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
    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      const timezone = normalizeTimezone(schedule.timezone || 'UTC');
      const nowLocal = getTimeInTimezone(timezone, new Date());
      const slotKey = getScheduleSlotKey(schedule, nowLocal);
      if (!slotKey) continue;

      const scheduleId = parseInt(schedule.id, 10);
      if (!Number.isFinite(scheduleId)) continue;
      const memoryKey = `${scheduleId}:${slotKey}`;
      if (triggeredSlots.get(scheduleId) === memoryKey) continue;
      triggeredSlots.set(scheduleId, memoryKey);

      await db.logScheduleExecution(
        schedule.id,
        schedule.capacity_name,
        schedule.action,
        'triggered',
        `Scheduler matched ${schedule.schedule_type} schedule at ${slotKey} ${timezone} via ${source || 'tick'}`
      );
      const result = await executeSchedule(schedule);
      if (result.status === 'error') triggeredSlots.delete(scheduleId);
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
  _private: { getScheduleSlotKey, isDueNow, executeSchedule },
};
