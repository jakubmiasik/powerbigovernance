/**
 * Who can reach what, across the whole tenant.
 *
 * A workspace detail page answers "who is in this workspace". The question
 * governance actually gets asked is the other way round — "what can this person
 * reach", and "which workspaces has nobody responsible for" — and neither can be
 * answered one workspace at a time.
 *
 * Pure: it takes the rows a run already indexed and reshapes them. No database,
 * no API, no clock, so the judgements it makes about an access model can be
 * tested directly.
 */

// Power BI names four workspace roles. They are ordered by what they permit, so
// "the strongest access this principal holds anywhere" is a comparison rather
// than a special case per role.
const ACCESS_LEVELS = [
  { key: 'admin', label: 'Admin', rank: 4, color: 'danger', description: 'Full control, including who else has access.' },
  { key: 'member', label: 'Member', rank: 3, color: 'warning', description: 'Can publish, share and edit content.' },
  { key: 'contributor', label: 'Contributor', rank: 2, color: 'info', description: 'Can create and edit content, but not share it.' },
  { key: 'viewer', label: 'Viewer', rank: 1, color: 'secondary', description: 'Can read content only.' },
];

const ACCESS_BY_KEY = new Map(ACCESS_LEVELS.map(level => [level.key, level]));

// The same four roles as the Fabric role assignment API names them. Kept next to
// the levels above rather than typed out again wherever a grant is made, so the
// two can never drift apart.
const FABRIC_ROLES = ACCESS_LEVELS.map(level => ({
  key: level.label,
  label: level.label,
  color: level.color,
  description: level.description,
}));
const UNKNOWN_ACCESS = { key: 'unknown', label: 'Unknown', rank: 0, color: 'light', description: 'The scan recorded no role for this grant.' };

function normalizeAccess(value) {
  const key = String(value || '').trim().toLowerCase();
  return ACCESS_BY_KEY.has(key) ? key : 'unknown';
}

function accessLevel(value) {
  return ACCESS_BY_KEY.get(normalizeAccess(value)) || UNKNOWN_ACCESS;
}

// A service principal, a group and a person are governed differently — a group
// holding Admin on forty workspaces is normal, one person holding it is not.
const PRINCIPAL_TYPES = [
  { key: 'user', label: 'User', icon: 'bi-person' },
  { key: 'group', label: 'Group', icon: 'bi-people' },
  { key: 'app', label: 'Service principal', icon: 'bi-robot' },
  { key: 'none', label: 'Unspecified', icon: 'bi-question-circle' },
];

const PRINCIPAL_BY_KEY = new Map(PRINCIPAL_TYPES.map(type => [type.key, type]));

function normalizePrincipalType(value) {
  const key = String(value || '').trim().toLowerCase();
  if (PRINCIPAL_BY_KEY.has(key)) return key;
  // The APIs have used both "App" and "ServicePrincipal" for the same thing.
  if (key === 'serviceprincipal') return 'app';
  return 'none';
}

function principalTypeLabel(value) {
  return (PRINCIPAL_BY_KEY.get(normalizePrincipalType(value)) || {}).label || 'Unspecified';
}

/**
 * The identity a grant is against.
 *
 * Email is the stable one where it exists; a group or a service principal often
 * has none, so the object id is next and the display name is the last resort.
 * Getting this wrong would split one person into several rows, or — worse —
 * merge two principals that share a display name.
 */
function principalKey(grant) {
  const email = String(grant.email || '').trim().toLowerCase();
  if (email) return 'email:' + email;
  const id = String(grant.principal_id || grant.principalId || '').trim().toLowerCase();
  if (id) return 'id:' + id;
  const name = String(grant.display_name || grant.displayName || '').trim().toLowerCase();
  if (name) return 'name:' + name;
  return 'unknown';
}

function grantOf(row) {
  return {
    workspaceId: row.workspace_id || row.workspaceId || null,
    principalId: row.principal_id || row.principalId || null,
    principalType: normalizePrincipalType(row.principal_type || row.principalType),
    displayName: row.display_name || row.displayName || null,
    email: row.email || null,
    accessRight: normalizeAccess(row.access_right || row.accessRight),
  };
}

function emptyCounts() {
  const counts = { unknown: 0 };
  for (const level of ACCESS_LEVELS) counts[level.key] = 0;
  return counts;
}

