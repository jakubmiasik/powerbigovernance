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

function dec(name, value) {
  const parsed = Number(value);
  return { name, type: TYPES.Decimal, value: Number.isFinite(parsed) ? parsed : null, precision: 28, scale: 10 };
}
function bit(name, value) {
  return { name, type: TYPES.Bit, value: value ? 1 : 0 };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// SQL Server refuses a request carrying more than 2100 parameters, so every write
// that scales with the number of rows is chunked by how many parameters each row
// costs rather than by a fixed row count.
const MAX_PARAMS = 2000;

function chunkByParams(rows, paramsPerRow) {
  const size = Math.max(1, Math.floor(MAX_PARAMS / Math.max(1, paramsPerRow)));
  const chunks = [];
  for (let start = 0; start < rows.length; start += size) chunks.push(rows.slice(start, start + size));
  return chunks;
}

/**
 * One multi-row INSERT per chunk instead of one statement per row.
 *
 * This is the difference between a run recording a thousand exceptions in a few
 * round trips and doing it in a few thousand.
 */
async function insertRows(conn, table, columns, rows, valuesFor) {
  if (!rows.length) return;
  for (const chunk of chunkByParams(rows, columns.length)) {
    const params = [];
    const tuples = chunk.map((row, index) => {
      const rowParams = valuesFor(row, index);
      params.push(...rowParams);
      return '(' + rowParams.map(param => '@' + param.name).join(', ') + ')';
    });
    await execSql(conn, 'INSERT INTO ' + table + ' (' + columns.join(', ') + ') VALUES ' + tuples.join(', '), params);
  }
}

/** `WHERE id IN (…)` with the ids bound, chunked to stay under the parameter cap. */
function idChunks(ids) {
  return chunkByParams(ids, 1);
}

function idPredicate(ids, prefix = 'i') {
  const params = ids.map((id, index) => int(prefix + index, id));
  return { clause: params.map(param => '@' + param.name).join(', '), params };
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
//
// A rule's compare fields are rows, not a JSON array. That makes "which rules
// compare this column" answerable, lets one field change without rewriting the
// whole definition, and keeps the shape the engine reads identical either way.

const RULE_FIELD_COLUMNS = ['rule_id', 'ordinal', 'label', 'value_type', 'tolerance', 'tolerance_days',
  'a_kind', 'a_value', 'b_kind', 'b_value'];

/** A stored field row → the operand shape the engine and the form both use. */
function mapRuleField(row) {
  return {
    label: row.label,
    type: row.value_type,
    tolerance: row.tolerance === null || row.tolerance === undefined ? undefined : Number(row.tolerance),
    toleranceDays: row.tolerance_days === null || row.tolerance_days === undefined ? undefined : Number(row.tolerance_days),
    a: { kind: row.a_kind || 'field', value: row.a_value },
    b: { kind: row.b_kind || 'field', value: row.b_value },
  };
}

function ruleFieldParams(ruleId, field, index) {
  const a = field.a || { kind: 'field', value: field.fieldA };
  const b = field.b || { kind: 'field', value: field.fieldB };
  return [
    int('r' + index, ruleId), int('o' + index, index), str('l' + index, field.label || null),
    str('t' + index, field.type || 'string'),
    dec('tol' + index, field.tolerance), int('td' + index, field.toleranceDays),
    str('ak' + index, a.kind || 'field'), str('av' + index, a.value === undefined ? null : String(a.value)),
    str('bk' + index, b.kind || 'field'), str('bv' + index, b.value === undefined ? null : String(b.value)),
  ];
}

/** Replaces a rule's fields. Delete then insert, so editing converges. */
async function writeRuleFields(conn, ruleId, compareFields) {
  await execSql(conn, 'DELETE FROM recon_rule_fields WHERE rule_id=@id', [int('id', ruleId)]);
  await insertRows(conn, 'recon_rule_fields', RULE_FIELD_COLUMNS, compareFields || [],
    (field, index) => ruleFieldParams(ruleId, field, index));
  await execSql(conn, 'UPDATE recon_rules SET fields_normalized=1 WHERE id=@id', [int('id', ruleId)]);
}

/**
 * Attaches each rule's compare fields.
 *
 * A rule written before the fields were rows still carries them in its JSON column,
 * so it is read from there — `fields_normalized` is what distinguishes a converted
 * rule with no fields from one that predates the table.
 */
async function attachRuleFields(conn, rules) {
  if (!rules.length) return rules;
  const byRule = new Map();
  for (const chunk of idChunks(rules.map(rule => rule.id))) {
    const { clause, params } = idPredicate(chunk);
    const rows = await execSql(conn,
      'SELECT * FROM recon_rule_fields WHERE rule_id IN (' + clause + ') ORDER BY rule_id, ordinal', params);
    for (const row of rows) {
      if (!byRule.has(row.rule_id)) byRule.set(row.rule_id, []);
      byRule.get(row.rule_id).push(mapRuleField(row));
    }
  }
  return rules.map(rule => ({
    ...rule,
    compareFields: rule.fields_normalized
      ? (byRule.get(rule.id) || [])
      : (byRule.get(rule.id) || parseJson(rule.compare_fields, [])),
  }));
}

async function listRules({ status } = {}) {
  return withConnection(async conn => {
    const sql = status
      ? 'SELECT * FROM recon_rules WHERE status=@status ORDER BY name'
      : 'SELECT * FROM recon_rules ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'draft\' THEN 1 ELSE 2 END, name';
    const rows = await execSql(conn, sql, status ? [str('status', status)] : []);
    return attachRuleFields(conn, rows);
  });
}

async function getRuleById(id) {
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT * FROM recon_rules WHERE id=@id', [int('id', id)]);
    if (!rows.length) return null;
    const [rule] = await attachRuleFields(conn, rows);
    return rule;
  });
}

