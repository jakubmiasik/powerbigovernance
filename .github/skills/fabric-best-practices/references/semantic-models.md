# Semantic Models & Reports

## Reuse first

- Build **shared semantic models** owned by a data team; reports connect live to them
  ("thin reports"). Avoid one model per report — it duplicates logic and refresh cost.
- **Endorse** (Promoted/Certified) the shared models so people find the right one.
- Separate model and report artifacts in Git and in workspaces where practical.

## Storage mode

| Mode | Use when | Watch out for |
|------|----------|---------------|
| **Direct Lake** | Gold data already in OneLake Delta tables; large data; near-real-time without refresh | Capacity guardrails (rows per table, model size, files/row groups per table, by SKU); fallback to DirectQuery (Direct Lake on SQL endpoint) when exceeded or with SQL views/RLS on the endpoint; calculated columns/tables limitations |
| **Import** | Small-to-medium data, best query performance, complex transformations in Power Query | Refresh windows and memory; use incremental refresh |
| **DirectQuery** | Data must stay at source / truly real-time | Slower, source load; limit visuals per page; use aggregations |
| **Composite** | Mix of the above, aggregations over DirectQuery | Complexity; relationship limitations across source groups |

- For Direct Lake, keep gold tables **V-Ordered and optimized**, avoid views if you want
  to stay in Direct Lake, and decide whether to allow DirectQuery fallback.
- Confirm current guardrails per F SKU on learn.microsoft.com before sizing.

## Modeling

- **Star schema**: fact tables with numeric measures and foreign keys; dimension tables
  with descriptive attributes. Avoid wide flat tables and snowflaking where not needed.
- Relationships: **one-to-many, single direction**. Use bi-directional filtering or
  many-to-many only deliberately (and prefer `CROSSFILTER` in a measure).
- Integer surrogate keys for relationships; hide key columns from report view.
- A proper **date table**, marked as date table; **turn off Auto date/time**.
- Remove unused columns and rows; reduce **cardinality** (split datetime into date and
  time, round decimals, avoid high-cardinality text) — size drives memory and speed.
- Do transformations **upstream** (gold layer / Power Query with folding), not in
  DAX calculated columns.
- Use **explicit measures** for every aggregation; hide raw numeric columns; set
  "summarize by: none" on non-additive columns.
- Organize with **display folders**, add **descriptions** to tables/columns/measures,
  use business-friendly names, and format strings.
- Use **calculation groups** for time intelligence and repeated patterns.
- Use **incremental refresh** (and the **large semantic model storage format**) for
  large Import models.

## DAX

- Use variables (`VAR`) to avoid repeated evaluation and improve readability.
- Use `DIVIDE` instead of `/`; avoid `IFERROR`/`ISERROR`.
- Filter columns, not tables: `CALCULATE([Sales], 'Product'[Color] = "Red")` instead of
  `FILTER('Product', …)` over whole tables.
- Prefer `SELECTEDVALUE`, `TREATAS`, `KEEPFILTERS` patterns over complex iterators;
  avoid nested iterators over large fact tables.
- Measure performance with **Performance Analyzer** and **DAX Studio**.

## Automated checks

- Run **Best Practice Analyzer** rules — Tabular Editor, or in Fabric notebooks with
  **Semantic Link Labs** (`labs.run_model_bpa(...)`) — and the **Memory Analyzer /
  VertiPaq Analyzer** to find oversized columns. Integrate BPA into CI where possible.

## Security in models

- Implement **RLS** with dynamic rules (`USERPRINCIPALNAME()` against a security table),
  assign roles to **security groups**, test with "View as role".
- Use **OLS** to hide sensitive tables/columns.
- Remember workspace Admin/Member/Contributor bypass RLS — consumers should be Viewers
  or app users only.

## Refresh

- Schedule refreshes outside business peaks, stagger them, avoid refresh storms on the
  hour. Chain refresh after data loads (pipeline semantic model refresh activity)
  rather than guessing times.
- Configure refresh **failure notifications** to a group/distribution list.
- Use service-principal or workspace-identity based connections, not personal credentials.

## Reports

- Limit visuals per page (a rule of thumb: keep it lean; each visual issues queries).
- Use **bookmarks, drill-through, tooltips** instead of crowded pages.
- Consistent **theme** (organizational JSON theme), accessible colors and contrast,
  alt text, logical tab order.
- Distribute through **workspace apps** with audiences; avoid sharing individual reports
  ad hoc. Use **subscriptions** and **Data Activator alerts** for push delivery.
- Avoid custom visuals not certified or not approved by the organization.
