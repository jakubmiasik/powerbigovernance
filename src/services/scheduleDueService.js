/**
 * When a schedule is due.
 *
 * Two things are scheduled now — capacity actions and analysis scans — and they
 * have to agree about what "daily at 07:00 Europe/Warsaw" means. This is the one
 * place that decides, so a second scheduler cannot drift from the first over
 * daylight saving, catch-up, or which minute counts as which slot.
 *
 * Pure: no database, no timers. The clock is always passed in, so every case
 * below — including the two DST transitions — is directly testable.
 */

const { getTimeInTimezone } = require('./scheduleTimeService');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The frequencies a schedule can use, with what each needs from the form. Shared
// so the two schedulers and their pages offer exactly the same set.
const SCHEDULE_TYPES = [
  { key: 'hourly', label: 'Every hour', needsHour: false, needsDay: false, description: 'At the given minute past every hour.' },
  { key: 'daily', label: 'Every day', needsHour: true, needsDay: false, description: 'Once a day at the given time.' },
  { key: 'weekdays', label: 'Weekdays only', needsHour: true, needsDay: false, description: 'Monday to Friday at the given time.' },
  { key: 'weekly', label: 'Once a week', needsHour: true, needsDay: true, description: 'On the chosen day at the given time.' },
];

const SCHEDULE_TYPE_KEYS = SCHEDULE_TYPES.map(type => type.key);

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

  if (nowLocal.minute !== minute) return false;
  if (type === 'hourly') return true;
  if (nowLocal.hour !== hour) return false;
  if (type === 'daily') return true;
  if (type === 'weekdays') return nowLocal.dayOfWeek >= 1 && nowLocal.dayOfWeek <= 5;
  if (type === 'weekly') return DAY_NAMES[nowLocal.dayOfWeek] === schedule.schedule_day;
  return false;
}

function getScheduleSlotKey(schedule, nowLocal) {
  if (!isDueNow(schedule, nowLocal)) return null;
  const dateKey = getDateKey(nowLocal);
  const hour = String(nowLocal.hour).padStart(2, '0');
  const minute = String(nowLocal.minute).padStart(2, '0');
  return `${dateKey}T${hour}:${minute}`;
}

function truncateToMinute(date) {
  return new Date(Math.floor(date.getTime() / 60000) * 60000);
}

/**
 * Most recent minute within the catch-up window at which `schedule` was due,
 * or null if it was not due at all.
 *
 * Walking back minute by minute — rather than computing the slot arithmetically —
 * keeps daylight saving correct, because each candidate instant is re-resolved in
 * the schedule's own timezone. The window matters on App Service, where a worker
 * can be recycled or idled out for long enough to miss the minute entirely.
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

/** How a schedule's timing reads to a person, in its own timezone. */
function describeSchedule(schedule) {
  const type = SCHEDULE_TYPES.find(candidate => candidate.key === schedule.schedule_type);
  const minute = String(getScheduleMinute(schedule)).padStart(2, '0');
  const timezone = schedule.timezone || 'UTC';
  if (!type) return 'Unknown schedule';
  if (type.key === 'hourly') return 'Every hour at :' + minute + ' (' + timezone + ')';

  const at = String(getScheduleHour(schedule)).padStart(2, '0') + ':' + minute + ' ' + timezone;
  if (type.key === 'daily') return 'Every day at ' + at;
  if (type.key === 'weekdays') return 'Weekdays at ' + at;
  return 'Every ' + (schedule.schedule_day || 'Monday') + ' at ' + at;
}

module.exports = {
  DAY_NAMES,
  SCHEDULE_TYPES,
  SCHEDULE_TYPE_KEYS,
  isDueNow,
  getScheduleSlotKey,
  findDueSlot,
  describeSchedule,
  truncateToMinute,
};
