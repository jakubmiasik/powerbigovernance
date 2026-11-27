// Shared by every test file: the modules under test, fixtures and helpers.
// Moved here unchanged from the single test file it used to be.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-with-enough-length';
process.env.RUN_CACHE_TTL_MS = '1';

const app = require('../src/app');

function request(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

function postJson(server, path, payload) {
  const { port } = server.address();
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); } catch (err) { reject(new Error('Non-JSON response: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const { convertScheduleToUtc } = require('../src/services/scheduleTimeService');
const scheduler = require('../src/services/schedulerService');

const runMetrics = require('../src/services/runMetricsService');

const workspaceDeletion = require('../src/services/workspaceDeletionService');
const dbService = require('../src/services/databaseService');

function stubDeletionDb() {
  const calls = { marked: [], runs: [] };
  const originalMark = dbService.markWorkspaceDeleted;
  const originalRuns = dbService.markWorkspaceDeletedInRuns;
  dbService.markWorkspaceDeleted = async (args) => { calls.marked.push(args); };
  dbService.markWorkspaceDeletedInRuns = async (id) => { calls.runs.push(id); return 1; };
  calls.restore = () => {
    dbService.markWorkspaceDeleted = originalMark;
    dbService.markWorkspaceDeletedInRuns = originalRuns;
  };
  return calls;
}

function sampleRun(overrides) {
  return Object.assign({
    summary: {
      totalWorkspaces: 2, totalItems: 3, totalReports: 2, totalDatasets: 1,
      totalUsers: 2, totalStorageSize: 1024, capacities: [{ id: 'c1' }],
      workspacesOnCapacity: 1, workspacesOnSharedCapacity: 1,
    },
    workspaces: [
      {
        id: 'ws-1', name: 'Finance', state: 'Active', totalItems: 2, reportCount: 2,
        capacitySku: 'F64', licenseType: 'Fabric', capacityId: 'cap-a',
        items: [
          { id: 'i1', name: 'Report A', type: 'Report', creator: { name: 'Ann', upn: 'ann@x.com' } },
          { id: 'i2', name: 'Report B', type: 'Report' },
        ],
        users: [{ name: 'Ann', email: 'ann@x.com', role: 'Admin' }],
      },
      {
        id: 'ws-2', name: 'Sales', state: 'Active', totalItems: 1, datasetCount: 1,
        licenseType: 'Pro',
        items: [{ id: 'i3', name: 'Model', type: 'SemanticModel' }],
        users: [{ name: 'Bob', email: 'bob@x.com', role: 'Viewer' }],
      },
    ],
  }, overrides);
}

function tenantRun(settings) {
  return { summary: {}, workspaces: [], tenantSettings: settings };
}

const pbi = require('../src/services/powerbiService');

function httpError(status, headers) {
  const err = new Error('HTTP ' + status);
  err.response = { status, headers: headers || {}, data: { error: { message: 'boom' } } };
  return err;
}

const itemDetails = require('../src/services/itemDetailsService');

function stubPbi(overrides) {
  return Object.assign({
    getItemDetail: async () => ({ id: 'i1', displayName: 'Sales LH', type: 'Lakehouse', description: 'Curated sales', workspaceId: 'w1' }),
    getLakehouseTables: async () => [{ name: 'dim_date', type: 'Managed', format: 'Delta', location: 'Tables/dim_date' }],
    getSqlEndpointInfo: async () => ({ connectionString: 'abc.datawarehouse.fabric.microsoft.com', database: 'Sales LH', provisioningStatus: 'Success' }),
    getSqlEndpointSchema: async () => ([
      { schema: 'dbo', name: 'dim_date', type: 'BASE TABLE', columns: [{ name: 'DateKey', dataType: 'int', nullable: false }] },
    ]),
    getOneLakeBreakdown: async () => ({ totalFiles: 3, totalSize: 900, folders: [{ folder: 'Tables/dim_date', area: 'Tables', files: 3, size: 900 }] }),
    getDatasetDatasources: async () => [],
    getDatasetParameters: async () => [],
    getDatasetRefreshHistory: async () => [],
    getDashboardTiles: async () => [],
  }, overrides);
}

const insights = require('../src/services/workspaceInsightsService');

const SCAN_DATE = '2026-07-30T00:00:00Z';

function ws(overrides) {
  return Object.assign({
    id: 'ws-' + Math.random().toString(36).slice(2, 8),
    name: 'Workspace',
    state: 'Active',
    items: [{ id: 'i1', name: 'Report', type: 'Report', lastUpdated: '2026-07-29T00:00:00Z' }],
    users: [{ name: 'Ann', email: 'ann@x.com', role: 'Admin', type: 'User' }],
  }, overrides);
}

function findingKeys(result, workspaceName) {
  const match = result.workspaces.find(w => w.name === workspaceName);
  return match ? match.findings.map(f => f.key) : null;
}

const dbPrivate = require('../src/services/databaseService')._private;

// ── HTTP error explanations ──
const httpErrors = require('../src/services/httpErrorService');

// ── Deployment pipelines ──
const pipelineService = require('../src/services/deploymentPipelineService');
const { requireAuth } = require('../src/middleware/auth');

// ── Data reconciliation engine ──
const recon = require('../src/services/reconciliationService');

const INVOICE_RULE = {
  keyFieldA: 'InvoiceNumber',
  keyFieldB: 'Invoice_No',
  priority: 'medium',
  compareFields: [
    { label: 'Customer', fieldA: 'Customer', fieldB: 'CustomerName', type: 'string' },
    { label: 'Net amount', fieldA: 'NetAmount', fieldB: 'Net', type: 'number' },
  ],
};

// ── Analysis run progress ──
const runProgress = require('../src/services/runProgressService');

// Drives a progress state through the phases a real run goes through, up to the
// point named by `stopAfter`.
function progressThrough(stopAfter, { startedAt = 0 } = {}) {
  const state = runProgress.createProgress({ runId: 7, startedAt });
  const steps = [
    ['workspaces', 12],
    ['items', 400],
    ['capacities', 3],
    ['pipelines', 1],
    ['workspaceDetails', 12],
    ['access', 12],
    ['storage', 90],
    ['details', 300],
    ['tenantSettings', 200],
    ['save', 1],
  ];
  for (const [key, total] of steps) {
    runProgress.beginPhase(state, key, { total, now: startedAt });
    runProgress.advancePhase(state, key, { done: total, now: startedAt });
    runProgress.completePhase(state, key, { now: startedAt });
    if (key === stopAfter) break;
  }
  return state;
}

// ── Reconciliation: external database sources ──
const sqlSource = require('../src/services/sqlSourceService');

// ── Reconciliation: comparing runs ──
const reconCompare = require('../src/services/reconciliationComparisonService');

const RUN_A = { id: 1, rule_id: 9, rule_version: 1, started_at: '2026-08-01T10:00:00Z', records_a: 100, records_b: 98, keys_compared: 100, matched: 90, exception_count: 10 };
const RUN_B = { id: 2, rule_id: 9, rule_version: 1, started_at: '2026-08-10T10:00:00Z', records_a: 120, records_b: 120, keys_compared: 120, matched: 114, exception_count: 6 };

function finding(fingerprint, key, outcome, severity = 'medium') {
  return { fingerprint, business_key: key, outcome, severity, exception_id: null };
}

// ── Reconciliation: the dashboard's connection discipline ──
const reconRepo = require('../src/services/reconciliationRepository');

/**
 * Stands in for a tedious connection, which carries exactly one request at a time.
 * A second request issued while the first is in flight is rejected — the real
 * driver's behaviour, and the fault that left the dashboard panels empty.
 */
function fakeSqlPrimitives(rowsFor) {
  let inFlight = false;
  const executed = [];
  return {
    executed,
    getConnection: async () => ({ close() {} }),
    execSql: async (conn, sql, params) => {
      if (inFlight) throw new Error('Requests can only be made in the LoggedIn state, not the SentClientRequest state');
      inFlight = true;
      executed.push({ sql, params });
      await new Promise(resolve => setImmediate(resolve));
      inFlight = false;
      return rowsFor(sql);
    },
  };
}

async function withFakeSql(rowsFor, fn) {
  const real = { getConnection: dbService._sql.getConnection, execSql: dbService._sql.execSql };
  const fake = fakeSqlPrimitives(rowsFor);
  dbService._sql.getConnection = fake.getConnection;
  dbService._sql.execSql = fake.execSql;
  try {
    return { result: await fn(), executed: fake.executed };
  } finally {
    Object.assign(dbService._sql, real);
  }
}

// ── Master data: standardisation ──
const mdm = require('../src/services/mdmService');

// ── Master data: scoring ──
const PERSON_FIELDS = [
  { key: 'name', column: 'Name', standardisers: ['trim', 'lower'], comparator: 'jaro_winkler', weight: 3 },
  { key: 'email', column: 'Email', standardisers: ['trim', 'lower'], comparator: 'exact', weight: 3 },
  { key: 'city', column: 'City', standardisers: ['trim', 'lower'], comparator: 'exact', weight: 1 },
];

function personRecord(raw, fields = PERSON_FIELDS) {
  return { raw, sourceId: raw.Id, sourceSystem: raw.SourceSystem, standardised: mdm.standardiseRecord(raw, fields) };
}

// ── Master data: survivorship ──
const SURVIVOR_MODEL = {
  sourceField: 'SourceSystem',
  timestampField: 'UpdatedAt',
  sourcePriority: ['SAP', 'CRM'],
};

function survivorRecords(fields) {
  return [
    { Id: 'c-1', SourceSystem: 'CRM', UpdatedAt: '2026-08-10', Name: 'Jonathan Smith', Phone: null, Credit: 5000 },
    { Id: 's-1', SourceSystem: 'SAP', UpdatedAt: '2026-01-05', Name: 'J Smith', Phone: '0200000', Credit: 3000 },
    { Id: 'l-1', SourceSystem: 'Legacy', UpdatedAt: '2026-08-20', Name: 'Jonathan Smith', Phone: '0200000', Credit: 4000 },
  ].map(raw => ({ raw, sourceId: raw.Id, sourceSystem: raw.SourceSystem, standardised: mdm.standardiseRecord(raw, fields) }));
}

// ── Master data: the whole pipeline ──
const CUSTOMER_MODEL = {
  sourceIdField: 'Id',
  sourceField: 'SourceSystem',
  timestampField: 'UpdatedAt',
  sourcePriority: ['SAP', 'CRM', 'Legacy'],
  autoMatchThreshold: 0.9,
  reviewThreshold: 0.7,
  blocks: [{ field: 'name', strategy: 'phonetic' }, { field: 'email', strategy: 'exact' }],
  fields: [
    { key: 'name', column: 'Name', standardisers: ['trim', 'collapse_whitespace', 'strip_punctuation', 'lower'], comparator: 'jaro_winkler', weight: 3, survivorship: 'longest' },
    { key: 'email', column: 'Email', standardisers: ['trim', 'lower'], comparator: 'exact', weight: 4, survivorship: 'most_recent' },
    { key: 'city', column: 'City', standardisers: ['trim', 'lower'], comparator: 'exact', weight: 1, survivorship: 'source_priority' },
  ],
};

const RAW_CUSTOMERS = [
  { Id: 'sap-1', SourceSystem: 'SAP', UpdatedAt: '2026-01-01', Name: 'ACME Ltd.', Email: 'ops@acme.com', City: 'London' },
  { Id: 'crm-1', SourceSystem: 'CRM', UpdatedAt: '2026-08-01', Name: 'Acme Limited', Email: 'ops@acme.com', City: 'London' },
  { Id: 'leg-1', SourceSystem: 'Legacy', UpdatedAt: '2026-03-01', Name: 'ACME  LTD', Email: 'ops@acme.com', City: null },
  { Id: 'sap-2', SourceSystem: 'SAP', UpdatedAt: '2026-02-01', Name: 'Globex Corporation', Email: 'hi@globex.com', City: 'Leeds' },
];

// ── Relational view of an analysis run ──
const analysisModel = require('../src/services/analysisModelRepository');

const SCAN_RESULT = {
  summary: { totalWorkspaces: 2 },
  workspaces: [
    {
      id: 'ws-1', name: 'Finance', type: 'Workspace', state: 'Active',
      capacityId: 'cap-1', capacityName: 'F64', capacitySku: 'F64', isOnDedicatedCapacity: true,
      storageSize: 1024, storageFiles: 8,
      items: [
        { id: 'i-1', name: 'Sales', type: 'Lakehouse', storageSize: 900 },
        { id: 'i-2', name: 'Finance DW', type: 'Warehouse' },
        { id: 'i-3', name: 'Monthly', type: 'Report', lastUpdate: '2026-07-01T00:00:00Z' },
      ],
      users: [
        { identifier: 'u1', displayName: 'Ann', emailAddress: 'ann@x.com', groupUserAccessRight: 'Admin', principalType: 'User' },
        { identifier: 'sp1', displayName: 'Scanner', groupUserAccessRight: 'Admin', principalType: 'App' },
      ],
    },
    // A workspace whose access list could not be read is not a workspace with no
    // users, and the two must stay distinguishable.
    { id: 'ws-2', name: 'Marketing', items: [], users: [], usersReadable: false },
  ],
};

// ── Quality section: guidance content and routing ──
const guide = require('../src/services/qualityGuideService');

// ── Job progress ──
const jobProgress = require('../src/services/jobProgressService');

// ── Workspace access ──
//
// A workspace detail page answers "who is in this workspace". The question
// governance gets asked is the other way round — what can this person reach, and
// which workspaces has nobody responsible for — and neither can be answered one
// workspace at a time.

const workspaceAccess = require('../src/services/workspaceAccessService');
const analysisScope = require('../src/services/analysisScopeService');
const scheduleDue = require('../src/services/scheduleDueService');

const ACCESS_FIXTURE = {
  workspaces: [
    { workspace_id: 'ws-1', name: 'Finance', state: 'Active', capacity_name: 'F64', item_count: 12, users_readable: 1 },
    // Readable, and nobody can administer it.
    { workspace_id: 'ws-2', name: 'Orphan', state: 'Active', item_count: 1, users_readable: 1 },
    // The scan could not read this one's access list at all.
    { workspace_id: 'ws-3', name: 'Marketing', state: 'Active', item_count: 3, users_readable: 0 },
  ],
  grants: [
    { workspace_id: 'ws-1', principal_id: 'u1', principal_type: 'User', display_name: 'Ann', email: 'Ann@X.com', access_right: 'Admin' },
    { workspace_id: 'ws-1', principal_id: 'sp1', principal_type: 'App', display_name: 'Scanner', email: null, access_right: 'Member' },
    { workspace_id: 'ws-2', principal_id: 'u1', principal_type: 'User', display_name: 'Ann', email: 'ann@x.com', access_right: 'Viewer' },
  ],
};

// ── Scoped analysis scans ──
//
// A scan used to mean the whole tenant, always. On a large tenant that is hours of
// API calls to answer a question about three workspaces. A scoped scan is a
// smaller, faster answer — as long as nothing downstream mistakes it for the full
// picture, which is what most of these tests are about.

const analysisLauncher = require('../src/services/analysisLauncher');
const analysisScheduleService = require('../src/services/analysisScheduleService');

// ── When a schedule is due ──

const DUE_DAILY = { schedule_type: 'daily', schedule_hour: 7, schedule_minute: 30, timezone: 'UTC' };

// ── Fabric artifact naming conventions ──
//
// Fabric imposes no naming rules of its own and everything lands in the same
// workspace, so without a convention nobody can tell which lakehouse holds bronze
// data without opening it. The default here is the convention from the supplied
// document; every part of it is configurable.

const namingService = require('../src/services/namingConventionService');

const NAMING = { ...namingService.DEFAULT_CONVENTION, enabled: true };

// ── Granting a user or a group a role ─────────────────────────────────────────
//
// A different operation from adding the service principal itself, and the
// difference is the whole reason this has its own page: adding the principal is
// an admin-API call made on behalf of a signed-in administrator, while granting
// anyone else a role is an ordinary workspace role assignment the principal makes
// itself — and only where it is a workspace Admin.

async function withServer(fn) {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try { return await fn(server); } finally { await new Promise(resolve => server.close(resolve)); }
}

// ── Which security groups should exist ────────────────────────────────────────
//
// Granting a role is the easy half. Which groups exist before anyone grants
// anything is the half that decides whether access stays manageable, and it
// cannot be retrofitted once the forty individual grants are in place.

const securityGroups = require('../src/services/securityGroupGuideService');

// ── People → security groups → workspaces ─────────────────────────────────────
//
// The mapping is mechanical: who somebody is decides which groups they belong to
// and what those groups should hold. Doing it by hand across three environments
// is where the inconsistencies come from, and an inconsistency in access is not a
// typo — it is somebody who can publish to production.

const sgMapping = require('../src/services/securityGroupMappingService');
const sgRepo = require('../src/services/securityGroupRepository');

// ── Per-user access: tenants and sections ──
const perms = require('../src/services/permissionService');
const sections = require('../src/services/appSectionService');

const TENANTS = [{ id: 1, name: 'Contoso' }, { id: 2, name: 'Fabrikam' }];

function resolveFor(record, extra = {}) {
  return perms.resolvePermissions({
    user: { email: 'ann@x.com', name: 'Ann' },
    record,
    adminEmails: [],
    anyAdminConfigured: true,
    tenants: TENANTS,
    ...extra,
  });
}

// ── Enforcement in front of the routes ──
const permMiddleware = require('../src/middleware/permissions');

function fakeRes() {
  return {
    locals: {}, statusCode: 200, jsonBody: null, rendered: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
    render(view, model) { this.rendered = { view, model }; return this; },
  };
}

// ── Entra ID directory picker and group-based grants ──

function withFakeDirectory(client, fn, servicePrincipals = [{ id: 1, name: 'Primary' }]) {
  const dir = require('../src/services/directoryService');
  const db = require('../src/services/databaseService');
  const powerbi = require('../src/services/powerbiService');
  const realSps = db.getServicePrincipals;
  const realCreate = powerbi.createPowerBIService;
  db.getServicePrincipals = async () => servicePrincipals;
  powerbi.createPowerBIService = () => client;
  dir.clearDirectoryCache();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      db.getServicePrincipals = realSps;
      powerbi.createPowerBIService = realCreate;
      dir.clearDirectoryCache();
    });
}

// ── Governance Outcome (fixed rules, no generated text) ──

const SOFTWAREONE = '77f4d6ee-95d6-499c-bdfc-786d81583d02';
const OTHER_TENANT = '86b46898-3da5-42e8-93ba-28477cf0e5ef';

// Rows shaped like the spec's queries, reproducing its acceptance figures.
function outcomeFixture() {
  const ws = (name, items, users, extra = {}) => ({
    workspace_id: 'id-' + name, name, capacity_sku: 'sku' in extra ? extra.sku : 'F8', item_count: items, user_count: users,
    no_description: 1, no_pipeline: 1, is_empty: items === 0 ? 1 : 0, single_principal: users === 1 ? 1 : 0,
    no_sku: extra.sku === null ? 1 : 0, is_capacity_metrics: name.startsWith('Microsoft Fabric Capacity Metrics') ? 1 : 0,
  });
  const workspaces = [ws('DemoFabric', 100, 4), ws('Test', 93, 3), ws('ws_demo_dev', 72, 2)];
  const filler = [40, 30, 25, 20, 18, 15, 12, 10, 9, 8, 7, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1];
  filler.forEach((items, i) => workspaces.push(ws('ws_' + i, items, 2, { sku: i < 9 ? null : (i < 25 ? 'F2' : 'F8') })));
  workspaces.push(ws('Microsoft Fabric Capacity Metrics', 0 + 1, 2), ws('Microsoft Fabric Capacity Metrics 2', 1, 2));
  workspaces.push(ws('ws_poc_adventureworks', 0, 2), ws('test_gn', 0, 1));
  const run = { run_id: 37, sp_id: 1, sp_run_number: 12, tenant_id: SOFTWAREONE, sp_name: 'SoftwareOne', status: 'completed', started_at: new Date('2026-11-26T09:20:00Z'), completed_at: new Date('2026-11-26T09:52:30Z'), run_by: 'scheduler', scope_kind: 'tenant' };
  const totals = {
    total_workspaces: '63', total_items: '578', total_reports: '45', total_datasets: '94', total_dashboards: '0', total_dataflows: '6',
    total_lakehouses: '48', total_notebooks: '104', total_pipelines: '76', total_warehouses: '67', total_users: '27', creator_count: '17',
    explorer_count: '10', capacity_count: '11', workspaces_on_capacity: '28', workspaces_on_shared_capacity: '0', total_storage_size: '0',
    total_storage_files: '0', storage_scanned_count: '0', tenant_settings_total: '189', tenant_settings_enabled: '120', tenant_settings_disabled: '69',
    tenant_settings_group_scoped: '3', tenant_settings_delegated: '21', captured_at: new Date('2026-11-26T09:52:31Z'),
  };
  const trendRow = (id, at, w, items, wh, nb, pl, st) => ({ run_id: id, sp_id: 1, sp_name: 'SoftwareOne', sp_run_number: { 24: 7, 28: 9, 29: 10, 36: 11, 37: 12 }[id], completed_at: new Date(at), total_workspaces: w, total_items: items, total_warehouses: wh, total_notebooks: nb, total_pipelines: pl, tenant_settings_total: st });
  return {
    run,
    data: {
      totals,
      workspacesByType: [{ type: 'Workspace', workspaces: 37 }, { type: 'AdminWorkspace', workspaces: 1 }, { type: 'Personal', workspaces: 25 }],
      skus: [{ sku: 'F8', workspaces: 12, items: 407, pct_items: 70.4 }, { sku: 'F2', workspaces: 16, items: 120, pct_items: 20.8 }, { sku: '(not recorded)', workspaces: 9, items: 51, pct_items: 8.8 }],
      workspaces,
      accessRun: { access_run_id: 36, sp_id: 1, sp_name: 'SoftwareOne', sp_run_number: 11, access_completed_at: new Date('2026-11-25T18:10:00Z') },
      access: [
        { principal_type: 'User', access_right: 'Admin', assignments: 55, distinct_principals: 12 },
        { principal_type: 'User', access_right: 'Member', assignments: 10, distinct_principals: 6 },
        { principal_type: 'App', access_right: 'Admin', assignments: 41, distinct_principals: 3 },
        { principal_type: 'App', access_right: 'Contributor', assignments: 2, distinct_principals: 1 },
      ],
      trend: [
        trendRow(24, '2026-11-02T10:00:00Z', 55, 470, 30, 90, 70, 189),
        trendRow(28, '2026-11-10T10:00:00Z', 58, 500, 33, 95, 72, 189),
        trendRow(29, '2026-11-12T10:00:00Z', 60, 520, 35, 98, 74, 189),
        trendRow(36, '2026-11-25T18:10:00Z', 62, 560, 36, 102, 75, 189),
        trendRow(37, '2026-11-26T09:52:30Z', 63, 578, 67, 104, 76, 189),
      ],
      deletions: Array.from({ length: 28 }, (_, i) => ({ workspace_name: 'old_' + i, state: 'Deleted', deleted_at: new Date(Date.UTC(2026, 10, 1 + (i % 25))), run_id: 29, sp_id: 1, sp_name: 'SoftwareOne', sp_run_number: 10 })),
    },
  };
}

function buildFixtureOutcome(mutate) {
  const { buildOutcome, loadRules } = require('../src/services/governanceRulesService');
  const fx = outcomeFixture();
  if (mutate) mutate(fx);
  return buildOutcome({ run: fx.run, data: fx.data, rules: loadRules(), connectionMode: 'sql-login', generatedAt: new Date('2026-11-26T10:00:00Z'), trigger: 'after-scan' });
}


// ── Compare: one tenant at a time, and a confirmation for different coverage ──

function compareFixture() {
  const A = SOFTWAREONE;
  const B = OTHER_TENANT;
  const wide = (id, n, day, tenant = A, sp = 1) => ({ id, sp_id: sp, sp_name: tenant === A ? 'SoftwareOne' : 'Other', sp_run_number: n, tenant_id: tenant, status: 'completed', started_at: '2026-11-' + day + 'T09:00:00Z', scope_kind: 'tenant' });
  const scoped = { ...wide(52, 4, 27), scope_kind: 'workspaces', scope_workspaces: JSON.stringify([{ id: 'w1', name: 'Finance' }]) };
  return { A, B, runs: [wide(50, 3, 26), wide(40, 2, 20), scoped, wide(60, 1, 25, B, 2)] };
}

function compareResponse(runs, globalRun = null) {
  return {
    locals: { availableRuns: runs, globalRun }, statusCode: 200, rendered: null, body: null,
    status(code) { this.statusCode = code; return this; },
    render(view, model) { this.rendered = { view, model }; return this; },
    json(body) { this.body = body; return this; },
  };
}

module.exports = {
  assert,
  http,
  test,
  app,
  request,
  postJson,
  convertScheduleToUtc,
  scheduler,
  runMetrics,
  workspaceDeletion,
  dbService,
  stubDeletionDb,
  sampleRun,
  tenantRun,
  pbi,
  httpError,
  itemDetails,
  stubPbi,
  insights,
  SCAN_DATE,
  ws,
  findingKeys,
  dbPrivate,
  httpErrors,
  pipelineService,
  requireAuth,
  recon,
  INVOICE_RULE,
  runProgress,
  progressThrough,
  sqlSource,
  reconCompare,
  RUN_A,
  RUN_B,
  finding,
  reconRepo,
  fakeSqlPrimitives,
  withFakeSql,
  mdm,
  PERSON_FIELDS,
  personRecord,
  SURVIVOR_MODEL,
  survivorRecords,
  CUSTOMER_MODEL,
  RAW_CUSTOMERS,
  analysisModel,
  SCAN_RESULT,
  guide,
  jobProgress,
  workspaceAccess,
  analysisScope,
  scheduleDue,
  ACCESS_FIXTURE,
  analysisLauncher,
  analysisScheduleService,
  DUE_DAILY,
  namingService,
  NAMING,
  withServer,
  securityGroups,
  sgMapping,
  sgRepo,
  perms,
  sections,
  TENANTS,
  resolveFor,
  permMiddleware,
  fakeRes,
  withFakeDirectory,
  SOFTWAREONE,
  OTHER_TENANT,
  outcomeFixture,
  buildFixtureOutcome,
  compareFixture,
  compareResponse,
};
