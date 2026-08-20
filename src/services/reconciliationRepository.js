// Persistence for the reconciliation engine: sources, rules and their version
// history, runs, exceptions and the decisions taken on them.
//
// Reuses the SQL primitives from databaseService so connection handling, token
// refresh and schema-drift tolerance stay in one place.

const { _sql } = require('./databaseService');
const { exceptionFingerprint, CLOSED_STATUSES, EXCEPTION_STATUS } = require('./reconciliationService');

const { TYPES } = _sql;

// Looked up on each call rather than destructured once, so a test can substitute
// the SQL primitives. That matters here: a tedious connection carries one request
// at a time, and issuing two together fails in a way that is easy to swallow and
// hard to notice — which is exactly what happened to the dashboard.
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

// Columns written for every source, whatever kind it is. Grouped so the insert and
// the update cannot drift apart.
function sourceColumns(source) {
  return [
    { column: 'name', param: str('name', source.name) },
    { column: 'system_label', param: str('label', source.systemLabel) },
    { column: 'kind', param: str('kind', source.kind) },
    { column: 'workspace_id', param: str('ws', source.workspaceId || null) },
    { column: 'workspace_name', param: str('wsName', source.workspaceName || null) },
    { column: 'item_id', param: str('item', source.itemId || null) },
    { column: 'item_type', param: str('itemType', source.itemType || null) },
    { column: 'sp_id', param: int('spId', source.spId) },
    { column: 'sp_name', param: str('spName', source.spName || null) },
    { column: 'tenant_id', param: str('tenantId', source.tenantId || null) },
    { column: 'connection_string', param: str('conn', source.connectionString || null) },
    { column: 'database_name', param: str('db', source.databaseName || null) },
    { column: 'auth_mode', param: str('auth', source.authMode || null) },
    { column: 'sql_port', param: int('port', source.sqlPort) },
    { column: 'sql_username', param: str('user', source.sqlUsername || null) },
    { column: 'schema_json', param: str('schema', source.schemaJson || null) },
  ];
}

async function saveSource(source) {
  return withConnection(async conn => {
    // Registering the same Fabric item twice should update it, not duplicate it.
    // External databases have no item identity, so they are matched by id instead.
    let existingId = source.id ? Number.parseInt(source.id, 10) : null;
    if (!existingId && source.workspaceId && source.itemId) {
      const found = await execSql(conn, 'SELECT id FROM recon_sources WHERE workspace_id=@ws AND item_id=@item', [
        str('ws', source.workspaceId), str('item', source.itemId),
      ]);
      existingId = found.length ? found[0].id : null;
    }

    const columns = sourceColumns(source);
    // A password is only written when a new one was supplied, so editing a source's
    // name does not silently clear its stored credential.
    if (source.sqlPassword !== undefined) {
      columns.push({ column: 'sql_password', param: str('pwd', source.sqlPassword) });
    }
    if (source.schemaJson !== undefined && source.schemaJson !== null) {
      columns.push({ column: 'schema_read_at', param: null, raw: 'SYSUTCDATETIME()' });
    }

    const params = columns.filter(c => c.param).map(c => c.param);
    const assignment = c => c.column + '=' + (c.raw || '@' + c.param.name);

    if (existingId) {
      await execSql(conn, 'UPDATE recon_sources SET ' + columns.map(assignment).join(', ') + ' WHERE id=@id',
        [...params, int('id', existingId)]);
      return existingId;
    }

    const rows = await execSql(conn,
      'INSERT INTO recon_sources (' + columns.map(c => c.column).concat('created_by').join(', ') + ')'
      + ' OUTPUT INSERTED.id VALUES (' + columns.map(c => c.raw || '@' + c.param.name).concat('@by').join(', ') + ')',
      [...params, str('by', source.createdBy)]);
    return rows[0] ? rows[0].id : null;
  });
}

