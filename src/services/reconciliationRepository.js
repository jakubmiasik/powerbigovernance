// Persistence for the reconciliation engine: sources, rules and their version
// history, runs, exceptions and the decisions taken on them.
//
// Reuses the SQL primitives from databaseService so connection handling, token
// refresh and schema-drift tolerance stay in one place.

const { _sql } = require('./databaseService');
const { exceptionFingerprint, CLOSED_STATUSES, EXCEPTION_STATUS } = require('./reconciliationService');

const { getConnection, execSql, TYPES } = _sql;

async function withConnection(fn) {
  const conn = await getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

function str(name, value, length) {
  return { name, type: TYPES.NVarChar, value: value === undefined ? null : value, length };
}
function int(name, value) {
  const parsed = Number.parseInt(value, 10);
  return { name, type: TYPES.Int, value: Number.isFinite(parsed) ? parsed : null };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// ── Sources ──
async function listSources() {
  return withConnection(conn => execSql(conn, 'SELECT * FROM recon_sources ORDER BY name'));
}

async function getSourceById(id) {
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT * FROM recon_sources WHERE id=@id', [int('id', id)]);
    return rows[0] || null;
  });
}

async function saveSource(source) {
  return withConnection(async conn => {
    // Registering the same Fabric item twice should update it, not duplicate it.
    const existing = source.workspaceId && source.itemId
      ? await execSql(conn, 'SELECT id FROM recon_sources WHERE workspace_id=@ws AND item_id=@item', [
        str('ws', source.workspaceId), str('item', source.itemId),
      ])
      : [];

    if (existing.length) {
      await execSql(conn, `UPDATE recon_sources SET name=@name, system_label=@label, kind=@kind,
        workspace_name=@wsName, item_type=@itemType, connection_string=@conn, database_name=@db WHERE id=@id`, [
        int('id', existing[0].id), str('name', source.name), str('label', source.systemLabel), str('kind', source.kind),
        str('wsName', source.workspaceName), str('itemType', source.itemType),
        str('conn', source.connectionString), str('db', source.databaseName),
      ]);
      return existing[0].id;
    }

    const rows = await execSql(conn, `INSERT INTO recon_sources
      (name, system_label, kind, workspace_id, workspace_name, item_id, item_type, connection_string, database_name, created_by)
      OUTPUT INSERTED.id
      VALUES (@name, @label, @kind, @ws, @wsName, @item, @itemType, @conn, @db, @by)`, [
      str('name', source.name), str('label', source.systemLabel), str('kind', source.kind),
      str('ws', source.workspaceId), str('wsName', source.workspaceName), str('item', source.itemId),
      str('itemType', source.itemType), str('conn', source.connectionString), str('db', source.databaseName),
      str('by', source.createdBy),
    ]);
    return rows[0] ? rows[0].id : null;
  });
}

async function deleteSource(id) {
  return withConnection(conn => execSql(conn, 'DELETE FROM recon_sources WHERE id=@id', [int('id', id)]));
}

// ── Rules ──
function mapRule(row) {
  if (!row) return null;
  return {
    ...row,
    compareFields: parseJson(row.compare_fields, []),
  };
}

async function listRules({ status } = {}) {
  return withConnection(async conn => {
    const sql = status
      ? 'SELECT * FROM recon_rules WHERE status=@status ORDER BY name'
      : 'SELECT * FROM recon_rules ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'draft\' THEN 1 ELSE 2 END, name';
    const rows = await execSql(conn, sql, status ? [str('status', status)] : []);
    return rows.map(mapRule);
  });
}

async function getRuleById(id) {
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT * FROM recon_rules WHERE id=@id', [int('id', id)]);
    return mapRule(rows[0]);
  });
}

