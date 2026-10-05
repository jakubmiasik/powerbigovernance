// Persistence for application users and their tenant / section grants.
//
// Reuses the SQL primitives from databaseService so connection handling and token
// refresh stay in one place. Looked up per call rather than destructured once, so
// tests can substitute them.

const { _sql } = require('./databaseService');
const { normalizeEmail, ROLE_ADMIN, ROLE_USER } = require('./permissionService');

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
  return { name, type: TYPES.NVarChar, value: value === undefined ? null : value };
}
function int(name, value) {
  const parsed = Number.parseInt(value, 10);
  return { name, type: TYPES.Int, value: Number.isFinite(parsed) ? parsed : null };
}

const USER_COLUMNS = 'id, email, display_name, role, is_active, principal_type, entra_object_id, created_at, created_by, updated_at, updated_by';

const PRINCIPAL_USER = 'user';
const PRINCIPAL_GROUP = 'group';

function shapeUser(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    is_active: row.is_active === true || row.is_active === 1,
    principal_type: row.principal_type === PRINCIPAL_GROUP ? PRINCIPAL_GROUP : PRINCIPAL_USER,
    tenantIds: [],
    sectionKeys: [],
  };
}

/** Attaches tenant and section grants to already-loaded entries, in place. */
async function attachGrants(conn, entries) {
  if (!entries.length) return entries;
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  // Separate statements rather than one joined query: a tedious connection runs
  // one request at a time, and a three-way join would duplicate rows per grant,
  // which has to be undone again on the way out.
  for (const row of await execSql(conn, 'SELECT user_id, sp_id FROM app_user_tenants')) {
    const entry = byId.get(Number(row.user_id));
    if (entry) entry.tenantIds.push(Number(row.sp_id));
  }
  for (const row of await execSql(conn, 'SELECT user_id, section_key FROM app_user_sections')) {
    const entry = byId.get(Number(row.user_id));
    if (entry) entry.sectionKeys.push(row.section_key);
  }
  return entries;
}

/** Every configured user and security group with their grants, for the admin panel. */
async function listUsers() {
  return withConnection(async (conn) => {
    const users = (await execSql(conn, `SELECT ${USER_COLUMNS} FROM app_users ORDER BY role DESC, principal_type, email, display_name`))
      .map(shapeUser);
    return attachGrants(conn, users);
  });
}

/** One person's own entry, by sign-in email. Null when they are not configured. */
async function getUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  return withConnection(async (conn) => {
    const rows = await execSql(
      conn,
      `SELECT ${USER_COLUMNS} FROM app_users WHERE email = @email AND principal_type = @principalType`,
      [str('email', normalized), str('principalType', PRINCIPAL_USER)],
    );
    const user = shapeUser(rows[0]);
    if (!user) return null;

    for (const row of await execSql(conn, 'SELECT sp_id FROM app_user_tenants WHERE user_id = @userId', [int('userId', user.id)])) {
      user.tenantIds.push(Number(row.sp_id));
    }
    for (const row of await execSql(conn, 'SELECT section_key FROM app_user_sections WHERE user_id = @userId', [int('userId', user.id)])) {
      user.sectionKeys.push(row.section_key);
    }
    return user;
  });
}

/**
 * The granted security groups a person belongs to.
 *
 * Matched on the directory object id rather than the group's name or address: a
 * group can be renamed, and the grant must survive it.
 */
async function getGroupRecords(groupIds = []) {
  const wanted = [...new Set(groupIds.map(id => String(id || '').trim()).filter(Boolean))];
  if (!wanted.length) return [];

  return withConnection(async (conn) => {
    // Parameterised one placeholder per id — an id is directory data, not something
    // to concatenate into SQL.
    const placeholders = wanted.map((_, index) => '@g' + index).join(', ');
    const params = wanted.map((id, index) => str('g' + index, id));
    params.push(str('principalType', PRINCIPAL_GROUP));

    const groups = (await execSql(
      conn,
      `SELECT ${USER_COLUMNS} FROM app_users
        WHERE principal_type = @principalType AND entra_object_id IN (${placeholders})`,
      params,
    )).map(shapeUser);

    return attachGrants(conn, groups);
  });
}

/**
 * Whether any administrator exists. This is what ends bootstrap mode, so it asks
 * for active administrators specifically: a deactivated one cannot sign in to fix
 * anything, and treating it as present would be the lockout the bootstrap exists
 * to prevent.
 */
async function hasAnyAdmin() {
  return withConnection(async (conn) => {
    const rows = await execSql(
      conn,
      `SELECT TOP 1 id FROM app_users WHERE role = @role AND is_active = 1`,
      [str('role', ROLE_ADMIN)],
    );
    return rows.length > 0;
  });
}

/**
 * Whether any security group has been granted anything.
 *
 * Checked so the directory is only consulted when group grants actually exist: an
 * installation that names individuals never needs Graph read permission at all.
 */
