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
- **Data Reconciliation** — Define controls that verify records agree between two business systems, run them, and manage the resulting exceptions through a controlled lifecycle
- **Master Data Management** — Match records that arrived from many systems, build one golden record per entity, and publish it to a chosen destination with full provenance

## Prerequisites

- **Node.js** 18+ 
- **Entra ID App Registration** (for Power BI API access via service principal)
- **Power BI Admin** permissions (for admin-level APIs)

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

## Data Reconciliation

Verifies that records representing the same business event exist and agree across two systems — an invoice in an ERP and the same invoice in the reporting platform, for example.

| Page | Purpose |
|---|---|
| `/reconciliation` | Oversight: active rules, open exceptions by type, severity, owner and age, rules with recurring discrepancies, recent runs. A dropdown scopes the whole page to what a single run found |
| `/reconciliation/sources` | Register the systems to compare and browse their datasets and fields |
| `/reconciliation/rules` | Create, version, activate and retire controls; change status or assign an owner across several at once; run one or more of them |
| `/reconciliation/runs` | Full run history: what was checked, when, under which rule version, and what it produced |
| `/reconciliation/compare` | Every rule's latest run against its previous one, and any two runs of the same rule side by side |
| `/reconciliation/exceptions` | Investigate, assign, comment and resolve discrepancies, one at a time or in bulk |

Two kinds of source can be registered:

- **Fabric lakehouses and warehouses.** You choose the tenant (service principal) the item belongs to, and the item list comes from that tenant's most recent completed analysis run. The source records which service principal it was registered under, so runs read it under the right credential instead of guessing. Its schema comes from the artifact details the analysis run already collected, so browsing fields costs no extra API calls.
- **Any other SQL Server or Azure SQL database**, by server, database and optional port, authenticating either with this application's Entra ID identity or with a SQL login whose password is stored encrypted (which requires `SECRET_ENCRYPTION_KEY`). *Test connection* checks it before you register, and the schema is read once at registration and stored, so authoring a rule never opens a connection to the business system. Other database engines are not supported — they would need their own wire protocol and driver, and a connector that quietly failed against them would be worse than saying so.

Batch changes apply the same status and/or owner to several rules at once. Rules are still checked individually: a batch activation moves the rules that are complete, names the ones it could not activate and why, and records a version entry for each rule it changed.

Exceptions can be worked in bulk: select any set — filtering by rule first, for instance — and assign an owner, change severity, move status, or add a comment to all of them at once. Severity is set by the engine from the outcome, but what is material is a business judgement, so overriding it is recorded like any other decision. Bulk changes follow the same lifecycle as single ones: an exception that cannot make the transition is named rather than forced, closing needs a reason, and each exception gets its own history entries.

The comparison page opens on **every rule's latest completed run against the one before it** — exception count and change, how many items are newly failing, fixed and still failing, current severity mix, and a verdict per rule. A rule that has run only once is listed with what that run found and no comparison, since a control nobody has re-run is exactly the one worth noticing. Any two runs of the same rule can then be opened in detail.

Comparing two runs works from the findings each run recorded, not from its totals — twenty exceptions before and twenty after can mean nothing moved, or that twenty were fixed and twenty new ones appeared. Only runs of the same rule can be compared, because different rules check different records. Runs recorded before per-run findings were kept still compare on totals, and the page says so rather than reporting every item as fixed.

Each side of a comparison can be a **field**, a **SQL expression** evaluated by that source (`TRIM(Customer)`, `CASE WHEN Status = 1 THEN 'Posted' ELSE 'Draft' END`), or a **fixed value** to check a column against. Expressions are validated when the rule is saved — statement separators, comments and anything that writes are refused — but they are author-written SQL running against the source, so rule authoring should be treated as a privileged capability.

Outcomes are match, missing from source A, missing from source B, value mismatch, duplicate record, and invalid or incomplete key. Numeric and date comparisons support tolerances so agreed-immaterial differences do not raise exceptions.

Exceptions follow a controlled lifecycle — open, acknowledged, in investigation, resolved, ignored/accepted — and unsupported transitions are refused. Closing one requires a recorded reason. Every rule change, run, assignment, comment and decision is retained for audit, and an exception seen again after being closed is reopened with a note rather than silently staying closed.

## Master Data Management

Turns raw records that arrived from several source systems into one agreed version of each customer, product or supplier — the golden record.

| Page | Purpose |
|---|---|
| `/mdm` | Models, headline numbers, recent runs |
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
