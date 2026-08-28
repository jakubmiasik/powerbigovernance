/**
 * People → security groups → Fabric workspace roles.
 *
 * The mapping is mechanical: who someone is (a stream, a project role, the
 * environments they work in) determines which groups they belong to and what
 * those groups should hold in a workspace. Doing it by hand across three
 * environments is where the inconsistencies come from, and an inconsistency in
 * access is not a typo — it is somebody who can publish to production.
 *
 * Pure: no database, no API, no clock. Everything here is derived from the rules
 * below, which is why none of it is stored — a stored derivation goes stale the
 * moment a rule changes, and then the table and the rule disagree with nobody
 * able to say which is right.
 */

// The environments a stream is built across, in the order work moves through
// them. Order matters: it is how the groups are listed and how they read.
const ENVIRONMENTS = [
  { code: 'DEV', label: 'Development', sortOrder: 1 },
  { code: 'TEST', label: 'Test', sortOrder: 2 },
  { code: 'PROD', label: 'Production', sortOrder: 3 },
];

const ENVIRONMENT_CODES = ENVIRONMENTS.map(environment => environment.code);

// What somebody does on the project, which is not the same as what they hold in a
// workspace — the second is derived from the first by the rules below.
const PROJECT_ROLES = [
  { code: 'DE', label: 'Data Engineer', isAdmin: false, sortOrder: 1 },
  { code: 'BI', label: 'Business Intelligence', isAdmin: false, sortOrder: 2 },
  { code: 'AI', label: 'Artificial Intelligence', isAdmin: false, sortOrder: 3 },
  { code: 'PM', label: 'Project Manager', isAdmin: false, sortOrder: 4 },
  { code: 'ADMIN', label: 'Administrator', isAdmin: true, sortOrder: 5 },
  { code: 'UX', label: 'User Experience', isAdmin: false, sortOrder: 6 },
  { code: 'OTHER', label: 'Other', isAdmin: false, sortOrder: 7 },
];

const PROJECT_ROLE_BY_CODE = new Map(PROJECT_ROLES.map(role => [role.code, role]));

// The stream that is not a delivery stream: central platform work, which spans
// every stream's workspaces rather than owning one.
const CENTRAL_STREAM = 'CORP';

const DEFAULT_RULES = {
  prefix: 'SG',
  separator: '-',
  // Production is where a mistake costs something, so building rights stop at the
  // door unless the person administers the platform.
  prodViewerNonAdmin: true,
  // Central platform work is not scoped to one stream's workspaces.
  centralStreamAllScopes: true,
};

function normalizeRules(rules) {
  const input = rules || {};
  return {
    prefix: sanitizeToken(input.prefix, DEFAULT_RULES.prefix),
    separator: typeof input.separator === 'string' && input.separator ? input.separator : DEFAULT_RULES.separator,
    prodViewerNonAdmin: input.prodViewerNonAdmin === undefined
      ? DEFAULT_RULES.prodViewerNonAdmin : !!input.prodViewerNonAdmin,
    centralStreamAllScopes: input.centralStreamAllScopes === undefined
      ? DEFAULT_RULES.centralStreamAllScopes : !!input.centralStreamAllScopes,
  };
}

/**
 * A token safe to put in a group name.
 *
 * These names are created in a directory and then matched against what is there,
 * so a stray space or separator produces a name that does not match the pattern it
 * claims to follow — and a group nobody can find by name is a group nobody links.
 */
function sanitizeToken(value, fallback) {
  const cleaned = String(value == null ? '' : value)
    .trim().toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 32);
  return cleaned || fallback || '';
}

function normalizeStream(value) {
  return sanitizeToken(value, '');
}

function normalizeProjectRole(value) {
  const code = sanitizeToken(value, '');
  // Nothing typed stays nothing, so a caller can tell "no role" from "a role I do
  // not recognise" — the second becomes OTHER, which is what the form offers for it.
  if (!code) return '';
  return PROJECT_ROLE_BY_CODE.has(code) ? code : 'OTHER';
}