/**
 * What state a workspace is in, said in one badge.
 *
 * The API reports this three different ways — `state` on the admin endpoint, a
 * missing state on the Fabric one, and a deletion this tool recorded itself —
 * and "Active" and "not reported" are not the same claim.
 */
const WORKSPACE_STATUSES = [
  { key: 'active', label: 'Active', color: 'success', description: 'In use and reachable.' },
  { key: 'deleted', label: 'Deleted', color: 'danger', description: 'Removed from the tenant. Nothing can be granted on it.' },
  { key: 'removing', label: 'Removing', color: 'danger', description: 'On its way out. Nothing can be granted on it.' },
  { key: 'orphaned', label: 'Orphaned', color: 'warning', description: 'The API reports it as orphaned — no owner remains.' },
  { key: 'personal', label: 'Personal', color: 'info', description: 'A personal workspace ("My workspace"). It takes no members at all.' },
  { key: 'unknown', label: 'Unknown', color: 'secondary', description: 'The scan recorded no state for this workspace.' },
];

const STATUS_BY_KEY = new Map(WORKSPACE_STATUSES.map(status => [status.key, status]));

function workspaceStatus(workspace) {
  if (isPersonalWorkspace(workspace)) return STATUS_BY_KEY.get('personal');
  const state = String((workspace && workspace.state) || '').trim().toLowerCase();
  if (!state) return STATUS_BY_KEY.get('unknown');
  if (state === 'deleted') return STATUS_BY_KEY.get('deleted');
  if (state === 'removing' || state === 'deleting') return STATUS_BY_KEY.get('removing');
  if (state === 'orphaned') return STATUS_BY_KEY.get('orphaned');
  if (state === 'active') return STATUS_BY_KEY.get('active');
  // A state the API introduced since this was written is shown as itself rather
  // than flattened into "unknown", which would lose the only fact we have.
  return { key: state, label: (workspace.state || '').trim(), color: 'secondary', description: 'Reported by the API as "' + workspace.state + '".' };
}

// Words that make a workspace name a subject area rather than a person. Without
// them "Finance Reporting" and "Global Sales" read as two capitalized words the
// same way "Anna Nowak" does.
const SUBJECT_WORDS = new Set([
  'workspace', 'workspaces', 'team', 'teams', 'data', 'analytics', 'analysis', 'report', 'reports',
  'reporting', 'finance', 'financial', 'accounting', 'sales', 'marketing', 'people', 'operations',
  'ops', 'dev', 'development', 'test', 'testing', 'prod', 'production', 'uat', 'sandbox', 'demo',
  'pilot', 'project', 'projects', 'platform', 'warehouse', 'lakehouse', 'insights', 'dashboard',
  'dashboards', 'metrics', 'model', 'models', 'shared', 'common', 'corporate', 'group', 'global',
  'central', 'enterprise', 'customer', 'customers', 'product', 'products', 'supply', 'chain',
  'logistics', 'inventory', 'revenue', 'budget', 'planning', 'forecast', 'quality', 'governance',
  'security', 'audit', 'compliance', 'admin', 'service', 'services', 'engineering', 'science',
  'master', 'gold', 'silver', 'bronze', 'staging', 'archive', 'legacy', 'personal', 'sample',
  'training', 'template', 'sync', 'hub', 'lab', 'portal', 'source', 'landing', 'curated',
]);

function looksLikeEmail(name) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(name || '').trim());
}

/**
 * Whether a workspace name reads as somebody's name.
 *
 * Deliberately narrow. Two or three Title Case words, no digits, and none of them
 * a subject-area word: "Anna Nowak" qualifies, "Finance Reporting", "EMEA Sales"
 * and "DWH_Prod" do not. A false positive here is a warning on a legitimate
 * workspace, so the rule errs towards saying nothing.
 */
