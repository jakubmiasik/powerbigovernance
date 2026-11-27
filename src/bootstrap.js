const { startScheduler } = require('./services/schedulerService');
const { runMigrations, markInterruptedRuns } = require('./services/databaseService');
const { HEARTBEAT_STALE_SECONDS } = require('./services/runProgressService');
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
  // A run in flight when the process stopped has no one left to finish it. Left
  // alone it would sit at "running" forever, so it is closed off as interrupted —
  // but only once its heartbeat is old enough that no other worker can still own it.
  try {
    const interrupted = await markInterruptedRuns(HEARTBEAT_STALE_SECONDS);
    if (interrupted.length) {
      console.warn('[Bootstrap] Marked abandoned analysis run(s) as interrupted:', interrupted.join(', '));
    }
  } catch (err) {
    console.warn('[Bootstrap] Could not reconcile abandoned analysis runs:', err.message);
  }
  // A credential's expiry, once read from Key Vault or the certificate, is kept so
  // Settings and Home can warn before sign-in starts failing.
  require('./services/authService').onCredentialExpiry((id, expiresOn, source) =>
    require('./services/databaseService').recordCredentialExpiry(id, expiresOn, source));
  startScheduler();
}

module.exports = { bootstrap };
