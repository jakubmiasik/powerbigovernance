const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService } = require('../services/powerbiService');
const { executeCapacityActionWithService } = require('../services/capacityActionService');
const { normalizeTimezone, convertScheduleToUtc } = require('../services/scheduleTimeService');
const { kickScheduler } = require('../services/schedulerService');

function formatUtcScheduleLabel(scheduleType, utcSchedule) {
  if (!utcSchedule || utcSchedule.scheduleMinuteUtc == null) return null;
  const minute = String(utcSchedule.scheduleMinuteUtc).padStart(2, '0');
  if (scheduleType === 'hourly') return `Every hour at minute ${minute} UTC`;
  if (utcSchedule.scheduleHourUtc == null) return null;
  const time = `${String(utcSchedule.scheduleHourUtc).padStart(2, '0')}:${minute} UTC`;
  return utcSchedule.scheduleDayUtc ? `${time} (${utcSchedule.scheduleDayUtc})` : time;
}


function ensureScheduleUtcFields(schedule) {
  if (!schedule) return schedule;
  const needsMinute = schedule.schedule_minute_utc == null;
  const needsHour = schedule.schedule_type !== 'hourly' && schedule.schedule_hour_utc == null;
  const needsDay = schedule.schedule_day_utc == null;
  const normalizedTimezone = normalizeTimezone(schedule.timezone || 'UTC');

  if (!needsMinute && !needsHour && !needsDay && schedule.timezone === normalizedTimezone) {
    return schedule;
  }

  try {
    const utc = convertScheduleToUtc({
      scheduleType: schedule.schedule_type,
      hour: schedule.schedule_hour,
      minute: schedule.schedule_minute,
      day: schedule.schedule_day,
      timezone: normalizedTimezone,
    });
    return {
      ...schedule,
      timezone: normalizedTimezone,
      schedule_hour_utc: schedule.schedule_hour_utc != null ? schedule.schedule_hour_utc : utc.scheduleHourUtc,
      schedule_minute_utc: schedule.schedule_minute_utc != null ? schedule.schedule_minute_utc : utc.scheduleMinuteUtc,
      schedule_day_utc: schedule.schedule_day_utc != null ? schedule.schedule_day_utc : utc.scheduleDayUtc,
    };
  } catch {
    return { ...schedule, timezone: normalizedTimezone };
  }
}

function getDetailedErrorMessage(err) {
  if (!err) return 'Unknown error';
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`code=${err.code}`);
  if (err.number !== undefined) parts.push(`number=${err.number}`);
  if (err.state !== undefined) parts.push(`state=${err.state}`);
  if (err.class !== undefined) parts.push(`class=${err.class}`);

  const original = err.originalError || err.cause;
  if (original) {
    if (original.message && original.message !== err.message) parts.push(`inner=${original.message}`);
    if (original.info && original.info.message) parts.push(`sql=${original.info.message}`);
  }

  if (Array.isArray(err.precedingErrors) && err.precedingErrors.length) {
    const nested = err.precedingErrors
      .map(e => e && (e.message || (e.info && e.info.message)))
      .filter(Boolean);
    if (nested.length) parts.push(`details=${nested.join(' | ')}`);
  }

  return parts.join(' ; ');
}

// Helper to get a PBI service instance using the first configured SP
async function getPbiService(req, res) {
  const globalRun = res ? res.locals.globalRun : null;
  let sp;
  if (globalRun && globalRun.sp_id) {
    sp = await db.getServicePrincipalById(globalRun.sp_id);
  }
  if (!sp) {
    const sps = await db.getServicePrincipals();
    if (sps.length === 0) throw new Error('No service principal configured. Go to Settings to add one.');
    sp = sps[0];
  }
  const keyVaultAuthUrl = `/settings/kv/auth?spId=${encodeURIComponent(String(sp.id))}&returnTo=${encodeURIComponent(req.originalUrl || '/capacities')}`;
  return createPowerBIService(sp, {
    keyVaultDelegatedToken: req.session?.keyVaultDelegatedToken?.token || null,
    keyVaultAuthUrl,
  });
}

// ── Capacities list page ──
router.get('/', async (req, res) => {
  try {
    const pbi = await getPbiService(req, res);
    const capacities = await pbi.getCapacities();
    res.render('capacities/list', {
      title: 'Capacities',
      user: req.user,
      capacities,
      breadcrumb: [{ label: 'Capacities', href: '/capacities' }],
    });
  } catch (err) {
    res.render('capacities/list', {
      title: 'Capacities',
      user: req.user,
      capacities: [],
      breadcrumb: [{ label: 'Capacities', href: '/capacities' }],
      error: err.message,
    });
  }
});