function looksLikePersonName(name) {
  const trimmed = String(name || '').replace(/,/g, ' ').trim();
  if (!trimmed || /\d/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  return words.every(word =>
    /^[A-ZÀ-ÖØ-Þ][a-zß-öø-ÿ'’-]+$/.test(word) && !SUBJECT_WORDS.has(word.toLowerCase()));
}

/**
 * Whether a workspace belongs to one person rather than to the organisation.
 *
 * Two tiers, because the evidence comes in two strengths. The API saying
 * `PersonalGroup` is a fact — a personal workspace takes no members at all, so a
 * grant against one fails whatever anyone does. A name that reads like a person,
 * or a workspace nobody administers, is a signal: it usually means somebody's
 * private working area, but it can equally be a badly named team workspace, so it
 * is reported as a warning and still offered.
 *
 * `adminCount` is optional — the live tenant listing has no user data, and the
 * absence of that evidence must not read as "no admin".
 */
function classifyWorkspacePersonal(workspace) {
  const source = workspace || {};
  const name = String(source.name || source.displayName || '').trim();
  const reasons = [];
  let confirmed = false;

  if (isPersonalWorkspace(source)) {
    confirmed = true;
    reasons.push('The API reports this as a personal workspace ("My workspace").');
  }
  if (looksLikeEmail(name)) {
    reasons.push('Named after a mailbox (' + name + ') rather than a subject area.');
  } else if (looksLikePersonName(name)) {
    reasons.push('Named after a person ("' + name + '") rather than a subject area.');
  }

  const adminCount = Number.isFinite(Number(source.adminCount)) && source.adminCount !== null
    ? Number(source.adminCount)
    : null;
  // Only when the access list was actually read. "Nobody holds Admin" and "we
  // could not see who holds Admin" are opposite claims.
  if (adminCount === 0 && source.usersReadable !== false) {
    reasons.push('Nobody holds Admin, so no one in the organisation is accountable for it.');
  }

  const personal = confirmed || reasons.length > 0;
  return {
    personal,
    confidence: confirmed ? 'confirmed' : (personal ? 'likely' : null),
    reasons,
    // A real personal workspace rejects every member add. The heuristics only
    // warn: refusing to grant on a guess would block work nothing else can do.
    grantable: !confirmed,
    summary: reasons[0] || null,
  };
}

/**
 * Reshapes one run's workspaces and access grants into the three views the page
 * needs: every grant, the same grants by workspace, and the same grants by
 * principal.
 *
 * A workspace whose access list the scan could not read is carried through as
 * unreadable rather than as a workspace with nobody in it. Those two look
 * identical in a row count and mean opposite things: the second is a finding, the
 * first is a gap in the evidence.
 */
function buildAccessOverview(input) {
  // A default parameter only covers `undefined`, and a caller that read nothing
  // hands over `null` just as often — an empty access picture is a normal state
  // here, never a reason to throw.
  const source = input || {};
  const workspaces = Array.isArray(source.workspaces) ? source.workspaces : [];
  const grants = Array.isArray(source.grants) ? source.grants : [];
  const byWorkspace = new Map();

  for (const row of workspaces) {
    const id = row.workspace_id || row.workspaceId || null;
    if (!id) continue;
    byWorkspace.set(id, {
      workspaceId: id,
      name: row.name || null,
      state: row.state || null,
      // Carried through because it is the only reliable way to tell a personal
      // workspace from a badly named team one.
      type: row.type || null,
      capacityName: row.capacity_name || row.capacityName || null,
      itemCount: Number(row.item_count || row.itemCount) || 0,
      // Written as a bit, so it arrives as 0/1 from SQL and as a boolean from a
      // shaped object. Only an explicit "no" means the list could not be read.
      usersReadable: !(row.users_readable === 0 || row.users_readable === false
        || row.usersReadable === 0 || row.usersReadable === false),
      grants: [],
      counts: emptyCounts(),
    });
  }

  const byPrincipal = new Map();
  const flat = [];

  for (const row of grants) {
    const grant = grantOf(row);
    // A grant against a workspace this run did not record still counts — dropping
    // it would understate what a principal can reach.
    let workspace = byWorkspace.get(grant.workspaceId);
    if (!workspace) {
      workspace = {
        workspaceId: grant.workspaceId,
        name: row.workspace_name || row.workspaceName || null,
        state: null, type: null, capacityName: null, itemCount: 0, usersReadable: true,
        grants: [], counts: emptyCounts(),
      };
      byWorkspace.set(grant.workspaceId, workspace);
    }

    workspace.grants.push(grant);
    workspace.counts[grant.accessRight] += 1;

    const key = principalKey(row);
    if (!byPrincipal.has(key)) {
      byPrincipal.set(key, {
        key,
        principalId: grant.principalId,
        principalType: grant.principalType,
        displayName: grant.displayName,
        email: grant.email,
        workspaces: [],
        counts: emptyCounts(),
        strongest: 'unknown',
      });
    }
    const principal = byPrincipal.get(key);
    // The first grant seen may be the one missing a name or a type; fill the gaps
    // from later ones rather than showing a blank because of ordering.
    principal.displayName = principal.displayName || grant.displayName;
    principal.email = principal.email || grant.email;
    if (principal.principalType === 'none') principal.principalType = grant.principalType;
    principal.principalId = principal.principalId || grant.principalId;
    principal.workspaces.push({
      workspaceId: grant.workspaceId,
      name: workspace.name,
      accessRight: grant.accessRight,
    });
    principal.counts[grant.accessRight] += 1;
    if (accessLevel(grant.accessRight).rank > accessLevel(principal.strongest).rank) {
      principal.strongest = grant.accessRight;
    }

    flat.push({
      ...grant,
      workspaceName: workspace.name,
      workspaceState: workspace.state,
      principalKey: key,
    });
  }

  const workspaceList = [...byWorkspace.values()].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || '')));

  // Classified once the grants are attached, because "nobody holds Admin" is part
  // of the evidence and is not known until then.
  for (const workspace of workspaceList) {
    workspace.status = workspaceStatus(workspace);
    workspace.personal = classifyWorkspacePersonal({
      name: workspace.name,
      type: workspace.type,
      adminCount: workspace.usersReadable ? workspace.counts.admin : null,
      usersReadable: workspace.usersReadable,
    });
  }
  // The flat grant list is built before the workspaces are classified, so the
  // verdict is copied onto it afterwards rather than computed twice.
  const statusById = new Map(workspaceList.map(workspace => [workspace.workspaceId, workspace]));
  for (const grant of flat) {
    const workspace = statusById.get(grant.workspaceId);
    grant.workspaceStatus = workspace ? workspace.status : null;
    grant.workspacePersonal = workspace ? workspace.personal : null;
  }

  const principalList = [...byPrincipal.values()].sort((a, b) =>
    b.workspaces.length - a.workspaces.length
    || String(a.displayName || a.email || '').localeCompare(String(b.displayName || b.email || '')));

  return {
    workspaces: workspaceList,
    principals: principalList,
    grants: flat.sort((a, b) =>
      String(a.workspaceName || '').localeCompare(String(b.workspaceName || ''))
      || accessLevel(b.accessRight).rank - accessLevel(a.accessRight).rank
      || String(a.displayName || a.email || '').localeCompare(String(b.displayName || b.email || ''))),
    totals: summarizeAccess(workspaceList, principalList),
  };
}