/**
 * The environments an assignment covers, in pipeline order.
 *
 * An empty selection means DEV rather than nothing: somebody with no environment
 * at all is a row that grants nothing, which is never what was meant.
 */
function normalizeEnvironments(values) {
  const wanted = new Set((Array.isArray(values) ? values : [values])
    .map(value => sanitizeToken(value, ''))
    .filter(Boolean));
  const known = ENVIRONMENT_CODES.filter(code => wanted.has(code));
  return known.length ? known : ['DEV'];
}

/** `SG-IBP-DE-DEV` — stream, project role, environment. */
function groupName(stream, projectRole, environment, rules) {
  const config = normalizeRules(rules);
  return [
    config.prefix,
    normalizeStream(stream) || 'STREAM',
    normalizeProjectRole(projectRole) || 'ROLE',
    sanitizeToken(environment, 'ENV'),
  ].join(config.separator);
}

function isAdminRole(projectRole) {
  const role = PROJECT_ROLE_BY_CODE.get(normalizeProjectRole(projectRole));
  return !!(role && role.isAdmin);
}

/**
 * What a group should hold in a workspace.
 *
 * Three rules, in order:
 *   - Central platform work spans every stream, so it is granted across the board
 *     rather than within one stream's workspaces.
 *   - Production takes no builders. Anyone who is not an administrator reads it.
 *   - Otherwise the project role decides: administrators administer, project
 *     managers read, everyone else builds.
 */
function fabricRoleFor(stream, projectRole, environment, rules) {
  const config = normalizeRules(rules);
  const streamCode = normalizeStream(stream);
  const roleCode = normalizeProjectRole(projectRole);
  const environmentCode = sanitizeToken(environment, 'DEV');

  if (config.centralStreamAllScopes && streamCode === CENTRAL_STREAM) {
    const role = roleCode === 'ADMIN' ? 'Admin' : roleCode === 'PM' ? 'Viewer' : 'Contributor';
    return {
      role,
      allWorkspaces: true,
      environment: environmentCode,
      label: role + ' (All)',
      reason: 'Central platform work is not scoped to one stream, so this applies across workspaces.',
    };
  }

  if (config.prodViewerNonAdmin && environmentCode === 'PROD' && !isAdminRole(roleCode)) {
    return {
      role: 'Viewer',
      allWorkspaces: false,
      environment: environmentCode,
      label: 'Viewer',
      reason: 'Production is read-only for anyone who does not administer the platform.',
    };
  }

  const role = roleCode === 'ADMIN' ? 'Admin' : roleCode === 'PM' ? 'Viewer' : 'Contributor';
  return {
    role,
    allWorkspaces: false,
    environment: environmentCode,
    label: role,
    reason: roleCode === 'ADMIN'
      ? 'Administrators manage who has access and the workspace itself.'
      : roleCode === 'PM'
        ? 'Project management is read-only: no creating, editing or publishing.'
        : 'Builders create and edit content without deciding who else sees it.',
  };
}

/** The groups one assignment puts a person into — one per environment. */
function groupsForAssignment(assignment, rules) {
  const stream = normalizeStream(assignment && assignment.stream);
  const projectRole = normalizeProjectRole(assignment && assignment.projectRole);
  return normalizeEnvironments(assignment && assignment.environments).map(environment => ({
    stream,
    projectRole,
    environment,
    name: groupName(stream, projectRole, environment, rules),
    fabricRole: fabricRoleFor(stream, projectRole, environment, rules),
  }));
}

/** Same person, same stream, same project role — one row, not two. */
function assignmentKey(assignment) {
  return [
    normalizeStream(assignment && assignment.stream),
    normalizeProjectRole(assignment && assignment.projectRole),
    String((assignment && (assignment.name || assignment.displayName)) || '').trim().toUpperCase(),
  ].join('|');
}

