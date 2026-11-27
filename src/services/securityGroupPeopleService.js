/**
 * Everyone the tenant's scan found in a workspace, as the starting list for the
 * security group plan.
 *
 * Typing people in one at a time is how a plan ends up covering the dozen anyone
 * remembered. The scan already knows who holds a role in which workspace, so the
 * list starts from that: one row per distinct person, every workspace they reach
 * and the role they hold there.
 *
 * By design a person nobody has mapped yet is treated as Other — the role that
 * grants least — until someone says what they actually do. A mapping is never
 * guessed from a workspace role: Admin on a workspace says nothing about whether
 * someone is a Data Engineer.
 *
 * Pure: it takes the scan's access rows and the stored assignments.
 */

const OTHER = 'OTHER';
const RANK = { admin: 4, member: 3, contributor: 2, viewer: 1 };

function personKey(email, name) {
  const mail = String(email || '').trim().toLowerCase();
  if (mail) return 'email:' + mail;
  const label = String(name || '').trim().toLowerCase();
  return label ? 'name:' + label : null;
}

function isPerson(grant) {
  const type = String(grant.principal_type || grant.principalType || '').toLowerCase();
  // Groups and service principals are not people to map; an unspecified type with
  // an e-mail address is treated as a person.
  if (type === 'user') return true;
  if (type === 'group' || type === 'app' || type === 'serviceprincipal') return false;
  return Boolean(grant.email);
}

/**
 * @param grants       rows from analysis_workspace_users (workspace_name may be joined in)
 * @param assignments  stored assignments of this tenant
 * @returns people, sorted with the unmapped first, then by name
 */
function buildPeople(grants, assignments) {
  const mapped = new Map();
  for (const assignment of assignments || []) {
    const key = personKey(assignment.email, assignment.name);
    if (!key) continue;
    if (!mapped.has(key)) mapped.set(key, []);
    mapped.get(key).push({
      id: assignment.id, stream: assignment.stream, projectRole: assignment.projectRole,
      environments: assignment.environments || [],
    });
  }

  const people = new Map();
  for (const grant of grants || []) {
    if (!isPerson(grant)) continue;
    const email = grant.email || null;
    const name = grant.display_name || grant.displayName || email;
    const key = personKey(email, name);
    if (!key) continue;
    if (!people.has(key)) {
      people.set(key, { key, name, email: email ? String(email).toLowerCase() : null, workspaces: [], strongest: null });
    }
    const person = people.get(key);
    const role = grant.access_right || grant.accessRight || null;
    const workspaceId = grant.workspace_id || grant.workspaceId;
    if (!person.workspaces.some(w => w.id === workspaceId)) {
      person.workspaces.push({ id: workspaceId, name: grant.workspace_name || grant.workspaceName || workspaceId, role });
    }
    if ((RANK[String(role || '').toLowerCase()] || 0) > (RANK[String(person.strongest || '').toLowerCase()] || 0)) {
      person.strongest = role;
    }
  }

  // People mapped by hand but not found in the scan stay visible: they may have
  // no workspace yet, and the plan is for them too.
  for (const [key, list] of mapped) {
    if (!people.has(key)) {
      const assignment = (assignments || []).find(a => personKey(a.email, a.name) === key);
      people.set(key, { key, name: assignment.name, email: assignment.email || null, workspaces: [], strongest: null, notInScan: true });
    }
  }

  return [...people.values()].map(person => {
    const assignmentsFor = mapped.get(person.key) || [];
    return {
      ...person,
      workspaces: person.workspaces.sort((a, b) => String(a.name).localeCompare(String(b.name))),
      assignments: assignmentsFor,
      mapped: assignmentsFor.length > 0,
      // Until somebody says otherwise.
      projectRole: assignmentsFor.length ? assignmentsFor[0].projectRole : OTHER,
      stream: assignmentsFor.length ? assignmentsFor[0].stream : null,
      notInScan: !!person.notInScan,
    };
  }).sort((a, b) => (a.mapped - b.mapped) || String(a.name).localeCompare(String(b.name)));
}

function summarize(people) {
  return {
    total: people.length,
    mapped: people.filter(p => p.mapped).length,
    other: people.filter(p => !p.mapped).length,
    notInScan: people.filter(p => p.notInScan).length,
  };
}

/**
 * The groups with who is in them and whether they are in any workspace — the
 * answer the page ends on.
 */
function groupOverview(groups) {
  return (groups || []).map(group => {
    const checks = group.workspaces.map(w => (w.lastCheck ? w.lastCheck.state : 'unchecked'));
    return {
      id: group.id,
      name: group.entraGroupName || group.suggestedName,
      suggestedName: group.suggestedName,
      linked: !!group.entraGroupId,
      participants: (group.members || []).map(m => m.name),
      workspaceCount: group.workspaces.length,
      verified: checks.filter(state => state === 'present').length,
      problems: checks.filter(state => state === 'missing' || state === 'wrong-role').length,
      unchecked: checks.filter(state => state === 'unchecked').length,
      status: !group.workspaces.length ? 'not-attached'
        : checks.some(state => state === 'missing' || state === 'wrong-role') ? 'problem'
          : checks.every(state => state === 'present') ? 'verified' : 'not-verified',
    };
  });
}

module.exports = { buildPeople, summarize, groupOverview, personKey, OTHER };
