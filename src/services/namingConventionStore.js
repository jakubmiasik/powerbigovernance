/**
 * Where the naming convention is kept.
 *
 * Its own module so the settings page that writes it and the pages that check
 * names against it agree on the storage key without either importing the other's
 * route. `namingConventionService` stays pure — it knows the rules, not where they
 * live.
 */

const db = require('./databaseService');
const naming = require('./namingConventionService');

const NAMING_SETTING_KEY = 'fabricNamingConvention';

/**
 * The stored convention, or the default when nothing has been saved.
 *
 * Never throws: a database that cannot be reached must not take down a page whose
 * main job is something else. It falls back to the default, which is disabled, so
 * an unreadable setting means "no naming findings" rather than a tenant-wide wall
 * of them.
 */
async function loadNamingConvention() {
  let stored = null;
  try {
    stored = await db.getAppSetting(NAMING_SETTING_KEY, null);
  } catch (err) {
    console.warn('[Naming] Could not read the naming convention:', err.message);
  }
  return naming.normalizeConvention(stored || naming.DEFAULT_CONVENTION);
}

async function saveNamingConvention(convention, actor) {
  await db.saveAppSetting(NAMING_SETTING_KEY, naming.normalizeConvention(convention), actor);
}

module.exports = { NAMING_SETTING_KEY, loadNamingConvention, saveNamingConvention };
