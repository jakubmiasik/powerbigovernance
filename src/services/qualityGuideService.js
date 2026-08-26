/**
 * The explanatory content behind the help and prerequisite modals.
 *
 * Kept as data rather than markup for two reasons: the same topic is reachable from
 * several pages and must read identically in each, and what the application
 * *requires* to work should be stated in one place so it can be checked against the
 * code rather than drifting into folklore.
 *
 * Pure — no database, no API. Renderers walk these structures.
 */

// ── How to use each discipline ──

const RECONCILIATION_HELP = {
  key: 'reconciliation',
  title: 'How Reconciliation Works',
  summary: 'A control that checks the same business records agree in two systems, and turns every disagreement into an item somebody owns.',
  steps: [
    {
      title: '1. Register the two systems',
      body: 'On Quality → Sources, register each system you want to compare: a Fabric lakehouse or warehouse (choose the tenant it belongs to), or any SQL Server or Azure SQL database. Registration reads the schema once and stores it, so authoring a rule never opens a connection to the business system.',
    },
    {
      title: '2. Define the business key',
      body: 'The field that identifies the same record in both systems — an invoice number, a customer code. The two systems rarely name it the same way, so you pick the column on each side. Everything else follows from matching on this.',
    },
    {
      title: '3. Choose the values to compare',
      body: 'Each side can be a column, a SQL expression evaluated by that source (TRIM, CASE WHEN, CAST), a fixed value to check a column against, or an aggregate. Numeric and date comparisons take a tolerance, so differences the business has agreed are immaterial do not raise exceptions.',
    },
    {
      title: '3b. Compare across different grains',
      body: 'When one system holds detail and the other holds a total — an analytical ledger with one row per posting against a synthetic balance with one row per account — pick "Aggregate (group by key)" on the detailed side: Sum of Amount on the left, the plain Amount field on the right, with Account as the business key. The source database does the grouping, so a million postings are added up where they live rather than being read into this application. The side that aggregates comes back as one row per key, so duplicates cannot arise there — and every value read from that side must aggregate too, or the rule is refused.',
    },
    {
      title: '3c. Say what kind of control it is',
      body: 'Each rule belongs to a group: Start-to-Start, Start-to-End, End-to-End, Point-to-Point, Left-to-Right, Right-to-Left, Aggregate-to-Detail, Period-over-Period. The group travels with every run, exception and summary, so the dashboard can answer the coverage question no individual rule can: forty Left-to-Right controls and no Right-to-Left one means nothing is checking what the target invented.',
    },
    {
      title: '4. Activate and run',
      body: 'A rule starts as a draft and is refused activation until it can actually run. Running it reads both systems, compares record by record, and records what it found. Every run is kept with the rule version that produced it.',
    },
    {
      title: '5. Work the exceptions',
      body: 'Each discrepancy becomes an exception with an owner and a status: open, acknowledged, in investigation, resolved, or ignored. Closing one needs a recorded reason. An exception seen again after being closed is reopened with a note rather than staying quietly shut.',
    },
  ],
  outcomes: [
    ['Match', 'The record exists in both systems and the compared values agree.'],
    ['Missing from source A', 'It is in the second system but not the first.'],
    ['Missing from source B', 'It is in the first system but not the second.'],
    ['Value mismatch', 'It is in both, but a compared value differs beyond tolerance.'],
    ['Duplicate record', 'The same business key appears more than once.'],
    ['Invalid or incomplete key', 'The record cannot be matched reliably because its key is missing.'],
  ],
  sample: {
    title: 'Worked example — invoices between an ERP and the reporting warehouse',
    lines: [
      'Business key: ERP.InvoiceNumber ↔ Warehouse.Invoice_No',
      'Compare: TRIM(ERP.Customer) ↔ Warehouse.CustomerName — shared words, weight 2',
      'Compare: ERP.NetAmount ↔ Warehouse.Net — numeric, tolerance 0.01',
      'Compare: ERP.Currency ↔ fixed value "EUR" — exact, required',
      'Group: Left-to-Right — everything raised in the ERP must have reached the warehouse.',
      'Duplicates: raise an exception. Incomplete keys: raise an exception.',
      '',
      'Second example — an account balance held at two grains:',
      'Business key: Analytics.Account ↔ Synthetic.Account',
      'Compare: Sum of Analytics.Amount ↔ Synthetic.Amount — numeric, tolerance 0.01',
      'Group: Aggregate-to-Detail. The left side is grouped by Account by the source database.',
    ],
    reading: 'A run reporting 1,204 keys compared, 1,180 matched and 24 exceptions means 24 invoices need someone to look. If eighteen of them are "missing from source B", that is one integration problem, not eighteen data problems — which is why the run detail groups by outcome before it lists items.',
  },
};

