# UI design system

How the Fabric Governance screens are built, and what to use when adding or reworking one.

## Principles

- **Findings before inventory.** Governance screens open with what needs attention, then show what it was found in.
- **No made-up numbers.** If a value was not measured, show *Not evaluated*, *Not available* or *Not configured*. Never show a placeholder score, trend or percentage. `partials/ui/kpi` renders `null` as *Not evaluated* for this reason.
- **Progressive enhancement.** Every table lists every row and every link works without `ui.js`. Scripts add search, paging and drawers, and never add access the server did not grant.
- **Colour never carries meaning alone.** Severity pills, status dots and risk badges always come with a text label.

## Tokens (`src/public/css/style.css`, section 1)

| Token | Value | Use |
|---|---|---|
| `--color-primary` | `#0F766E` | Brand teal: primary buttons, active nav, links |
| `--shell-bg` | `#0B1D33` | Navy sidebar (stays navy in dark mode) |
| `--color-bg` / `--color-surface` | `#F4F6F9` / `#FFFFFF` | Canvas and cards |
| `--sem-{success,warning,danger,info,neutral}-{fg,bg,solid,border}` | | Semantic states |
| `--space-1` … `--space-12` | 4 px steps | All spacing |
| `--font-body` | Segoe UI, then Inter | Type |

Text/background pairs are checked against WCAG 2.2 AA. Text pairs need 4.5:1, and form-control borders need 3:1 (`--color-border-strong`). If you change a token, check its pair again.

The Bootstrap variables (`--bs-primary-rgb` and others) are mapped to these tokens. As a result, existing screens built with Bootstrap utilities (`btn-primary`, `badge bg-danger`, `alert-warning`, `text-success`) pick up the system without being rewritten. Badges render as tinted pills.

## Shell (`partials/header.ejs`, `partials/footer.ejs`)

- **Sidebar.** The sidebar has five groups: Overview, Governance, Security & Access, Operations and Configuration. A section's group comes from `group` in `services/appSectionService.js`, and `NAV_GROUPS` sets the order. Admin-only pages are listed in the header and shown only to administrators. The routes still enforce access.
- **Context bar.** The context bar shows the tenant (the service principal and tenant ID of the selected scan) and the data status: *Scan data loaded*, *No completed scan*, *Viewing a fixed scan* or *Data store unavailable*. It also shows when the scan ran (`<time data-local-time>`, displayed in the viewer's time zone) and the scan selector.
- **Global search.** Press **Ctrl K** to search. Results come only from the navigation rendered for the user. The search can also jump to Workspace Triage with `?q=`.
- **Preferences.** Theme, row density and the collapsed sidebar are stored in `localStorage` and applied before first paint.

## Components

| Component | Where | Notes |
|---|---|---|
| Page header | `partials/ui/page-header` + `.page-actions` | One `h1` per page |
| KPI tile | `partials/ui/kpi` | `value: null` renders as *Not evaluated* |
| State | `partials/ui/state` | Kinds: `empty`, `error`, `denied`, `loading`, `unavailable` |
| Drawer | `partials/ui/drawer` + `Drawer.open(id, opener)` | Modal dialog that traps focus and closes on Esc. Full screen below 768 px |
| Data grid | `table[data-grid]` | See below |
| Chips | `.chip[aria-pressed]` | Filter toggles |
| Findings list | `.finding-list > .finding-item` | Severity icon, title, description, count, action |
| Layouts | `.layout-split`, `.panel-grid.cols-2/3`, `.kpi-grid.cols-4`, `.inventory-grid` | Use the extra width for context panels |

All partials take a single `ui` object, for example `include('partials/ui/state', { ui: { kind: 'empty', title: '…' } })`. EJS includes inherit the page's locals, so a bare `title` would pick up the page title.

### Data grid

```html
<div data-grid-toolbar-for="myTable"><!-- optional: page buttons --></div>
<div class="table-responsive">
  <table id="myTable" class="table" data-grid data-grid-label="workspaces">
    <th data-col="name" data-col-required>Name</th>
    <th data-col="state" data-filter-col>State</th>        <!-- adds a "State: All" filter -->
    <th data-col="extra" data-col-default="wide">Extra</th> <!-- shown by default only at ≥1920 px -->
```

The grid adds search, column filters, a Columns menu (choices are remembered per table), a density switch, and paging with 10, 25, 50 or 100 rows per page. Pages can add their own row predicates with `DataGrid.get('myTable').setFilter(name, fn)`. To react to changes, listen for the `grid:render` event, which reports `{ total, matched, shown, page, pages }`. Header sorting works on every table and from the keyboard (`aria-sort`). Opt a table out with `data-no-sort`.

Rows hidden by a filter or by paging are never selected. Workspace Triage depends on this, so a bulk delete only ever covers rows the user can see.

## Responsive behaviour

| Width | Behaviour |
|---|---|
| ≥ 2560 | Content capped at 2280 px; wider aside (460 px) and drawer (600 px) |
| ≥ 1920 | `wide` columns appear, the drawer widens, and content is capped at 1840 px |
| ≥ 1440 | Three-column panel grids, more padding, and secondary table columns (`hide-below-1440`) |
| ≥ 1280 | The context aside sits beside the main column |
| < 992 | The sidebar becomes an overlay (Esc closes it) and the breadcrumb is hidden |
| < 768 | Drawers go full screen, filter chips scroll sideways, and KPIs show in two columns |

## Accessibility checklist for new screens

- Use one `h1` per page and section headings in order.
- Every icon is `aria-hidden="true"`, and every icon-only button has an `aria-label`.
- Tables get `scope="col"`. Put an action column's label in `visually-hidden`.
- Destructive or permission-changing actions use an explicit confirmation (`showConfirmAction`, or a typed confirmation as in workspace deletion).
- Results are announced: toasts are a polite live region, and error toasts use `role="alert"` and stay on screen for 8 seconds.
- `:focus-visible` is styled globally. Do not remove outlines.
