/**
 * Reading and writing the relational view of an analysis run.
 *
 * The scan's JSON document remains the record of what happened. These tables are
 * the query path: one workspace's items, one workspace's access, every warehouse in
 * a run — questions that previously meant parsing the whole tenant.
 *
 * The shaping functions are pure and exported separately, so the mapping from the
 * scan's nested result to normalised rows is testable without a database.
 */

const { _sql } = require('./databaseService');

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
function big(name, value) {
  const parsed = Number(value);
  return { name, type: TYPES.BigInt, value: Number.isFinite(parsed) ? parsed : null };
}
function bit(name, value) {
  return { name, type: TYPES.Bit, value: value === null || value === undefined ? null : (value ? 1 : 0) };
}
function when(name, value) {
  if (!value) return { name, type: TYPES.DateTime2, value: null };
  const parsed = new Date(value);
  return { name, type: TYPES.DateTime2, value: Number.isNaN(parsed.getTime()) ? null : parsed };
}

// ── Shaping ──

/**
 * Flattens one run's parsed result into rows.
 *
 * `usersReadable` matters and is easy to lose: a workspace whose access list the
 * scan could not read is not a workspace with no users, and storing zero rows for
 * both would make the two indistinguishable.
 */
function shapeRun(runId, results) {
  const workspaces = [];
  const items = [];
  const users = [];

  for (const workspace of (results && results.workspaces) || []) {
    const workspaceUsers = Array.isArray(workspace.users) ? workspace.users : [];
    const workspaceItems = Array.isArray(workspace.items) ? workspace.items : [];

    workspaces.push({
      runId,
      workspaceId: workspace.id,
      name: workspace.name,
      type: workspace.type,
      state: workspace.state,
      capacityId: workspace.capacityId,
      capacityName: workspace.capacityName,
      capacitySku: workspace.capacitySku,
      isOnDedicatedCapacity: workspace.isOnDedicatedCapacity,
      pipelineName: workspace.pipelineName,
      pipelineStage: workspace.pipelineStage,
      storageSize: workspace.storageSize,
      storageFiles: workspace.storageFiles,
      itemCount: workspaceItems.length,
      userCount: workspaceUsers.length,
      usersReadable: workspace.usersReadable === false ? false : true,
      description: workspace.description,
    });

    for (const item of workspaceItems) {
      items.push({
        runId,
        workspaceId: workspace.id,
        itemId: item.id,
        name: item.name,
        type: item.type,
        description: item.description,
        storageSize: item.storageSize,
        modifiedAt: item.lastUpdate || item.modifiedDateTime || null,
        modifiedBy: item.modifiedBy || null,
      });
    }

    for (const user of workspaceUsers) {
      users.push({
        runId,
        workspaceId: workspace.id,
        principalId: user.identifier || user.graphId || null,
        principalType: user.principalType || null,
        displayName: user.displayName || null,
        email: user.emailAddress || user.userPrincipalName || null,
        accessRight: user.groupUserAccessRight || user.accessRight || null,
      });
    }
  }

  return { workspaces, items, users };
}

// ── Writing ──

/**
 * Replaces a run's relational rows.
 *
 * Deleting first makes this idempotent: re-running it after a scan updated its
 * storage figures, or backfilling a run twice, converges rather than duplicating.
 * Rows are written one at a time on a single connection — a scan is thousands of
 * rows, not millions, and a failure then costs one row rather than the batch.
 */
async function saveRunModel(runId, results) {
  const shaped = shapeRun(runId, results);
  await withConnection(async conn => {
    for (const table of ['analysis_workspace_users', 'analysis_items', 'analysis_workspaces']) {
      await execSql(conn, 'DELETE FROM ' + table + ' WHERE run_id=@run', [int('run', runId)]);
    }

    for (const workspace of shaped.workspaces) {
      await execSql(conn, `INSERT INTO analysis_workspaces
        (run_id, workspace_id, name, type, state, capacity_id, capacity_name, capacity_sku,
         is_on_dedicated_capacity, pipeline_name, pipeline_stage, storage_size, storage_files,
         item_count, user_count, users_readable, description)
        VALUES (@run, @ws, @name, @type, @state, @capId, @capName, @capSku,
         @dedicated, @pipeline, @stage, @size, @files, @items, @users, @readable, @description)`, [
        int('run', runId), str('ws', workspace.workspaceId), str('name', workspace.name),
        str('type', workspace.type), str('state', workspace.state),
        str('capId', workspace.capacityId), str('capName', workspace.capacityName), str('capSku', workspace.capacitySku),
        bit('dedicated', workspace.isOnDedicatedCapacity),
        str('pipeline', workspace.pipelineName), str('stage', workspace.pipelineStage),
        big('size', workspace.storageSize), big('files', workspace.storageFiles),
        int('items', workspace.itemCount), int('users', workspace.userCount),
        bit('readable', workspace.usersReadable), str('description', workspace.description),
      ]);
    }

    for (const item of shaped.items) {
      await execSql(conn, `INSERT INTO analysis_items
        (run_id, workspace_id, item_id, name, type, description, storage_size, modified_at, modified_by)
        VALUES (@run, @ws, @item, @name, @type, @description, @size, @modified, @by)`, [
        int('run', runId), str('ws', item.workspaceId), str('item', item.itemId),
        str('name', item.name), str('type', item.type), str('description', item.description),
        big('size', item.storageSize), when('modified', item.modifiedAt), str('by', item.modifiedBy),
      ]);
    }

    for (const user of shaped.users) {
      await execSql(conn, `INSERT INTO analysis_workspace_users
        (run_id, workspace_id, principal_id, principal_type, display_name, email, access_right)
        VALUES (@run, @ws, @principal, @ptype, @display, @email, @access)`, [
        int('run', runId), str('ws', user.workspaceId), str('principal', user.principalId),
        str('ptype', user.principalType), str('display', user.displayName),
        str('email', user.email), str('access', user.accessRight),
      ]);
    }

    await execSql(conn, 'DELETE FROM analysis_run_model_state WHERE run_id=@run', [int('run', runId)]);
    await execSql(conn, `INSERT INTO analysis_run_model_state (run_id, workspaces, items, users)
      VALUES (@run, @workspaces, @items, @users)`, [
      int('run', runId), int('workspaces', shaped.workspaces.length),
      int('items', shaped.items.length), int('users', shaped.users.length),
    ]);
  });

  return { workspaces: shaped.workspaces.length, items: shaped.items.length, users: shaped.users.length };
}