/** Stores a freshly read schema without touching the rest of the source. */
async function saveSourceSchema(id, schemaJson) {
  return withConnection(conn => execSql(conn,
    'UPDATE recon_sources SET schema_json=@schema, schema_read_at=SYSUTCDATETIME() WHERE id=@id',
    [int('id', id), str('schema', schemaJson)]));
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

/**
 * Applies a status change and/or an owner to one rule, on a connection the caller
 * owns. Every change is still versioned individually — a batch is a convenience for
 * the operator, not a reason for the audit trail to lose detail about what happened
 * to each control.
 */
async function applyRuleChange(conn, id, { status, owner, assignOwner }, actor) {
  const assignments = [];
  const params = [int('id', id)];
  if (status) { assignments.push('status=@status'); params.push(str('status', status)); }
  if (assignOwner) { assignments.push('owner=@owner'); params.push(str('owner', owner || null)); }
  if (!assignments.length) return null;

  assignments.push('updated_at=SYSUTCDATETIME()', 'updated_by=@by');
  params.push(str('by', actor));
  await execSql(conn, 'UPDATE recon_rules SET ' + assignments.join(', ') + ' WHERE id=@id', params);

  const current = await execSql(conn, 'SELECT version FROM recon_rules WHERE id=@id', [int('id', id)]);
  const version = current[0] ? Number(current[0].version) : 1;
  const notes = [];
  if (status) notes.push('Status changed to ' + status);
  if (assignOwner) notes.push(owner ? 'Assigned to ' + owner : 'Owner cleared');
  await recordRuleVersion(conn, id, version, actor, notes.join('; '));
  return version;
}

async function setRuleStatusAndOwner(id, change, actor) {
  return withConnection(conn => applyRuleChange(conn, id, change, actor));
}

/**
 * Applies the same change to several rules on one connection. Each rule is written
 * separately so one failure does not discard the rest; the caller is told which
 * ones went through.
 */
async function batchUpdateRules(ids, change, actor) {
  return withConnection(async conn => {
    const results = [];
    for (const id of ids) {
      try {
        await applyRuleChange(conn, id, change, actor);
        results.push({ id, success: true });
      } catch (err) {
        results.push({ id, success: false, message: err.message });
      }
    }
    return results;
  });
}

async function deleteRule(id) {
  return withConnection(conn => execSql(conn, 'DELETE FROM recon_rules WHERE id=@id', [int('id', id)]));
}

/** Distinct owners already in use, so assignment offers real names before free text. */
async function listOwners() {
  return withConnection(async conn => {
    const rows = await execSql(conn, `
      SELECT owner FROM recon_rules WHERE owner IS NOT NULL AND LTRIM(RTRIM(owner)) <> ''
      UNION SELECT owner FROM recon_exceptions WHERE owner IS NOT NULL AND LTRIM(RTRIM(owner)) <> ''`);
    return rows.map(row => row.owner).sort((a, b) => a.localeCompare(b));
  });
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
 *
 * Alongside that standing list, each run's findings are recorded as they were at
 * the time. The standing list only ever holds the current state of an item, so
 * without this there would be no way to ask what a particular run saw — which is
 * what comparing two runs, and summarising one, both need.
 */
async function recordExceptions(runId, rule, exceptions) {
  const created = [];
  const updated = [];
  const reopened = [];

  await withConnection(async conn => {
    const recordFinding = (exceptionId, fingerprint, exception, isNew) => execSql(conn,
      `INSERT INTO recon_run_findings (run_id, rule_id, exception_id, fingerprint, business_key, outcome, severity, is_new)
       VALUES (@run, @rule, @exception, @fp, @key, @outcome, @severity, @isNew)`, [
        int('run', runId), int('rule', rule.id), int('exception', exceptionId), str('fp', fingerprint),
        str('key', String(exception.businessKey)), str('outcome', exception.outcome),
        str('severity', exception.severity), int('isNew', isNew ? 1 : 0),
      ]);

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
        await recordFinding(id, fingerprint, exception, true);
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
      await recordFinding(row.id, fingerprint, exception, false);
    }
  });

  return { created: created.length, updated: updated.length, reopened: reopened.length };
}

/** What one run found, in the shape the comparison and per-run summary read. */
async function listRunFindings(runId) {
  return withConnection(async conn => {
    try {
      return await execSql(conn,
        'SELECT run_id, rule_id, exception_id, fingerprint, business_key, outcome, severity, is_new FROM recon_run_findings WHERE run_id=@run',
        [int('run', runId)]);
    } catch (err) {
      // Runs recorded before findings were kept have none; that is not an error,
      // but it must not be presented as "this run found nothing".
      if ((err.message || '').includes('Invalid object name')) return [];
      throw err;
    }
  });
}

/** True when this run predates per-run findings, so its detail cannot be shown. */
async function hasRunFindings(runId) {
  return withConnection(async conn => {
    try {
      const rows = await execSql(conn, 'SELECT TOP 1 id FROM recon_run_findings WHERE run_id=@run', [int('run', runId)]);
      return rows.length > 0;
    } catch {
      return false;
    }
  });
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

/**
 * Applies owner, severity and status to one exception on a connection the caller
 * owns, recording an event for each part that actually changed.
 *
 * Severity is set by the engine from the outcome, but a business decides what is
 * material to it — an amount mismatch under a threshold may not warrant the same
 * attention as a missing invoice. Overriding it is a judgement worth recording,
 * which is why it lands in the audit trail like any other decision.
 */
async function applyExceptionChange(conn, exception, { owner, assignOwner, severity, toStatus, comment, reason, actor }) {
  const assignments = [];
  const params = [int('id', exception.id)];
  const events = [];

  if (assignOwner && (owner || null) !== (exception.owner || null)) {
    assignments.push('owner=@owner');
    params.push(str('owner', owner || null));
    events.push({ action: 'assigned', comment: owner ? 'Assigned to ' + owner : 'Owner cleared', actor });
  }
  if (severity && severity !== exception.severity) {
    assignments.push('severity=@severity');
    params.push(str('severity', severity));
    events.push({ action: 'severity-change', comment: 'Severity ' + exception.severity + ' → ' + severity, actor });
  }
  if (toStatus && toStatus !== exception.status) {
    const closing = CLOSED_STATUSES.has(toStatus);
    assignments.push('status=@status', 'resolved_at=' + (closing ? 'SYSUTCDATETIME()' : 'NULL'));
    params.push(str('status', toStatus));
    if (reason) {
      assignments.push('resolution_reason=@reason');
      params.push(str('reason', reason));
    }
    events.push({ action: 'status-change', fromStatus: exception.status, toStatus, comment, actor });
  } else if (comment) {
    events.push({ action: 'comment', comment, actor });
  }

  if (assignments.length) {
    await execSql(conn, 'UPDATE recon_exceptions SET ' + assignments.join(', ') + ' WHERE id=@id', params);
  }
  for (const event of events) {
    await addExceptionEvent(conn, exception.id, event);
  }
  return events.length;
}

/**
 * Applies the same decision to several exceptions on one connection. Each is
 * written separately so one failure does not discard the rest, and every one gets
 * its own history entries — a bulk action must not be less auditable than the same
 * decisions taken one at a time.
 */
async function batchUpdateExceptions(exceptions, change) {
  return withConnection(async conn => {
    const results = [];
    for (const exception of exceptions) {
      try {
        const changes = await applyExceptionChange(conn, exception, change);
        results.push({ id: exception.id, success: true, changed: changes > 0 });
      } catch (err) {
        results.push({ id: exception.id, success: false, message: err.message });
      }
    }
    return results;
  });
}

/** The exceptions named by a list of ids, for validating a bulk decision. */
async function getExceptionsByIds(ids) {
  const wanted = (ids || []).map(id => Number.parseInt(id, 10)).filter(Number.isFinite);
  if (!wanted.length) return [];
  return withConnection(async conn => {
    // Parameterised one id at a time rather than interpolated into an IN list, so
    // the values never reach the statement as text.
    const params = wanted.map((id, index) => int('e' + index, id));
    const placeholders = wanted.map((_, index) => '@e' + index).join(', ');
    const rows = await execSql(conn, 'SELECT * FROM recon_exceptions WHERE id IN (' + placeholders + ')', params);
    return rows.map(mapException);
  });
}

/** Findings for several runs in one read, so a per-rule overview is one query. */
async function listFindingsForRuns(runIds) {
  const wanted = (runIds || []).map(id => Number.parseInt(id, 10)).filter(Number.isFinite);
  if (!wanted.length) return [];
  return withConnection(async conn => {
    try {
      const params = wanted.map((id, index) => int('r' + index, id));
      const placeholders = wanted.map((_, index) => '@r' + index).join(', ');
      return await execSql(conn,
        'SELECT run_id, rule_id, exception_id, fingerprint, business_key, outcome, severity, is_new'
        + ' FROM recon_run_findings WHERE run_id IN (' + placeholders + ')', params);
    } catch (err) {
      if ((err.message || '').includes('Invalid object name')) return [];
      throw err;
    }
  });
}

// ── Oversight ──

/**
 * The dashboard aggregates.
 *
 * The queries run one after another. A tedious connection carries a single request
 * at a time, so issuing them together — as this used to — meant the first one
 * answered and every other was rejected with an invalid-state error. Those errors
 * were swallowed, so the panels rendered empty and looked like data that had not
 * refreshed after a run rather than queries that never ran at all.
 *
 * Failures are still tolerated, because a missing table must not take the whole
 * page down, but they are now logged and reported so the next one cannot hide.
 */
async function getDashboardData({ runId = null } = {}) {
  return withConnection(async conn => {
    const problems = [];
    const safe = async (label, sql, params = []) => {
      try {
        return await execSql(conn, sql, params);
      } catch (err) {
        console.warn('[Reconciliation] Dashboard query "' + label + '" failed:', err.message);
        problems.push(label);
        return [];
      }
    };

    const rules = await safe('rules by status', 'SELECT status, COUNT(*) AS total FROM recon_rules GROUP BY status');

    // Scoped to one run, the panels describe what that run found. Unscoped, they
    // describe the standing exception list — the current state of the control.
    const scoped = Number.isFinite(Number.parseInt(runId, 10));
    const runParam = () => [int('run', runId)];

    const exceptionsByStatus = scoped
      ? await safe('run findings by status', `SELECT e.status, COUNT(*) AS total
          FROM recon_run_findings f JOIN recon_exceptions e ON e.id = f.exception_id
          WHERE f.run_id=@run GROUP BY e.status`, runParam())
      : await safe('exceptions by status', 'SELECT status, COUNT(*) AS total FROM recon_exceptions GROUP BY status');

    const exceptionsByOutcome = scoped
      ? await safe('run findings by outcome',
        'SELECT outcome, COUNT(*) AS total FROM recon_run_findings WHERE run_id=@run GROUP BY outcome', runParam())
      : await safe('open exceptions by outcome',
        "SELECT outcome, COUNT(*) AS total FROM recon_exceptions WHERE status NOT IN ('resolved','accepted') GROUP BY outcome");

    const exceptionsBySeverity = scoped
      ? await safe('run findings by severity',
        'SELECT severity, COUNT(*) AS total FROM recon_run_findings WHERE run_id=@run GROUP BY severity', runParam())
      : await safe('open exceptions by severity',
        "SELECT severity, COUNT(*) AS total FROM recon_exceptions WHERE status NOT IN ('resolved','accepted') GROUP BY severity");

    const byRule = scoped
      ? await safe('run findings by rule', `SELECT TOP 20 f.rule_id, MAX(r.rule_name) AS rule_name, NULL AS business_area,
            COUNT(*) AS open_count, MAX(CAST(f.is_new AS INT)) AS worst_recurrence, MAX(f.recorded_at) AS last_seen
          FROM recon_run_findings f LEFT JOIN recon_runs r ON r.id = f.run_id
          WHERE f.run_id=@run GROUP BY f.rule_id ORDER BY COUNT(*) DESC`, runParam())
      : await safe('rules with open exceptions', `SELECT TOP 20 rule_id, rule_name, business_area,
            COUNT(*) AS open_count, MAX(occurrence_count) AS worst_recurrence, MAX(last_seen_at) AS last_seen
          FROM recon_exceptions WHERE status NOT IN ('resolved','accepted')
          GROUP BY rule_id, rule_name, business_area ORDER BY COUNT(*) DESC`);

    const byOwner = scoped
      ? await safe('run findings by owner', `SELECT ISNULL(e.owner, '(unassigned)') AS owner, COUNT(*) AS total
          FROM recon_run_findings f JOIN recon_exceptions e ON e.id = f.exception_id
          WHERE f.run_id=@run GROUP BY e.owner ORDER BY COUNT(*) DESC`, runParam())
      : await safe('open exceptions by owner', `SELECT ISNULL(owner, '(unassigned)') AS owner, COUNT(*) AS total
          FROM recon_exceptions WHERE status NOT IN ('resolved','accepted') GROUP BY owner ORDER BY COUNT(*) DESC`);

    const recentRuns = await safe('recent runs', 'SELECT TOP 15 * FROM recon_runs ORDER BY started_at DESC');

    // Ageing buckets make "how long has this been ignored" visible at a glance.
    // They describe the standing list, so they are not scoped to a single run.
    const ageing = await safe('exception ageing', `
      SELECT
        SUM(CASE WHEN DATEDIFF(day, first_seen_at, SYSUTCDATETIME()) <= 7 THEN 1 ELSE 0 END) AS week1,
        SUM(CASE WHEN DATEDIFF(day, first_seen_at, SYSUTCDATETIME()) BETWEEN 8 AND 30 THEN 1 ELSE 0 END) AS month1,
        SUM(CASE WHEN DATEDIFF(day, first_seen_at, SYSUTCDATETIME()) > 30 THEN 1 ELSE 0 END) AS older
      FROM recon_exceptions WHERE status NOT IN ('resolved','accepted')`);

    const run = scoped
      ? (await safe('selected run', 'SELECT * FROM recon_runs WHERE id=@run', runParam()))[0] || null
      : null;

    return {
      rules, exceptionsByStatus, exceptionsByOutcome, exceptionsBySeverity,
      byRule, recentRuns, byOwner, ageing: ageing[0] || { week1: 0, month1: 0, older: 0 },
      scopedRun: run,
      scoped,
      problems,
    };
  });
}

module.exports = {
  listSources, getSourceById, saveSource, saveSourceSchema, deleteSource,
  listRules, getRuleById, createRule, updateRule, setRuleStatus, deleteRule, getRuleVersions,
  setRuleStatusAndOwner, batchUpdateRules, listOwners,
  createRun, completeRun, listRuns, getRunById,
  recordExceptions, listRunFindings, hasRunFindings, listFindingsForRuns,
  listExceptions, getExceptionById, getExceptionsByIds, getExceptionEvents,
  batchUpdateExceptions,
  updateExceptionStatus, assignException, commentOnException,
  getDashboardData,
  EXCEPTION_STATUS,
};