function ruleParams(rule) {
  return [
    str('name', rule.name), str('description', rule.description), str('area', rule.businessArea),
    str('owner', rule.owner), str('priority', rule.priority || 'medium'),
    int('sourceA', rule.sourceAId), int('sourceB', rule.sourceBId),
    str('datasetA', rule.datasetA), str('datasetB', rule.datasetB),
    str('keyA', rule.keyFieldA), str('keyB', rule.keyFieldB),
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
  // The snapshot stays a document — it is an immutable copy of a definition at a
  // point in time, not something anyone queries into. But it now has to include the
  // compare fields explicitly, because the rule row no longer carries them.
  const [rule] = await attachRuleFields(conn, rows);
  await execSql(conn, `INSERT INTO recon_rule_versions (rule_id, version, snapshot, change_note, changed_by)
    VALUES (@id, @version, @snapshot, @note, @by)`, [
    int('id', ruleId), int('version', version),
    str('snapshot', JSON.stringify(rule)), str('note', note), str('by', actor),
  ]);
}

async function createRule(rule, actor) {
  return withConnection(async conn => {
    const rows = await execSql(conn, `INSERT INTO recon_rules
      (name, description, business_area, owner, priority, status, version,
       source_a_id, source_b_id, dataset_a, dataset_b, key_field_a, key_field_b,
       duplicate_handling, incomplete_key_handling, row_limit, created_by, updated_by)
      OUTPUT INSERTED.id
      VALUES (@name, @description, @area, @owner, @priority, 'draft', 1,
       @sourceA, @sourceB, @datasetA, @datasetB, @keyA, @keyB,
       @dupes, @keys, @rowLimit, @by, @by)`,
    [...ruleParams(rule), str('by', actor)]);
    const id = rows[0] ? rows[0].id : null;
    if (id) {
      await writeRuleFields(conn, id, rule.compareFields);
      await recordRuleVersion(conn, id, 1, actor, 'Rule created');
    }
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
      duplicate_handling=@dupes, incomplete_key_handling=@keys,
      row_limit=@rowLimit, version=@version, updated_at=SYSUTCDATETIME(), updated_by=@by WHERE id=@id`,
    [...ruleParams(rule), int('id', id), int('version', nextVersion), str('by', actor)]);
    await writeRuleFields(conn, id, rule.compareFields);
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
  return withConnection(async conn => {
    await execSql(conn, 'DELETE FROM recon_rule_fields WHERE rule_id=@id', [int('id', id)]);
    await execSql(conn, 'DELETE FROM recon_rules WHERE id=@id', [int('id', id)]);
  });
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
  return withConnection(async conn => {
    await execSql(conn, `UPDATE recon_runs SET status=@status,
      records_a=@ra, records_b=@rb, keys_compared=@keys, matched=@matched, exception_count=@exceptions,
      error_message=@error, completed_at=SYSUTCDATETIME() WHERE id=@id`, [
      int('id', runId), str('status', status),
      int('ra', summary ? summary.recordsA : null), int('rb', summary ? summary.recordsB : null),
      int('keys', summary ? summary.keysCompared : null), int('matched', summary ? summary.matched : null),
      int('exceptions', summary ? summary.exceptions : null), str('error', error || null),
    ]);

    // Per-outcome counts are rows, so "how has value_mismatch trended" is a query
    // rather than a parse of every run's document.
    await execSql(conn, 'DELETE FROM recon_run_outcome_counts WHERE run_id=@id', [int('id', runId)]);
    const counts = Object.entries((summary && summary.counts) || {});
    await insertRows(conn, 'recon_run_outcome_counts', ['run_id', 'outcome', 'total'], counts,
      ([outcome, total], index) => [int('r' + index, runId), str('o' + index, outcome), int('t' + index, total)]);
  });
}

/** The per-outcome counts for one run, falling back to the stored document. */
async function getRunOutcomeCounts(runId) {
  return withConnection(async conn => {
    try {
      const rows = await execSql(conn,
        'SELECT outcome, total FROM recon_run_outcome_counts WHERE run_id=@id ORDER BY outcome', [int('id', runId)]);
      if (rows.length) return Object.fromEntries(rows.map(row => [row.outcome, Number(row.total)]));
    } catch (err) {
      if (!(err.message || '').includes('Invalid object name')) throw err;
    }
    const runs = await execSql(conn, 'SELECT counts_json FROM recon_runs WHERE id=@id', [int('id', runId)]);
    return parseJson(runs[0] && runs[0].counts_json, {});
  });
}

/**
 * Moves the JSON documents written before this schema into their tables.
 *
 * On request rather than at startup: converting every historic rule and exception
 * at boot would mean parsing every stored document before the app could serve
 * anything, and the readers already fall back to the JSON meanwhile.
 */
async function normalizeLegacyRows({ maxExceptions = 2000 } = {}) {
  return withConnection(async conn => {
    const result = { rules: 0, exceptions: 0, runs: 0, remainingExceptions: 0 };

    const rules = await execSql(conn,
      'SELECT id, compare_fields FROM recon_rules WHERE fields_normalized=0 AND compare_fields IS NOT NULL');
    for (const rule of rules) {
      await writeRuleFields(conn, rule.id, parseJson(rule.compare_fields, []));
      result.rules += 1;
    }

    const runs = await execSql(conn, `SELECT r.id, r.counts_json FROM recon_runs r
      WHERE r.counts_json IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM recon_run_outcome_counts c WHERE c.run_id = r.id)`);
    for (const run of runs) {
      const counts = Object.entries(parseJson(run.counts_json, {}));
      await insertRows(conn, 'recon_run_outcome_counts', ['run_id', 'outcome', 'total'], counts,
        ([outcome, total], index) => [int('r' + index, run.id), str('o' + index, outcome), int('t' + index, total)]);
      result.runs += 1;
    }

    const cap = Math.max(1, Math.min(20000, Number(maxExceptions) || 2000));
    const exceptions = await execSql(conn,
      'SELECT TOP (' + cap + ') id, values_a, values_b, differences FROM recon_exceptions WHERE values_normalized=0');
    const valueRows = [];
    const differenceRows = [];
    for (const exception of exceptions) {
      for (const [side, json] of [['a', exception.values_a], ['b', exception.values_b]]) {
        for (const [label, value] of Object.entries(parseJson(json, {}) || {})) {
          valueRows.push({ exceptionId: exception.id, side, label, value: value === null ? null : String(value) });
        }
      }
      for (const difference of parseJson(exception.differences, []) || []) {
        differenceRows.push({
          exceptionId: exception.id, label: difference.field,
          reason: difference.reason || null, delta: difference.difference,
        });
      }
      result.exceptions += 1;
    }

    await insertRows(conn, 'recon_exception_values', ['exception_id', 'side', 'field_label', 'value'],
      valueRows, (row, index) => [
        int('e' + index, row.exceptionId), str('s' + index, row.side),
        str('f' + index, row.label), str('v' + index, row.value),
      ]);
    await insertRows(conn, 'recon_exception_differences', ['exception_id', 'field_label', 'reason', 'delta'],
      differenceRows, (row, index) => [
        int('e' + index, row.exceptionId), str('f' + index, row.label),
        str('r' + index, row.reason), dec('d' + index, row.delta),
      ]);

    for (const chunk of idChunks(exceptions.map(exception => exception.id))) {
      const predicate = idPredicate(chunk);
      await execSql(conn,
        'UPDATE recon_exceptions SET values_normalized=1 WHERE id IN (' + predicate.clause + ')', predicate.params);
    }

    const remaining = await execSql(conn, 'SELECT COUNT(*) AS total FROM recon_exceptions WHERE values_normalized=0');
    result.remainingExceptions = remaining[0] ? Number(remaining[0].total) : 0;
    return result;
  });
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
    const findings = [];
    const events = [];
    // Exception id → the values and differences it should end up with. Collected as
    // the run walks its findings, then written in a handful of statements rather
    // than three per exception.
    const valueRows = [];
    const differenceRows = [];
    const touchedIds = [];

    const collectDetail = (exceptionId, exception) => {
      if (!exceptionId) return;
      touchedIds.push(exceptionId);
      for (const side of ['a', 'b']) {
        const values = side === 'a' ? exception.valuesA : exception.valuesB;
        for (const [label, value] of Object.entries(values || {})) {
          valueRows.push({
            exceptionId, side, label,
            value: value === null || value === undefined ? null : String(value),
          });
        }
      }
      for (const difference of exception.differences || []) {
        differenceRows.push({
          exceptionId,
          label: difference.field,
          reason: difference.reason || null,
          delta: difference.difference,
        });
      }
    };

    for (const exception of exceptions) {
      const fingerprint = exceptionFingerprint(rule.id, exception);
      const existing = await execSql(conn, 'SELECT id, status, occurrence_count FROM recon_exceptions WHERE fingerprint=@fp', [
        str('fp', fingerprint),
      ]);

      if (!existing.length) {
        const rows = await execSql(conn, `INSERT INTO recon_exceptions
          (fingerprint, rule_id, rule_name, business_area, first_run_id, last_run_id, business_key,
           outcome, severity, status, values_normalized)
          OUTPUT INSERTED.id
          VALUES (@fp, @rule, @ruleName, @area, @run, @run, @key, @outcome, @severity, 'open', 1)`, [
          str('fp', fingerprint), int('rule', rule.id), str('ruleName', rule.name), str('area', rule.business_area),
          int('run', runId), str('key', String(exception.businessKey)), str('outcome', exception.outcome),
          str('severity', exception.severity),
        ]);
        const id = rows[0] ? rows[0].id : null;
        if (id) {
          created.push(id);
          events.push({
            exceptionId: id, action: 'identified', toStatus: 'open', actor: 'reconciliation run',
            comment: 'Identified by run #' + runId,
          });
        }
        collectDetail(id, exception);
        findings.push({ exceptionId: id, fingerprint, exception, isNew: true });
        continue;
      }

      const row = existing[0];
      const wasClosed = CLOSED_STATUSES.has(String(row.status));
      await execSql(conn, `UPDATE recon_exceptions SET last_run_id=@run, last_seen_at=SYSUTCDATETIME(),
        occurrence_count=occurrence_count+1, severity=@severity, values_normalized=1
        ${wasClosed ? ", status='open', resolved_at=NULL" : ''} WHERE id=@id`, [
        int('id', row.id), int('run', runId), str('severity', exception.severity),
      ]);

      if (wasClosed) {
        reopened.push(row.id);
        events.push({
          exceptionId: row.id, action: 'reopened', fromStatus: row.status, toStatus: 'open',
          actor: 'reconciliation run',
          comment: 'Seen again by run #' + runId + ' after being ' + row.status,
        });
      } else {
        updated.push(row.id);
      }
      collectDetail(row.id, exception);
      findings.push({ exceptionId: row.id, fingerprint, exception, isNew: false });
    }

    // The captured values replace whatever the previous run recorded, so a
    // recurring exception shows what it looks like now rather than accumulating.
    for (const chunk of idChunks(touchedIds)) {
      const { clause, params } = idPredicate(chunk);
      await execSql(conn, 'DELETE FROM recon_exception_values WHERE exception_id IN (' + clause + ')', params);
      await execSql(conn, 'DELETE FROM recon_exception_differences WHERE exception_id IN (' + clause + ')',
        idPredicate(chunk).params);
    }

    await insertRows(conn, 'recon_exception_values', ['exception_id', 'side', 'field_label', 'value'],
      valueRows, (row, index) => [
        int('e' + index, row.exceptionId), str('s' + index, row.side),
        str('f' + index, row.label), str('v' + index, row.value),
      ]);

    await insertRows(conn, 'recon_exception_differences', ['exception_id', 'field_label', 'reason', 'delta'],
      differenceRows, (row, index) => [
        int('e' + index, row.exceptionId), str('f' + index, row.label),
        str('r' + index, row.reason), dec('d' + index, row.delta),
      ]);

    await insertEvents(conn, events);

    await insertRows(conn, 'recon_run_findings',
      ['run_id', 'rule_id', 'exception_id', 'fingerprint', 'business_key', 'outcome', 'severity', 'is_new'],
      findings, (finding, index) => [
        int('run' + index, runId), int('rule' + index, rule.id), int('exc' + index, finding.exceptionId),
        str('fp' + index, finding.fingerprint), str('key' + index, String(finding.exception.businessKey)),
        str('out' + index, finding.exception.outcome), str('sev' + index, finding.exception.severity),
        bit('new' + index, finding.isNew),
      ]);
  });

  return { created: created.length, updated: updated.length, reopened: reopened.length };
}

async function addExceptionEvent(conn, exceptionId, event) {
  return insertEvents(conn, [{ ...event, exceptionId }]);
}

/**
 * Writes history entries in bulk.
 *
 * A bulk decision produces one event per exception per part of the change. Writing
 * them one statement at a time is what made a large bulk update slow; the audit
 * trail is identical either way.
 */
async function insertEvents(conn, events) {
  return insertRows(conn, 'recon_exception_events',
    ['exception_id', 'action', 'from_status', 'to_status', 'comment', 'actor'],
    events, (event, index) => [
      int('e' + index, event.exceptionId), str('a' + index, event.action),
      str('f' + index, event.fromStatus || null), str('t' + index, event.toStatus || null),
      str('c' + index, event.comment || null), str('by' + index, event.actor || 'system'),
    ]);
}

function mapException(row) {
  if (!row) return null;
  return { ...row };
}

/**
 * Attaches the captured values and differences to exceptions that need them.
 *
 * Only the detail view does. The list and every bulk action work without them,
 * which is the point of them being rows rather than columns on the exception.
 * An exception written before the tables existed still carries its JSON, so it is
 * read from there — `values_normalized` distinguishes converted from legacy.
 */
async function attachExceptionDetail(conn, exceptions) {
  if (!exceptions.length) return exceptions;
  const values = new Map();
  const differences = new Map();

  for (const chunk of idChunks(exceptions.map(exception => exception.id))) {
    const predicate = idPredicate(chunk);
    const valueRows = await execSql(conn,
      'SELECT exception_id, side, field_label, value FROM recon_exception_values WHERE exception_id IN ('
      + predicate.clause + ') ORDER BY field_label', predicate.params);
    for (const row of valueRows) {
      if (!values.has(row.exception_id)) values.set(row.exception_id, { a: {}, b: {} });
      values.get(row.exception_id)[row.side][row.field_label] = row.value;
    }

    const differencePredicate = idPredicate(chunk);
    const differenceRows = await execSql(conn,
      'SELECT exception_id, field_label, reason, delta FROM recon_exception_differences WHERE exception_id IN ('
      + differencePredicate.clause + ') ORDER BY field_label', differencePredicate.params);
    for (const row of differenceRows) {
      if (!differences.has(row.exception_id)) differences.set(row.exception_id, []);
      differences.get(row.exception_id).push({
        field: row.field_label,
        reason: row.reason,
        difference: row.delta === null || row.delta === undefined ? null : Number(row.delta),
      });
    }
  }

  return exceptions.map(exception => {
    const stored = values.get(exception.id);
    if (exception.values_normalized || stored || differences.has(exception.id)) {
      return {
        ...exception,
        valuesA: stored ? stored.a : {},
        valuesB: stored ? stored.b : {},
        differences: differences.get(exception.id) || [],
      };
    }
    return {
      ...exception,
      valuesA: parseJson(exception.values_a, null),
      valuesB: parseJson(exception.values_b, null),
      differences: parseJson(exception.differences, []),
    };
  });
}

/**
 * The WHERE clause behind an exception filter, built once so listing, counting and
 * acting on a filtered set can never disagree about what the filter means. A bulk
 * action that operated on a different set from the one on screen would be a
 * dangerous kind of wrong.
 */
function exceptionFilterClause(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.status) { clauses.push('status=@status'); params.push(str('status', filters.status)); }
  if (filters.openOnly) clauses.push("status NOT IN ('resolved','accepted')");
  if (filters.severity) { clauses.push('severity=@severity'); params.push(str('severity', filters.severity)); }
  if (filters.outcome) { clauses.push('outcome=@outcome'); params.push(str('outcome', filters.outcome)); }
  if (filters.ruleId) { clauses.push('rule_id=@rule'); params.push(int('rule', filters.ruleId)); }
  if (filters.owner) { clauses.push('owner=@owner'); params.push(str('owner', filters.owner)); }
  if (filters.runId) {
    // What this run actually found, from the findings it recorded — not
    // `last_run_id`, which means "the most recent run that saw this exception".
    // For the newest run those coincide, so the filter looked like it worked; for
    // any earlier run it silently answered a different question.
    //
    // Runs recorded before findings were kept have none, so they fall back to the
    // old meaning rather than showing an empty list.
    clauses.push(`(
      id IN (SELECT f.exception_id FROM recon_run_findings f WHERE f.run_id=@run)
      OR (last_run_id=@run AND NOT EXISTS (SELECT 1 FROM recon_run_findings f2 WHERE f2.run_id=@run))
    )`);
    params.push(int('run', filters.runId));
  }
  return { where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
}

// Only these columns are needed to list exceptions. The values and differences are
// large JSON documents that the list never renders, and reading them for every row
// was making the page pay for data it immediately discarded.
const EXCEPTION_LIST_COLUMNS = `id, rule_id, rule_name, business_area, business_key, outcome,
  severity, status, owner, occurrence_count, first_seen_at, last_seen_at, resolved_at, last_run_id`;

async function listExceptions(filters = {}) {
  const { where, params } = exceptionFilterClause(filters);
  const limit = Math.max(1, Math.min(2000, Number(filters.limit) || 500));
  return withConnection(async conn => {
    const rows = await execSql(conn,
      'SELECT TOP (' + limit + ') ' + EXCEPTION_LIST_COLUMNS + ' FROM recon_exceptions' + where
      + " ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen_at DESC",
      params);
    return rows.map(mapException);
  });
}

/** How many exceptions a filter covers, so a whole-set action can say what it will touch. */
async function countExceptions(filters = {}) {
  const { where, params } = exceptionFilterClause(filters);
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT COUNT(*) AS total FROM recon_exceptions' + where, params);
    return rows[0] ? Number(rows[0].total) : 0;
  });
}

/**
 * One page of the exceptions a filter covers, ordered by id.
 *
 * Keyset paging rather than OFFSET: the set is walked once, in id order, and each
 * page continues from the last id seen. That stays the same cost at page one and
 * page five hundred, and — unlike OFFSET — is not disturbed by the rows the action
 * is itself updating.
 */
async function listExceptionPage(filters = {}, { after = 0, limit = 500 } = {}) {
  const { where, params } = exceptionFilterClause(filters);
  const size = Math.max(1, Math.min(2000, Number(limit) || 500));
  const cursor = Number.parseInt(after, 10) || 0;
  const clause = where ? where + ' AND id > @after' : ' WHERE id > @after';
  return withConnection(async conn => {
    const rows = await execSql(conn,
      'SELECT TOP (' + size + ') ' + EXCEPTION_LIST_COLUMNS + ' FROM recon_exceptions' + clause + ' ORDER BY id',
      [...params, int('after', cursor)]);
    return {
      exceptions: rows.map(mapException),
      nextAfter: rows.length ? rows[rows.length - 1].id : null,
      done: rows.length < size,
    };
  });
}

/**
 * Every exception a filter covers.
 *
 * Kept for callers that genuinely want the whole set in memory. `max` is a
 * safety valve, not a policy: the bulk action pages instead, so that it can act on
 * a set of any size and report progress while it does.
 */
async function listExceptionsForAction(filters = {}, { max = 5000 } = {}) {
  const cap = Math.max(1, Math.min(200000, Number(max) || 5000));
  const collected = [];
  let after = 0;
  for (;;) {
    const page = await listExceptionPage(filters, { after, limit: 1000 });
    collected.push(...page.exceptions);
    after = page.nextAfter;
    if (page.done || collected.length >= cap || after === null) {
      return { exceptions: collected.slice(0, cap), truncated: collected.length > cap };
    }
  }
}

async function getExceptionById(id) {
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT * FROM recon_exceptions WHERE id=@id', [int('id', id)]);
    if (!rows.length) return null;
    const [exception] = await attachExceptionDetail(conn, rows.map(mapException));
    return exception;
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
 * Works out what a change actually does to one exception.
 *
 * Pure: the decision is the same for every exception, but whether each part of it
 * changes anything is not, and that is what determines both the update and the
 * history entries.
 */
function planExceptionChange(exception, { owner, assignOwner, severity, toStatus, comment, actor }) {
  const parts = [];
  const events = [];

  if (assignOwner && (owner || null) !== (exception.owner || null)) {
    parts.push('owner');
    events.push({
      exceptionId: exception.id, action: 'assigned', actor,
      comment: owner ? 'Assigned to ' + owner : 'Owner cleared',
    });
  }
  if (severity && severity !== exception.severity) {
    parts.push('severity');
    events.push({
      exceptionId: exception.id, action: 'severity-change', actor,
      comment: 'Severity ' + exception.severity + ' → ' + severity,
    });
  }
  if (toStatus && toStatus !== exception.status) {
    parts.push(CLOSED_STATUSES.has(toStatus) ? 'close' : 'reopen');
    events.push({
      exceptionId: exception.id, action: 'status-change',
      fromStatus: exception.status, toStatus, comment, actor,
    });
  } else if (comment) {
    events.push({ exceptionId: exception.id, action: 'comment', comment, actor });
  }

  return { parts, events, changed: parts.length > 0 || events.length > 0 };
}

/** The SET clause and its parameters for one combination of changing parts. */
function exceptionUpdateFor(parts, { owner, severity, toStatus, reason }) {
  const assignments = [];
  const params = [];
  if (parts.includes('owner')) {
    assignments.push('owner=@owner');
    params.push(str('owner', owner || null));
  }
  if (parts.includes('severity')) {
    assignments.push('severity=@severity');
    params.push(str('severity', severity));
  }
  if (parts.includes('close') || parts.includes('reopen')) {
    assignments.push('status=@status', 'resolved_at=' + (parts.includes('close') ? 'SYSUTCDATETIME()' : 'NULL'));
    params.push(str('status', toStatus));
    if (reason) {
      assignments.push('resolution_reason=@reason');
      params.push(str('reason', reason));
    }
  }
  return { assignments, params };
}

/**
 * Applies the same decision to several exceptions.
 *
 * The decision is uniform, so the work is grouped by which parts of it actually
 * change something and each group is written with one statement. Fifty exceptions
 * used to cost around a hundred round trips — one update and one history insert
 * each — which is what made a bulk change on a whole rule slow. It is now a handful
 * of statements regardless of how many exceptions are involved, and the audit trail
 * is unchanged: every exception still gets its own history entries.
 */
async function batchUpdateExceptions(exceptions, change) {
  const plans = exceptions.map(exception => ({ exception, plan: planExceptionChange(exception, change) }));

  return withConnection(async conn => {
    const results = [];
    // Group by which parts change. At most a handful of distinct combinations.
    const groups = new Map();
    for (const { exception, plan } of plans) {
      if (!plan.parts.length) continue;
      const key = plan.parts.slice().sort().join('+');
      if (!groups.has(key)) groups.set(key, { parts: plan.parts, ids: [] });
      groups.get(key).ids.push(exception.id);
    }

    const failed = new Set();
    for (const group of groups.values()) {
      const { assignments, params } = exceptionUpdateFor(group.parts, change);
      if (!assignments.length) continue;
      for (const chunk of chunkByParams(group.ids, 1)) {
        const predicate = idPredicate(chunk);
        try {
          await execSql(conn,
            'UPDATE recon_exceptions SET ' + assignments.join(', ') + ' WHERE id IN (' + predicate.clause + ')',
            [...params, ...predicate.params]);
        } catch (err) {
          // A failed chunk marks only its own exceptions, so the rest still land.
          for (const id of chunk) failed.add(id);
          console.warn('[Reconciliation] Bulk update chunk failed:', err.message);
        }
      }
    }

    const events = plans
      .filter(({ exception }) => !failed.has(exception.id))
      .flatMap(({ plan }) => plan.events);
    try {
      await insertEvents(conn, events);
    } catch (err) {
      console.warn('[Reconciliation] Bulk history write failed:', err.message);
    }

    for (const { exception, plan } of plans) {
      results.push(failed.has(exception.id)
        ? { id: exception.id, success: false, message: 'The update could not be applied.' }
        : { id: exception.id, success: true, changed: plan.changed });
    }
    return results;
  });
}

/** The exceptions named by a list of ids, for validating a bulk decision. */
async function getExceptionsByIds(ids) {
  const wanted = (ids || []).map(id => Number.parseInt(id, 10)).filter(Number.isFinite);
  if (!wanted.length) return [];
  return withConnection(async conn => {
    const found = [];
    // Ids are bound, never interpolated, and chunked so a large selection stays
    // under the parameter cap. Only the columns a bulk decision needs are read.
    for (const chunk of idChunks(wanted)) {
      const { clause, params } = idPredicate(chunk, 'e');
      const rows = await execSql(conn,
        'SELECT ' + EXCEPTION_LIST_COLUMNS + ' FROM recon_exceptions WHERE id IN (' + clause + ')', params);
      found.push(...rows.map(mapException));
    }
    return found;
  });
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

/**
 * What deleting a run would remove.
 *
 * A destructive action should say what it will do before it does it, and the answer
 * here is not obvious: an exception is a standing item keyed by fingerprint, seen by
 * one or more runs. Deleting a run removes only the exceptions that no other run
 * ever saw — the rest lose one sighting and keep their history.
 */
async function getRunDeletionImpact(runId) {
  return withConnection(async conn => {
    const rows = await execSql(conn, 'SELECT COUNT(*) AS total FROM recon_run_findings WHERE run_id=@run', [int('run', runId)]);
    const findings = rows[0] ? Number(rows[0].total) : 0;

    const orphaned = await execSql(conn, `
      SELECT COUNT(*) AS total FROM (
        SELECT f.exception_id FROM recon_run_findings f
        WHERE f.run_id=@run AND f.exception_id IS NOT NULL
        GROUP BY f.exception_id
        HAVING NOT EXISTS (
          SELECT 1 FROM recon_run_findings other
          WHERE other.exception_id = f.exception_id AND other.run_id <> @run
        )
      ) AS solitary`, [int('run', runId)]);

    const shared = await execSql(conn, `
      SELECT COUNT(DISTINCT f.exception_id) AS total FROM recon_run_findings f
      WHERE f.run_id=@run AND f.exception_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM recon_run_findings other
          WHERE other.exception_id = f.exception_id AND other.run_id <> @run
        )`, [int('run', runId)]);

    // A run recorded before findings were kept has none, so nothing can be
    // attributed to it and its exceptions are left alone.
    return {
      findings,
      exceptionsToDelete: orphaned[0] ? Number(orphaned[0].total) : 0,
      exceptionsToKeep: shared[0] ? Number(shared[0].total) : 0,
      attributable: findings > 0,
    };
  });
}

/**
 * Deletes a run and everything that belongs only to it.
 *
 * Exceptions are shared between runs, so they are handled in two groups: those no
 * surviving run ever saw are removed along with their values, differences and
 * history; those other runs also saw keep everything and have their first and last
 * sighting recomputed from the findings that remain. Leaving them pointing at a
 * deleted run would make the exception look as if it came from nowhere.
 *
 * `onProgress` is called as each stage completes, so a caller can report it.
 */
async function deleteRun(runId, { onProgress = () => {} } = {}) {
  return withConnection(async conn => {
    const removed = { findings: 0, exceptions: 0, repaired: 0, values: 0, events: 0 };

    const solitary = await execSql(conn, `
      SELECT f.exception_id FROM recon_run_findings f
      WHERE f.run_id=@run AND f.exception_id IS NOT NULL
      GROUP BY f.exception_id
      HAVING NOT EXISTS (
        SELECT 1 FROM recon_run_findings other
        WHERE other.exception_id = f.exception_id AND other.run_id <> @run
      )`, [int('run', runId)]);
    const orphanIds = solitary.map(row => row.exception_id);

    const sharedRows = await execSql(conn, `
      SELECT DISTINCT f.exception_id FROM recon_run_findings f
      WHERE f.run_id=@run AND f.exception_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM recon_run_findings other
          WHERE other.exception_id = f.exception_id AND other.run_id <> @run
        )`, [int('run', runId)]);
    const sharedIds = sharedRows.map(row => row.exception_id);

    onProgress({ stage: 'planned', orphans: orphanIds.length, shared: sharedIds.length });

    // Exceptions nothing else saw go entirely, with their detail and history.
    for (const chunk of idChunks(orphanIds)) {
      for (const table of ['recon_exception_values', 'recon_exception_differences', 'recon_exception_events']) {
        const predicate = idPredicate(chunk);
        await execSql(conn, 'DELETE FROM ' + table + ' WHERE exception_id IN (' + predicate.clause + ')', predicate.params);
      }
      const predicate = idPredicate(chunk);
      await execSql(conn, 'DELETE FROM recon_exceptions WHERE id IN (' + predicate.clause + ')', predicate.params);
      removed.exceptions += chunk.length;
      onProgress({ stage: 'exceptions', done: removed.exceptions, total: orphanIds.length });
    }

    // The run's own rows go before the survivors are repaired, so the recomputation
    // sees only the sightings that remain.
    const findingCount = await execSql(conn, 'SELECT COUNT(*) AS total FROM recon_run_findings WHERE run_id=@run', [int('run', runId)]);
    removed.findings = findingCount[0] ? Number(findingCount[0].total) : 0;
    await execSql(conn, 'DELETE FROM recon_run_findings WHERE run_id=@run', [int('run', runId)]);
    await execSql(conn, 'DELETE FROM recon_run_outcome_counts WHERE run_id=@run', [int('run', runId)]);
    onProgress({ stage: 'findings', done: removed.findings });

    // Survivors: first and last sighting, and the occurrence count, come from the
    // findings that are left.
    for (const chunk of idChunks(sharedIds)) {
      const predicate = idPredicate(chunk);
      await execSql(conn, `
        UPDATE e SET
          e.first_run_id = s.first_run,
          e.last_run_id = s.last_run,
          e.occurrence_count = s.sightings
        FROM recon_exceptions e
        JOIN (
          SELECT exception_id, MIN(run_id) AS first_run, MAX(run_id) AS last_run, COUNT(*) AS sightings
          FROM recon_run_findings WHERE exception_id IN (` + predicate.clause + `)
          GROUP BY exception_id
        ) AS s ON s.exception_id = e.id`, predicate.params);
      removed.repaired += chunk.length;
      onProgress({ stage: 'repaired', done: removed.repaired, total: sharedIds.length });
    }

    // Any exception still pointing at the deleted run — one from before findings
    // existed — is detached rather than left referencing something gone.
    await execSql(conn, 'UPDATE recon_exceptions SET last_run_id=NULL WHERE last_run_id=@run', [int('run', runId)]);
    await execSql(conn, 'UPDATE recon_exceptions SET first_run_id=NULL WHERE first_run_id=@run', [int('run', runId)]);

    await execSql(conn, 'DELETE FROM recon_runs WHERE id=@run', [int('run', runId)]);

    // Anything the run left without evidence goes too. Exceptions recorded before
    // per-run findings existed have no findings row, so they are invisible to the
    // attribution above and would otherwise outlive the run that produced them.
    const orphanRows = await execSql(conn,
      'SELECT TOP (5000) e.id FROM recon_exceptions e WHERE' + ORPHAN_PREDICATE);
    if (orphanRows.length) {
      const orphanIdList = orphanRows.map(row => row.id);
      for (const chunk of idChunks(orphanIdList)) {
        for (const table of ['recon_exception_values', 'recon_exception_differences', 'recon_exception_events']) {
          const predicate = idPredicate(chunk);
          await execSql(conn, 'DELETE FROM ' + table + ' WHERE exception_id IN (' + predicate.clause + ')', predicate.params);
        }
        const predicate = idPredicate(chunk);
        await execSql(conn, 'DELETE FROM recon_exceptions WHERE id IN (' + predicate.clause + ')', predicate.params);
        removed.exceptions += chunk.length;
      }
      onProgress({ stage: 'orphans', done: orphanIdList.length });
    }

    onProgress({ stage: 'done', ...removed });
    return removed;
  });
}

/**
 * Exceptions that no longer have a run behind them.
 *
 * An exception is evidence of what a run found. Once no run references it and no
 * findings record it, there is nothing left that says it was ever observed — it is
 * a leftover, not a finding. Deleting a run used to consider only exceptions its
 * findings pointed at, so anything recorded before per-run findings existed
 * survived its own run's deletion and kept appearing in the current state.
 */
async function countOrphanedExceptions() {
  return withConnection(async conn => {
    const rows = await execSql(conn, ORPHAN_COUNT_SQL);
    return rows[0] ? Number(rows[0].total) : 0;
  });
}

const ORPHAN_PREDICATE = `
  NOT EXISTS (SELECT 1 FROM recon_run_findings f WHERE f.exception_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM recon_runs r WHERE r.id = e.last_run_id)
  AND NOT EXISTS (SELECT 1 FROM recon_runs r2 WHERE r2.id = e.first_run_id)`;

const ORPHAN_COUNT_SQL = 'SELECT COUNT(*) AS total FROM recon_exceptions e WHERE' + ORPHAN_PREDICATE;

async function deleteOrphanedExceptions({ batchSize = 1000 } = {}) {
  return withConnection(async conn => {
    let removed = 0;
    for (;;) {
      const rows = await execSql(conn,
        'SELECT TOP (' + Math.max(1, Math.min(5000, batchSize)) + ') e.id FROM recon_exceptions e WHERE' + ORPHAN_PREDICATE);
      if (!rows.length) return removed;

      const ids = rows.map(row => row.id);
      for (const table of ['recon_exception_values', 'recon_exception_differences', 'recon_exception_events']) {
        const predicate = idPredicate(ids);
        await execSql(conn, 'DELETE FROM ' + table + ' WHERE exception_id IN (' + predicate.clause + ')', predicate.params);
      }
      const predicate = idPredicate(ids);
      await execSql(conn, 'DELETE FROM recon_exceptions WHERE id IN (' + predicate.clause + ')', predicate.params);
      removed += ids.length;
    }
  });
}

/** The runs of one rule, or every run, oldest first so deletion is deterministic. */
async function listRunIds({ ruleId } = {}) {
  return withConnection(async conn => {
    const rows = await execSql(conn,
      'SELECT id FROM recon_runs' + (ruleId ? ' WHERE rule_id=@rule' : '') + ' ORDER BY id',
      ruleId ? [int('rule', ruleId)] : []);
    return rows.map(row => row.id);
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

/**
 * Rules and, beneath each, the runs that contributed to what is standing now.
 *
 * The flat "rules with open exceptions" list answered how many, never which run
 * they came from — so a rule with a spike looked the same as one with a long tail.
 * Two queries: one row per rule, one row per rule and run, joined in memory. Two
 * reads rather than one per rule.
 *
 * `status` narrows both to one exception status; without it, everything still open.
 */
async function getRulesOverview({ status = null } = {}) {
  return withConnection(async conn => {
    const params = status ? [str('status', status)] : [];
    const filter = status ? 'e.status=@status' : "e.status NOT IN ('resolved','accepted')";

    const rules = await execSql(conn, `
      SELECT e.rule_id, MAX(e.rule_name) AS rule_name, MAX(e.business_area) AS business_area,
             COUNT(*) AS total,
             SUM(CASE WHEN e.severity='high' THEN 1 ELSE 0 END) AS high,
             SUM(CASE WHEN e.severity='medium' THEN 1 ELSE 0 END) AS medium,
             SUM(CASE WHEN e.severity='low' THEN 1 ELSE 0 END) AS low,
             MAX(e.occurrence_count) AS worst_recurrence,
             MAX(e.last_seen_at) AS last_seen
      FROM recon_exceptions e
      WHERE ${filter}
      GROUP BY e.rule_id
      ORDER BY COUNT(*) DESC`, params);

    // Which run each standing exception came from, so a rule expands into its runs.
    // An exception seen by several runs counts under each of them: the question is
    // "what did this run contribute", not "which run owns it".
    const byRun = await execSql(conn, `
      SELECT f.rule_id, f.run_id, COUNT(DISTINCT f.exception_id) AS total,
             MAX(r.started_at) AS started_at, MAX(r.rule_version) AS rule_version
      FROM recon_run_findings f
      JOIN recon_exceptions e ON e.id = f.exception_id
      LEFT JOIN recon_runs r ON r.id = f.run_id
      WHERE ${filter}
      GROUP BY f.rule_id, f.run_id
      ORDER BY f.rule_id, MAX(r.started_at) DESC`, status ? [str('status', status)] : []);

    const runsByRule = new Map();
    for (const row of byRun) {
      if (!runsByRule.has(row.rule_id)) runsByRule.set(row.rule_id, []);
      runsByRule.get(row.rule_id).push({
        runId: row.run_id,
        total: Number(row.total),
        startedAt: row.started_at,
        ruleVersion: row.rule_version,
        // A run whose row is gone still shows its contribution, labelled as deleted
        // rather than silently dropped.
        deleted: row.started_at === null || row.started_at === undefined,
      });
    }

    return rules.map(rule => {
      const runs = runsByRule.get(rule.rule_id) || [];
      const attributed = runs.reduce((sum, run) => sum + run.total, 0);
      return {
        ruleId: rule.rule_id,
        ruleName: rule.rule_name,
        businessArea: rule.business_area,
        total: Number(rule.total),
        high: Number(rule.high), medium: Number(rule.medium), low: Number(rule.low),
        worstRecurrence: Number(rule.worst_recurrence),
        lastSeen: rule.last_seen,
        runs,
        // Exceptions with no findings behind them — recorded before per-run findings
        // existed. Saying so beats a hierarchy that quietly does not add up.
        unattributed: Math.max(0, Number(rule.total) - attributed),
      };
    });
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
  createRun, completeRun, listRuns, getRunById, getRunOutcomeCounts,
  deleteRun, getRunDeletionImpact, listRunIds,
  countOrphanedExceptions, deleteOrphanedExceptions,
  normalizeLegacyRows,
  recordExceptions, listRunFindings, hasRunFindings, listFindingsForRuns,
  listExceptions, countExceptions, listExceptionsForAction, listExceptionPage,
  getExceptionById, getExceptionsByIds, getExceptionEvents,
  batchUpdateExceptions,
  updateExceptionStatus, assignException, commentOnException,
  getDashboardData, getRulesOverview,
  EXCEPTION_STATUS,
  _private: { planExceptionChange, exceptionUpdateFor, chunkByParams },
};
