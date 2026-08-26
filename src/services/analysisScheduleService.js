/**
 * Running analysis scans on a schedule.
 *
 * Scanning used to be something people did by hand, because it always meant the
 * whole tenant and took hours. Scoped scans are short enough to run nightly, so
 * scopes and schedules arrive together — and a governance picture is only worth
 * trusting if it refreshes without somebody remembering to press a button.
 *
 * The timing is `scheduleDueService`, shared with the capacity scheduler. What is
 * here is the part that is specific to scans: deciding not to start one on top of
 * another, and starting it through the launcher rather than by importing a route.
 */

const db = require('./databaseService');
const launcher = require('./analysisLauncher');
const {
  scopeFromRow, scopeToRow, describeScope, requestedWorkspaceScope, normalizeScope, SCOPE_KIND,
} = require('./analysisScopeService');
const { SCHEDULE_TYPE_KEYS, describeSchedule } = require('./scheduleDueService');
const { normalizeTimezone } = require('./scheduleTimeService');

// A scan can take hours. Starting a second one for the same schedule while the
// first is still going would double the API load and produce two runs neither of
// which is the answer — so an overlapping slot is skipped and said so, rather than
// queued.
const OVERLAP_STATUSES = new Set(['running', 'cancelling']);

/**
 * Validates a schedule as submitted. Returns a message, or null when it is usable.
 *
 * Checked here rather than in the route so the same rules apply to an edit, and so
 * they can be tested without an HTTP server.
 */
function validateSchedule(schedule) {
  if (!schedule || !String(schedule.name || '').trim()) return 'The schedule needs a name.';
  if (!SCHEDULE_TYPE_KEYS.includes(schedule.scheduleType)) return 'Choose how often the scan should run.';

  const minute = Number.parseInt(schedule.minute, 10);
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return 'The minute must be between 0 and 59.';

  if (schedule.scheduleType !== 'hourly') {
    const hour = Number.parseInt(schedule.hour, 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return 'The hour must be between 0 and 23.';
  }
  if (schedule.scheduleType === 'weekly' && !schedule.day) return 'Choose which day of the week to run on.';

  // Checked against what was asked for, not against the normalized scope: an empty
  // selection normalizes to the whole tenant, so testing the result would let
  // "selected workspaces, none ticked" through as a nightly tenant scan.
  if (requestedWorkspaceScope(schedule.scope) && !normalizeScope(schedule.scope).workspaces.length) {
    return 'Select at least one workspace, or choose the whole tenant.';
  }
  return null;
}

/** A submitted schedule, in the shape the database layer takes. */
function toStoredSchedule(schedule) {
  const scope = scopeToRow(schedule.scope);
  return {
    name: String(schedule.name || '').trim(),
    spId: schedule.spId,
    scopeKind: scope.scopeKind,
    scopeWorkspaces: scope.scopeWorkspaces,
    scheduleType: schedule.scheduleType,
    hour: schedule.scheduleType === 'hourly' ? null : Number.parseInt(schedule.hour, 10),
    minute: Number.parseInt(schedule.minute, 10) || 0,
    day: schedule.scheduleType === 'weekly' ? schedule.day : null,
    timezone: normalizeTimezone(schedule.timezone || 'UTC'),
    enabled: schedule.enabled !== false,
    createdBy: schedule.createdBy || null,
  };
}

/** A stored row, decorated for a page: its scope and timing in words. */
function describeStoredSchedule(row) {
  const scope = scopeFromRow(row);
  return {
    ...row,
    scope,
    scopeLabel: describeScope(scope),
    timingLabel: describeSchedule(row),
  };
}

/**
 * Whether a scan for this schedule is already in flight.
 *
 * Runs are matched by schedule, not by service principal: two schedules covering
 * different workspaces are meant to be able to run at once, and blocking on that
 * would make a nightly-per-area setup silently skip most of itself.
 */
function findRunningRun(runs, scheduleId) {
  const wanted = Number.parseInt(scheduleId, 10);
  return (runs || []).find(run =>
    OVERLAP_STATUSES.has(String(run.status)) && Number(run.schedule_id) === wanted) || null;
}

async function getServicePrincipalFor(schedule, servicePrincipals) {
  const sps = servicePrincipals || await db.getServicePrincipals();
  if (!sps.length) return null;
  const wanted = Number.parseInt(schedule.sp_id, 10);
  if (Number.isFinite(wanted)) {
    const found = sps.find(sp => Number.parseInt(sp.id, 10) === wanted);
    if (found) return found;
  }
  return sps[0];
}

/**
 * Starts the scan a due schedule asks for.
 *
 * Returns as soon as the run record exists rather than when the scan finishes — a
 * tenant scan takes minutes to hours, and a scheduler tick that waited for one
 * would hold every other schedule behind it.
 */
async function executeSchedule(schedule, { source = 'scheduler' } = {}) {
  const scope = scopeFromRow(schedule);
  try {
    const sp = await getServicePrincipalFor(schedule);
    if (!sp) {
      await db.logAnalysisScheduleRun(schedule.id, null, 'error', 'No service principal configured.');
      return { status: 'error', message: 'No service principal configured.' };
    }

    const runs = await db.getAnalysisRuns().catch(() => []);
    const inFlight = findRunningRun(runs, schedule.id);
    if (inFlight) {
      const message = 'Skipped: run #' + inFlight.id + ' from this schedule is still going.';
      await db.logAnalysisScheduleRun(schedule.id, inFlight.id, 'skipped', message);
      return { status: 'skipped', message };
    }

    if (!launcher.isRegistered()) {
      const message = 'No analysis runner is registered in this process.';
      await db.logAnalysisScheduleRun(schedule.id, null, 'error', message);
      return { status: 'error', message };
    }

    const started = await launcher.start({
      sp,
      scope,
      scheduleId: schedule.id,
      runBy: 'schedule: ' + (schedule.name || '#' + schedule.id),
    });

    const runId = started && started.runId ? started.runId : null;
    const message = 'Started run #' + runId + ' — ' + describeScope(scope) + ' (' + source + ').';
    await db.logAnalysisScheduleRun(schedule.id, runId, 'started', message);
    return { status: 'started', message, runId };
  } catch (err) {
    await db.logAnalysisScheduleRun(schedule.id, null, 'error', err.message);
    return { status: 'error', message: err.message };
  }
}

module.exports = {
  OVERLAP_STATUSES,
  validateSchedule,
  toStoredSchedule,
  describeStoredSchedule,
  findRunningRun,
  getServicePrincipalFor,
  executeSchedule,
};
