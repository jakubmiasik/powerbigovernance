// Screenshots of the component catalogue in light and dark, enterprise and
// consumer, comfortable and compact. Run: npm run test:visual
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const url = require('node:url');

const page = url.pathToFileURL(path.join(__dirname, '..', 'catalogue', 'dist', 'index.html')).href;
const combos = [
  { theme: 'light', variant: 'enterprise', density: 'comfortable' },
  { theme: 'dark', variant: 'enterprise', density: 'comfortable' },
  { theme: 'light', variant: 'enterprise', density: 'compact' },
  { theme: 'light', variant: 'consumer', density: 'comfortable' },
  { theme: 'dark', variant: 'consumer', density: 'comfortable' },
];

for (const c of combos) {
  test(`catalogue — ${c.theme} / ${c.variant} / ${c.density}`, async ({ page: p }) => {
    await p.goto(`${page}?theme=${c.theme}&variant=${c.variant}&density=${c.density}`);
    await p.waitForFunction(() => !document.querySelector('i[data-lucide]') || !window.lucide);
    await expect(p).toHaveScreenshot(`catalogue-${c.theme}-${c.variant}-${c.density}.png`, { fullPage: true });
  });
}

test('catalogue — mobile consumer with the navigation open', async ({ page: p }) => {
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${page}?variant=consumer`);
  await p.click('[data-pd-nav-toggle].pd-menu-toggle');
  await expect(p).toHaveScreenshot('catalogue-mobile-nav.png');
});

test('drawer docks beside the grid at 1440 px and overlays below it', async ({ page: p }) => {
  await p.goto(page);
  await p.click('#cat-table tbody tr:first-child button');
  await expect(p.locator('.pd-dock')).toHaveClass(/is-docked/);
  await expect(p.locator('#cat-drawer')).toHaveAttribute('aria-modal', 'false');
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.goto(page);
  await p.click('#cat-table tbody tr:first-child button');
  await expect(p.locator('#cat-drawer')).toHaveAttribute('aria-modal', 'true');
  await p.keyboard.press('Escape');
  await expect(p.locator('#cat-drawer')).toHaveAttribute('aria-hidden', 'true');
});
