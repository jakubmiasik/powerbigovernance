/**
 * Which security groups a Fabric tenant should have, and what goes in each.
 *
 * Granting a role is the easy half. The half that decides whether access stays
 * manageable is which groups exist before anyone grants anything — a workspace
 * granting four groups rather than forty people is the whole difference, and it
 * cannot be retrofitted once the forty grants are in place.
 *
 * Kept as data rather than as markup, like the quality guides: the same material
 * is reachable from the triage finding, the role granting page and the navigation,
 * and it has to read identically in each. Pure — no database, no API — so the
 * group plan it generates is testable directly.
 */

const PRINCIPLES = [
  {
    title: 'Grant roles to groups, never to people',
    body: 'A role held by a named person has to be remembered when that person changes team or leaves, and nothing in Fabric will remind anyone. A role held by a group is maintained wherever group membership is already maintained — usually joiner/leaver automation that already exists. This is the one rule the others are consequences of.',
  },
  {
    title: 'One group per role per scope',
    body: 'A group that means "people who can do things in Finance" is useless at assignment time, because Admin, Member, Contributor and Viewer are different answers. The unit that works is the pair: a scope (a domain, a workspace, a set of workspaces that move together) and a role within it. Fewer groups than that and every grant becomes a judgement call; more, and nobody can say what a group is for.',
  },
  {
    title: 'Environments are separate scopes',
    body: 'The people who may publish to production are not the people who may publish to development, and a single group for both means the stricter of the two is unenforceable. Where a domain has more than one environment, each is its own scope.',
  },
  {
    title: 'Service principals belong in their own groups',
    body: 'Tenant settings that enable API access are applied to security groups, and putting applications in the same group as people means loosening a setting for everyone to enable one job. A group holding only service principals can be granted exactly what its jobs need.',
  },
  {
    title: 'Broad read access is an app audience, not a workspace role',
    body: 'Viewer on the workspace shows people everything in it, including the half-finished. Publishing an app and giving the audience the group is how a report reaches a wide readership without the workspace becoming a public folder.',
  },
  {
    title: 'The group name says what it grants',
    body: 'Somebody reviewing access a year from now reads group names, not documentation. A name carrying the scope, the environment and the role can be checked against a workspace role assignment at a glance; a name like "BI Users" cannot be checked at all.',
  },
];

// The four workspace roles, said in terms of who should be in the group rather
// than in terms of the permission matrix, which the product documents already.
const ROLE_GROUPS = [
  {
    role: 'Admin',
    holds: 'The team accountable for the workspace — typically two to four people, never one.',
    grants: 'Everything a Member can do, plus changing who has access and deleting the workspace.',
    guidance: 'Keep it small and keep it human. A workspace whose only Admin is a service principal has nobody accountable for it, and one with a single Admin is one leaver away from having none — both are findings in Workspace Triage.',
  },
  {
    role: 'Member',
    holds: 'The people who build and publish content in this workspace and may share it onward.',
    grants: 'Publishing, editing and sharing content; adding others as Contributor or Viewer.',
    guidance: 'This is the working group for a delivery team. In production, membership is usually narrower than in development — which is why environments are separate scopes.',
  },
  {
    role: 'Contributor',
    holds: 'People who build content but should not decide who else sees it.',
    grants: 'Creating and editing content, without sharing it onward.',
    guidance: 'The right default for most builders. Sharing is a governance decision, and Contributor is the role that says so.',
  },
  {
    role: 'Viewer',
    holds: 'People who read content directly in the workspace rather than through an app.',
    grants: 'Reading content only.',
    guidance: 'Use it for a small, known readership. For a wide one, publish an app and give the audience the group instead — the workspace holds work in progress, an app holds what was meant to be read.',
  },
];

// Groups that exist once for the tenant rather than once per workspace.
const TENANT_GROUPS = [
  {
    name: 'Fabric administrators',
    purpose: 'The people who hold the Fabric Administrator role in Entra ID.',
    holds: 'A named, small set of people. This role can see and change everything in the tenant.',
  },
  {
    name: 'Capacity administrators',
    purpose: 'Who may manage a capacity: assign workspaces to it, and pause, resume or scale it.',
    holds: 'The platform team. Note that pausing or scaling a capacity in Azure additionally needs Azure rights on the capacity resource, which is a separate grant.',
  },
  {
    name: 'Domain administrators and contributors',
    purpose: 'Who may manage a domain in the data hub, and who may assign workspaces into it.',
    holds: 'The data owners for that domain, not the platform team.',
  },
  {
    name: 'Workspace creators',
    purpose: 'The tenant setting controlling who may create workspaces.',
    holds: 'Delivery leads. Left open to everyone, a tenant grows workspaces nobody governs; closed entirely, work moves into personal workspaces, which is worse because nothing can be granted in one.',
  },
  {
    name: 'Service principals allowed to use Fabric APIs',
    purpose: 'The tenant setting that enables application access to the APIs — including this application.',
    holds: 'Only service principals, and only the ones that need it. This is the group that makes automation possible; it is also the group that makes it auditable.',
  },
  {
    name: 'Developers allowed to publish',
    purpose: 'Tenant settings covering publishing apps, sharing to the whole organisation, and exporting data.',
    holds: 'Whoever the organisation has decided may do each of those. Applying a setting to a group is what makes "who may share to the whole company" a question with an answer.',
  },
];

