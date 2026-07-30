const { startScheduler } = require('./services/schedulerService');
const { runMigrations } = require('./services/databaseService');
const { validateConfig } = require('./config/settings');

async function bootstrap() {
  validateConfig({ requireProductionSecrets: process.env.NODE_ENV === 'production' });
  try {
    await runMigrations();
  } catch (err) {
    // The scheduler must come up even when the database is briefly unreachable at
    // startup, otherwise no capacity action ever fires for the life of the process.
    console.warn('[Bootstrap] Migrations failed:', err.message);
  }
  startScheduler();
}

module.exports = { bootstrap };
