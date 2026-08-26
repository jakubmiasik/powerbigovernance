# Power BI Governance App

A web application to investigate and govern Power BI workspaces, reports, datasets, dashboards, dataflows, and user access across your tenant.

## Features

- **Workspace Explorer** — Browse all workspaces (your own or all via Admin API)
- **Report & Dataset Inventory** — View reports, datasets, dashboards, and dataflows per workspace
- **Dataset Deep Dive** — Inspect data sources, parameters, and refresh history
- **Dashboard Tiles** — Explore tile composition of dashboards
- **User & Access Review** — See who has access to each workspace and at what level
- **Governance Dashboard** — Tenant-wide metrics: capacity distribution, workspace states, refresh failures
- **Configurable Connection** — Set up service principal credentials via UI or environment variables
- **Entra ID Authentication** — Protect the app with Microsoft Entra ID sign-in (optional)
- **Scoped and Scheduled Scans** — Scan the whole tenant or just the workspaces you care about, on demand or on a schedule
- **Workspace Access** — See who can reach which workspace across the tenant, spot workspaces nobody administers, and grant the service principal access where it is missing
- **Data Reconciliation** — Define controls that verify records agree between two business systems, run them, and manage the resulting exceptions through a controlled lifecycle
- **Master Data Management** — Match records that arrived from many systems, build one golden record per entity, and publish it to a chosen destination with full provenance

## Prerequisites

- **Node.js** 18+
- **Entra ID App Registration** (for Power BI API access via service principal)
- **Power BI / Fabric Administrator** to grant the tenant settings the service principal needs
- **Azure Contributor** on each capacity the app should pause, resume or scale — a Fabric Administrator alone cannot do this
- An **Azure SQL database** for the application's own storage

The Home page carries the full checklist, grouped by where each permission is granted, in a **Prerequisites** panel. It is worth reading before the first scan: a missing permission rarely announces itself — the admin APIs return an empty list rather than an error when consent is missing, and a capacity action fails as "unauthorized" long after the capacity appeared in the inventory.

## Setup

### 1. Register a Service Principal for Power BI