/**
 * Every group implied by a set of assignments, with the people in each.
 *
 * Membership is derived here rather than stored: a person's groups follow from
 * their stream, role and environments, and a stored copy would disagree with the
 * assignment the moment either changed — with nothing to say which was right.
 */
function buildMapping(assignments, rules) {
  const config = normalizeRules(rules);
  const byName = new Map();

  for (const assignment of assignments || []) {
    for (const group of groupsForAssignment(assignment, config)) {
      if (!byName.has(group.name)) {
        byName.set(group.name, {
          name: group.name,
          stream: group.stream,
          projectRole: group.projectRole,
          environment: group.environment,
          fabricRole: group.fabricRole,
          members: [],
        });
      }
      byName.get(group.name).members.push({
        assignmentId: assignment.id || null,
        personId: assignment.personId || null,
        name: assignment.name || assignment.displayName || null,
        email: assignment.email || null,
      });
    }
  }

  const groups = [...byName.values()].sort((a, b) =>
    String(a.stream).localeCompare(String(b.stream))
    || String(a.projectRole).localeCompare(String(b.projectRole))
    || ENVIRONMENT_CODES.indexOf(a.environment) - ENVIRONMENT_CODES.indexOf(b.environment));

  return {
    groups,
    rules: config,
    totals: {
      groups: groups.length,
      assignments: (assignments || []).length,
      people: new Set((assignments || [])
        .map(assignment => String(assignment.email || assignment.name || '').trim().toLowerCase())
        .filter(Boolean)).size,
    },
  };
}

// ── Why this person is in these groups ──

function personJustification(assignment, rules) {
  const stream = normalizeStream(assignment && assignment.stream);
  const role = normalizeProjectRole(assignment && assignment.projectRole);
  const environments = normalizeEnvironments(assignment && assignment.environments);
  const roles = environments
    .map(environment => fabricRoleFor(stream, role, environment, rules).label + ' (' + environment + ')')
    .join('; ');
  const name = (assignment && (assignment.name || assignment.displayName)) || 'This person';

  if (stream === CENTRAL_STREAM && role === 'ADMIN') {
    return name + ' is a central Fabric administrator for ' + stream + ', so they hold workspace Admin across '
      + environments.join(', ') + '. Computed roles: ' + roles + '. Membership of these groups should be tightly '
      + 'controlled and reviewed, because it is the access that can grant more access.';
  }

  const because = {
    DE: 'builds and maintains ingestion and transformation',
    BI: 'builds semantic models and reports',
    AI: 'works on notebooks and curated data for AI and ML',
    PM: 'manages the project and needs to read, not change, what it produces',
    ADMIN: 'performs administrative functions',
    UX: 'designs how the content is used',
  }[role] || 'works on';

  return name + ' ' + because + ' for stream ' + stream + ' in ' + environments.join(', ')
    + '. Computed roles: ' + roles + '.';
}

function groupJustification(group, rules) {
  const config = normalizeRules(rules);
  const central = group && normalizeStream(group.stream) === CENTRAL_STREAM;
  const base = central
    ? 'This group is central platform administration, granted across workspaces rather than within one stream.'
    : 'This group standardises access by stream and role. One group per environment is what makes least privilege '
      + 'enforceable and keeps a build right in development from becoming one in production.';
  const prod = group && group.environment === 'PROD' && config.prodViewerNonAdmin && !isAdminRole(group.projectRole)
    ? ' Production is read-only here: the rule grants Viewer to everyone who does not administer the platform.'
    : '';
  return base + prod + ' Membership is reviewed on the group, not on each person.';
}

// ── CSV ──

const CSV_COLUMNS = ['Stream', 'Project Role', 'Name', 'Email', 'Environments'];

/**
 * Splits CSV text into rows, respecting quoted fields.
 *
 * Business names legitimately contain commas — "Nowak, Anna" is one field — and a
 * split on commas turns one person into two columns and drops the row.
 */
