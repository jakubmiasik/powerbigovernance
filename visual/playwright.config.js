// Visual regression for Fabric Governance screens on @podavo/ui.
// Run: npm run test:visual (renders fixtures first). Missing baselines are written
// on first run and must be committed; intended changes: npm run test:visual:update.
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: /screens\.spec\.js/,
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  updateSnapshots: 'missing',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  use: { browserName: 'chromium', deviceScaleFactor: 1 },
  outputDir: __dirname + '/.results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: __dirname + '/.report' }]],
});
