const cron = require('node-cron');
const db = require('./databaseService');
const { createPowerBIService } = require('./powerbiService');

let schedulerStarted = false;

async function executeSchedule(schedule) {
  try {
    const sps = await db.getServicePrincipals();
    if (sps.length === 0) {
      console.log('[Scheduler] No SP configured, skipping schedule', schedule.id);
      await db.logScheduleExecution(schedule.id, schedule.capacity_name, schedule.action, 'error', 'No service principal configured');
      return;
    }
    const pbi = createPowerBIService(sps[0]);
    const { subscription_id, resource_group, capacity_name, action } = schedule;

    console.log(`[Scheduler] Executing ${action} on capacity "${capacity_name}" (${resource_group})`);

    // Check current state before executing to avoid 400 errors
    try {
      const detail = await pbi.getArmCapacityDetail(subscription_id, resource_group, capacity_name);
      const currentState = (detail.properties && detail.properties.state) || '';
      const provisioningState = (detail.properties && detail.properties.provisioningState) || '';

      // Skip if already in target state
      if (action === 'suspend' && (currentState === 'Paused' || currentState === 'Suspended')) {
        console.log(`[Scheduler] Capacity "${capacity_name}" already paused/suspended, skipping.`);
        await db.logScheduleExecution(schedule.id, capacity_name, action, 'skipped', 'Capacity already paused');
        return;
      }
      if (action === 'resume' && currentState === 'Active') {
        console.log(`[Scheduler] Capacity "${capacity_name}" already active, skipping.`);
        await db.logScheduleExecution(schedule.id, capacity_name, action, 'skipped', 'Capacity already active');
        return;
      }
      // Skip if in transitional state (provisioning, updating, etc.)
      if (provisioningState && provisioningState !== 'Succeeded') {
        console.log(`[Scheduler] Capacity "${capacity_name}" in transitional state (${provisioningState}), skipping.`);
        await db.logScheduleExecution(schedule.id, capacity_name, action, 'skipped', `Capacity in transitional state: ${provisioningState}`);
        return;
      }
    } catch (stateErr) {
      console.warn(`[Scheduler] Could not check state for "${capacity_name}":`, stateErr.message);
      // Continue anyway — worst case we get the 400 and log it
    }

    if (action === 'suspend') {
      await pbi.suspendCapacity(subscription_id, resource_group, capacity_name);
    } else if (action === 'resume') {
      await pbi.resumeCapacity(subscription_id, resource_group, capacity_name);
    }

    console.log(`[Scheduler] ${action} completed for "${capacity_name}"`);
    await db.logScheduleExecution(schedule.id, capacity_name, action, 'success', `${action} completed successfully`);
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
      const now = new Date();
      const currentMin = now.getUTCMinutes();
      const currentHour = now.getUTCHours();
      const currentDay = now.getUTCDay(); // 0=Sun
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

      for (const schedule of schedules) {
        if (!schedule.enabled) continue;

        const type = schedule.schedule_type;
        const schedMin = schedule.schedule_minute || 0;
        const schedHour = schedule.schedule_hour;

        let shouldRun = false;

        if (type === 'hourly' && currentMin === schedMin) {
          shouldRun = true;
        } else if (type === 'daily' && currentMin === schedMin && currentHour === schedHour) {
          shouldRun = true;
        } else if (type === 'weekdays' && currentMin === schedMin && currentHour === schedHour && currentDay >= 1 && currentDay <= 5) {
          shouldRun = true;
        } else if (type === 'weekly' && currentMin === schedMin && currentHour === schedHour && dayNames[currentDay] === schedule.schedule_day) {
          shouldRun = true;
        }

        if (shouldRun) {
          executeSchedule(schedule);
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error checking schedules:', err.message);
    }
  });
}

module.exports = { startScheduler };
