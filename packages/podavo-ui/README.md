# @podavo/ui

The Podavo unified design system: one set of tokens, components and behaviour shared by every Podavo product, from consumer apps to Fabric Governance.

It has no build step and no runtime dependencies. It ships as plain CSS, framework-free JavaScript and EJS partials, and draws its icons from [Lucide](https://lucide.dev), pinned at 0.517.0.

## Use it

```html
<html data-product="governance" data-pd-variant="enterprise" data-theme="light">
<link rel="stylesheet" href="/podavo-ui/css/podavo.css">
<!-- Bootstrap apps only, after bootstrap.css: -->
<link rel="stylesheet" href="/podavo-ui/css/bootstrap-bridge.css">
…
<script src="https://unpkg.com/lucide@0.517.0/dist/umd/lucide.min.js"></script>
<script src="/podavo-ui/js/podavo.js"></script>
```

Render a partial from EJS. Every partial takes a single `ui` object, because EJS includes inherit the page's locals:

```ejs
<%- include('…/podavo-ui/ejs/metric-card', { ui: { label: 'Need attention', value: 48, hint: '76.2%', icon: 'triangle-alert', tone: 'warning' } }) %>
```

## Axes

| Attribute on `<html>` | Values | What it changes |
|---|---|---|
| `data-theme` | `light`, `dark` | All colour tokens. The navigation stays navy in both. |
| `data-pd-variant` | `enterprise` (default), `consumer` | Control height (34 px or 44 px), body size, spacing, touch targets, radii. |
| `data-density` | `comfortable`, `compact` | Row padding and font size in data grids. |
| `data-product` | for example `governance` | `--pd-accent` only. |

Shared components read only tokens. A product never hard-codes its colours into a component; it overrides `--pd-accent`.

## Components

| Component | Markup / partial | Behaviour |
|---|---|---|
| AppShell | `ejs/app-shell-start` + `ejs/app-shell-end` | Skip link, collapsible sidebar (remembered), mobile overlay that closes on Esc |
| Sidebar | `ejs/sidebar` | Grouped navigation, `aria-current`, optional fallback icon class |
| PageHeader | `ejs/page-header` | One `<h1>` per page; actions slot |
| Button | `ejs/button` / `.pd-btn` | Variants: primary, secondary, soft, ghost, danger, danger-outline. Sizes: sm and block. Loading state: `aria-busy="true"` |
| IconButton | `ejs/icon-button` / `.pd-icon-btn` | Label required (it becomes `aria-label`); `aria-pressed` for toggles |
| Input, Select | `ejs/input`, `ejs/select` | Label, help and error text tied together with `aria-describedby` and `aria-invalid` |
| SearchField | `ejs/search-field` | `command: true` turns it into a combobox over the navigation (Ctrl K) |
| Badge | `ejs/badge` / `.pd-badge--{tone}` | Always carries text, so colour is never the only signal |
| Card | `ejs/card` / `.pd-card` | Header, body, footer |
| MetricCard | `ejs/metric-card` / `.pd-metric` | Concise and left-aligned; `value: null` renders *Not evaluated* |
| Tabs | `ejs/tabs` / `.pd-tabs` | Panel tabs (roving focus, arrow keys) or navigation tabs |
| FilterBar | `ejs/filter-bar` | Chips or filter tiles; each is an `aria-pressed` toggle |
| DataGrid | `table.pd-table[data-grid]` | Search, column filters, Columns popover, paging, CSV export, density |
| Drawer | `ejs/drawer` | Modal overlay with focus trap; docked beside content at ≥1440 px inside `.pd-dock`; full screen below 768 px |
| Dialog | `ejs/dialog` / `<dialog class="pd-dialog">` | Native modal; Esc closes; focus returns to the opener |
| Popover, Menu | `ejs/popover` / `[data-pd-popover]` | Esc and outside clicks close it; menus move with the arrow keys |
| State | `ejs/state` | `empty`, `error`, `denied`, `loading`, `unavailable` |

The JavaScript API is `window.Podavo` (`icons`, `shell`, `search`, `drawer`, `dialog`, `popover`, `tabs`, `grid`, `localTime`).

## Catalogue and tests

```bash
npm install
npm run catalogue          # writes catalogue/dist/index.html, which you can open in a browser
npm test                   # renders every partial and checks its accessibility contract
npm run test:visual        # Playwright screenshots: light and dark × enterprise and consumer
npm run test:visual:update # accept intended visual changes
```

The catalogue page has switches for theme, variant and density, and the visual tests drive them through the URL (`?theme=dark&variant=consumer`).

## Versioning

The package follows semantic versioning; see [CHANGELOG.md](CHANGELOG.md).