/**
 * The facts about an access model worth putting above the table.
 *
 * A list of ten thousand grants is a record, not an answer. These are the four
 * things somebody reviewing access is actually looking for, and each is invisible
 * in the grant list itself.
 */
function summarizeAccess(workspaces, principals) {
  const readable = workspaces.filter(workspace => workspace.usersReadable);
  return {
    workspaces: workspaces.length,
    unreadable: workspaces.length - readable.length,
    grants: workspaces.reduce((sum, workspace) => sum + workspace.grants.length, 0),
    principals: principals.length,
    // Nobody can administer it, and nobody can grant anyone else access to it
    // either — recoverable only by a tenant administrator.
    withoutAdmin: readable.filter(workspace => workspace.counts.admin === 0).length,
    // One admin is one resignation away from the case above.
    singleAdmin: readable.filter(workspace => workspace.counts.admin === 1).length,
    // Access held by a person rather than a group is what nobody remembers to remove.
    adminPeople: principals.filter(p => p.principalType === 'user' && p.counts.admin > 0).length,
    // Somebody's private working area holding organisational content. Nothing can
    // be granted on a confirmed one, so it is not a workspace governance can reach.
    personal: workspaces.filter(workspace => workspace.personal && workspace.personal.personal).length,
    personalConfirmed: workspaces.filter(workspace => workspace.personal && workspace.personal.confidence === 'confirmed').length,
    servicePrincipals: principals.filter(p => p.principalType === 'app').length,
  };
}

/**
 * The workspaces a given service principal is not already in.
 *
 * The grant flow used to offer every workspace in the tenant with nothing said
 * about which ones already had the principal, so the safe action — add it only
 * where it is missing — meant checking forty workspaces by hand first.
 */
