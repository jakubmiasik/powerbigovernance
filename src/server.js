const app = require('./app');
const { getConfig } = require('./config/settings');

const config = getConfig();
const port = config.port;

app.listen(port, () => {
  console.log(`\n  Power BI Governance App`);
  console.log(`  ──────────────────────`);
  console.log(`  Running at: http://localhost:${port}`);
  console.log(`  Settings:   http://localhost:${port}/settings\n`);
});