function parseCsvGrid(text) {
  const source = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; continue; }
        quoted = false;
        continue;
      }
      field += character;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ',') { row.push(field); field = ''; continue; }
    if (character === '\r') continue;
    if (character === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += character;
  }

  row.push(field);
  if (row.some(value => String(value || '').trim() !== '')) rows.push(row);
  return rows;
}

/**
 * Reads a mapping CSV into assignments, saying what it could not read.
 *
 * Rows are rejected individually and named. An import that silently drops eleven
 * of forty rows produces an access model that is wrong in a way nobody looks for.
 */
function parseMappingCsv(text) {
  const grid = parseCsvGrid(text);
  if (grid.length < 2) {
    return { assignments: [], skipped: [], error: 'The file has no data rows — a header line and at least one row are needed.' };
  }

  const headers = grid[0].map(header => String(header || '').trim().toLowerCase());
  const columnOf = names => {
    for (const name of names) {
      const index = headers.indexOf(name);
      if (index !== -1) return index;
    }
    return -1;
  };

  const columns = {
    stream: columnOf(['stream']),
    role: columnOf(['project role', 'role']),
    name: columnOf(['name', 'user', 'person']),
    email: columnOf(['email', 'upn', 'userprincipalname']),
    environments: columnOf(['environments', 'environment', 'envs', 'env']),
  };

  if (columns.stream === -1 || columns.role === -1 || columns.name === -1) {
    return {
      assignments: [], skipped: [],
      error: 'The header must name at least Stream, Project Role and Name. Found: ' + (headers.join(', ') || '(nothing)'),
    };
  }

  const cell = (row, index) => (index === -1 ? '' : String(row[index] == null ? '' : row[index]).trim());
  const assignments = [];
  const skipped = [];
  const seen = new Set();

  for (let index = 1; index < grid.length; index += 1) {
    const row = grid[index];
    const stream = normalizeStream(cell(row, columns.stream));
    const name = cell(row, columns.name);
    const rawRole = cell(row, columns.role);

    if (!stream || !name) {
      skipped.push({ line: index + 1, reason: 'Needs both a stream and a name.', value: row.join(',').slice(0, 120) });
      continue;
    }

    const assignment = {
      stream,
      projectRole: normalizeProjectRole(rawRole),
      name,
      email: cell(row, columns.email) || null,
      environments: normalizeEnvironments(cell(row, columns.environments).split(/[;,\s|]+/)),
    };

    // The same person, stream and role twice in one file is one assignment.
    const key = assignmentKey(assignment);
    if (seen.has(key)) {
      skipped.push({ line: index + 1, reason: 'Already in this file — same person, stream and role.', value: name });
      continue;
    }
    seen.add(key);

    // Compared against what was written, not against what it became: by now an
    // unrecognised role is already OTHER, and OTHER is a role this app knows.
    if (rawRole && assignment.projectRole === 'OTHER' && sanitizeToken(rawRole, '') !== 'OTHER') {
      // Kept, not dropped: an unknown role still describes somebody who needs
      // access, and OTHER is what the form would have made of it too.
      skipped.push({ line: index + 1, reason: 'Unknown project role "' + rawRole + '" — imported as OTHER.', value: name, imported: true });
    }

    assignments.push(assignment);
  }

  return { assignments, skipped, error: null };
}

function csvCell(value) {
  return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}

/** The mapping as a CSV, with the derived columns spelled out. */
function toMappingCsv(assignments, rules) {
  const lines = [CSV_COLUMNS.concat(['Security Groups', 'Fabric Roles']).join(',')];
  for (const assignment of assignments || []) {
    const groups = groupsForAssignment(assignment, rules);
    lines.push([
      csvCell(normalizeStream(assignment.stream)),
      csvCell(normalizeProjectRole(assignment.projectRole)),
      csvCell(assignment.name || assignment.displayName || ''),
      csvCell(assignment.email || ''),
      csvCell(normalizeEnvironments(assignment.environments).join(';')),
      csvCell(groups.map(group => group.name).join(';')),
      csvCell(groups.map(group => group.fabricRole.label + ' (' + group.environment + ')').join(';')),
    ].join(','));
  }
  return lines.join('\n');
}

