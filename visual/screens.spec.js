// Fabric Governance screens in light and dark mode, comfortable and compact
// density, at the desktop widths the layout is designed for, plus mobile.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const url = require('node:url');

const screen = name => url.pathToFileURL(path.join(__dirname, '.out', name + '.html')).href;

async function open(page, name, { theme = 'light', density = 'comfortable', width = 1440, height = 1000 } = {}) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(([t, d]) => { localStorage.setItem('pd-theme', t); localStorage.setItem('pd-density', d); }, [theme, density]);
  await page.goto(screen(name));
  // Icons are drawn by Lucide; wait until none are left to draw (or Lucide is absent).
  await page.waitForFunction(() => !window.lucide || !document.querySelector('i[data-lucide]'));
}

for (const name of ['triage', 'overview']) {
  for (const theme of ['light', 'dark']) {
    for (const density of ['comfortable', 'compact']) {
      test(`${name} — ${theme} / ${density} / 1440`, async ({ page }) => {
        await open(page, name, { theme, density });
        await expect(page).toHaveScreenshot(`${name}-${theme}-${density}-1440.png`, { fullPage: true });
      });
    }
  }
  for (const width of [1280, 1920, 2560]) {
    test(`${name} — light / ${width}`, async ({ page }) => {
      await open(page, name, { width });
      await expect(page).toHaveScreenshot(`${name}-light-${width}.png`);
    });
  }
}

test('triage — details drawer docked at 1440', async ({ page }) => {
  await open(page, 'triage');
  await page.locator('#triage-table tbody tr:visible').first().locator('td').nth(4).click();
  await expect(page.locator('.pd-dock')).toHaveClass(/is-docked/);
  await expect(page).toHaveScreenshot('triage-drawer-docked-1440.png');
});

test('triage — details drawer as a full-screen overlay on mobile', async ({ page }) => {
  await open(page, 'triage', { width: 390, height: 844 });
  await page.locator('#triage-table tbody tr:visible').first().locator('td').nth(4).click();
  await expect(page.locator('#workspaceDrawer')).toHaveAttribute('aria-modal', 'true');
  await expect(page).toHaveScreenshot('triage-drawer-mobile.png');
});

test('no access — state component', async ({ page }) => {
  await open(page, 'no-access');
  await expect(page).toHaveScreenshot('no-access-light-1440.png');
});