1. Go to [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**
2. Name it (e.g., `PowerBI-Governance-SP`) and register
3. Under **Certificates & secrets**, create a new client secret
4. Under **API permissions**, add:
   - **Power BI Service** → `Tenant.Read.All` (Application permission)
   - Grant admin consent
5. Create a **Security Group** in Entra ID and add the service principal as a member
6. In **Power BI Admin Portal** → **Tenant settings** → **Developer settings**:
   - Enable **"Service principals can use Fabric APIs"**
   - Apply it to the security group you created

### 2. (Optional) Register a Web App for User Sign-In

1. Register another app in Entra ID for this web app
2. Set **Redirect URI** to `http://localhost:3000/auth/callback` (Web platform)
3. Under **Certificates & secrets**, create a client secret
4. Under **API permissions**, add `openid`, `profile`, `email`

### 3. Configure the App

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Or configure via the Settings page in the UI after starting the app.

### 4. Install & Run

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

For development with auto-reload:

```bash
npm run dev
```

## Configuration Options

| Variable | Description |
|---|---|
| `ENTRA_CLIENT_ID` | Web app client ID (for user sign-in) |
| `ENTRA_CLIENT_SECRET` | Web app client secret |
| `ENTRA_TENANT_ID` | Entra ID tenant ID |
| `POWERBI_CLIENT_ID` | Service principal client ID |
| `POWERBI_CLIENT_SECRET` | Service principal client secret |
| `POWERBI_TENANT_ID` | Tenant ID for Power BI API |
| `SESSION_SECRET` | Express session secret |
| `SCHEDULER_CATCHUP_MINUTES` | How far back a tick looks for a schedule that came due (default 240) — applies to capacity actions and analysis scans alike |
| `SCHEDULER_TICK_MS` | Scheduler tick interval (default 60000) |
| `REQUIRE_AUTH` | Force (`true`) or disable (`false`) the in-app sign-in requirement. Defaults to enabled whenever the app runs on Azure App Service. |
| `PORT` | Server port (default: 3000) |

Authentication is enforced in two places. Azure App Service EasyAuth should be configured with
`unauthenticatedClientAction: RedirectToLoginPage` and `/health` in `globalValidation.excludedPaths`
so the health probe (which also drives the scheduler catch-up tick) stays reachable. The application
additionally refuses anonymous requests itself, so leaving EasyAuth on "allow unauthenticated
access" no longer exposes the app.

## Architecture

```
src/
├── app.js                    # Express app with middleware & routes
├── server.js                 # Entry point
├── config/settings.js        # Configuration management (env + file)
├── services/
│   ├── authService.js        # MSAL client credentials authentication
│   └── powerbiService.js     # Power BI REST API wrapper
├── middleware/auth.js         # Entra ID authentication middleware
├── routes/
│   ├── index.js              # Home page
│   ├── auth.js               # Sign-in/sign-out routes
│   ├── config.js             # Settings page
│   ├── workspaces.js         # Workspace browsing & detail
│   └── governance.js         # Governance overview
└── views/                    # EJS templates with Bootstrap 5
```

## Power BI APIs Used

| API | Purpose |
|---|---|
| `GET /groups` | List workspaces |
| `GET /admin/groups` | List all workspaces (admin) |
| `GET /groups/{id}/reports` | Reports in workspace |
| `GET /groups/{id}/datasets` | Datasets in workspace |
| `GET /groups/{id}/dashboards` | Dashboards in workspace |
| `GET /groups/{id}/dataflows` | Dataflows in workspace |
| `GET /groups/{id}/users` | Workspace access |
| `GET /datasets/{id}/datasources` | Dataset data sources |
| `GET /datasets/{id}/refreshes` | Refresh history |
| `GET /datasets/{id}/parameters` | Dataset parameters |
| `GET /dashboards/{id}/tiles` | Dashboard tiles |
| `GET /capacities` | Available capacities |
| `POST /admin/workspaces/getInfo` | Workspace scanner |

## Running an Analysis

A scan reads the tenant through the admin APIs and stores what it found. Two things about *when* and *how much*:

### Scoping a scan

A scan used to mean the whole tenant, always. On a large tenant that is hours of API calls to answer a question about three workspaces, which is why scanning was something people did rarely rather than something they scheduled.

**What to scan** on `/analysis` offers the whole tenant or a chosen set of workspaces. The picker reads its list from the last completed tenant-wide scan, which costs nothing; *Refresh from tenant* reads it live, which is one API call and the only way to see a workspace created since — or to choose one at all before the first scan has ever run.

A scoped run narrows both the workspaces and the items, so every total it reports describes what was actually scanned rather than the tenant it sits in. It records the workspaces it was asked for **by name as well as id**, because a workspace deleted between runs still has to be nameable in the run history, and by then there is nothing left to look it up in. If a selected workspace is no longer visible to the service principal, the run says so in its progress log instead of quietly covering less — otherwise a nightly scoped scan shrinks week by week and nothing announces it.

Choosing "selected workspaces" and selecting none is refused rather than run tenant-wide. It normalises to the whole tenant internally (a scan of nothing is never what anyone meant), so the request is validated against what was *asked for*, not against the normalised result.

**Everything reading the tenant as a whole prefers the last tenant-wide run.** The Grant Access page, and the workspace list behind the grant dialog, would not be *wrong* about a scoped run's three workspaces — they would be wrong about every other workspace in the tenant, and silently. Pick any run from the dropdown to see it, and the page states the coverage when the run you are looking at is scoped. Runs recorded before scopes existed have no scope column and are treated as tenant-wide, which is what they were.

### Scheduled scans

A governance picture is only worth trusting if it refreshes without somebody remembering to press a button, and a scoped scan is short enough to run nightly. Schedules live on `/analysis`: a name, a service principal, a scope, a frequency (hourly, daily, weekdays, weekly), a time and a timezone.

They share the existing scheduler's tick rather than running their own — a second interval would mean a second self-healing path, a second catch-up window and two things to explain when nothing ran. The timing logic (including the daylight-saving-correct catch-up walk) moved into `scheduleDueService` so a capacity action and a scan cannot disagree about what "daily at 07:00 Europe/Warsaw" means. Saving a schedule echoes back the UTC minute it will actually fire at, because "07:00 Europe/Warsaw" and "which minute will this land on tonight" are different questions.

| | |
|---|---|
| **Catch-up** | A schedule due while the worker was recycled or idled out is still run, up to `SCHEDULER_CATCHUP_MINUTES` (default 240) late, and the log says how late |
| **No stacking** | A schedule never starts a scan on top of one of its own that is still running. It records the skip and names the run in the way. Two *different* schedules may run at once — scoped schedules per business area are meant to |
| **No double-start** | Dedupe is against the database, not memory, so a restart or a second worker mid-window cannot replay a scan |
| **Run now** | Goes through the same executor the scheduler uses, so testing a schedule cannot behave differently from the schedule itself — including refusing to stack |

The scheduler cannot import the analysis route (that would be a cycle, and would make it untestable without an Express app), and the runner has to stay with the route because it owns the in-memory progress map. So the route registers its runner with `analysisLauncher` at load and the scheduler asks that.

## Workspace Access

**Settings → Grant Access** (`/settings/access`) answers who can reach which workspace, and adds the service principal where it is missing. The two belong on one page: granting a principal access without seeing the access model is how a service account ends up Admin on every workspace in the tenant, and reviewing access without being able to act on it is a report nobody comes back to.

The **Grant SP Access to Workspaces** button has moved here from the Run Analysis page, which had the action and none of the context.

### Who has access to what

Three views of the same grants, driven by one filter (text, role, principal type):

- **Every grant** — the flat list: workspace, principal, email, type, role.
- **By workspace** — each workspace expands to show who is in it, with the role mix summarised.
- **By principal** — each principal expands to show every workspace they can reach, and the strongest role they hold anywhere.

Above them, the facts a grant list cannot show you:

| | |
|---|---|
| **No admin at all** | Nobody can administer the workspace, and nobody can grant anyone else access to it either — recoverable only by a tenant administrator |
| **A single admin** | One departure from the case above |
| **Access unreadable** | The scan could not read the workspace's access list. That is a gap in the evidence, not a workspace with nobody in it, and the two are counted separately everywhere |
| **Principals** | How many distinct identities hold access, and how many of them are service principals |

A principal is identified by email where one exists, then by object id, then by display name. Getting that order wrong would split one person across several rows on a case difference, or — worse — merge two service principals that share a display name.

Access is what the selected scan observed, not live state. The page names the scan and its date, and offers the other completed scans, because a report you cannot date is one you have to distrust.

### Granting

The grant dialog now says which workspaces **already have** the principal and pre-selects only the ones that do not, so the safe action no longer means checking each workspace by hand first. It grants to the service principal selected on the page rather than to whichever was configured first — with more than one tenant registered, that silently granted access to the wrong application. Failures are named individually: "granted 38 of 50" without saying which twelve, or why, is not something anyone can act on.

Granting uses the Power BI admin API on behalf of an administrator, so it asks you to sign in as one and returns you to this page afterwards.

## Data Reconciliation

Verifies that records representing the same business event exist and agree across two systems — an invoice in an ERP and the same invoice in the reporting platform, for example.

Reconciliation and master data sit together under **Quality** in the navigation, because they are two uses of the same registered systems. A system is registered once at `/quality/sources` and both read it; the section's own entry is **Quality Configuration** — `/quality`, the landing page showing what is configured. Each discipline has a **How it works** button explaining the steps, what it produces, and a worked example.

| Page | Purpose |
|---|---|
| `/quality` | What is configured across both disciplines, and the guides |
| `/quality/sources` | Register the systems reconciliation and master data read — the only place registration happens |
| `/reconciliation` | Oversight: active rules, open exceptions by type, severity, owner and age, a **Rules Overview** that expands each rule into the runs behind it, and recent runs. A dropdown scopes the whole page to what a single run found |
| `/reconciliation/rules` | Create, version, activate and retire controls; change status or assign an owner across several at once; run one or more of them |
| `/reconciliation/runs` | Full run history: what was checked, when, under which rule version, and what it produced. Runs can be deleted individually, per rule, or entirely |
| `/reconciliation/compare` | Every rule's latest run against its previous one, and any two runs of the same rule side by side |
| `/reconciliation/exceptions` | Investigate, assign, comment and resolve discrepancies, one at a time or in bulk |

The dataset dropdowns on the rule form and the master data model form carry a **text filter**: a warehouse with several hundred tables is a list nobody can scroll, and typing `sales` narrows it to `dbo.SalesOrder` and `Sales.Header` alike. A dataset already chosen stays selectable even when it falls outside the filter, so typing never silently changes which table a rule reads.

Two kinds of source can be registered:

- **Fabric lakehouses and warehouses.** You choose the tenant (service principal) the item belongs to, and the item list comes from that tenant's most recent completed analysis run. The source records which service principal it was registered under, so runs read it under the right credential instead of guessing. Its schema comes from the artifact details the analysis run already collected, so browsing fields costs no extra API calls.
- **Any other SQL Server or Azure SQL database**, by server, database and optional port, authenticating either with this application's Entra ID identity or with a SQL login whose password is stored encrypted (which requires `SECRET_ENCRYPTION_KEY`). *Test connection* checks it before you register, and the schema is read once at registration and stored, so authoring a rule never opens a connection to the business system. Other database engines are not supported — they would need their own wire protocol and driver, and a connector that quietly failed against them would be worse than saying so.

Batch changes apply the same status and/or owner to several rules at once. Rules are still checked individually: a batch activation moves the rules that are complete, names the ones it could not activate and why, and records a version entry for each rule it changed.

Exceptions can be worked in bulk, either on the rows ticked or on **everything the current filter covers** — the whole rule rather than the page, which matters because the list is capped. There is no size limit on a whole-set change: it is applied a page at a time and reports its progress, estimated time and running counts while it runs, so a decision over tens of thousands of exceptions is watchable rather than a spinner that may or may not still be alive. It shows how many exceptions it will touch, and refuses to run until the filter is narrowed to at least a rule, status, severity or type.

Filtering to a run means **what that run found**, read from the findings it recorded. It previously meant `last_run_id` — the most recent run that saw each exception — which coincides with the newest run and silently answers a different question for every earlier one.

A run's detail page loads its exception list a page at a time with a progress bar, so a run with a large number of findings shows the list filling rather than nothing at all.

**Rules Overview** replaces the flat "rules with open exceptions" list. Each rule expands to show which run its standing exceptions came from and how many each contributed, with a status filter across the whole section. An exception seen by several runs counts under each — the question is what a run contributed, not which run owns it. Exceptions no run accounts for, because they predate per-run findings, are shown as such rather than left to make the hierarchy not add up.

**Deleting a run** removes the run, its findings and its outcome counts. Exceptions are shared between the runs that saw them, so they are handled in two groups: those no surviving run ever recorded are deleted along with their values, differences and history; those other runs also saw are kept, with their first and last sighting and occurrence count recomputed from the findings that remain — leaving them pointing at a deleted run would make an exception look as if it came from nowhere. The confirmation says how many fall into each group before anything happens, and the deletion runs as a job with progress. Runs of one rule, or every run, can be deleted the same way; clearing the entire history requires an explicit confirmation.

Deletion also sweeps exceptions left with **no run behind them at all**. An exception recorded before per-run findings existed has no findings row, so attribution cannot see it, and it used to outlive the run that produced it and keep counting towards the current state. An install that deleted runs before this can clear what was stranded from a banner on the reconciliation page. Assign an owner, change severity, move status, or add a comment to all of them at once. Severity is set by the engine from the outcome, but what is material is a business judgement, so overriding it is recorded like any other decision. Bulk changes follow the same lifecycle as single ones: an exception that cannot make the transition is named rather than forced, closing needs a reason, and each exception gets its own history entries.

The comparison page opens on **every rule's latest completed run against the one before it** — exception count and change, how many items are newly failing, fixed and still failing, current severity mix, and a verdict per rule. A rule that has run only once is listed with what that run found and no comparison, since a control nobody has re-run is exactly the one worth noticing. Any two runs of the same rule can then be opened in detail.

Comparing two runs works from the findings each run recorded, not from its totals — twenty exceptions before and twenty after can mean nothing moved, or that twenty were fixed and twenty new ones appeared. Only runs of the same rule can be compared, because different rules check different records. Runs recorded before per-run findings were kept still compare on totals, and the page says so rather than reporting every item as fixed.

Each side of a comparison can be a **field**, a **SQL expression** evaluated by that source (`TRIM(Customer)`, `CASE WHEN Status = 1 THEN 'Posted' ELSE 'Draft' END`), a **fixed value** to check a column against, or an **aggregate**. Expressions are validated when the rule is saved — statement separators, comments and anything that writes are refused — but they are author-written SQL running against the source, so rule authoring should be treated as a privileged capability.

### Comparing across different grains

The two systems often hold the same fact at different grains: an analytical ledger with one row per posting, and a synthetic balance with one row per account. Row-by-row comparison is meaningless there. An **aggregate** operand states the control as it actually reads — `Sum of Amount` on the detailed side against the plain `Amount` field on the summarised side, with `Account` as the business key:

```sql
-- source A, the analytical ledger
SELECT [Account] AS [recon_key], SUM([Amount]) AS [recon_c0a] FROM [dbo].[Postings] GROUP BY [Account]
-- source B, the synthetic balance
SELECT [Account] AS [recon_key], [Amount] AS [recon_c0b] FROM [dbo].[Balances]
```

The functions are `sum`, `count`, `count distinct`, `average`, `minimum` and `maximum`, and each wraps either a column or an expression (`SUM(CASE WHEN Reversed = 0 THEN Amount ELSE 0 END)`). The function comes from a fixed list rather than from the rule text, so choosing "sum" can never turn the projection into something else.

The aggregation happens in the source database, not here: it groups far better than this process can, and reading a million postings across the wire to add them up in JavaScript is precisely the cost the grouping exists to avoid. The `GROUP BY` is derived from the projection — everything selected that is not itself an aggregate — so the two cannot drift apart.

An aggregated side returns one row per business key by construction, so duplicates on that side cannot arise and the rule's duplicate handling has nothing to act on there. Every value read from that side must then aggregate as well: a plain column alongside an aggregate would silently join the `GROUP BY` and split one business key into several rows, raising duplicates that exist only because of how the rule was written. The rule form warns while it is being written, and the server refuses it on save, naming the values that need attention.

### Groups of rules

Every rule belongs to a group naming the *kind* of control it is, independent of which systems it happens to touch: **Start-to-Start**, **Start-to-End**, **End-to-End**, **Point-to-Point**, **Left-to-Right**, **Right-to-Left**, **Aggregate-to-Detail**, **Period-over-Period**, or **Ungrouped** for one nobody has classified yet.

The group is denormalised onto runs and exceptions the same way the rule name is, because the exception list filters and groups by it on every page load. It appears on the rule list and form, the exception list and detail, the run list and detail, the comparison overview, and the Rules Overview hierarchy, and both the exception list and the Rules Overview can be filtered to one group. Re-classifying a rule carries through to the exceptions it already raised on the next run that sees them, rather than leaving the estate split between the old label and the new one.

The dashboard gains a **Coverage by Group of Rules** panel showing, per group, how many rules exist, how many are active, and how many exceptions are open. That answers the question no individual rule can: an estate with forty Left-to-Right controls and no Right-to-Left one is checking that nothing was lost and not noticing what the target invented.

Outcomes are match, missing from source A, missing from source B, value mismatch, duplicate record, and invalid or incomplete key. Numeric and date comparisons support tolerances so agreed-immaterial differences do not raise exceptions.

Exceptions follow a controlled lifecycle — open, acknowledged, in investigation, resolved, ignored/accepted — and unsupported transitions are refused. Closing one requires a recorded reason. Every rule change, run, assignment, comment and decision is retained for audit, and an exception seen again after being closed is reopened with a note rather than silently staying closed.

## Master Data Management

Turns raw records that arrived from several source systems into one agreed version of each customer, product or supplier — the golden record.

| Page | Purpose |
|---|---|
| `/mdm` | Models, headline numbers, recent runs |
| `/quality/sources` | Where the raw table's system and the destination are registered |
| `/mdm/models/:id` | Define the raw table, the fields, how records are matched, which value survives, and where to publish |
| `/mdm/runs` | Full run history: which model version produced which golden records, and whether it was published |
| `/mdm/runs/:id` | The golden records with per-value provenance, the crosswalk back to source records, and the pairs a steward still has to decide |

Sources come from the same registry the reconciliation engine uses, so a lakehouse or database registered once serves both. The raw table is normally a Fabric lakehouse table holding every record from every system; the destination is chosen from the same list.

**A Fabric lakehouse SQL analytics endpoint is read-only**, so it can hold the raw table but cannot be a destination. A Fabric *warehouse*, an Azure SQL database or any registered SQL Server can. The model form says so when a read-only destination is selected rather than letting a run fail at its last step.

A **preview** masters the records and stores the result for review without touching the destination. **Publishing** also writes the golden records, and is only offered for an active model, because it replaces a table other systems read.

### The pipeline

**1. Standardise** — remove differences that carry no meaning, without overwriting the original: trim, collapse spaces, case, strip punctuation, fold accents, digits only, letters and digits only, sort words, and expand abbreviations from a configurable map (`ST` → `STREET`, `LTD` → `LIMITED`). Values the model treats as absent — `""`, `-`, `N/A`, `NULL`, `UNKNOWN` — become null, so two records are never merged for both saying "unknown".

**2. Block** — comparing every record with every other is quadratic; a hundred thousand rows is five billion comparisons. A blocking key groups records that share something cheap and only compares within the group. Available keys: exact value, first N characters, Soundex, same words in any order, and shared N-gram. Use several — a pair is a candidate if it shares *any* of them, which recovers what a single key would miss. Every run reports its largest block, because one key that lands most records in a single block gives the quadratic cost straight back and the only symptom is a run that never finishes.

**3. Match** — each candidate pair is scored field by field, with a comparator suited to the errors that field actually suffers:

| Comparator | Use it for |
|---|---|
| Exact | Identifiers, where partial agreement means nothing |
| Edit distance | References and short codes with typos |
| Jaro-Winkler | Person names — it rewards agreement at the start |
| Shared words | Company names and addresses, where word order and extra tokens vary |
| Numeric tolerance | Amounts and quantities; degrades past the tolerance rather than falling off a cliff |
| Date tolerance | Dates recorded at different precision |
| Sounds alike | A blunt instrument — give it less weight than a string comparator |

Weights are normalised across the fields that could actually be compared, so a pair where half the fields are empty is not quietly penalised — without that, sparse records never reach the threshold, and they are the ones most in need of mastering. Per field you can also choose what a missing value means (ignore it, count it as disagreement, or score it neutral), mark a field **required** (the pair is rejected unless it agrees — a shared tax ID), or mark it a **blocker** (the pair is rejected if it *disagrees*, but it may be absent — country, legal entity). Two thresholds decide the outcome: merge automatically above one, send to a steward between them, reject below.

**4. Group** — matched pairs become entities by transitive closure. Transitivity is also how master data over-merges: A matches B, B matches C, and A and C are unrelated. **Strict grouping** refuses to merge a group unless every pair within it matched, trading recall for a guarantee. Leave it off while tuning; turn it on before anyone depends on the output. Either way, a group far larger than the rest is flagged as suspected over-merging.

**5. Survive** — the rule that picks the surviving value is a business decision, so each field carries its own: most recent, most trusted source, most agreed (voting, ties broken by trust then recency), longest, first non-empty, highest, lowest, total, or reserved for a steward. A source that is not on the trust list ranks last, never first, so an unexpected new system cannot silently outrank the book of record.

Every surviving value records which rule chose it, why, and which source record it came from. A golden record whose values cannot be traced back cannot be defended, and disagreement is the normal case in master data. The optional crosswalk table carries the same mapping to the destination.

Pairs in the middle band go to a steward. Those decisions are the tuning signal: pairs confirmed as the same entity that scored below the threshold say it is set too high, and rejected pairs scoring close to it say the opposite.

## Data Model and Performance

An analysis run's result was stored only as one `results_json` document. That is a good way to keep an immutable record of a scan and a poor way to query it: opening one workspace meant reading and parsing the whole tenant on every page load, with no index able to help, and any question narrower than "give me everything" paid the cost of everything.

The same facts are now also written in third normal form — `analysis_workspaces`, `analysis_items`, `analysis_workspace_users`, each keyed by run plus the identifier that names the thing, with indexes on the predicates that are actually used. The document is still written, because it is the faithful record of the scan and the whole-tenant analytics (Governance Overview, workspace triage, run comparison) genuinely do want all of it. It simply stops being the query path.

- Runs are indexed as they complete. `POST /analysis/index/:runId` builds the tables for a run recorded before they existed; that is done on request rather than at startup, because normalising every historic run at boot would mean parsing every stored document before the app could serve anything.
- Readers check whether a run has been indexed and fall back to the document if not, so nothing breaks on an un-indexed run. `analysis_run_model_state` is what makes "this run found nothing" distinguishable from "this run predates the tables".
- Rebuilding a run replaces its rows, so re-indexing converges instead of duplicating.
- `getAnalysisRunMeta` reads a run without its document, for the many callers that only wanted a status or a service principal id and were pulling megabytes to get one.
- Exception listing selects only the columns it renders. The stored values and differences are large JSON documents the list never shows.
- Indexes were added for predicates the newer features query on but had no support for: exceptions by rule and status, exceptions by owner, golden records by model, crosswalk by source record.

### Reconciliation

The reconciliation engine is fully normalised. What used to be four JSON columns are now tables:

| Was | Is | Why |
|---|---|---|
| `recon_rules.compare_fields` | `recon_rule_fields` | One row per compare field, with the operand kind, aggregate function and tolerance as columns. Changing one field no longer rewrites the whole definition, and "which rules compare this column" becomes answerable |
| `recon_exceptions.values_a` / `values_b` | `recon_exception_values` | One row per field per side. The list and every bulk action work without them, which is the point |
| `recon_exceptions.differences` | `recon_exception_differences` | One row per disagreeing field, indexed by field — so "which field mismatches most often" is a query |
| `recon_runs.counts_json` | `recon_run_outcome_counts` | One row per outcome, so trends across runs are a query rather than a parse of every run |

**Bulk updates are set-based.** Applying a decision to fifty exceptions used to cost about a hundred round trips — one `UPDATE` and one history insert each — which is what made changing a whole rule slow. The decision is uniform, so the work is now grouped by which parts of it actually change something and each group is one statement, chunked to stay under SQL Server's 2100-parameter limit. Fifty exceptions cost three statements; five thousand cost a handful. Every exception still gets its own history entries.

Run ingest is batched the same way: values, differences, findings and history each go in one multi-row insert per chunk rather than one statement per row.

`recon_rule_versions.snapshot` stays a document deliberately — it is an immutable copy of a definition at a point in time, not something anyone queries into. It now carries the compare fields explicitly, since the rule row no longer does.

Rows written before this schema keep working: readers fall back to the stored JSON, and `fields_normalized` / `values_normalized` distinguish a converted row with nothing in it from one that predates the tables. `POST /reconciliation/normalize` converts them, on request rather than at startup.

### What was left as JSON, deliberately

A golden record's provenance and a run's progress snapshot are each read as a whole, by one owner, and never filtered on. Splitting them would add joins and buy nothing — 3NF is worth it where you query the parts.

## Operational Notes

- The application now validates production-critical configuration during startup. In production, set `SESSION_SECRET`, `SQL_SERVER`, and `SQL_DATABASE` explicitly.
- Analysis run metadata used by the global selector is cached briefly (`RUN_CACHE_TTL_MS`, default 30000) to avoid querying Azure SQL on every request.
- Startup side effects are isolated in `src/bootstrap.js`; importing `src/app.js` no longer starts the scheduler or runs migrations, which makes HTTP tests safer.
- API calls use bounded retry behavior for transient HTTP failures (`408`, `429`, and `5xx`) and respect `Retry-After` when present, capped by `API_MAX_RETRY_DELAY_MS` (default 120000) so one throttled request cannot block a run indefinitely.
- Analysis runs collect per-artifact details (item metadata, lakehouse tables, SQL endpoint schema, semantic model sources and refreshes, dashboard tiles) into `item_details_cache`, so opening an artifact reads the database instead of calling the APIs. Bounded by `ANALYSIS_DETAIL_MAX_ITEMS` (default 2000) and `ANALYSIS_DETAIL_CONCURRENCY` (default 4), and skippable with `ANALYSIS_COLLECT_DETAILS=false`. Artifacts the run did not cover still load on first view and are stored then.
- Analysis runs report why they are slow. The progress modal shows the current phase and the workspace or item being read, counters for API calls, throttling, retries and failures, and an activity log. A run waiting out a rate limit says so with a countdown; a run with no activity at all for `ANALYSIS_STALL_SECONDS` (default 90) is flagged as stalled.
- **A scan can be sent to the background and picked up later.** *Continue in background* closes the modal while the scan keeps running on the server; the **Status** value in the runs table is a button that reopens the progress view for that run, and shows its percentage, current step and a progress bar without opening anything. Progress is written to `analysis_run_progress` every `ANALYSIS_PROGRESS_PERSIST_MS` (default 4000), so a run can be checked on after a page reload, from a different browser, or from a different application instance — the modal says when it is reading another instance's checkpoint, since cancellation only works on the instance executing the run.
- Progress is measured as work units per step rather than as fixed percentages. Each step reports what it has finished and what is left (`85 / 210`, `125 remaining`), the overall bar is weighted by how expensive each step actually is, and an estimated time remaining appears once the estimate is worth showing. A run in flight never reads 100%.
- A run whose application instance stopped mid-scan is recognised rather than left at "running" forever: once its progress has not been written for `ANALYSIS_HEARTBEAT_STALE_SECONDS` (default 900) it is reported as **interrupted**, and startup marks such runs interrupted in the database.
- Basic security headers, JSON/form body limits, and a lightweight `/api` rate limiter are enabled without adding runtime dependencies.
- Bootstrap's contextual table row classes (`table-warning` and friends) paint a pale background and set black text. The app's dark theme colours table cells directly, which wins on the cells and puts light text back — pale on pale. Dark mode now gives those rows dark tints at a specificity that beats the generic cell rule, so a highlighted row stays both highlighted and readable.
- `analysis_workspace_users` rows were written with nulls for every identity field. A scan compacts each user to `{name, email, role, type}` before storing the run, and the indexer read only the admin API's own names (`displayName`, `emailAddress`, `groupUserAccessRight`, `principalType`) — so the grant count was right and nobody in it could be named. Both shapes are now accepted. **Runs indexed before this need re-indexing** from the Run Analysis page to pick up the identities; the access page falls back to the stored document meanwhile.
- An aggregate operand is stored as a function plus what the function is applied to (`a_fn`, `a_value_kind`), rather than as `"sum(Amount)"` encoded into the value text — text nothing could query, validate, or re-render back into a form.
- A rule's group lives on the rule, and is denormalised onto `recon_runs` and `recon_exceptions`. The exception list filters and groups by it on every page load, and joining back to the rule for a label would cost that join on every row.
- Every reconciliation view is rendered in the test suite with the shape its route supplies. These templates are only reachable through a live database, so a local a route stopped passing — or a column a view started reading — used to appear as a blank page in a browser and nowhere else.
- Analysis runs carry their scope (`scope_kind`, `scope_workspaces`) and, when a schedule started them, `schedule_id`. Storing the chosen workspaces as a document is deliberate: it is read as a whole, by one owner, and never filtered on — the same reasoning as the other things left as JSON below.
- Repository queries that share one connection run one after another. A `tedious` connection carries a single request at a time, so issuing several together leaves the first answered and the rest rejected — which is how the reconciliation dashboard came to render empty panels that looked like stale data. A panel that genuinely cannot be read is now named on the page and logged, rather than blanked silently.
- Startup migrations run statement by statement, so one failing `ALTER` no longer skips the migrations behind it, and a database that is unreachable at startup no longer prevents the capacity scheduler from starting.
- The capacity scheduler catches up on schedules that came due while the process was restarting or idle. The look-back window is `SCHEDULER_CATCHUP_MINUTES` (default 20, `0` disables it); already-completed runs are recognised from `capacity_schedule_history`, so a catch-up never repeats an action that already ran.
- On Azure App Service, enable **Always On** so the minute-by-minute scheduler tick keeps running when there is no incoming traffic. Without it, actions only fire when a request wakes the app and the schedule is still inside the catch-up window.

## Development Checks

```bash
npm run check:js
npm test
npm run check
```