function ruleParams(rule) {
  return [
    str('name', rule.name), str('description', rule.description), str('area', rule.businessArea),
    str('owner', rule.owner), str('priority', rule.priority || 'medium'),
    int('sourceA', rule.sourceAId), int('sourceB', rule.sourceBId),
    str('datasetA', rule.datasetA), str('datasetB', rule.datasetB),
    str('keyA', rule.keyFieldA), str('keyB', rule.keyFieldB),
    str('fields', JSON.stringify(rule.compareFields || [])),
    str('dupes', rule.duplicateHandling || 'exception'),
    str('keys', rule.incompleteKeyHandling || 'exception'),
    int('rowLimit', rule.rowLimit),
  ];
}

// Every write records a version snapshot: an auditor must be able to see which
// definition of the control was in force when a given run happened.
async function recordRuleVersion(conn, ruleId, version, actor, note) {
  const rows = await execSql(conn, 'SELECT * FROM recon_rules WHERE id=@id', [int('id', ruleId)]);
  if (!rows.length) return;
  await execSql(conn, `INSERT INTO recon_rule_versions (rule_id, version, snapshot, change_note, changed_by)
    VALUES (@id, @version, @snapshot, @note, @by)`, [
    int('id', ruleId), int('version', version),
    str('snapshot', JSON.stringify(rows[0])), str('note', note), str('by', actor),
  ]);
}

async function createRule(rule, actor) {
  return withConnection(async conn => {
    const rows = await execSql(conn, `INSERT INTO recon_rules
      (name, description, business_area, owner, priority, status, version,
       source_a_id, source_b_id, dataset_a, dataset_b, key_field_a, key_field_b,
       compare_fields, duplicate_handling, incomplete_key_handling, row_limit, created_by, updated_by)
      OUTPUT INSERTED.id
      VALUES (@name, @description, @area, @owner, @priority, 'draft', 1,
       @sourceA, @sourceB, @datasetA, @datasetB, @keyA, @keyB,
       @fields, @dupes, @keys, @rowLimit, @by, @by)`,
    [...ruleParams(rule), str('by', actor)]);
    const id = rows[0] ? rows[0].id : null;
    if (id) await recordRuleVersion(conn, id, 1, actor, 'Rule created');
    return id;
  });
}

async function updateRule(id, rule, actor, note) {
  return withConnection(async conn => {
    const current = await execSql(conn, 'SELECT version FROM recon_rules WHERE id=@id', [int('id', id)]);
    const nextVersion = (current[0] ? Number(current[0].version) : 0) + 1;
    await execSql(conn, `UPDATE recon_rules SET name=@name, description=@description, business_area=@area,
      owner=@owner, priority=@priority, source_a_id=@sourceA, source_b_id=@sourceB,
      dataset_a=@datasetA, dataset_b=@datasetB, key_field_a=@keyA, key_field_b=@keyB,
      compare_fields=@fields, duplicate_handling=@dupes, incomplete_key_handling=@keys,
      row_limit=@rowLimit, version=@version, updated_at=SYSUTCDATETIME(), updated_by=@by WHERE id=@id`,
    [...ruleParams(rule), int('id', id), int('version', nextVersion), str('by', actor)]);
    await recordRuleVersion(conn, id, nextVersion, actor, note || 'Rule updated');
    return nextVersion;
  });
}

async function setRuleStatus(id, status, actor) {
  return withConnection(async conn => {
    await execSql(conn, 'UPDATE recon_rules SET status=@status, updated_at=SYSUTCDATETIME(), updated_by=@by WHERE id=@id', [
      int('id', id), str('status', status), str('by', actor),
    ]);
    const current = await execSql(conn, 'SELECT version FROM recon_rules WHERE id=@id', [int('id', id)]);
    const version = current[0] ? Number(current[0].version) : 1;
    await recordRuleVersion(conn, id, version, actor, 'Status changed to ' + status);
  });
}

async function deleteRule(id) {
  return withConnection(conn => execSql(conn, 'DELETE FROM recon_rules WHERE id=@id', [int('id', id)]));
}

