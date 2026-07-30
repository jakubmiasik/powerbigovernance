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
| `PORT` | Server port (default: 3000) |

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

## Operational Notes

- The application now validates production-critical configuration during startup. In production, set `SESSION_SECRET`, `SQL_SERVER`, and `SQL_DATABASE` explicitly.
- Analysis run metadata used by the global selector is cached briefly (`RUN_CACHE_TTL_MS`, default 30000) to avoid querying Azure SQL on every request.
- Startup side effects are isolated in `src/bootstrap.js`; importing `src/app.js` no longer starts the scheduler or runs migrations, which makes HTTP tests safer.
- API calls use bounded retry behavior for transient HTTP failures (`408`, `429`, and `5xx`) and respect `Retry-After` when present, capped by `API_MAX_RETRY_DELAY_MS` (default 120000) so one throttled request cannot block a run indefinitely.
- Analysis runs report why they are slow. The progress modal shows the current phase and the workspace or item being read, counters for API calls, throttling, retries and failures, and an activity log. A run waiting out a rate limit says so with a countdown; a run with no activity at all for `ANALYSIS_STALL_SECONDS` (default 90) is flagged as stalled.
- Basic security headers, JSON/form body limits, and a lightweight `/api` rate limiter are enabled without adding runtime dependencies.
- Startup migrations run statement by statement, so one failing `ALTER` no longer skips the migrations behind it, and a database that is unreachable at startup no longer prevents the capacity scheduler from starting.
- The capacity scheduler catches up on schedules that came due while the process was restarting or idle. The look-back window is `SCHEDULER_CATCHUP_MINUTES` (default 20, `0` disables it); already-completed runs are recognised from `capacity_schedule_history`, so a catch-up never repeats an action that already ran.
- On Azure App Service, enable **Always On** so the minute-by-minute scheduler tick keeps running when there is no incoming traffic. Without it, actions only fire when a request wakes the app and the schedule is still inside the catch-up window.

## Development Checks

```bash
npm run check:js
npm test
npm run check
```