// ── Refresh capacities (AJAX) ──
router.get('/refresh', async (req, res) => {
  try {
    const pbi = await getPbiService(req, res);
    const capacities = await pbi.getCapacities();
    res.json({ success: true, capacities });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Capacity detail page ──
router.get('/:id', async (req, res) => {
  try {
    const pbi = await getPbiService(req, res);
    const capacities = await pbi.getCapacities();
    const capacity = capacities.find(c => (c.id || '').toLowerCase() === req.params.id.toLowerCase());
    if (!capacity) {
      return res.render('error', { title: 'Error', user: req.user, message: 'Capacity not found.' });
    }

    // Try to get ARM details if subscription info is configured
    let armDetail = null;
    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
    if (subscriptionId) {
      try {
        const armCaps = await pbi.listArmCapacities(subscriptionId);
        armDetail = armCaps.find(c =>
          (c.name || '').toLowerCase() === (capacity.displayName || '').toLowerCase() ||
          (c.properties?.administrationMembers || []).length > 0
        );
        // Better match: find by capacity ID from ARM properties
        if (!armDetail) {
          armDetail = armCaps.find(c =>
            c.id && c.id.toLowerCase().includes(req.params.id.toLowerCase())
          );
        }
        // Match by display name
        if (!armDetail) {
          armDetail = armCaps.find(c =>
            (c.name || '').toLowerCase() === (capacity.displayName || '').toLowerCase()
          );
        }
      } catch (armErr) {
        armDetail = { error: armErr.message };
      }
    }

    // Get schedules for this capacity
    const allSchedules = await db.getCapacitySchedules();
    const schedules = allSchedules
      .filter(s => (s.capacity_name || '').toLowerCase() === (capacity.displayName || '').toLowerCase())
      .map(ensureScheduleUtcFields);

    // Get execution history
    const history = await db.getScheduleHistory(capacity.displayName || '', 5);

    res.render('capacities/detail', {
      title: 'Capacity: ' + (capacity.displayName || 'Unknown'),
      user: req.user,
      capacity,
      armDetail,
      schedules,
      history,
      subscriptionId: subscriptionId || '',
      breadcrumb: [{ label: 'Capacities', href: '/capacities' }, { label: capacity.displayName || 'Detail', href: '#' }],
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// ── Pause capacity ──
router.post('/:name/suspend', async (req, res) => {
  try {
    const { subscriptionId, resourceGroup } = req.body;
    if (!subscriptionId || !resourceGroup) {
      return res.json({ success: false, message: 'Subscription ID and Resource Group are required.' });
    }
    const pbi = await getPbiService(req, res);

    // Check current state before executing
    try {
      const detail = await pbi.getArmCapacityDetail(subscriptionId, resourceGroup, req.params.name);
      const state = (detail.properties && detail.properties.state) || '';
      const provisioning = (detail.properties && detail.properties.provisioningState) || '';
      if (state === 'Paused' || state === 'Suspended') {
        return res.json({ success: false, message: 'Capacity is already paused.' });
      }
      if (provisioning && provisioning !== 'Succeeded') {
        return res.json({ success: false, message: `Capacity is in transitional state (${provisioning}). Please wait and try again.` });
      }
    } catch (stateErr) {
      // Continue anyway if state check fails
      console.warn('[Capacities] State check failed:', stateErr.message);
    }

    await pbi.suspendCapacity(subscriptionId, resourceGroup, req.params.name);
    res.json({ success: true, message: 'Capacity suspend initiated.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Resume capacity ──
router.post('/:name/resume', async (req, res) => {
  try {
    const { subscriptionId, resourceGroup } = req.body;
    if (!subscriptionId || !resourceGroup) {
      return res.json({ success: false, message: 'Subscription ID and Resource Group are required.' });
    }
    const pbi = await getPbiService(req, res);

    // Check current state before executing
    try {
      const detail = await pbi.getArmCapacityDetail(subscriptionId, resourceGroup, req.params.name);
      const state = (detail.properties && detail.properties.state) || '';
      const provisioning = (detail.properties && detail.properties.provisioningState) || '';
      if (state === 'Active') {
        return res.json({ success: false, message: 'Capacity is already active.' });
      }
      if (provisioning && provisioning !== 'Succeeded') {
        return res.json({ success: false, message: `Capacity is in transitional state (${provisioning}). Please wait and try again.` });
      }
    } catch (stateErr) {
      // Continue anyway if state check fails
      console.warn('[Capacities] State check failed:', stateErr.message);
    }

    await pbi.resumeCapacity(subscriptionId, resourceGroup, req.params.name);
    res.json({ success: true, message: 'Capacity resume initiated.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Add schedule ──
router.post('/:name/schedule', async (req, res) => {
  try {
    const { subscriptionId, resourceGroup, action, scheduleType, hour, minute, day, timezone } = req.body;
    if (!subscriptionId || !resourceGroup || !action || !scheduleType) {
      return res.json({ success: false, message: 'All fields are required.' });
    }
    const allSps = await db.getServicePrincipals();
    if (!allSps.length) {
      return res.json({ success: false, message: 'No service principal configured. Add one in Settings first.' });
    }
    const preferredSpId = res.locals.globalRun && res.locals.globalRun.sp_id ? parseInt(res.locals.globalRun.sp_id, 10) : null;
    const selectedSp = Number.isFinite(preferredSpId) ? allSps.find(s => parseInt(s.id, 10) === preferredSpId) : null;
    const effectiveSp = selectedSp || allSps[0];
    const normalizedTimezone = normalizeTimezone(timezone);
    let utcSchedule;
    try {
      utcSchedule = convertScheduleToUtc({
        scheduleType,
        hour,
        minute,
        day: day || null,
        timezone: normalizedTimezone,
      });
    } catch {
      const parsedHour = Number.isFinite(parseInt(hour, 10)) ? parseInt(hour, 10) : 0;
      const parsedMinute = Number.isFinite(parseInt(minute, 10)) ? parseInt(minute, 10) : 0;
      utcSchedule = {
        scheduleHourUtc: scheduleType === 'hourly' ? null : parsedHour,
        scheduleMinuteUtc: parsedMinute,
        scheduleDayUtc: day || null,
      };
    }

    const scheduleId = await db.saveCapacitySchedule({
      capacityName: req.params.name,
      subscriptionId,
      resourceGroup,
      action,
      scheduleType,
      hour: hour != null ? parseInt(hour) : null,
      minute: minute != null ? parseInt(minute) : null,
      day: day || null,
      timezone: normalizedTimezone,
      hourUtc: utcSchedule.scheduleHourUtc,
      minuteUtc: utcSchedule.scheduleMinuteUtc,
      dayUtc: utcSchedule.scheduleDayUtc,
      spId: parseInt(effectiveSp.id, 10),
      enabled: true,
    });
    kickScheduler();
    const utcLabel = formatUtcScheduleLabel(scheduleType, utcSchedule);
    res.json({ success: true, id: scheduleId, utcSchedule: {
      hour: utcSchedule.scheduleHourUtc,
      minute: utcSchedule.scheduleMinuteUtc,
      day: utcSchedule.scheduleDayUtc,
      label: utcLabel,
    } });
  } catch (err) {
    const details = getDetailedErrorMessage(err);
    console.error('[Capacities] Add schedule failed:', details);
    res.json({ success: false, message: details });
  }
});

// ── Delete schedule ──
router.delete('/schedule/:id', async (req, res) => {
  try {
    await db.deleteCapacitySchedule(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Update schedule ──
router.put('/schedule/:id', async (req, res) => {
  try {
    const { action, scheduleType, hour, minute, day, timezone } = req.body;
    if (!action || !scheduleType) {
      return res.json({ success: false, message: 'Action and schedule type are required.' });
    }
    const normalizedTimezone = normalizeTimezone(timezone || 'UTC');
    let utcSchedule;
    try {
      utcSchedule = convertScheduleToUtc({
        scheduleType,
        hour,
        minute,
        day: day || null,
        timezone: normalizedTimezone,
      });
    } catch {
      const parsedHour = Number.isFinite(parseInt(hour, 10)) ? parseInt(hour, 10) : 0;
      const parsedMinute = Number.isFinite(parseInt(minute, 10)) ? parseInt(minute, 10) : 0;
      utcSchedule = {
        scheduleHourUtc: scheduleType === 'hourly' ? null : parsedHour,
        scheduleMinuteUtc: parsedMinute,
        scheduleDayUtc: day || null,
      };
    }
    await db.updateCapacitySchedule(parseInt(req.params.id), {
      action,
      scheduleType,
      hour: scheduleType === 'hourly' ? null : (hour != null ? parseInt(hour, 10) : undefined),
      minute: minute != null ? parseInt(minute, 10) : undefined,
      day: scheduleType === 'weekly' ? (day || null) : null,
      timezone: normalizedTimezone,
      hourUtc: utcSchedule.scheduleHourUtc,
      minuteUtc: utcSchedule.scheduleMinuteUtc,
      dayUtc: utcSchedule.scheduleDayUtc,
    });
    kickScheduler();
    const utcLabel = formatUtcScheduleLabel(scheduleType, utcSchedule);
    res.json({ success: true, utcSchedule: {
      hour: utcSchedule.scheduleHourUtc,
      minute: utcSchedule.scheduleMinuteUtc,
      day: utcSchedule.scheduleDayUtc,
      label: utcLabel,
    } });
  } catch (err) {
    const details = getDetailedErrorMessage(err);
    console.error('[Capacities] Update schedule failed:', details);
    res.json({ success: false, message: details });
  }
});

// ── Toggle schedule ──
router.post('/schedule/:id/toggle', async (req, res) => {
  try {
    await db.toggleCapacitySchedule(parseInt(req.params.id), req.body.enabled);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Schedule history ──
router.get('/history/:capacityName', async (req, res) => {
  try {
    const history = await db.getScheduleHistory(req.params.capacityName, 5);
    res.json({ success: true, history });
  } catch (err) {
    res.json({ success: false, message: err.message, history: [] });
  }
});

module.exports = router;