async function getRuleVersions(ruleId) {
  return withConnection(conn => execSql(conn,
    'SELECT id, version, change_note, changed_at, changed_by FROM recon_rule_versions WHERE rule_id=@id ORDER BY version DESC',
    [int('id', ruleId)]));
}

// ── Runs ──
async function createRun({ ruleId, ruleVersion, ruleName, runBy }) {
  return withConnection(async conn => {
    const rows = await execSql(conn, `INSERT INTO recon_runs (rule_id, rule_version, rule_name, status, run_by)
      OUTPUT INSERTED.id VALUES (@rule, @version, @name, 'running', @by)`, [
      int('rule', ruleId), int('version', ruleVersion), str('name', ruleName), str('by', runBy),
    ]);
    return rows[0] ? rows[0].id : null;
  });
}

async function completeRun(runId, { status, summary, error }) {
  return withConnection(conn => execSql(conn, `UPDATE recon_runs SET status=@status,
    records_a=@ra, records_b=@rb, keys_compared=@keys, matched=@matched, exception_count=@exceptions,
    counts_json=@counts, error_message=@error, completed_at=SYSUTCDATETIME() WHERE id=@id`, [
    int('id', runId), str('status', status),
    int('ra', summary ? summary.recordsA : null), int('rb', summary ? summary.recordsB : null),
    int('keys', summary ? summary.keysCompared : null), int('matched', summary ? summary.matched : null),
    int('exceptions', summary ? summary.exceptions : null),
    str('counts', summary ? JSON.stringify(summary.counts) : null), str('error', error || null),
  ]));
}

async function listRuns({ ruleId, limit = 100 } = {}) {
  return withConnection(conn => execSql(conn,
    'SELECT TOP (' + Math.max(1, Math.min(1000, Number(limit) || 100)) + ') * FROM recon_runs'
    + (ruleId ? ' WHERE rule_id=@rule' : '') + ' ORDER BY started_at DESC',
    ruleId ? [int('rule', ruleId)] : []));
}

async function getRunById(id) {
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT * FROM recon_runs WHERE id=@id', [int('id', id)]);
    return rows[0] || null;
  });
}

// ── Exceptions ──
/**
 * Fold this run's findings into the standing exception list.
 *
 * An exception already open for the same rule, key and outcome is the same
 * business item seen again — its occurrence count and last-seen date move, but its
 * owner, status and history are preserved. Only genuinely new items are created,
 * and one that had been resolved but has recurred is reopened with a note, because
 * silently leaving it closed would hide a returning problem.
 */
async function recordExceptions(runId, rule, exceptions) {
  const created = [];
  const updated = [];
  const reopened = [];

  await withConnection(async conn => {
    for (const exception of exceptions) {
      const fingerprint = exceptionFingerprint(rule.id, exception);
      const existing = await execSql(conn, 'SELECT id, status, occurrence_count FROM recon_exceptions WHERE fingerprint=@fp', [
        str('fp', fingerprint),
      ]);

      const valuesA = JSON.stringify(exception.valuesA || null);
      const valuesB = JSON.stringify(exception.valuesB || null);
      const differences = JSON.stringify(exception.differences || []);

      if (!existing.length) {
        const rows = await execSql(conn, `INSERT INTO recon_exceptions
          (fingerprint, rule_id, rule_name, business_area, first_run_id, last_run_id, business_key,
           outcome, severity, status, values_a, values_b, differences)
          OUTPUT INSERTED.id
          VALUES (@fp, @rule, @ruleName, @area, @run, @run, @key, @outcome, @severity, 'open', @va, @vb, @diff)`, [
          str('fp', fingerprint), int('rule', rule.id), str('ruleName', rule.name), str('area', rule.business_area),
          int('run', runId), str('key', String(exception.businessKey)), str('outcome', exception.outcome),
          str('severity', exception.severity), str('va', valuesA), str('vb', valuesB), str('diff', differences),
        ]);
        const id = rows[0] ? rows[0].id : null;
        if (id) {
          created.push(id);
          await addExceptionEvent(conn, id, {
            action: 'identified', toStatus: 'open', actor: 'reconciliation run',
            comment: 'Identified by run #' + runId,
          });
        }
        continue;
      }

      const row = existing[0];
      const wasClosed = CLOSED_STATUSES.has(String(row.status));
      await execSql(conn, `UPDATE recon_exceptions SET last_run_id=@run, last_seen_at=SYSUTCDATETIME(),
        occurrence_count=occurrence_count+1, values_a=@va, values_b=@vb, differences=@diff, severity=@severity
        ${wasClosed ? ", status='open', resolved_at=NULL" : ''} WHERE id=@id`, [
        int('id', row.id), int('run', runId), str('va', valuesA), str('vb', valuesB),
        str('diff', differences), str('severity', exception.severity),
      ]);

      if (wasClosed) {
        reopened.push(row.id);
        await addExceptionEvent(conn, row.id, {
          action: 'reopened', fromStatus: row.status, toStatus: 'open', actor: 'reconciliation run',
          comment: 'Seen again by run #' + runId + ' after being ' + row.status,
        });
      } else {
        updated.push(row.id);
      }
    }
  });

  return { created: created.length, updated: updated.length, reopened: reopened.length };
}

