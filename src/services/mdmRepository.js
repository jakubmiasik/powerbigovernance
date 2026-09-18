// Persistence for master data management: models and their version history, runs,
// the golden records each run produced, the crosswalk back to source records, and
// the pairs a steward still has to decide.
//
// Reuses the SQL primitives from databaseService so connection handling, token
// refresh and schema-drift tolerance stay in one place.

const { _sql } = require('./databaseService');

const { TYPES } = _sql;

// Looked up per call rather than destructured once, so tests can substitute the
// primitives — and so the one-request-at-a-time discipline can be asserted.
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
function dec(name, value) {
  const parsed = Number(value);
  return { name, type: TYPES.Decimal, value: Number.isFinite(parsed) ? parsed : null, precision: 5, scale: 3 };
}
function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// ── Models ──
function mapModel(row) {
  if (!row) return null;
  return { ...row, config: parseJson(row.config, {}) };
}

async function listModels() {
  return withConnection(async conn => {
    const rows = await execSql(conn,
      "SELECT * FROM mdm_models ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, name");
    return rows.map(mapModel);
  });
}

async function getModelById(id) {
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT * FROM mdm_models WHERE id=@id', [int('id', id)]);
    return mapModel(rows[0]);
  });
}

function modelParams(model) {
  return [
    str('name', model.name), str('description', model.description), str('entity', model.entityType),
    int('sourceId', model.sourceId), str('sourceDataset', model.sourceDataset),
    int('destinationId', model.destinationId), str('destinationTable', model.destinationTable),
    str('crosswalkTable', model.crosswalkTable), str('writeMode', model.writeMode || 'replace'),
    str('config', JSON.stringify(model.config || {})), int('rowLimit', model.rowLimit),
  ];
}

// Every write records a snapshot: which definition of the model produced a given
// set of golden records is exactly the question asked when someone disputes one.
async function recordModelVersion(conn, modelId, version, actor, note) {
  const rows = await execSql(conn, 'SELECT * FROM mdm_models WHERE id=@id', [int('id', modelId)]);
  if (!rows.length) return;
  await execSql(conn, `INSERT INTO mdm_model_versions (model_id, version, snapshot, change_note, changed_by)
    VALUES (@id, @version, @snapshot, @note, @by)`, [
    int('id', modelId), int('version', version),
    str('snapshot', JSON.stringify(rows[0])), str('note', note), str('by', actor),
  ]);
}

async function createModel(model, actor) {
  return withConnection(async conn => {
    const rows = await execSql(conn, `INSERT INTO mdm_models
      (name, description, entity_type, status, version, source_id, source_dataset,
       destination_id, destination_table, crosswalk_table, write_mode, config, row_limit, created_by, updated_by)
      OUTPUT INSERTED.id
      VALUES (@name, @description, @entity, 'draft', 1, @sourceId, @sourceDataset,
       @destinationId, @destinationTable, @crosswalkTable, @writeMode, @config, @rowLimit, @by, @by)`,
    [...modelParams(model), str('by', actor)]);
    const id = rows[0] ? rows[0].id : null;
    if (id) await recordModelVersion(conn, id, 1, actor, 'Model created');
    return id;
  });
}

async function updateModel(id, model, actor, note) {
  return withConnection(async conn => {
    const current = await execSql(conn, 'SELECT version FROM mdm_models WHERE id=@id', [int('id', id)]);
    const nextVersion = (current[0] ? Number(current[0].version) : 0) + 1;
    await execSql(conn, `UPDATE mdm_models SET name=@name, description=@description, entity_type=@entity,
      source_id=@sourceId, source_dataset=@sourceDataset, destination_id=@destinationId,
      destination_table=@destinationTable, crosswalk_table=@crosswalkTable, write_mode=@writeMode,
      config=@config, row_limit=@rowLimit, version=@version, updated_at=SYSUTCDATETIME(), updated_by=@by
      WHERE id=@id`,
    [...modelParams(model), int('id', id), int('version', nextVersion), str('by', actor)]);
    await recordModelVersion(conn, id, nextVersion, actor, note || 'Model updated');
    return nextVersion;
  });
}

async function setModelStatus(id, status, actor) {
  return withConnection(async conn => {
    await execSql(conn, 'UPDATE mdm_models SET status=@status, updated_at=SYSUTCDATETIME(), updated_by=@by WHERE id=@id', [
      int('id', id), str('status', status), str('by', actor),
    ]);
    const current = await execSql(conn, 'SELECT version FROM mdm_models WHERE id=@id', [int('id', id)]);
    await recordModelVersion(conn, id, current[0] ? Number(current[0].version) : 1, actor, 'Status changed to ' + status);
  });
}