const MDM_HELP = {
  key: 'mdm',
  title: 'How Master Data Works',
  summary: 'Takes raw records that arrived from several systems and works out which describe the same real thing, then builds one agreed version — the golden record.',
  steps: [
    {
      title: '1. Point at the raw table',
      body: 'One table holding every record from every source system — normally a Fabric lakehouse table. It needs a column identifying each record and, to get the most from survivorship, a column naming which system each row came from and one saying when it was last updated.',
    },
    {
      title: '2. Standardise',
      body: 'Per field, remove the differences that carry no meaning: trim, case, punctuation, accents, digits only, expand abbreviations. Values like "N/A" and "unknown" become absent, so two records are never merged for both saying they do not know.',
    },
    {
      title: '3. Block',
      body: 'Comparing every record with every other is quadratic — a hundred thousand rows is five billion comparisons. A blocking key groups records that share something cheap (same value, same first letters, same Soundex) and only compares within the group. Use several: a pair is a candidate if it shares any of them.',
    },
    {
      title: '4. Match',
      body: 'Each candidate pair is scored field by field with a comparator suited to that field. Above the merge threshold the records join; between the two thresholds the pair goes to a steward; below, nothing happens. Mark a field required (must agree) or must-not-conflict (may be absent, may not disagree).',
    },
    {
      title: '5. Survive and publish',
      body: 'For each field, choose which value lives: most recent, most trusted source, most agreed, longest, first non-empty, highest, lowest, total. Preview stores the result for review; publishing writes it to the destination table with a crosswalk back to the source records.',
    },
  ],
  outcomes: [
    ['Golden record', 'One agreed version of an entity, with every value traceable to the source record it came from.'],
    ['Crosswalk', 'Which source records contributed to which golden record — what a downstream system follows back.'],
    ['Needs a steward', 'The sources disagreed on a field whose rule is "leave for a steward".'],
    ['Review pair', 'Two records similar enough to be worth a look but not enough to merge automatically.'],
  ],
  sample: {
    title: 'Worked example — customers across SAP, a CRM and a legacy system',
    lines: [
      'Raw table: lakehouse dbo.RawCustomers, with RecordId, SourceSystem and UpdatedAt',
      'Trust order: SAP, CRM, Legacy',
      'Blocking: Soundex on Name, exact on Email',
      'Match: Name — Jaro-Winkler, weight 3 · Email — exact, weight 4 · Country — exact, must not conflict',
      'Survive: Name = longest · Email = most recent · CreditLimit = highest · TaxId = most trusted source',
    ],
    reading: 'A run turning 200 raw records into 120 golden records collapsed 80 duplicates. Check the largest group before trusting it: one group far bigger than the rest usually means matches chained transitively (A~B, B~C) rather than a genuinely large entity — turn on strict grouping and run it again.',
  },
};

const HELP_TOPICS = [RECONCILIATION_HELP, MDM_HELP];
const HELP_BY_KEY = new Map(HELP_TOPICS.map(topic => [topic.key, topic]));

// ── What the application needs in order to work ──
//
// Grouped by where the permission is granted, because that is how someone actually
// goes about obtaining them: each group is one admin, one portal, one conversation.

