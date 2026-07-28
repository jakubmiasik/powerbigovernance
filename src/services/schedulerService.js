const cron = require('node-cron');
const db = require('./databaseService');
const { createPowerBIService } = require('./powerbiService');

let schedulerStarted = false;
const lastTriggeredSlots = new Map();
const timezoneSupportCache = new Map();

function normalizeTimezone(tz) {
  const raw = (tz || 'UTC').toString().trim();
  const cleaned = raw.replace(/\s*\(.*\)\s*$/, '').trim();
  const upper = cleaned.toUpperCase();
  const aliasMap = {
    UTC: 'UTC',
    CET: 'Europe/Warsaw',
    CEST: 'Europe/Warsaw',
    EET: 'Europe/Helsinki',
    ET: 'America/New_York',
    CT: 'America/Chicago',
    MT: 'America/Denver',
    PT: 'America/Los_Angeles',
    GMT: 'Europe/London',
    BST: 'Europe/London',
    IST: 'Asia/Kolkata',
    JST: 'Asia/Tokyo',
    SGT: 'Asia/Singapore',
    AEST: 'Australia/Sydney',
    SAST: 'Africa/Johannesburg',
  };
  if (cleaned.includes('/')) return cleaned;
  return aliasMap[upper] || 'UTC';
}

function isTimezoneSupported(tz) {
  if (timezoneSupportCache.has(tz)) return timezoneSupportCache.get(tz);
  let supported = true;
  try {
    // Throws RangeError when timezone is invalid/unsupported in this runtime
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
  } catch {
    supported = false;
  }
  timezoneSupportCache.set(tz, supported);
  return supported;
}

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
      return;
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
        return;
      } catch (err) {
        lastError = err;
        console.warn(`[Scheduler] Attempt failed for schedule ${schedule.id} via SP ${sp.id}:`, err.message);
      }
    }

    throw lastError || new Error('No service principal was able to execute this schedule.');
  } catch (err) {
    console.error(`[Scheduler] Error executing schedule ${schedule.id}:`, err.message);
    await db.logScheduleExecution(schedule.id, schedule.capacity_name, schedule.action, 'error', err.message);
  }
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

// Check schedules every minute and run matching ones
function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  console.log('[Scheduler] Capacity scheduler started');

  // Run every minute, check DB for active schedules
  cron.schedule('* * * * *', async () => {
    try {
      const schedules = await db.getCapacitySchedules();
      let lastExecutions = [];
      try {
        lastExecutions = await db.getLastScheduleExecutions();
      } catch (historyErr) {
        console.warn('[Scheduler] Could not read schedule history, continuing without persisted dedupe:', historyErr.message);
      }
      const lastExecutionBySchedule = new Map(
        lastExecutions
          .filter(row => row && row.schedule_id != null)
          .map(row => [parseInt(row.schedule_id, 10), row.last_executed_at ? new Date(row.last_executed_at) : null])
      );

      for (const schedule of schedules) {
        if (!schedule.enabled) continue;

        const tz = normalizeTimezone(schedule.timezone);
        if (!isTimezoneSupported(tz)) {
          console.warn(`[Scheduler] Unsupported timezone "${schedule.timezone}" for schedule ${schedule.id}. Skipping.`);
          continue;
        }
        const now = getTimeInTimezone(tz);
        const slotKey = getCurrentSlotKey(schedule, now);
        if (!slotKey) continue;

        const scheduleId = parseInt(schedule.id, 10);
        if (!Number.isFinite(scheduleId)) continue;

        if (lastTriggeredSlots.get(scheduleId) === slotKey) continue;

        const lastExecutedAt = lastExecutionBySchedule.get(scheduleId);
        const alreadyExecutedInSlot = wasExecutedInSlot(schedule, tz, slotKey, lastExecutedAt);
        if (alreadyExecutedInSlot) {
          lastTriggeredSlots.set(scheduleId, slotKey);
          continue;
        }

        lastTriggeredSlots.set(scheduleId, slotKey);
        await db.logScheduleExecution(
          schedule.id,
          schedule.capacity_name,
          schedule.action,
          'triggered',
          `Scheduler due window reached (${tz}) at ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`
        );
        executeSchedule(schedule);
      }
    } catch (err) {
      console.error('[Scheduler] Error checking schedules:', err.message);
    }
  });
}

function hasPassedScheduleTime(local, scheduleHour, scheduleMinute) {
  const hour = parseInt(scheduleHour, 10);
  const minute = parseInt(scheduleMinute, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  return local.hour > hour || (local.hour === hour && local.minute >= minute);
}

function getDateKey(local) {
  return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
}

function getCurrentSlotKey(schedule, local) {
  const type = schedule.schedule_type;
  const schedMin = Number.isFinite(parseInt(schedule.schedule_minute, 10)) ? parseInt(schedule.schedule_minute, 10) : 0;
  const schedHour = Number.isFinite(parseInt(schedule.schedule_hour, 10)) ? parseInt(schedule.schedule_hour, 10) : null;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dateKey = getDateKey(local);

  if (type === 'hourly') {
    return local.minute >= schedMin ? `${dateKey}T${String(local.hour).padStart(2, '0')}` : null;
  }
  if (type === 'daily') {
    return hasPassedScheduleTime(local, schedHour, schedMin) ? dateKey : null;
  }
  if (type === 'weekdays') {
    return local.dayOfWeek >= 1 && local.dayOfWeek <= 5 && hasPassedScheduleTime(local, schedHour, schedMin) ? dateKey : null;
  }
  if (type === 'weekly') {
    return dayNames[local.dayOfWeek] === schedule.schedule_day && hasPassedScheduleTime(local, schedHour, schedMin) ? dateKey : null;
  }
  return null;
}

function wasExecutedInSlot(schedule, tz, currentSlotKey, lastExecutedAt) {
  if (!lastExecutedAt || !currentSlotKey) return false;
  const executedLocal = getTimeInTimezone(tz, lastExecutedAt);
  const executedSlotKey = getCurrentSlotKey(schedule, executedLocal);
  return executedSlotKey === currentSlotKey;
}

// Get current time components in a given IANA timezone
function getTimeInTimezone(tz, date) {
  try {
    const now = date || new Date();
    const parts = {};
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    for (const p of fmt.formatToParts(now)) {
      parts[p.type] = p.value;
    }
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dayMap[parts.weekday] !== undefined ? dayMap[parts.weekday] : new Date().getUTCDay();
    return {
      year: parseInt(parts.year, 10),
      month: parseInt(parts.month, 10),
      day: parseInt(parts.day, 10),
      hour: parseInt(parts.hour, 10) % 24,
      minute: parseInt(parts.minute, 10),
      dayOfWeek: dow,
    };
  } catch {
    // Fallback to UTC if timezone is invalid
    const now = date || new Date();
    return {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
      dayOfWeek: now.getUTCDay(),
    };
  }
}

module.exports = { startScheduler };
