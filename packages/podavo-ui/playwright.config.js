// Visual regression for @podavo/ui: the catalogue in every theme × variant.
// Baselines live in tests/__screenshots__; a missing baseline is written on the
// first run (updateSnapshots: 'missing') and must be committed with the change.
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.js/,
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  updateSnapshots: 'missing',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  reporter: [['list'], ['html', { open: 'never' }]],
});
