const cron = require('node-cron');
const db = require('./databaseService');
const { createPowerBIService } = require('./powerbiService');
const { convertScheduleToUtc } = require('./scheduleTimeService');

let schedulerStarted = false;
const lastTriggeredSlots = new Map();
let schedulerTickInProgress = false;
let lastKickMs = 0;

async function runScheduleWithSp(schedule, sp) {
  const pbi = createPowerBIService(sp);
  const { subscription_id, resource_group, capacity_name, action } = schedule;
  const spLabel = `${sp.name || 'SP'} (${sp.id})`;
  console.log(`[Scheduler] Trying ${action} on "${capacity_name}" via ${spLabel}`);

  // Check current state before executing to avoid 400 errors
  try {
    const detail = await pbi.getArmCapacityDetail(subscription_id, resource_group, capacity_name);
    const currentState = (detail.properties && detail.properties.state) || '';
    const provisioningState = (detail.properties && detail.properties.provisioningState) || '';

    // Skip if already in target state
    if (action === 'suspend' && (currentState === 'Paused' || currentState === 'Suspended')) {
      return { status: 'skipped', message: `Capacity already paused (checked with ${spLabel})` };
    }
    if (action === 'resume' && currentState === 'Active') {
      return { status: 'skipped', message: `Capacity already active (checked with ${spLabel})` };
    }
    // Skip if in transitional state (provisioning, updating, etc.)
    if (provisioningState && provisioningState !== 'Succeeded') {
      return { status: 'skipped', message: `Capacity in transitional state: ${provisioningState}` };
    }
  } catch (stateErr) {
    // Continue anyway — worst case we get an action error and try next SP
    console.warn(`[Scheduler] State check failed for "${capacity_name}" via ${spLabel}:`, stateErr.message);
  }

  if (action === 'suspend') {
    await pbi.suspendCapacity(subscription_id, resource_group, capacity_name);
  } else if (action === 'resume') {
    await pbi.resumeCapacity(subscription_id, resource_group, capacity_name);
  } else {
    throw new Error(`Unsupported schedule action "${action}"`);
  }

  return { status: 'success', message: `${action} completed successfully via ${spLabel}` };
}

async function executeSchedule(schedule) {
  try {
    const allSps = await db.getServicePrincipals();
    if (allSps.length === 0) {
      console.log('[Scheduler] No SP configured, skipping schedule', schedule.id);
      await db.logScheduleExecution(schedule.id, schedule.capacity_name, schedule.action, 'error', 'No service principal configured');
      return { status: 'error', message: 'No service principal configured' };
    }

    const preferredSpId = schedule.sp_id != null ? parseInt(schedule.sp_id, 10) : null;
    const preferred = Number.isFinite(preferredSpId) ? allSps.find(sp => parseInt(sp.id, 10) === preferredSpId) : null;
    const candidates = preferred
      ? [preferred].concat(allSps.filter(sp => parseInt(sp.id, 10) !== parseInt(preferred.id, 10)))
      : allSps;

    let lastError = null;
    for (const sp of candidates) {
      try {
        const result = await runScheduleWithSp(schedule, sp);
        await db.logScheduleExecution(schedule.id, schedule.capacity_name, schedule.action, result.status, result.message);
        return result;
      } catch (err) {
        lastError = err;
        console.warn(`[Scheduler] Attempt failed for schedule ${schedule.id} via SP ${sp.id}:`, err.message);
      }
    }

    throw lastError || new Error('No service principal was able to execute this schedule.');
  } catch (err) {
    console.error(`[Scheduler] Error executing schedule ${schedule.id}:`, err.message);
    await db.logScheduleExecution(schedule.id, schedule.capacity_name, schedule.action, 'error', err.message);
    return { status: 'error', message: err.message };
  }
}


function isScheduleResultComplete(result) {
  if (!result) return false;
  if (result.status === 'success') return true;
  return result.status === 'skipped' && /already (paused|active)/i.test(result.message || '');
}

function buildCronExpression(schedule) {
  const min = schedule.schedule_minute || 0;
  const hour = schedule.schedule_hour != null ? schedule.schedule_hour : '*';
  const type = schedule.schedule_type;

  if (type === 'hourly') {
    return `${min} * * * *`;
  }
  if (type === 'daily') {
    return `${min} ${hour} * * *`;
  }
  if (type === 'weekdays') {
    return `${min} ${hour} * * 1-5`;
  }
  if (type === 'weekly') {
    const dayMap = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 0 };
    const dayNum = dayMap[schedule.schedule_day] || 1;
    return `${min} ${hour} * * ${dayNum}`;
  }
  return null;
}

