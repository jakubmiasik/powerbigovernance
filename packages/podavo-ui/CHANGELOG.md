# Changelog

`@podavo/ui` follows [Semantic Versioning](https://semver.org/):

- **Major**: a token, class, partial parameter or JS API is removed or renamed, or its meaning changes in a way that breaks existing markup.
- **Minor**: new components, tokens, variants or options that existing markup does not need to change for.
- **Patch**: fixes to existing behaviour or appearance that keep the API unchanged.

Every release that changes how something looks must update the visual baselines (`npm run test:visual:update`) in the same change, so reviewers can see the difference.

## 1.0.0 — first release

- Tokens: colour (light and dark), semantic states, spacing (4 px grid), radii, shadows, type, motion, layout.
- Variants: `data-pd-variant="enterprise | consumer"`, row density `data-density="comfortable | compact"`, product accent `data-product`.
- Components: AppShell, Sidebar, Topbar, PageHeader, Button, IconButton, Input, Select, SearchField, Badge, Avatar, Card, MetricCard, Tabs, FilterBar (chips and filter tiles), DataGrid, Drawer (overlay or docked), Dialog, Popover, Menu, State, Toast, distribution bar, meta list, stepper.
- Behaviour (`js/podavo.js`): Lucide icon rendering, shell toggles, command search, drawer with focus management, dialog, popover and menu, tabs with arrow keys, data grid (search, filters, columns, paging, CSV export).
- Optional Bootstrap 5.3 bridge (`css/bootstrap-bridge.css`).
- Component catalogue (`npm run catalogue`) and visual regression tests (`npm run test:visual`).