async function deleteModel(id) {
  return withConnection(conn => execSql(conn, 'DELETE FROM mdm_models WHERE id=@id', [int('id', id)]));
}

async function getModelVersions(modelId) {
  return withConnection(conn => execSql(conn,
    'SELECT id, version, change_note, changed_at, changed_by FROM mdm_model_versions WHERE model_id=@id ORDER BY version DESC',
    [int('id', modelId)]));
}

// ── Runs ──
async function createRun({ modelId, modelVersion, modelName, mode, runBy }) {
  return withConnection(async conn => {
    const rows = await execSql(conn, `INSERT INTO mdm_runs (model_id, model_version, model_name, status, mode, run_by)
      OUTPUT INSERTED.id VALUES (@model, @version, @name, 'running', @mode, @by)`, [
      int('model', modelId), int('version', modelVersion), str('name', modelName),
      str('mode', mode || 'preview'), str('by', runBy),
    ]);
    return rows[0] ? rows[0].id : null;
  });
}

async function completeRun(runId, { status, stats, writtenRows, error }) {
  return withConnection(conn => execSql(conn, `UPDATE mdm_runs SET status=@status,
    raw_records=@raw, golden_records=@golden, merged_clusters=@merged, duplicates_removed=@dupes,
    review_pairs=@review, pairs_compared=@pairs, stats_json=@stats, written_rows=@written,
    error_message=@error, completed_at=SYSUTCDATETIME() WHERE id=@id`, [
    int('id', runId), str('status', status),
    int('raw', stats ? stats.rawRecords : null), int('golden', stats ? stats.goldenRecords : null),
    int('merged', stats ? stats.mergedClusters : null), int('dupes', stats ? stats.duplicatesRemoved : null),
    int('review', stats ? stats.reviewPairs : null), int('pairs', stats ? stats.pairsCompared : null),
    str('stats', stats ? JSON.stringify(stats) : null), int('written', writtenRows),
    str('error', error || null),
  ]));
}

async function listRuns({ modelId, limit = 100 } = {}) {
  return withConnection(conn => execSql(conn,
    'SELECT TOP (' + Math.max(1, Math.min(1000, Number(limit) || 100)) + ') * FROM mdm_runs'
    + (modelId ? ' WHERE model_id=@model' : '') + ' ORDER BY started_at DESC',
    modelId ? [int('model', modelId)] : []));
}

async function getRunById(id) {
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT * FROM mdm_runs WHERE id=@id', [int('id', id)]);
    if (!rows[0]) return null;
    return { ...rows[0], stats: parseJson(rows[0].stats_json, null) };
  });
}

/**
 * Stores what a run produced. Written row by row on one connection rather than in
 * one large statement: a golden set is thousands of rows, not millions, and keeping
 * each write small means a failure loses one row rather than the batch.
 */
async function saveRunResults(runId, modelId, { golden, crosswalk, review }) {
  return withConnection(async conn => {
    for (const record of golden || []) {
      await execSql(conn, `INSERT INTO mdm_golden_records
        (run_id, model_id, golden_id, member_count, conflicts, needs_steward, source_systems, values_json, provenance_json)
        VALUES (@run, @model, @golden, @members, @conflicts, @steward, @systems, @values, @provenance)`, [
        int('run', runId), int('model', modelId), str('golden', record.goldenId),
        int('members', record.memberCount), int('conflicts', record.conflicts),
        int('steward', record.needsSteward ? 1 : 0),
        str('systems', (record.sourceSystems || []).join(', ')),
        str('values', JSON.stringify(record.values)), str('provenance', JSON.stringify(record.provenance)),
      ]);
    }
    for (const entry of crosswalk || []) {
      await execSql(conn, `INSERT INTO mdm_crosswalk (run_id, model_id, golden_id, source_record_id, source_system)
        VALUES (@run, @model, @golden, @source, @system)`, [
        int('run', runId), int('model', modelId), str('golden', entry.goldenId),
        str('source', entry.sourceId === null || entry.sourceId === undefined ? null : String(entry.sourceId)),
        str('system', entry.sourceSystem || null),
      ]);
    }
    for (const pair of review || []) {
      await execSql(conn, `INSERT INTO mdm_review_pairs
        (run_id, model_id, left_record_id, right_record_id, left_system, right_system, score, detail_json)
        VALUES (@run, @model, @left, @right, @leftSystem, @rightSystem, @score, @detail)`, [
        int('run', runId), int('model', modelId),
        str('left', pair.leftId === null || pair.leftId === undefined ? null : String(pair.leftId)),
        str('right', pair.rightId === null || pair.rightId === undefined ? null : String(pair.rightId)),
        str('leftSystem', pair.leftSystem || null), str('rightSystem', pair.rightSystem || null),
        dec('score', pair.score), str('detail', JSON.stringify(pair.contributions || [])),
      ]);
    }
  });
}

