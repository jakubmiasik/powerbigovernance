// Turns a saved analysis run into a triage list: which workspaces need attention
// and why. Everything here is derived from data already stored in results_json —
// no extra API calls — and every function is pure so it can be tested directly.

const { checkWorkspace, normalizeConvention } = require('./namingConventionService');

const DEFAULT_STALE_DAYS = 90;
const DEFAULT_OVERSHARED_USERS = 50;

// Ordered worst-first. `weight` feeds the risk score; ties break on item count so
// a neglected large workspace outranks a neglected empty one.
const FINDING_DEFS = [
  {
    key: 'ownerless',
    label: 'No admin',
    severity: 'high',
    weight: 100,
    icon: 'person-x',
    description: 'Nobody has Admin access, so no one can grant access, fix a broken refresh, or delete the workspace.',
  },
  {
    key: 'orphanedAdmin',
    label: 'Only non-user admins',
    severity: 'high',
    weight: 80,
    icon: 'robot',
    description: 'Every admin is a service principal or app. There is no person accountable for this workspace.',
  },
  {
    key: 'singleAdmin',
    label: 'Single admin',
    severity: 'medium',
    weight: 50,
    icon: 'person-exclamation',
    description: 'One admin is a single point of failure — access is lost the moment that account is disabled.',
  },
  {
    key: 'staleContent',
    label: 'Stale content',
    severity: 'medium',
    weight: 40,
    icon: 'hourglass-bottom',
    description: 'Nothing has been updated for a long time. A candidate for archiving or decommissioning.',
  },
  {
    key: 'orphanedContent',
    label: 'Orphaned content',
    severity: 'medium',
    weight: 35,
    icon: 'file-earmark-x',
    description: 'Items were created by principals who no longer appear anywhere in the tenant — typically people who have left.',
  },
  {
    key: 'capacityRisk',
    label: 'Fabric items off capacity',
    severity: 'medium',
    weight: 30,
    icon: 'lightning-charge',
    description: 'Fabric-only items sit in a workspace that is not on dedicated capacity, so they cannot run.',
  },
  {
    key: 'personalAccess',
    label: 'No group-based access',
    severity: 'medium',
    weight: 25,
    icon: 'person-lines-fill',
    description: 'Access is held by individual accounts and no security group holds any role. Every joiner and leaver then has to be remembered by hand, which is how access outlives the job that needed it.',
  },
  {
    key: 'overShared',
    label: 'Broadly shared',
    severity: 'low',
    weight: 20,
    icon: 'people',
    description: 'Access has been granted to an unusually large number of principals.',
  },
  {
    key: 'namingConvention',
    label: 'Off-convention names',
    severity: 'low',
    weight: 18,
    icon: 'type',
    description: 'Artifacts whose names do not follow the configured Fabric naming convention. Open the workspace to see each one and the name it should have.',
  },
  {
    key: 'emptyWorkspace',
    label: 'Empty workspace',
    severity: 'low',
    weight: 15,
    icon: 'inbox',
    description: 'No content, but people still have access. Usually left over from an abandoned project.',
  },
];

const FINDING_BY_KEY = new Map(FINDING_DEFS.map(def => [def.key, def]));

/**
 * What a risk score means, in words.
 *
 * The score is the sum of the weights of everything found — nothing is averaged
 * and nothing is capped, so it is a workload figure rather than a percentage:
 * two medium problems outrank one, and one severe problem outranks three trivial
 * ones. The bands exist so a number on a badge can be read without the table of
 * weights beside it.
 */
const RISK_BANDS = [
  { key: 'critical', label: 'Critical', min: 150, color: 'danger', description: 'Several serious problems at once, or one severe problem in a workspace that also has others. Deal with these first.' },
  { key: 'high', label: 'High', min: 80, color: 'danger', description: 'At least one high-severity finding — typically nobody accountable for the workspace.' },
  { key: 'medium', label: 'Medium', min: 35, color: 'warning', description: 'Worth scheduling: a single point of failure, abandoned content, or access nobody manages as a group.' },
  { key: 'low', label: 'Low', min: 1, color: 'secondary', description: 'Housekeeping. Nothing here stops anyone working today.' },
  { key: 'clean', label: 'Clean', min: 0, color: 'success', description: 'Nothing found by any of the checks below.' },
];

function riskBand(score) {
  const value = Number(score) || 0;
  return RISK_BANDS.find(band => value >= band.min) || RISK_BANDS[RISK_BANDS.length - 1];
}

// Item types that only exist on Fabric capacity.
const FABRIC_ONLY_TYPES = new Set([
  'lakehouse', 'warehouse', 'notebook', 'datapipeline', 'kqldatabase', 'kqlqueryset',
  'eventstream', 'eventhouse', 'sparkjobdefinition', 'environment', 'sqldatabase',
  'dataflowgen2', 'mlmodel', 'mlexperiment',
]);

const EMPTY_CAPACITY_ID = '00000000-0000-0000-0000-000000000000';

function isAdminRole(role) {
  return (role || '').toLowerCase() === 'admin';
}