async function addExceptionEvent(conn, exceptionId, { action, fromStatus, toStatus, comment, actor }) {
  await execSql(conn, `INSERT INTO recon_exception_events (exception_id, action, from_status, to_status, comment, actor)
    VALUES (@id, @action, @from, @to, @comment, @actor)`, [
    int('id', exceptionId), str('action', action), str('from', fromStatus || null),
    str('to', toStatus || null), str('comment', comment || null), str('actor', actor || 'system'),
  ]);
}

function mapException(row) {
  if (!row) return null;
  return {
    ...row,
    valuesA: parseJson(row.values_a, null),
    valuesB: parseJson(row.values_b, null),
    differences: parseJson(row.differences, []),
  };
}

async function listExceptions(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.status) { clauses.push('status=@status'); params.push(str('status', filters.status)); }
  if (filters.openOnly) clauses.push("status NOT IN ('resolved','accepted')");
  if (filters.severity) { clauses.push('severity=@severity'); params.push(str('severity', filters.severity)); }
  if (filters.outcome) { clauses.push('outcome=@outcome'); params.push(str('outcome', filters.outcome)); }
  if (filters.ruleId) { clauses.push('rule_id=@rule'); params.push(int('rule', filters.ruleId)); }
  if (filters.owner) { clauses.push('owner=@owner'); params.push(str('owner', filters.owner)); }
  if (filters.runId) { clauses.push('last_run_id=@run'); params.push(int('run', filters.runId)); }

  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const limit = Math.max(1, Math.min(2000, Number(filters.limit) || 500));
  return withConnection(async conn => {
    const rows = await execSql(conn,
      'SELECT TOP (' + limit + ') * FROM recon_exceptions' + where
      + " ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen_at DESC",
      params);
    return rows.map(mapException);
  });
}

async function getExceptionById(id) {
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT * FROM recon_exceptions WHERE id=@id', [int('id', id)]);
    return mapException(rows[0]);
  });
}

async function getExceptionEvents(exceptionId) {
  return withConnection(conn => execSql(conn,
    'SELECT * FROM recon_exception_events WHERE exception_id=@id ORDER BY occurred_at DESC, id DESC',
    [int('id', exceptionId)]));
}

async function updateExceptionStatus(id, { toStatus, fromStatus, owner, comment, reason, actor }) {
  return withConnection(async conn => {
    const closing = CLOSED_STATUSES.has(toStatus);
    await execSql(conn, `UPDATE recon_exceptions SET status=@status,
      owner = COALESCE(@owner, owner),
      resolution_reason = COALESCE(@reason, resolution_reason),
      resolved_at = ${closing ? 'SYSUTCDATETIME()' : 'NULL'}
      WHERE id=@id`, [
      int('id', id), str('status', toStatus), str('owner', owner || null), str('reason', reason || null),
    ]);
    await addExceptionEvent(conn, id, {
      action: 'status-change', fromStatus, toStatus, comment, actor,
    });
  });
}

