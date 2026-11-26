# UI design system: Podavo

Fabric Governance is built on **`@podavo/ui`**, the design system shared by every Podavo product. The package lives in [`packages/podavo-ui`](../packages/podavo-ui) and is documented in its [README](../packages/podavo-ui/README.md). This page covers how this application uses it.

## How it is wired

| Piece | Where |
|---|---|
| Tokens, components, behaviour | `packages/podavo-ui` (served at `/podavo-ui/css` and `/podavo-ui/js`; templates are read from disk) |
| Bootstrap bridge (this app is on Bootstrap 5.3) | `packages/podavo-ui/css/bootstrap-bridge.css` |
| Application layer: legacy aliases, governance-only pieces | `src/public/css/style.css` (`.gov-*` classes) |
| Shell | `src/views/partials/header.ejs` builds the navigation and the scan context, then renders the package's `app-shell-start` |
| Icon migration aid | `src/public/js/icon-map.js` draws Bootstrap Icons as their Lucide equivalents. Delete it once no page uses `bi-*` |

`<html>` carries `data-product="governance"` and `data-pd-variant="enterprise"`. Users switch theme (`data-theme`) and row density (`data-density`) from the top bar, and both choices are remembered.

## Principles carried into every screen

- **Findings before inventory.** Governance screens open with what needs attention.
- **No made-up numbers.** Anything not measured reads *Not evaluated*, *Not available* or *Not configured*. `metric-card` renders `value: null` as *Not evaluated*. There is no compliance score and no trend, because nothing measures them.
- **No decoration on operational screens.** There are no illustrations, background artwork or watermark icons. Icons come from Lucide only.
- **The application keeps its name.** The suite mark reads "Podavo", and the product name stays "Fabric Governance".
- **Only real features.** The shell has no notification bell, because there is no notification feed. Export works on rows already on screen and makes no request.

## Navigation

The navigation has five groups, set by `NAV_GROUPS` in `src/services/appSectionService.js`:

| Group | Pages |
|---|---|
| Overview | Home, Governance Overview |
| Governance | Workspaces, Deployment Pipelines, Tenant Settings |
| Operations | Run Analysis, Migrate Workspaces, Capacities |
| Data Quality | Security Groups, Quality Configuration, Reconciliation, Master Data |
| Configuration | Configuration, Users & Access, Grant Access, Governance Configuration (administrators only) |

Each section declares `icon` (the Bootstrap class, still used by the access panel) and `lucide` (the icon shown in the sidebar).

## Screens on Podavo components

| Screen | What it uses |
|---|---|
| Workspace Triage | Page header; three metric cards and a risk distribution; **finding tiles that act as filters** (click again to clear); a risk-scale strip whose full scoring opens in a dialog; thresholds in a popover; a data grid with a risk-level filter, column chooser, export and paging; a ⋯ row menu (details, open, delete); a **details drawer** with Overview, Findings, Access, Content and Activity tabs, docked beside the table at ≥1440 px and an overlay below that |
| Governance Overview | Metric cards and a risk distribution, prioritized findings that deep-link into triage (`?finding=`), workspaces to address first, inventory metric cards, a full workspace data grid, and a scan-context aside |
| No access, Error | The State component |

Every other page gets the shell, the tokens, Lucide icons and the Bootstrap bridge without changes. Its legacy `stat-card` tiles render as left-aligned metric cards. Migrate those pages one at a time, starting with layouts that use the components above.

## Safeguards that did not change

- Governance calculations, finding weights, risk bands and thresholds come from `workspaceInsightsService` unchanged. Triage reuses the same principal rules for its Owner and Access columns.
- Workspace deletion still requires a verified live status and a typed `DELETE`, and still hands over to the Fabric administrator sign-in. Rows hidden by a filter, a search or paging are deselected, so a bulk delete only covers rows the user can see.
- Navigation only lists sections the user holds. Route guards are untouched.

## Tests

- `npm test` runs the app tests and the package's component contract tests (`packages/podavo-ui/tests/components.test.js`).
- `npm run test:visual` renders triage, overview and no-access with a fixed fixture tenant, then compares screenshots in light and dark, comfortable and compact, at 1280, 1440, 1920 and 2560 px, plus the docked and mobile drawer. The package has its own catalogue screenshots under `packages/podavo-ui`. Both run in CI (`.github/workflows/visual-regression.yml`). A new baseline is written on its first run and uploaded as an artifact for you to commit.