async function runSchedulerTick(source) {
  if (schedulerTickInProgress) return;
  schedulerTickInProgress = true;
  try {
    const schedules = await db.getCapacitySchedules();

    for (const schedule of schedules) {
      if (!schedule.enabled) continue;

      const effectiveUtc = resolveScheduleUtc(schedule);
      if (!effectiveUtc) {
        await db.logScheduleExecution(schedule.id, schedule.capacity_name, schedule.action, 'error', 'Invalid schedule UTC mapping');
        continue;
      }

      const nowUtc = getUtcNowParts();
      const slotKey = getCurrentUtcSlotKey(schedule, nowUtc, effectiveUtc);
      if (!slotKey) continue;

      const scheduleId = parseInt(schedule.id, 10);
      if (!Number.isFinite(scheduleId)) continue;

      if (lastTriggeredSlots.get(scheduleId) === slotKey) continue;

      lastTriggeredSlots.set(scheduleId, slotKey);
      await db.logScheduleExecution(
        schedule.id,
        schedule.capacity_name,
        schedule.action,
        'triggered',
        `Scheduler due UTC window reached at ${String(nowUtc.hour).padStart(2, '0')}:${String(nowUtc.minute).padStart(2, '0')} via ${source || 'tick'}`
      );
      const result = await executeSchedule(schedule);
      if (!isScheduleResultComplete(result)) {
        lastTriggeredSlots.delete(scheduleId);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error checking schedules:', err.message);
  } finally {
    schedulerTickInProgress = false;
  }
}

// Check schedules every minute and run matching ones
function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  console.log('[Scheduler] Capacity scheduler started');

  // Run every minute, check DB for active schedules
  cron.schedule('* * * * *', () => {
    runSchedulerTick('cron');
  });

  // Also run one immediate check on startup
  runSchedulerTick('startup');
}

function kickScheduler() {
  if (!schedulerStarted) return;
  const nowMs = Date.now();
  if (nowMs - lastKickMs < 15000) return;
  lastKickMs = nowMs;
  runSchedulerTick('request');
}

function hasPassedScheduleTime(nowParts, scheduleHour, scheduleMinute) {
  const hour = parseInt(scheduleHour, 10);
  const minute = parseInt(scheduleMinute, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  return nowParts.hour > hour || (nowParts.hour === hour && nowParts.minute >= minute);
}

function getDateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getCurrentUtcSlotKey(schedule, nowUtc, effectiveUtc) {
  const type = schedule.schedule_type;
  const schedMin = effectiveUtc.minuteUtc;
  const schedHour = effectiveUtc.hourUtc;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dateKey = getDateKey(nowUtc);

  if (type === 'hourly') {
    return nowUtc.minute >= schedMin ? `${dateKey}T${String(nowUtc.hour).padStart(2, '0')}` : null;
  }
  if (type === 'daily') {
    return hasPassedScheduleTime(nowUtc, schedHour, schedMin) ? dateKey : null;
  }
  if (type === 'weekdays') {
    return nowUtc.dayOfWeek >= 1 && nowUtc.dayOfWeek <= 5 && hasPassedScheduleTime(nowUtc, schedHour, schedMin) ? dateKey : null;
  }
  if (type === 'weekly') {
    const targetDay = effectiveUtc.dayUtc || schedule.schedule_day_utc || schedule.schedule_day;
    return dayNames[nowUtc.dayOfWeek] === targetDay && hasPassedScheduleTime(nowUtc, schedHour, schedMin) ? dateKey : null;
  }
  return null;
}

function getUtcNowParts() {
  const now = new Date();
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
    dayOfWeek: now.getUTCDay(),
  };
}

function resolveScheduleUtc(schedule) {
  const minuteUtc = Number.isFinite(parseInt(schedule.schedule_minute_utc, 10)) ? parseInt(schedule.schedule_minute_utc, 10) : null;
  const hourUtc = Number.isFinite(parseInt(schedule.schedule_hour_utc, 10)) ? parseInt(schedule.schedule_hour_utc, 10) : null;
  const dayUtc = schedule.schedule_day_utc || null;

  if (minuteUtc != null && (schedule.schedule_type === 'hourly' || hourUtc != null)) {
    return { minuteUtc, hourUtc, dayUtc };
  }

  try {
    return convertScheduleToUtc({
      scheduleType: schedule.schedule_type,
      hour: schedule.schedule_hour,
      minute: schedule.schedule_minute,
      day: schedule.schedule_day,
      timezone: schedule.timezone,
    });
  } catch {
    return null;
  }
}

module.exports = {
  startScheduler,
  kickScheduler,
  _private: { buildCronExpression, getCurrentUtcSlotKey, resolveScheduleUtc, isScheduleResultComplete },
};