const ANTI_PATTERNS = [
  {
    title: 'Granting a person directly "just this once"',
    body: 'It is never once. Workspace Triage reports a workspace where every principal holding a role is an individual account and no security group holds any, because that access has to be maintained by hand and nothing maintains it.',
  },
  {
    title: 'One group for everything',
    body: 'A single "BI Team" group granted Member everywhere means every builder can share anything to anyone, and removing one person from one project removes them from all of them.',
  },
  {
    title: 'The all-company group as Member or Contributor',
    body: 'Read access for everyone is a legitimate decision. Write access for everyone is not a decision anyone made — it is what happens when the convenient group is used for the wrong role.',
  },
  {
    title: 'Groups named after people or projects that ended',
    body: '"Anna\'s reports" and "Q3 migration" outlive their meaning and nobody dares delete them. Name groups after the scope and the role, both of which survive.',
  },
  {
    title: 'Personal workspaces as a workaround',
    body: 'Content in somebody\'s personal workspace cannot be granted to anyone at all — no role can be assigned in one. It is not a shortcut, it is a dead end, and Grant Access marks these so they can be found.',
  },
];

// ── Generating the groups for a scope ──

const DEFAULT_ENVIRONMENTS = ['DEV', 'TEST', 'PROD'];
const DEFAULT_PREFIX = 'FAB';
const DEFAULT_SEPARATOR = '-';

function sanitizeToken(value, fallback) {
  const cleaned = String(value == null ? '' : value)
    .trim().toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 24);
  return cleaned || fallback;
}

/**
 * The groups one scope needs, named consistently.
 *
 * Generated rather than listed, because the answer is mechanical — a group per
 * role per environment — and typing twelve names by hand is where the
 * inconsistencies come from. What it produces is a list to create in Entra ID,
 * not anything this application creates itself.
 */
function securityGroupPlan(options) {
  const input = options || {};
  const prefix = sanitizeToken(input.prefix, DEFAULT_PREFIX);
  const domain = sanitizeToken(input.domain, 'DOMAIN');
  const separator = typeof input.separator === 'string' && input.separator ? input.separator : DEFAULT_SEPARATOR;

  const environments = (Array.isArray(input.environments) && input.environments.length
    ? input.environments
    : DEFAULT_ENVIRONMENTS)
    .map(environment => sanitizeToken(environment, ''))
    .filter(Boolean);

  const groups = [];
  // Environments first so the groups for one environment sit together: that is how
  // they are created, and how a reviewer reads them.
  for (const environment of (environments.length ? environments : [''])) {
    for (const role of ROLE_GROUPS) {
      const parts = [prefix, domain, environment, sanitizeToken(role.role, 'ROLE')].filter(Boolean);
      groups.push({
        name: parts.join(separator),
        role: role.role,
        environment: environment || null,
        holds: role.holds,
        // What to do with it once it exists, which is the part a list of names
        // leaves out.
        assignTo: 'The ' + (environment ? environment + ' ' : '') + domain + ' workspace(s), as ' + role.role + '.',
      });
    }
  }

  // The service principal group is per domain rather than per environment: an
  // application is one identity whatever it is reading.
  groups.push({
    name: [prefix, domain, 'SP'].filter(Boolean).join(separator),
    role: null,
    environment: null,
    holds: 'The service principals that read or write this domain, and nothing else.',
    assignTo: 'The tenant setting allowing service principals to use the Fabric APIs, and whichever workspaces the jobs need — usually Contributor.',
  });

  return { prefix, domain, separator, environments, groups };
}

/** One line per group, for pasting into a ticket or a script. */
function plainGroupList(plan) {
  return (plan && plan.groups ? plan.groups : []).map(group => group.name).join('\n');
}

module.exports = {
  PRINCIPLES,
  ROLE_GROUPS,
  TENANT_GROUPS,
  ANTI_PATTERNS,
  DEFAULT_ENVIRONMENTS,
  DEFAULT_PREFIX,
  DEFAULT_SEPARATOR,
  securityGroupPlan,
  plainGroupList,
};