// ── Reading ──

/**
 * Whether a run has been normalised.
 *
 * Distinguishes "this run genuinely found nothing" from "this run predates the
 * tables", which a plain row count cannot. A reader that got those two confused
 * would show an empty tenant instead of falling back to the JSON.
 */
async function getRunModelState(runId) {
  return withConnection(async conn => {
    try {
      const rows = await execSql(conn, 'SELECT * FROM analysis_run_model_state WHERE run_id=@run', [int('run', runId)]);
      return rows[0] || null;
    } catch (err) {
      if ((err.message || '').includes('Invalid object name')) return null;
      throw err;
    }
  });
}

async function listRunWorkspaces(runId) {
  return withConnection(conn => execSql(conn,
    'SELECT * FROM analysis_workspaces WHERE run_id=@run ORDER BY name', [int('run', runId)]));
}

async function getRunWorkspace(runId, workspaceId) {
  return withConnection(async conn => {
    const rows = await execSql(conn,
      'SELECT * FROM analysis_workspaces WHERE run_id=@run AND workspace_id=@ws',
      [int('run', runId), str('ws', workspaceId)]);
    return rows[0] || null;
  });
}

async function listWorkspaceItems(runId, workspaceId) {
  return withConnection(conn => execSql(conn,
    'SELECT * FROM analysis_items WHERE run_id=@run AND workspace_id=@ws ORDER BY type, name',
    [int('run', runId), str('ws', workspaceId)]));
}

async function listWorkspaceUsers(runId, workspaceId) {
  return withConnection(conn => execSql(conn,
    'SELECT * FROM analysis_workspace_users WHERE run_id=@run AND workspace_id=@ws ORDER BY access_right, display_name',
    [int('run', runId), str('ws', workspaceId)]));
}

/**
 * Every item of the given types in a run, with its workspace name.
 *
 * This is the query the JSON path could not do at all: finding the lakehouses and
 * warehouses in a tenant meant walking every workspace and every item in memory.
 */
async function listRunItemsByType(runId, types) {
  const wanted = (types || []).map(type => String(type).toLowerCase()).filter(Boolean);
  if (!wanted.length) return [];
  return withConnection(async conn => {
    const params = [int('run', runId), ...wanted.map((type, index) => str('t' + index, type))];
    const placeholders = wanted.map((_, index) => '@t' + index).join(', ');
    return execSql(conn, `
      SELECT i.workspace_id, i.item_id, i.name AS item_name, i.type AS item_type, w.name AS workspace_name
      FROM analysis_items i
      LEFT JOIN analysis_workspaces w ON w.run_id = i.run_id AND w.workspace_id = i.workspace_id
      WHERE i.run_id=@run AND LOWER(i.type) IN (${placeholders})
      ORDER BY w.name, i.name`, params);
  });
}

async function deleteRunModel(runId) {
  return withConnection(async conn => {
    for (const table of ['analysis_workspace_users', 'analysis_items', 'analysis_workspaces', 'analysis_run_model_state']) {
      try {
        await execSql(conn, 'DELETE FROM ' + table + ' WHERE run_id=@run', [int('run', runId)]);
      } catch (err) {
        if (!(err.message || '').includes('Invalid object name')) throw err;
      }
    }
  });
}

module.exports = {
  shapeRun,
  saveRunModel,
  getRunModelState,
  listRunWorkspaces,
  getRunWorkspace,
  listWorkspaceItems,
  listWorkspaceUsers,
  listRunItemsByType,
  deleteRunModel,
};
