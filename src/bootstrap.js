const { startScheduler } = require('./services/schedulerService');
const { runMigrations } = require('./services/databaseService');
const { validateConfig } = require('./config/settings');

async function bootstrap() {
  validateConfig({ requireProductionSecrets: process.env.NODE_ENV === 'production' });
  startScheduler();
  await runMigrations();
}

module.exports = { bootstrap };
