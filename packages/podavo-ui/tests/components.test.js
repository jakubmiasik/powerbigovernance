// Contract tests for the @podavo/ui partials: every component renders, escapes
// what it is given, and carries the ARIA its behaviour depends on.
// Runs with the package (npm test) and with the host app's `node --test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ejs = require('ejs');

const dir = path.join(__dirname, '..', 'ejs');
const render = (name, ui) => ejs.renderFile(path.join(dir, name + '.ejs'), { ui });

test('every partial in ejs/ renders with empty input', async () => {
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.ejs'))) {
    await assert.doesNotReject(ejs.renderFile(path.join(dir, file), { ui: {} }), file);
  }
});

test('Button: variants, loading and disabled states', async () => {
  assert.match(await render('button', { label: 'Save', variant: 'primary' }), /class="pd-btn pd-btn--primary"/);
  assert.match(await render('button', { label: 'Save', loading: true }), /aria-busy="true"/);
  assert.match(await render('button', { label: 'Save', disabled: true }), /<button[^>]* disabled/);
  assert.match(await render('button', { label: 'Go', href: '/x' }), /<a href="\/x"/);
  assert.doesNotMatch(await render('button', { label: '<b>x</b>' }), /<b>x<\/b>/);
});

test('IconButton: the label is the accessible name; toggles expose aria-pressed', async () => {
  const html = await render('icon-button', { icon: 'settings', label: 'Settings', pressed: true });
  assert.match(html, /aria-label="Settings"/);
  assert.match(html, /aria-pressed="true"/);
});

test('Input: help and error are announced and mark the field invalid', async () => {
  const html = await render('input', { id: 'd', label: 'Days', help: 'Whole days', error: 'Required' });
  assert.match(html, /<label class="pd-label" for="d">/);
  assert.match(html, /aria-describedby="d-help d-error"/);
  assert.match(html, /aria-invalid="true"/);
});

test('SearchField: as a command search it is an ARIA combobox', async () => {
  const html = await render('search-field', { id: 's', command: true });
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-controls="s-results"/);
  assert.match(html, /role="listbox"/);
});

test('MetricCard: a missing value is "Not evaluated", never a number', async () => {
  assert.match(await render('metric-card', { label: 'Score', value: null }), /Not evaluated/);
  assert.match(await render('metric-card', { label: 'Score', value: 0 }), /pd-metric-value">0</);
});

test('FilterBar and Tabs: toggles carry aria-pressed, panel tabs carry roles', async () => {
  assert.match(await render('filter-bar', { items: [{ key: 'a', label: 'A', count: 1, pressed: true }] }), /aria-pressed="true"/);
  const tabs = await render('tabs', { tabs: [{ id: 't', label: 'T', controls: 'p', selected: true }] });
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tab"[^>]*aria-controls="p"[^>]*aria-selected="true"/);
});

test('Drawer, Dialog and Popover expose their dialog semantics', async () => {
  assert.match(await render('drawer', { id: 'd' }), /role="dialog" aria-modal="true" aria-labelledby="d-title"/);
  assert.match(await render('dialog', { id: 'g', title: 'T' }), /<dialog class="pd-dialog" id="g" aria-labelledby="g-title">/);
  assert.match(await render('popover', { id: 'p', triggerLabel: 'Open' }), /data-pd-popover="p"[^>]*aria-expanded="false"/);
});

test('Sidebar: the active page is announced; a fallback icon class is kept', async () => {
  const html = await render('sidebar', { brand: { name: 'App' }, groups: [{ title: 'Main', items: [{ href: '/', label: 'Home', icon: 'house', fallbackClass: 'bi bi-house', active: true }] }] });
  assert.match(html, /aria-current="page"/);
  assert.match(html, /data-lucide="house" class="bi bi-house"/);
});

test('State: errors are alerts, everything else is a status', async () => {
  assert.match(await render('state', { kind: 'error' }), /role="alert"/);
  assert.match(await render('state', { kind: 'loading' }), /aria-busy="true"/);
});