// ── Is the group actually in the workspace? ──

const CHECK_STATES = {
  PRESENT: 'present',
  WRONG_ROLE: 'wrong-role',
  MISSING: 'missing',
  UNLINKED: 'unlinked',
  UNREADABLE: 'unreadable',
};

/**
 * Compares what should be in a workspace against what the workspace says is.
 *
 * A plan that nobody checked against the tenant is a document, not a control. The
 * three answers are different and are kept apart: the group is there with the
 * right role, it is there with the wrong one, or it is not there at all. A group
 * that was never linked to a real directory group cannot be checked — that is a
 * fourth answer and it is not "missing".
 */
function compareAssignment(expected, roleAssignments) {
  const objectId = String((expected && expected.entraGroupId) || '').trim().toLowerCase();
  if (!objectId) {
    return {
      state: CHECK_STATES.UNLINKED,
      present: false,
      actualRole: null,
      message: 'No Entra ID group is linked to this one, so there is nothing to look for in the workspace.',
    };
  }
  if (!Array.isArray(roleAssignments)) {
    return {
      state: CHECK_STATES.UNREADABLE,
      present: false,
      actualRole: null,
      message: 'The workspace role assignments could not be read, which is not the same as the group being absent.',
    };
  }

  const match = roleAssignments.find(assignment => {
    const principal = (assignment && assignment.principal) || assignment || {};
    const id = String(principal.id || principal.principalId || '').trim().toLowerCase();
    return id === objectId;
  });

  if (!match) {
    return {
      state: CHECK_STATES.MISSING,
      present: false,
      actualRole: null,
      message: 'The group holds no role in this workspace.',
    };
  }

  const actualRole = String(match.role || '').trim();
  const wanted = String((expected && expected.intendedRole) || '').trim();
  if (wanted && actualRole.toLowerCase() !== wanted.toLowerCase()) {
    return {
      state: CHECK_STATES.WRONG_ROLE,
      present: true,
      actualRole,
      message: 'The group is in the workspace as ' + actualRole + ', but the mapping says ' + wanted + '.',
    };
  }

  return {
    state: CHECK_STATES.PRESENT,
    present: true,
    actualRole,
    message: 'The group holds ' + (actualRole || 'a role') + ' in this workspace, as intended.',
  };
}

function summarizeChecks(results) {
  const counts = { present: 0, 'wrong-role': 0, missing: 0, unlinked: 0, unreadable: 0 };
  for (const result of results || []) {
    if (counts[result.state] !== undefined) counts[result.state] += 1;
  }
  return {
    ...counts,
    total: (results || []).length,
    // What somebody has to act on: a group that should be there and is not, or is
    // there holding something other than what was decided.
    actionable: counts.missing + counts['wrong-role'],
  };
}

module.exports = {
  ENVIRONMENTS,
  ENVIRONMENT_CODES,
  PROJECT_ROLES,
  PROJECT_ROLE_BY_CODE,
  CENTRAL_STREAM,
  DEFAULT_RULES,
  CHECK_STATES,
  CSV_COLUMNS,
  normalizeRules,
  sanitizeToken,
  normalizeStream,
  normalizeProjectRole,
  normalizeEnvironments,
  groupName,
  isAdminRole,
  fabricRoleFor,
  groupsForAssignment,
  assignmentKey,
  buildMapping,
  personJustification,
  groupJustification,
  parseCsvGrid,
  parseMappingCsv,
  toMappingCsv,
  compareAssignment,
  summarizeChecks,
};