// Power BI reports groups and service principals through the same users list, so
// principalType is what separates "a person is accountable" from "a robot owns it".
function isPersonPrincipal(user) {
  const type = (user && user.type ? String(user.type) : 'User').toLowerCase();
  return type === 'user' || type === '';
}

// A security group is the only principal whose membership is managed somewhere
// else — which is what makes joiner/leaver handling somebody's job rather than
// nobody's.
function isGroupPrincipal(user) {
  const type = (user && user.type ? String(user.type) : '').toLowerCase();
  return type === 'group' || type === 'securitygroup' || type === 'distributionlist';
}

function userDisplay(user) {
  if (!user) return 'Unknown';
  return user.name || user.email || 'Unknown';
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function principalKey(value) {
  return (value || '').trim().toLowerCase();
}

// Everyone the scan saw anywhere in the tenant. Used to decide whether an item's
// creator still exists; without it, orphan detection would be guesswork.
function collectKnownPrincipals(workspaces) {
  const known = new Set();
  for (const workspace of workspaces || []) {
    for (const user of workspace.users || []) {
      const email = principalKey(user.email);
      const name = principalKey(user.name);
      if (email) known.add(email);
      if (name) known.add(name);
    }
  }
  return known;
}

function latestActivity(workspace) {
  let latest = null;
  for (const item of workspace.items || []) {
    const updated = parseDate(item.lastUpdated || item.lastUpdatedDate);
    if (updated && (!latest || updated > latest)) latest = updated;
  }
  return latest;
}

function analyzeWorkspace(workspace, context) {
  const { referenceDate, staleDays, overSharedUsers, knownPrincipals, detectOrphans } = context;
  const users = workspace.users || [];
  const items = workspace.items || [];
  const admins = users.filter(user => isAdminRole(user.role));
  const humanAdmins = admins.filter(isPersonPrincipal);
  const findings = [];

  function addFinding(key, detail, extra) {
    const def = FINDING_BY_KEY.get(key);
    findings.push({
      key,
      label: def.label,
      severity: def.severity,
      icon: def.icon,
      weight: def.weight,
      description: def.description,
      detail,
      ...(extra || {}),
    });
  }

  // Access findings. A workspace with no user list at all (the scan could not read
  // it) is not evidence of an access problem, so it is skipped rather than flagged.
  if (users.length > 0) {
    if (admins.length === 0) {
      addFinding('ownerless', 'No principal holds Admin access.');
    } else if (humanAdmins.length === 0) {
      addFinding('orphanedAdmin', 'Admins are only: ' + admins.map(userDisplay).join(', ') + '.');
    } else if (humanAdmins.length === 1) {
      addFinding('singleAdmin', 'Only ' + userDisplay(humanAdmins[0]) + ' has Admin access.');
    }

    // Access held only by named people. The workspace works today and falls apart
    // quietly: nothing tells anyone to remove a leaver, and nothing grants a joiner.
    const groupPrincipals = users.filter(isGroupPrincipal);
    const peoplePrincipals = users.filter(isPersonPrincipal);
    if (peoplePrincipals.length && !groupPrincipals.length) {
      const named = peoplePrincipals.slice(0, 3).map(userDisplay).join(', ');
      addFinding('personalAccess',
        peoplePrincipals.length + ' individual account(s) hold access and no security group does: '
        + named + (peoplePrincipals.length > 3 ? ', …' : '') + '.',
        { count: peoplePrincipals.length });
    }

    if (users.length >= overSharedUsers) {
      addFinding('overShared', users.length + ' principals have access (threshold ' + overSharedUsers + ').', { count: users.length });
    }
  }

  const lastActivity = latestActivity(workspace);
  if (items.length === 0) {
    if (users.length > 0) {
      addFinding('emptyWorkspace', 'No items, but ' + users.length + ' principal(s) still have access.');
    }
  } else if (lastActivity) {
    const age = daysBetween(lastActivity, referenceDate);
    if (age >= staleDays) {
      addFinding('staleContent', 'Newest item was updated ' + age + ' days before this scan (' + lastActivity.toISOString().slice(0, 10) + ').', { days: age });
    }
  }

  // Orphaned content: creators the scan never saw as a principal anywhere.
  if (detectOrphans && items.length) {
    const orphanedBy = new Map();
    for (const item of items) {
      const creator = item.creator;
      if (!creator) continue;
      const key = principalKey(creator.upn) || principalKey(creator.name);
      if (!key) continue;
      if (knownPrincipals.has(key)) continue;
      const label = creator.upn || creator.name;
      orphanedBy.set(label, (orphanedBy.get(label) || 0) + 1);
    }
    if (orphanedBy.size) {
      const total = [...orphanedBy.values()].reduce((sum, count) => sum + count, 0);
      const top = [...orphanedBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([label, count]) => label + ' (' + count + ')');
      addFinding('orphanedContent', total + ' item(s) created by principals no longer in the tenant: ' + top.join(', ') + (orphanedBy.size > 3 ? ', …' : '') + '.', { count: total });
    }
  }

  // Names that do not follow the configured convention. Only when one is
  // configured *and* switched on: an unconfigured convention would flag an entire
  // tenant on its first scan, which is noise, not a finding.
  if (context.namingConvention && items.length) {
    const naming = checkWorkspace(workspace, context.namingConvention);
    if (naming.offenders.length) {
      const named = naming.offenders.slice(0, 3).map(offender => offender.name).join(', ');
      addFinding('namingConvention',
        naming.offenders.length + ' of ' + naming.checked + ' checked artifact(s) do not follow the convention: '
        + named + (naming.offenders.length > 3 ? ', …' : '') + '.',
        { count: naming.offenders.length, checked: naming.checked });
    }
  }

  // Fabric-only content in a workspace that is not on dedicated capacity.
  const onDedicatedCapacity = !!workspace.capacityId && workspace.capacityId !== EMPTY_CAPACITY_ID;
  if (!onDedicatedCapacity) {
    const fabricItems = items.filter(item => FABRIC_ONLY_TYPES.has((item.type || '').toLowerCase()));
    if (fabricItems.length) {
      addFinding('capacityRisk', fabricItems.length + ' Fabric-only item(s) in a workspace with no dedicated capacity.', { count: fabricItems.length });
    }
  }

  findings.sort((a, b) => b.weight - a.weight);
  const score = findings.reduce((sum, finding) => sum + finding.weight, 0);

  return {
    id: workspace.id,
    name: workspace.name || 'Unnamed',
    state: workspace.state || '-',
    licenseType: workspace.licenseType || 'Pro',
    capacitySku: workspace.capacitySku || null,
    totalItems: items.length || Number(workspace.totalItems) || 0,
    userCount: users.length || Number(workspace.userCount) || 0,
    adminCount: admins.length,
    humanAdminCount: humanAdmins.length,
    storageSize: Number(workspace.storageSize) || 0,
    lastActivity: lastActivity ? lastActivity.toISOString() : null,
    lastActivityDays: lastActivity ? daysBetween(lastActivity, context.referenceDate) : null,
    findings,
    score,
    // Read off the number actually shown on the badge, rather than off the worst
    // single finding: a workspace with four medium problems is not "medium".
    band: riskBand(score),
    highestSeverity: findings.length ? findings[0].severity : null,
  };
}

/**
 * Rank every workspace in a run by how much attention it needs.
 *
 * `referenceDate` is the scan date rather than "now", so staleness is measured
 * against when the data was collected and re-opening an old run gives the same
 * answer it gave then.
 */
function computeWorkspaceInsights(results, options = {}) {
  const workspaces = (results && results.workspaces) || [];
  const staleDays = Number.isFinite(Number(options.staleDays)) && Number(options.staleDays) > 0
    ? Number(options.staleDays)
    : DEFAULT_STALE_DAYS;
  const overSharedUsers = Number.isFinite(Number(options.overSharedUsers)) && Number(options.overSharedUsers) > 0
    ? Number(options.overSharedUsers)
    : DEFAULT_OVERSHARED_USERS;
  const referenceDate = parseDate(options.referenceDate) || new Date();

  const knownPrincipals = collectKnownPrincipals(workspaces);
  // With no user data at all, every creator would look orphaned. Better to report
  // nothing than to report a tenant-wide false positive.
  const detectOrphans = knownPrincipals.size > 0;

  // Normalized once for the whole run rather than per workspace: a tenant has
  // thousands of items, and re-deriving the rules for each of them is work that
  // produces the same answer every time.
  const namingConvention = options.namingConvention && options.namingConvention.enabled
    ? normalizeConvention(options.namingConvention)
    : null;

  const context = { referenceDate, staleDays, overSharedUsers, knownPrincipals, detectOrphans, namingConvention };
  const analyzed = workspaces.map(workspace => analyzeWorkspace(workspace, context));

  analyzed.sort((a, b) => b.score - a.score || b.totalItems - a.totalItems || a.name.localeCompare(b.name));

  const byFinding = {};
  for (const def of FINDING_DEFS) byFinding[def.key] = 0;
  for (const workspace of analyzed) {
    for (const finding of workspace.findings) byFinding[finding.key] += 1;
  }

  const flagged = analyzed.filter(workspace => workspace.findings.length > 0);
  return {
    workspaces: analyzed,
    flaggedCount: flagged.length,
    healthyCount: analyzed.length - flagged.length,
    totalCount: analyzed.length,
    byFinding,
    thresholds: { staleDays, overSharedUsers },
    // So the page can explain the number on the badge instead of asking the
    // reader to take it on trust.
    riskBands: RISK_BANDS,
    maxScore: FINDING_DEFS.reduce((sum, def) => sum + def.weight, 0),
    // So the page can hide the naming card rather than showing a permanent zero
    // for a check nobody has switched on.
    namingConventionEnabled: !!namingConvention,
    referenceDate: referenceDate.toISOString(),
    orphanDetectionAvailable: detectOrphans,
  };
}

module.exports = {
  FINDING_DEFS,
  RISK_BANDS,
  riskBand,
  DEFAULT_STALE_DAYS,
  DEFAULT_OVERSHARED_USERS,
  computeWorkspaceInsights,
};
