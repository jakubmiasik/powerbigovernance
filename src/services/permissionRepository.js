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

const USER_COLUMNS = 'id, email, display_name, role, is_active, created_at, created_by, updated_at, updated_by';

function shapeUser(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    is_active: row.is_active === true || row.is_active === 1,
    tenantIds: [],
    sectionKeys: [],
  };
}

/** Every configured user with their grants attached, for the admin panel. */
async function listUsers() {
  return withConnection(async (conn) => {
    const users = (await execSql(conn, `SELECT ${USER_COLUMNS} FROM app_users ORDER BY role DESC, email`))
      .map(shapeUser);
    if (!users.length) return [];

    const byId = new Map(users.map(user => [user.id, user]));
    // Separate statements rather than one joined query: a tedious connection runs
    // one request at a time, and a three-way join would duplicate user rows per
    // grant, which has to be undone again on the way out.
    for (const row of await execSql(conn, 'SELECT user_id, sp_id FROM app_user_tenants')) {
      const user = byId.get(Number(row.user_id));
      if (user) user.tenantIds.push(Number(row.sp_id));
    }
    for (const row of await execSql(conn, 'SELECT user_id, section_key FROM app_user_sections')) {
      const user = byId.get(Number(row.user_id));
      if (user) user.sectionKeys.push(row.section_key);
    }
    return users;
  });
}

/** One user, by sign-in email, with their grants. Null when they are not configured. */
async function getUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  return withConnection(async (conn) => {
    const rows = await execSql(conn, `SELECT ${USER_COLUMNS} FROM app_users WHERE email = @email`, [
      str('email', normalized),
    ]);
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
 * Creates or updates a user and replaces their grants.
 *
 * Grants are replaced wholesale rather than merged: the admin panel submits the
 * complete intended state, and merging would make unticking a box do nothing.
 */
async function saveUser({ id, email, displayName, role, isActive = true, tenantIds = [], sectionKeys = [], actor = null }) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('An email address is required.');
  const storedRole = role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER;

  return withConnection(async (conn) => {
    let userId = Number.parseInt(id, 10);

    if (Number.isFinite(userId)) {
      await execSql(
        conn,
        `UPDATE app_users SET email=@email, display_name=@displayName, role=@role, is_active=@isActive,
           updated_at=SYSUTCDATETIME(), updated_by=@actor WHERE id=@id`,
        [int('id', userId), str('email', normalized), str('displayName', displayName || null),
          str('role', storedRole), { name: 'isActive', type: TYPES.Bit, value: isActive ? 1 : 0 }, str('actor', actor)],
      );
    } else {
      // Saving an email that already exists is an edit, not a duplicate. Without
      // this the unique index turns a re-grant into an error the admin cannot act on.
      const existing = await execSql(conn, 'SELECT id FROM app_users WHERE email = @email', [str('email', normalized)]);
      if (existing.length) {
        userId = Number(existing[0].id);
        await execSql(
          conn,
          `UPDATE app_users SET display_name=@displayName, role=@role, is_active=@isActive,
             updated_at=SYSUTCDATETIME(), updated_by=@actor WHERE id=@id`,
          [int('id', userId), str('displayName', displayName || null), str('role', storedRole),
            { name: 'isActive', type: TYPES.Bit, value: isActive ? 1 : 0 }, str('actor', actor)],
        );
      } else {
        const inserted = await execSql(
          conn,
          `INSERT INTO app_users (email, display_name, role, is_active, created_by)
           OUTPUT INSERTED.id VALUES (@email, @displayName, @role, @isActive, @actor)`,
          [str('email', normalized), str('displayName', displayName || null), str('role', storedRole),
            { name: 'isActive', type: TYPES.Bit, value: isActive ? 1 : 0 }, str('actor', actor)],
        );
        userId = Number(inserted[0] && inserted[0].id);
      }
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

module.exports = { listUsers, getUserByEmail, hasAnyAdmin, saveUser, deleteUser };