function markServicePrincipalAccess(overview, servicePrincipalObjectId) {
  const wanted = String(servicePrincipalObjectId || '').trim().toLowerCase();
  return overview.workspaces.map(workspace => {
    const grant = wanted
      ? workspace.grants.find(g => String(g.principalId || '').toLowerCase() === wanted)
      : null;
    return {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      state: workspace.state,
      status: workspace.status || workspaceStatus(workspace),
      personal: workspace.personal || classifyWorkspacePersonal(workspace),
      itemCount: workspace.itemCount,
      usersReadable: workspace.usersReadable,
      hasAccess: !!grant,
      accessRight: grant ? grant.accessRight : null,
    };
  });
}

/**
 * Which workspaces the service principal cannot reach, from two live lists.
 *
 * `all` is every workspace in the tenant (the admin endpoint); `reachable` is what
 * the principal itself can see. The difference is what it has no access to — the
 * question the grant flow actually has to answer, and the one a scan cannot,
 * because a scan reads the admin API and so sees every workspace whether the
 * principal is a member or not.
 *
 * Pure, so the set arithmetic — which is the whole correctness of the feature —
 * is testable without touching an API.
 */
// A workspace a service principal cannot be added to, whatever its access.
// Personal workspaces take no members at all, and a deleted or deleting one is on
// its way out — offering either would produce a failure nobody can fix.
function isPersonalWorkspace(workspace) {
  return String((workspace && workspace.type) || '').toLowerCase() === 'personalgroup';
}

function isRetiredWorkspace(workspace) {
  const state = String((workspace && workspace.state) || '').trim().toLowerCase();
  // An absent state means the API did not say, which the Fabric endpoint does for
  // ordinary live workspaces. Only an explicit end-of-life state excludes one.
  return state === 'deleted' || state === 'removing' || state === 'deleting';
}

function missingServicePrincipalAccess(all, reachable) {
  const idOf = workspace => String((workspace && (workspace.id || workspace.workspaceId)) || '').trim().toLowerCase();
  const nameOf = workspace => (workspace && (workspace.displayName || workspace.name)) || null;

  const held = new Set((reachable || []).map(idOf).filter(Boolean));

  const seen = new Set();
  const missing = [];
  let withAccess = 0;
  let skipped = 0;
  let personalLikely = 0;

  for (const workspace of all || []) {
    const id = idOf(workspace);
    // A tenant list with a duplicate would offer the same workspace twice to grant.
    if (!id || seen.has(id)) continue;
    seen.add(id);

    if (held.has(id)) {
      withAccess += 1;
      continue;
    }

    // Counted, not silently dropped: "12 of 40 unreachable" and a list of 9 would
    // look like a bug rather than like three workspaces nothing can be done about.
    if (isPersonalWorkspace(workspace) || isRetiredWorkspace(workspace)) {
      skipped += 1;
      continue;
    }

    // The tenant listing carries no user data, so a name is the only evidence
    // available here. It is a warning attached to the row, not a reason to drop
    // it: the operator decides, and the grant is what settles it either way.
    const personal = classifyWorkspacePersonal({ name: nameOf(workspace), type: workspace.type });
    if (personal.personal) personalLikely += 1;

    missing.push({
      id: workspace.id || workspace.workspaceId,
      name: nameOf(workspace) || '(unnamed)',
      state: workspace.state || 'Active',
      status: workspaceStatus(workspace),
      personal,
    });
  }

  missing.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { total: seen.size, withAccess, skipped, personalLikely, missing };
}

module.exports = {
  missingServicePrincipalAccess,
  isPersonalWorkspace,
  isRetiredWorkspace,
  WORKSPACE_STATUSES,
  workspaceStatus,
  looksLikeEmail,
  looksLikePersonName,
  classifyWorkspacePersonal,
  ACCESS_LEVELS,
  ACCESS_BY_KEY,
  FABRIC_ROLES,
  PRINCIPAL_TYPES,
  UNKNOWN_ACCESS,
  normalizeAccess,
  accessLevel,
  normalizePrincipalType,
  principalTypeLabel,
  principalKey,
  buildAccessOverview,
  summarizeAccess,
  markServicePrincipalAccess,
};