async function listGoldenRecords(runId, { limit = 500 } = {}) {
  return withConnection(async conn => {
    const rows = await execSql(conn,
      'SELECT TOP (' + Math.max(1, Math.min(5000, Number(limit) || 500)) + ') * FROM mdm_golden_records'
      + ' WHERE run_id=@run ORDER BY member_count DESC, id',
      [int('run', runId)]);
    return rows.map(row => ({
      ...row,
      values: parseJson(row.values_json, {}),
      provenance: parseJson(row.provenance_json, {}),
    }));
  });
}

async function listCrosswalk(runId, goldenId) {
  return withConnection(conn => execSql(conn,
    'SELECT * FROM mdm_crosswalk WHERE run_id=@run' + (goldenId ? ' AND golden_id=@golden' : '') + ' ORDER BY golden_id',
    goldenId ? [int('run', runId), str('golden', goldenId)] : [int('run', runId)]));
}

async function listReviewPairs(runId, { decision = 'pending', limit = 300 } = {}) {
  return withConnection(async conn => {
    const params = [int('run', runId)];
    let where = 'run_id=@run';
    if (decision && decision !== 'all') { where += ' AND decision=@decision'; params.push(str('decision', decision)); }
    const rows = await execSql(conn,
      'SELECT TOP (' + Math.max(1, Math.min(2000, Number(limit) || 300)) + ') * FROM mdm_review_pairs'
      + ' WHERE ' + where + ' ORDER BY score DESC, id', params);
    return rows.map(row => ({ ...row, detail: parseJson(row.detail_json, []) }));
  });
}

/**
 * Records a steward's decision on candidate pairs. Applied one at a time so a
 * failure on one does not discard the rest, and each decision names who made it —
 * these are the judgements that should tune the model's thresholds next time.
 */
async function decideReviewPairs(ids, decision, actor, note) {
  return withConnection(async conn => {
    const results = [];
    for (const id of ids) {
      try {
        await execSql(conn, `UPDATE mdm_review_pairs SET decision=@decision, decided_by=@by,
          decided_at=SYSUTCDATETIME(), note=@note WHERE id=@id`, [
          int('id', id), str('decision', decision), str('by', actor), str('note', note || null),
        ]);
        results.push({ id, success: true });
      } catch (err) {
        results.push({ id, success: false, message: err.message });
      }
    }
    return results;
  });
}

/** Headline numbers for the master data landing page. */
async function getOverview() {
  return withConnection(async conn => {
    const problems = [];
    const safe = async (label, sql, params = []) => {
      try {
        return await execSql(conn, sql, params);
      } catch (err) {
        console.warn('[MDM] Overview query "' + label + '" failed:', err.message);
        problems.push(label);
        return [];
      }
    };

    // Sequential: a tedious connection carries one request at a time.
    const models = await safe('models by status', 'SELECT status, COUNT(*) AS total FROM mdm_models GROUP BY status');
    const recentRuns = await safe('recent runs', 'SELECT TOP 10 * FROM mdm_runs ORDER BY started_at DESC');
    const pendingReview = await safe('pending review', `SELECT COUNT(*) AS total FROM mdm_review_pairs WHERE decision='pending'`);
    const latest = await safe('latest completed run per model', `
      SELECT r.model_id, MAX(r.model_name) AS model_name, MAX(r.id) AS run_id,
             MAX(r.raw_records) AS raw_records, MAX(r.golden_records) AS golden_records,
             MAX(r.duplicates_removed) AS duplicates_removed
      FROM mdm_runs r WHERE r.status='completed' GROUP BY r.model_id`);

    return {
      models,
      recentRuns,
      pendingReview: pendingReview[0] ? Number(pendingReview[0].total) : 0,
      latest,
      problems,
    };
  });
}

module.exports = {
  listModels, getModelById, createModel, updateModel, setModelStatus, deleteModel, getModelVersions,
  createRun, completeRun, listRuns, getRunById, saveRunResults,
  listGoldenRecords, listCrosswalk, listReviewPairs, decideReviewPairs,
  getOverview,
};
