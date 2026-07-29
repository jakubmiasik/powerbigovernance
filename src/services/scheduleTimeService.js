const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayToIndex = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

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

function getTimeInTimezone(tz, date) {
  const now = date || new Date();
  try {
    const parts = {};
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    for (const p of fmt.formatToParts(now)) {
      parts[p.type] = p.value;
    }
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      year: parseInt(parts.year, 10),
      month: parseInt(parts.month, 10),
      day: parseInt(parts.day, 10),
      hour: parseInt(parts.hour, 10) % 24,
      minute: parseInt(parts.minute, 10),
      dayOfWeek: weekdayMap[parts.weekday] !== undefined ? weekdayMap[parts.weekday] : now.getUTCDay(),
    };
  } catch {
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

function getTimezoneOffsetMs(date, timezone) {
  const zoned = getTimeInTimezone(timezone, date);
  const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, 0, 0);
  return asUtc - date.getTime();
}

function localDateTimeToUtcDate(timezone, year, month, day, hour, minute) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const guess = new Date(localAsUtc);
  const offsetMs = getTimezoneOffsetMs(guess, timezone);
  return new Date(localAsUtc - offsetMs);
}

function addDaysYmd(year, month, day, addDays) {
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + addDays);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function convertScheduleToUtc({ scheduleType, hour, minute, day, timezone }) {
  const tz = normalizeTimezone(timezone);
  const localNow = getTimeInTimezone(tz, new Date());
  const localHour = Number.isFinite(parseInt(hour, 10)) ? parseInt(hour, 10) : 0;
  const localMinute = Number.isFinite(parseInt(minute, 10)) ? parseInt(minute, 10) : 0;

  let y = localNow.year;
  let m = localNow.month;
  let d = localNow.day;

  if (scheduleType === 'weekly' && day && dayToIndex[day] !== undefined) {
    const targetDow = dayToIndex[day];
    const diff = (targetDow - localNow.dayOfWeek + 7) % 7;
    const shifted = addDaysYmd(localNow.year, localNow.month, localNow.day, diff);
    y = shifted.year;
    m = shifted.month;
    d = shifted.day;
  } else if (scheduleType === 'weekdays') {
    const targetDow = localNow.dayOfWeek >= 1 && localNow.dayOfWeek <= 5 ? localNow.dayOfWeek : 1;
    const diff = (targetDow - localNow.dayOfWeek + 7) % 7;
    const shifted = addDaysYmd(localNow.year, localNow.month, localNow.day, diff);
    y = shifted.year;
    m = shifted.month;
    d = shifted.day;
  }

  const utcDate = localDateTimeToUtcDate(tz, y, m, d, localHour, localMinute);
  return {
    scheduleHourUtc: scheduleType === 'hourly' ? null : utcDate.getUTCHours(),
    scheduleMinuteUtc: utcDate.getUTCMinutes(),
    scheduleDayUtc: dayNames[utcDate.getUTCDay()],
    normalizedTimezone: tz,
  };
}

module.exports = {
  normalizeTimezone,
  convertScheduleToUtc,
};