const PREREQUISITES = [
  {
    key: 'entra',
    title: 'Entra ID — the service principal',
    icon: 'bi-person-badge',
    items: [
      { text: 'An app registration with a client secret, or a certificate held in Key Vault.', required: true },
      { text: 'Power BI Service application permission Tenant.Read.All, with admin consent granted. Without consent the admin APIs return 401 and every scan finds nothing.', required: true },
      { text: 'Microsoft Graph application permissions User.Read.All, Group.Read.All and Application.Read.All, if you want people and group names resolved rather than object IDs.', required: false },
      { text: 'The service principal added to a security group — the Fabric tenant setting below applies to groups, not to individual principals.', required: true },
    ],
  },
  {
    key: 'fabric-tenant',
    title: 'Fabric / Power BI tenant settings',
    icon: 'bi-sliders',
    note: 'Set in the Fabric Admin Portal by a Fabric Administrator. Changes can take up to 15 minutes to take effect.',
    items: [
      { text: 'Service principals can use Fabric APIs — enabled and applied to the security group holding the service principal.', required: true },
      { text: 'Service principals can access read-only admin APIs — required for the tenant-wide scan, the workspace scanner and tenant settings.', required: true },
      { text: 'Enhanced admin APIs responses with detailed metadata — needed for the item detail the scan collects.', required: false },
      { text: 'Allow XMLA endpoints and Analyze in Excel — needed for semantic model detail on premium capacities.', required: false },
    ],
  },
  {
    key: 'fabric-admin',
    title: 'Fabric administrator',
    icon: 'bi-shield-lock',
    items: [
      { text: 'A Fabric Administrator must grant the tenant settings above. The application itself does not need a person to hold the role at run time — but reading tenant settings, and the Grant SP Access action, do act on behalf of an administrator, so that action asks you to sign in as one.', required: true },
      { text: 'Workspace access for the service principal. The tenant-wide scan sees every workspace through the admin APIs, but reading a lakehouse or warehouse SQL endpoint needs the principal to be a member of the workspace. Use Grant SP Access on the Run Analysis page to add it as Admin where it is missing.', required: true },
    ],
  },
  {
    key: 'capacity',
    title: 'Capacities — pause, resume and scale',
    icon: 'bi-lightning',
    note: 'These are Azure permissions, not Fabric ones. A Fabric Administrator cannot pause a capacity without them.',
    items: [
      { text: 'The service principal needs the Contributor role on each Fabric or Power BI Embedded capacity resource it should control — assigned in the Azure portal on the capacity, its resource group, or the subscription.', required: true },
      { text: 'Capacity Administrator on the capacity itself, for the assignment operations that go through the Power BI API rather than Azure Resource Manager.', required: false },
      { text: 'Without Contributor, capacities still appear in the inventory but pause, resume and scheduled actions fail with an authorization error rather than doing nothing visible.', required: false },
    ],
  },
  {
    key: 'sql',
    title: 'Databases — this application and the ones it reads',
    icon: 'bi-database',
    items: [
      { text: 'An Azure SQL database for the application itself, with the identity the app runs as granted db_owner (it creates and migrates its own tables). Set SQL_SERVER and SQL_DATABASE.', required: true },
      { text: 'For Fabric sources: the service principal must be a workspace member. Workspace roles map to SQL permissions on the analytics endpoint, so no separate SQL grant is needed.', required: true },
      { text: 'For registered SQL Server or Azure SQL sources: either grant the application\'s identity read access (CREATE USER FROM EXTERNAL PROVIDER, then db_datareader), or register a SQL login. A SQL login\'s password needs SECRET_ENCRYPTION_KEY set so it can be stored encrypted.', required: false },
      { text: 'For a master data destination: write access, and a destination that can accept writes. A Fabric lakehouse SQL endpoint is read-only however the permissions are set — use a Fabric warehouse or a SQL database.', required: true },
      { text: 'Server firewall: the application\'s outbound addresses must be allowed on every database it reaches, including Azure SQL logical servers.', required: true },
    ],
  },
  {
    key: 'hosting',
    title: 'Hosting',
    icon: 'bi-server',
    items: [
      { text: 'SESSION_SECRET set explicitly in production.', required: true },
      { text: 'SECRET_ENCRYPTION_KEY set if any credential is stored in the database rather than Key Vault.', required: true },
      { text: 'On Azure App Service, enable Always On so the minute-by-minute capacity scheduler keeps running when there is no traffic. Without it, scheduled actions only fire when a request wakes the app.', required: true },
      { text: 'EasyAuth configured with /health excluded from validation, so the health probe — which also drives the scheduler catch-up tick — stays reachable.', required: false },
    ],
  },
];

/** Everything marked required, flattened — the short answer to "what must I have". */
function requiredPrerequisites() {
  return PREREQUISITES.flatMap(group =>
    group.items.filter(item => item.required).map(item => ({ group: group.title, text: item.text })));
}

module.exports = {
  RECONCILIATION_HELP,
  MDM_HELP,
  HELP_TOPICS,
  HELP_BY_KEY,
  PREREQUISITES,
  requiredPrerequisites,
};