async function assignException(id, owner, actor) {
  return withConnection(async conn => {
    await execSql(conn, 'UPDATE recon_exceptions SET owner=@owner WHERE id=@id', [
      int('id', id), str('owner', owner || null),
    ]);
    await addExceptionEvent(conn, id, {
      action: 'assigned', comment: owner ? 'Assigned to ' + owner : 'Owner cleared', actor,
    });
  });
}

async function commentOnException(id, comment, actor) {
  return withConnection(conn => addExceptionEvent(conn, id, { action: 'comment', comment, actor }));
}

// ── Oversight ──
async function getDashboardData() {
  return withConnection(async conn => {
    const safe = async (sql) => {
      try { return await execSql(conn, sql); } catch { return []; }
    };
    const [rules, exceptionsByStatus, exceptionsByOutcome, exceptionsBySeverity, byRule, recentRuns, byOwner] = await Promise.all([
      safe("SELECT status, COUNT(*) AS total FROM recon_rules GROUP BY status"),
      safe('SELECT status, COUNT(*) AS total FROM recon_exceptions GROUP BY status'),
      safe("SELECT outcome, COUNT(*) AS total FROM recon_exceptions WHERE status NOT IN ('resolved','accepted') GROUP BY outcome"),
      safe("SELECT severity, COUNT(*) AS total FROM recon_exceptions WHERE status NOT IN ('resolved','accepted') GROUP BY severity"),
      safe(`SELECT TOP 20 rule_id, rule_name, business_area,
              COUNT(*) AS open_count, MAX(occurrence_count) AS worst_recurrence, MAX(last_seen_at) AS last_seen
            FROM recon_exceptions WHERE status NOT IN ('resolved','accepted')
            GROUP BY rule_id, rule_name, business_area ORDER BY COUNT(*) DESC`),
      safe('SELECT TOP 15 * FROM recon_runs ORDER BY started_at DESC'),
      safe(`SELECT ISNULL(owner, '(unassigned)') AS owner, COUNT(*) AS total
            FROM recon_exceptions WHERE status NOT IN ('resolved','accepted') GROUP BY owner ORDER BY COUNT(*) DESC`),
    ]);
    // Ageing buckets make "how long has this been ignored" visible at a glance.
    const ageing = await safe(`
      SELECT
        SUM(CASE WHEN DATEDIFF(day, first_seen_at, SYSUTCDATETIME()) <= 7 THEN 1 ELSE 0 END) AS week1,
        SUM(CASE WHEN DATEDIFF(day, first_seen_at, SYSUTCDATETIME()) BETWEEN 8 AND 30 THEN 1 ELSE 0 END) AS month1,
        SUM(CASE WHEN DATEDIFF(day, first_seen_at, SYSUTCDATETIME()) > 30 THEN 1 ELSE 0 END) AS older
      FROM recon_exceptions WHERE status NOT IN ('resolved','accepted')`);

    return {
      rules, exceptionsByStatus, exceptionsByOutcome, exceptionsBySeverity,
      byRule, recentRuns, byOwner, ageing: ageing[0] || { week1: 0, month1: 0, older: 0 },
    };
  });
}

module.exports = {
  listSources, getSourceById, saveSource, deleteSource,
  listRules, getRuleById, createRule, updateRule, setRuleStatus, deleteRule, getRuleVersions,
  createRun, completeRun, listRuns, getRunById,
  recordExceptions, listExceptions, getExceptionById, getExceptionEvents,
  updateExceptionStatus, assignException, commentOnException,
  getDashboardData,
  EXCEPTION_STATUS,
};
