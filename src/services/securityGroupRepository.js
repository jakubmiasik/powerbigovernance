/**
 * Reading and writing the security group mapping.
 *
 * Lookup rows — streams, project roles, environments — are created on demand and
 * reused, which is what keeps the assignment table free of repeated text and makes
 * "every assignment in this stream" a key comparison rather than a string one.
 *
 * Group membership is never written. It is a join from the assignments, because a
 * person's groups follow from their stream, role and environments; a stored copy
 * would go stale the moment either changed.
 */

const { _sql } = require('./databaseService');
const mapping = require('./securityGroupMappingService');

const { TYPES } = _sql;
const getConnection = (...args) => _sql.getConnection(...args);
const execSql = (...args) => _sql.execSql(...args);

async function withConnection(fn) {
  const conn = await getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

function str(name, value) {
  return { name, type: TYPES.NVarChar, value: value === null || value === undefined ? null : String(value) };
}
function int(name, value) {
  const parsed = Number.parseInt(value, 10);
  return { name, type: TYPES.Int, value: Number.isFinite(parsed) ? parsed : null };
}

/**
 * The id of a lookup row, creating it if this is the first time it is seen.
 *
 * A tenant invents streams as it goes, so the alternative — a fixed list somebody
 * maintains by hand — means an import fails on a stream nobody thought of.
 */
async function lookupId(conn, table, code, extra) {
  const normalized = mapping.sanitizeToken(code, '');
  if (!normalized) return null;

  const existing = await execSql(conn, `SELECT id FROM ${table} WHERE code = @code`, [str('code', normalized)]);
  if (existing.length) return existing[0].id;

  const columns = ['code'];
  const values = ['@code'];
  const params = [str('code', normalized)];
  for (const [column, value] of Object.entries(extra || {})) {
    columns.push(column);
    values.push('@' + column);
    params.push(typeof value === 'number' ? int(column, value) : str(column, value));
  }

  const inserted = await execSql(conn,
    `INSERT INTO ${table} (${columns.join(', ')}) OUTPUT INSERTED.id VALUES (${values.join(', ')})`, params);
  return inserted.length ? inserted[0].id : null;
}

async function personId(conn, name, email) {
  const displayName = String(name || '').trim();
  // Stored as a blank rather than NULL: a unique index over a nullable column would
  // let the same person in twice.
  const mail = String(email || '').trim().toLowerCase();
  if (!displayName) return null;

  const existing = await execSql(conn,
    'SELECT id FROM sg_people WHERE display_name = @name AND email = @email',
    [str('name', displayName), str('email', mail)]);
  if (existing.length) return existing[0].id;

  const inserted = await execSql(conn,
    'INSERT INTO sg_people (display_name, email) OUTPUT INSERTED.id VALUES (@name, @email)',
    [str('name', displayName), str('email', mail)]);
  return inserted.length ? inserted[0].id : null;
}

/**
 * Adds or updates one assignment, and the group rows the environments imply.
 *
 * The groups are created here rather than lazily at read time so that a workspace
 * can be attached to one before anybody has been assigned to it — planning access
 * before the people arrive is the normal order, not the exception.
 */
async function saveAssignment(input, actor) {
  const stream = mapping.normalizeStream(input.stream);
  const projectRole = mapping.normalizeProjectRole(input.projectRole);
  const environments = mapping.normalizeEnvironments(input.environments);
  const name = String(input.name || '').trim();

  if (!stream) throw new Error('A stream is required.');
  if (!name) throw new Error('A name is required.');

  return withConnection(async conn => {
    const roleDef = mapping.PROJECT_ROLE_BY_CODE.get(projectRole) || { label: projectRole, isAdmin: false, sortOrder: 99 };
    const streamId = await lookupId(conn, 'sg_streams', stream, {});
    const roleId = await lookupId(conn, 'sg_project_roles', projectRole, {
      label: roleDef.label, is_admin: roleDef.isAdmin ? 1 : 0, sort_order: roleDef.sortOrder,
    });
    const person = await personId(conn, name, input.email);

    const existing = await execSql(conn,
      'SELECT id FROM sg_assignments WHERE person_id=@person AND stream_id=@stream AND project_role_id=@role',
      [int('person', person), int('stream', streamId), int('role', roleId)]);

    let assignmentId;
    let created = false;
    if (existing.length) {
      assignmentId = existing[0].id;
      await execSql(conn,
        'UPDATE sg_assignments SET note=@note, updated_at=SYSUTCDATETIME(), updated_by=@actor WHERE id=@id',
        [str('note', input.note || null), str('actor', actor || null), int('id', assignmentId)]);
    } else {
      const inserted = await execSql(conn,
        `INSERT INTO sg_assignments (person_id, stream_id, project_role_id, note, created_by)
         OUTPUT INSERTED.id VALUES (@person, @stream, @role, @note, @actor)`,
        [int('person', person), int('stream', streamId), int('role', roleId),
          str('note', input.note || null), str('actor', actor || null)]);
      assignmentId = inserted.length ? inserted[0].id : null;
      created = true;
    }

    // Replaced rather than merged: the form sends the complete set of environments,
    // and merging would make unticking a box do nothing.
    await execSql(conn, 'DELETE FROM sg_assignment_environments WHERE assignment_id=@id', [int('id', assignmentId)]);
    for (const environment of environments) {
      const environmentId = await ensureEnvironment(conn, environment);
      await execSql(conn,
        'INSERT INTO sg_assignment_environments (assignment_id, environment_id) VALUES (@a, @e)',
        [int('a', assignmentId), int('e', environmentId)]);
      await ensureGroup(conn, streamId, roleId, environmentId);
    }

    return { id: assignmentId, created };
  });
}

async function ensureEnvironment(conn, code) {
  const known = mapping.ENVIRONMENTS.find(environment => environment.code === code);
  return lookupId(conn, 'sg_environments', code, {
    label: known ? known.label : code,
    sort_order: known ? known.sortOrder : 99,
  });
}

async function ensureGroup(conn, streamId, roleId, environmentId) {
  const existing = await execSql(conn,
    'SELECT id FROM sg_groups WHERE stream_id=@s AND project_role_id=@r AND environment_id=@e',
    [int('s', streamId), int('r', roleId), int('e', environmentId)]);
  if (existing.length) return existing[0].id;

  const inserted = await execSql(conn,
    `INSERT INTO sg_groups (stream_id, project_role_id, environment_id)
     OUTPUT INSERTED.id VALUES (@s, @r, @e)`,
    [int('s', streamId), int('r', roleId), int('e', environmentId)]);
  return inserted.length ? inserted[0].id : null;
}

/** Every assignment, with the person and the environments it covers. */
async function listAssignments() {
  return withConnection(async conn => {
    const rows = await execSql(conn, `
      SELECT a.id, a.note, a.created_at, a.updated_at,
             p.id AS person_id, p.display_name, p.email, p.entra_object_id,
             s.code AS stream, r.code AS project_role
      FROM sg_assignments a
      JOIN sg_people p ON p.id = a.person_id
      JOIN sg_streams s ON s.id = a.stream_id
      JOIN sg_project_roles r ON r.id = a.project_role_id
      ORDER BY s.code, r.sort_order, p.display_name`);

    const environments = await execSql(conn, `
      SELECT ae.assignment_id, e.code, e.sort_order
      FROM sg_assignment_environments ae
      JOIN sg_environments e ON e.id = ae.environment_id
      ORDER BY e.sort_order`);

    const byAssignment = new Map();
    for (const row of environments) {
      if (!byAssignment.has(row.assignment_id)) byAssignment.set(row.assignment_id, []);
      byAssignment.get(row.assignment_id).push(row.code);
    }

    return rows.map(row => ({
      id: row.id,
      personId: row.person_id,
      name: row.display_name,
      email: row.email || null,
      entraObjectId: row.entra_object_id || null,
      stream: row.stream,
      projectRole: row.project_role,
      environments: byAssignment.get(row.id) || [],
      note: row.note || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });
}

/**
 * Removes an assignment, and the person with it when nothing else refers to them.
 *
 * Leaving orphaned people behind would make the directory of names grow with every
 * correction, and "who is in the mapping" would stop being answerable from it.
 */
async function deleteAssignment(id) {
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT person_id FROM sg_assignments WHERE id=@id', [int('id', id)]);
    if (!rows.length) return { deleted: 0 };

    await execSql(conn, 'DELETE FROM sg_assignment_environments WHERE assignment_id=@id', [int('id', id)]);
    await execSql(conn, 'DELETE FROM sg_assignments WHERE id=@id', [int('id', id)]);

    const person = rows[0].person_id;
    const remaining = await execSql(conn,
      'SELECT COUNT(*) AS total FROM sg_assignments WHERE person_id=@person', [int('person', person)]);
    if (remaining.length && Number(remaining[0].total) === 0) {
      await execSql(conn, 'DELETE FROM sg_people WHERE id=@person', [int('person', person)]);
    }
    return { deleted: 1 };
  });
}

/** Every group, with its directory link and the workspaces attached to it. */
async function listGroups() {
  return withConnection(async conn => {
    const groups = await execSql(conn, `
      SELECT g.id, g.entra_group_id, g.entra_group_name, g.entra_group_type, g.linked_at, g.linked_by,
             s.code AS stream, r.code AS project_role, e.code AS environment, e.sort_order
      FROM sg_groups g
      JOIN sg_streams s ON s.id = g.stream_id
      JOIN sg_project_roles r ON r.id = g.project_role_id
      JOIN sg_environments e ON e.id = g.environment_id
      ORDER BY s.code, r.sort_order, e.sort_order`);

    const attachments = await execSql(conn, `
      SELECT gw.id, gw.group_id, gw.workspace_id, gw.workspace_name, gw.intended_role,
             gw.attached_at, gw.attached_by,
             c.state, c.actual_role, c.message, c.checked_at
      FROM sg_group_workspaces gw
      OUTER APPLY (
        SELECT TOP 1 state, actual_role, message, checked_at
        FROM sg_group_workspace_checks
        WHERE group_workspace_id = gw.id
        ORDER BY checked_at DESC, id DESC
      ) c
      ORDER BY gw.workspace_name`);

    const byGroup = new Map();
    for (const row of attachments) {
      if (!byGroup.has(row.group_id)) byGroup.set(row.group_id, []);
      byGroup.get(row.group_id).push({
        id: row.id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        intendedRole: row.intended_role,
        attachedAt: row.attached_at,
        attachedBy: row.attached_by || null,
        // The last answer, not every answer. The history is kept, but a page
        // showing five checks per row would bury the current state.
        lastCheck: row.state ? {
          state: row.state, actualRole: row.actual_role || null,
          message: row.message || null, checkedAt: row.checked_at,
        } : null,
      });
    }

    return groups.map(row => ({
      id: row.id,
      stream: row.stream,
      projectRole: row.project_role,
      environment: row.environment,
      entraGroupId: row.entra_group_id || null,
      entraGroupName: row.entra_group_name || null,
      entraGroupType: row.entra_group_type || null,
      linkedAt: row.linked_at,
      linkedBy: row.linked_by || null,
      workspaces: byGroup.get(row.id) || [],
    }));
  });
}

/** Points a group at the directory group that actually exists. */
async function linkEntraGroup(groupId, entra, actor) {
  return withConnection(conn => execSql(conn, `
    UPDATE sg_groups
    SET entra_group_id=@id, entra_group_name=@name, entra_group_type=@type,
        linked_at=SYSUTCDATETIME(), linked_by=@actor
    WHERE id=@group`, [
    str('id', entra && entra.id ? entra.id : null),
    str('name', entra && entra.displayName ? entra.displayName : null),
    str('type', entra && entra.type ? entra.type : null),
    str('actor', actor || null),
    int('group', groupId),
  ]));
}

async function unlinkEntraGroup(groupId) {
  return withConnection(conn => execSql(conn, `
    UPDATE sg_groups
    SET entra_group_id=NULL, entra_group_name=NULL, entra_group_type=NULL, linked_at=NULL, linked_by=NULL
    WHERE id=@group`, [int('group', groupId)]));
}

/** Attaches a group to a workspace with the role it should hold there. */
async function attachWorkspace(groupId, workspace, actor) {
  const workspaceId = String((workspace && (workspace.id || workspace.workspaceId)) || '').trim();
  if (!workspaceId) throw new Error('A workspace is required.');

  return withConnection(async conn => {
    const existing = await execSql(conn,
      'SELECT id FROM sg_group_workspaces WHERE group_id=@g AND workspace_id=@w',
      [int('g', groupId), str('w', workspaceId)]);

    if (existing.length) {
      // Re-attaching is how the intended role is corrected, so it updates rather
      // than failing on the unique index.
      await execSql(conn,
        'UPDATE sg_group_workspaces SET intended_role=@role, workspace_name=@name WHERE id=@id',
        [str('role', workspace.intendedRole || 'Viewer'), str('name', workspace.name || null), int('id', existing[0].id)]);
      return { id: existing[0].id, created: false };
    }

    const inserted = await execSql(conn, `
      INSERT INTO sg_group_workspaces (group_id, workspace_id, workspace_name, intended_role, attached_by)
      OUTPUT INSERTED.id VALUES (@g, @w, @name, @role, @actor)`, [
      int('g', groupId), str('w', workspaceId), str('name', workspace.name || null),
      str('role', workspace.intendedRole || 'Viewer'), str('actor', actor || null),
    ]);
    return { id: inserted.length ? inserted[0].id : null, created: true };
  });
}

async function detachWorkspace(attachmentId) {
  return withConnection(async conn => {
    await execSql(conn, 'DELETE FROM sg_group_workspace_checks WHERE group_workspace_id=@id', [int('id', attachmentId)]);
    await execSql(conn, 'DELETE FROM sg_group_workspaces WHERE id=@id', [int('id', attachmentId)]);
  });
}

/** Records what a check found. Appended, so the drift is visible over time. */
async function recordChecks(results, actor) {
  if (!(results || []).length) return { recorded: 0 };
  return withConnection(async conn => {
    for (const result of results) {
      await execSql(conn, `
        INSERT INTO sg_group_workspace_checks (group_workspace_id, checked_by, state, actual_role, message)
        VALUES (@target, @actor, @state, @role, @message)`, [
        int('target', result.attachmentId), str('actor', actor || null), str('state', result.state),
        str('role', result.actualRole || null), str('message', result.message || null),
      ]);
    }
    return { recorded: results.length };
  });
}

/** Everything the page needs, in one call. */
async function loadMapping() {
  // Sequential: each of these opens its own connection, and running them together
  // doubles the connections a page load costs for no gain worth having.
  const assignments = await listAssignments();
  const groups = await listGroups();
  return { assignments, groups };
}

module.exports = {
  saveAssignment,
  listAssignments,
  deleteAssignment,
  listGroups,
  linkEntraGroup,
  unlinkEntraGroup,
  attachWorkspace,
  detachWorkspace,
  recordChecks,
  loadMapping,
  _private: { lookupId, personId, ensureGroup },
};
