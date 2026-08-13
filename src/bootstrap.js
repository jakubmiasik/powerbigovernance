const { startScheduler } = require('./services/schedulerService');
const { runMigrations } = require('./services/databaseService');
const { validateConfig } = require('./config/settings');

async function bootstrap() {
  // Neither config validation nor migrations may prevent the scheduler from starting.
  // The process serves traffic regardless (server.js listens in .finally), so bailing
  // out here previously left a live app with no capacity scheduler at all.
  try {
    validateConfig({ requireProductionSecrets: process.env.NODE_ENV === 'production' });
  } catch (err) {
    console.error('[Bootstrap] Configuration invalid:', err.message);
  }
  try {
    await runMigrations();
  } catch (err) {
    console.warn('[Bootstrap] Migrations failed:', err.message);
  }
  startScheduler();
}

module.exports = { bootstrap };