async function hasAnyGroupGrant() {
  return withConnection(async (conn) => {
    const rows = await execSql(
      conn,
      'SELECT TOP 1 id FROM app_users WHERE principal_type = @principalType AND is_active = 1',
      [str('principalType', PRINCIPAL_GROUP)],
    );
    return rows.length > 0;
  });
}

/**
 * Creates or updates a user or security group entry and replaces its grants.
 *
 * Grants are replaced wholesale rather than merged: the admin panel submits the
 * complete intended state, and merging would make unticking a box do nothing.
 */
async function saveUser({
  id, email, displayName, role, isActive = true, tenantIds = [], sectionKeys = [], actor = null,
  principalType = PRINCIPAL_USER, entraObjectId = null,
}) {
  const kind = principalType === PRINCIPAL_GROUP ? PRINCIPAL_GROUP : PRINCIPAL_USER;
  const normalized = normalizeEmail(email);
  const objectId = String(entraObjectId || '').trim() || null;

  // Each kind is identified by the thing that actually finds it again: a person by
  // the address in their sign-in token, a group by its directory object.
  if (kind === PRINCIPAL_USER && !normalized) throw new Error('An email address is required.');
  if (kind === PRINCIPAL_GROUP && !objectId) throw new Error('A security group must be chosen from the directory.');

  const storedRole = role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER;
  const common = [
    str('email', kind === PRINCIPAL_GROUP ? (normalized || null) : normalized),
    str('displayName', displayName || null),
    str('role', storedRole),
    { name: 'isActive', type: TYPES.Bit, value: isActive ? 1 : 0 },
    str('principalType', kind),
    str('entraObjectId', objectId),
    str('actor', actor),
  ];

  return withConnection(async (conn) => {
    let userId = Number.parseInt(id, 10);

    if (!Number.isFinite(userId)) {
      // Saving a principal that already exists is an edit, not a duplicate. Without
      // this the unique index turns a re-grant into an error the admin cannot act on.
      const existing = kind === PRINCIPAL_GROUP
        ? await execSql(conn, 'SELECT id FROM app_users WHERE principal_type = @principalType AND entra_object_id = @entraObjectId',
          [str('principalType', kind), str('entraObjectId', objectId)])
        : await execSql(conn, 'SELECT id FROM app_users WHERE principal_type = @principalType AND email = @email',
          [str('principalType', kind), str('email', normalized)]);
      if (existing.length) userId = Number(existing[0].id);
    }

    if (Number.isFinite(userId)) {
      await execSql(
        conn,
        `UPDATE app_users SET email=@email, display_name=@displayName, role=@role, is_active=@isActive,
           principal_type=@principalType, entra_object_id=@entraObjectId,
           updated_at=SYSUTCDATETIME(), updated_by=@actor WHERE id=@id`,
        [int('id', userId), ...common],
      );
    } else {
      const inserted = await execSql(
        conn,
        `INSERT INTO app_users (email, display_name, role, is_active, principal_type, entra_object_id, created_by)
         OUTPUT INSERTED.id VALUES (@email, @displayName, @role, @isActive, @principalType, @entraObjectId, @actor)`,
        common,
      );
      userId = Number(inserted[0] && inserted[0].id);
    }

    if (!Number.isFinite(userId)) throw new Error('Could not determine the saved user.');

    await execSql(conn, 'DELETE FROM app_user_tenants WHERE user_id = @userId', [int('userId', userId)]);
    await execSql(conn, 'DELETE FROM app_user_sections WHERE user_id = @userId', [int('userId', userId)]);

    for (const spId of [...new Set(tenantIds.map(Number).filter(Number.isFinite))]) {
      await execSql(conn, 'INSERT INTO app_user_tenants (user_id, sp_id) VALUES (@userId, @spId)', [
        int('userId', userId), int('spId', spId),
      ]);
    }
    for (const key of [...new Set(sectionKeys.filter(Boolean))]) {
      await execSql(conn, 'INSERT INTO app_user_sections (user_id, section_key) VALUES (@userId, @sectionKey)', [
        int('userId', userId), str('sectionKey', key),
      ]);
    }

    return userId;
  });
}

async function deleteUser(id) {
  const userId = Number.parseInt(id, 10);
  if (!Number.isFinite(userId)) return;
  await withConnection(async (conn) => {
    await execSql(conn, 'DELETE FROM app_user_tenants WHERE user_id = @userId', [int('userId', userId)]);
    await execSql(conn, 'DELETE FROM app_user_sections WHERE user_id = @userId', [int('userId', userId)]);
    await execSql(conn, 'DELETE FROM app_users WHERE id = @userId', [int('userId', userId)]);
  });
}

module.exports = {
  listUsers, getUserByEmail, getGroupRecords, hasAnyAdmin, hasAnyGroupGrant, saveUser, deleteUser,
  PRINCIPAL_USER, PRINCIPAL_GROUP,
};
