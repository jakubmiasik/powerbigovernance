const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const repo = require('../services/reconciliationRepository');
const { createPowerBIService } = require('../services/powerbiService');
const {
  reconcile, OUTCOME_DEFS, STATUS_DEFS, STATUS_BY_KEY, RULE_STATUS,
  isStatusTransitionAllowed, EXCEPTION_STATUS, OPERAND_KINDS,
  planRule, validateCompareFields, normalizeCompareField,
} = require('../services/reconciliationService');
const sqlSource = require('../services/sqlSourceService');
const { encryptSecret, isEncryptionConfigured } = require('../services/secretCryptoService');
const { compareRuns, compareAcrossRules, latestPairsByRule, VERDICT_DEFS, SEVERITY_LEVELS } = require('../services/reconciliationComparisonService');

const SOURCE_KIND = { FABRIC: 'fabric-sql', EXTERNAL: 'external-sql' };

// The reconciliation area is not tied to an analysis scan, so the global
// "Service Principal / Scan" bar would suggest a relationship that does not exist.
function view(res, template, locals) {
  return res.render(template, { hideRunSelector: true, ...locals });
}

function actorOf(req) {
  return (req.user && (req.user.name || req.user.email)) || 'anonymous';
}

/**
 * The service principal a source belongs to.
 *
 * A source names its own tenant, so reconciliation never has to guess which
 * credential to use — guessing is wrong as soon as more than one tenant is
 * configured, and it fails in a way that looks like a permission problem.
 */
async function getPbiServiceForSp(spId) {
  const sp = spId ? await db.getServicePrincipalById(spId) : null;
  if (!sp) {
    throw new Error('This source has no service principal recorded, or the one it named has been removed. Re-register it and pick a tenant.');
  }
  return createPowerBIService(sp);
}

// ── Source visibility ──
// Candidate sources come from the artifact details already collected by an
// analysis run, so browsing what is available costs nothing and works even when
// the Fabric APIs are unavailable.
function extractCandidates(run) {
  const candidates = [];
  let workspaces = [];
  try {
    workspaces = JSON.parse((run && run.results_json) || '{}').workspaces || [];
  } catch { workspaces = []; }

  for (const workspace of workspaces) {
    for (const item of workspace.items || []) {
      const type = (item.type || '').toLowerCase();
      if (type !== 'lakehouse' && type !== 'warehouse') continue;
      candidates.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        itemId: item.id,
        itemName: item.name,
        itemType: item.type,
      });
    }
  }
  return candidates.sort((a, b) =>
    (a.workspaceName || '').localeCompare(b.workspaceName || '') || (a.itemName || '').localeCompare(b.itemName || ''));
}

/** The most recent completed analysis run for a service principal, if there is one. */
function latestRunForSp(runs, spId) {
  const wanted = Number.parseInt(spId, 10);
  return (runs || []).find(run =>
    Number(run.sp_id) === wanted && run.status === 'completed') || null;
}

/**
 * The datasets and fields a rule author picks from.
 *
 * A Fabric source reads the schema captured by an analysis run, so browsing costs
 * no API calls. An external database has no analysis run behind it, so its schema
 * is read once at registration and stored on the source row.
 */
async function loadSourceDatasets(source) {
  if (!source) return [];

  if (source.schema_json) {
    try {
      const stored = JSON.parse(source.schema_json);
      if (Array.isArray(stored) && stored.length) return stored;
    } catch { /* fall through to the analysis-run schema */ }
  }

  if (!source.workspace_id || !source.item_id) return [];
  const cached = await db.getItemDetailsCache(source.workspace_id, source.item_id);
  if (!cached || !cached.payload) return [];
  let payload;
  try { payload = JSON.parse(cached.payload); } catch { return []; }

  const section = (payload.sections || []).find(s => s.key === 'sqlendpoint');
  if (!section || !Array.isArray(section.groups)) return [];
  return section.groups.map(group => ({
    name: group.label,
    kind: (group.badges && group.badges[0] && group.badges[0].text) || 'Table',
    fields: (group.rows || []).map(row => ({ name: row[0], dataType: row[1], nullable: row[2] === 'Yes' })),
  }));
}

router.get('/', async (req, res) => {
  const runId = req.query.runId ? Number.parseInt(req.query.runId, 10) : null;
  try {
    const [data, runs] = await Promise.all([
      repo.getDashboardData({ runId }),
      repo.listRuns({ limit: 200 }),
    ]);
    view(res, 'reconciliation/dashboard', {
      title: 'Reconciliation', user: req.user, data, runs, selectedRunId: runId,
      outcomeDefs: OUTCOME_DEFS, statusDefs: STATUS_DEFS, error: null,
    });
  } catch (err) {
    view(res, 'reconciliation/dashboard', {
      title: 'Reconciliation', user: req.user, data: null, runs: [], selectedRunId: runId,
      outcomeDefs: OUTCOME_DEFS, statusDefs: STATUS_DEFS, error: err.message,
    });
  }
});

router.get('/sources', async (req, res) => {
  const base = {
    title: 'Reconciliation Sources', user: req.user,
    authModes: sqlSource.AUTH_MODES,
    canStoreSecrets: isEncryptionConfigured(),
  };
  try {
    const [sources, servicePrincipals, analysisRuns] = await Promise.all([
      repo.listSources(), db.getServicePrincipals(), db.getAnalysisRuns(),
    ]);
    const datasetsBySource = {};
    for (const source of sources) {
      datasetsBySource[source.id] = await loadSourceDatasets(source);
    }
    // Which tenants have a scan to pick items from, so the page can say so before
    // the user selects one and finds an empty list.
    const scanBySp = {};
    for (const sp of servicePrincipals) {
      const run = latestRunForSp(analysisRuns, sp.id);
      scanBySp[sp.id] = run ? { id: run.id, startedAt: run.started_at } : null;
    }
    view(res, 'reconciliation/sources', {
      ...base, sources, servicePrincipals, scanBySp, datasetsBySource, error: null,
    });
  } catch (err) {
    view(res, 'reconciliation/sources', {
      ...base, sources: [], servicePrincipals: [], scanBySp: {}, datasetsBySource: {}, error: err.message,
    });
  }
});

/** Fabric items available in a tenant, taken from that tenant's most recent scan. */
router.get('/sources/candidates', async (req, res) => {
  try {
    const spId = Number.parseInt(req.query.spId, 10);
    if (!Number.isFinite(spId)) return res.json({ success: false, message: 'Select a tenant first.' });

    const runs = await db.getAnalysisRuns();
    const latest = latestRunForSp(runs, spId);
    if (!latest) {
      return res.json({
        success: true, candidates: [],
        message: 'No completed analysis run for this tenant yet. Run an analysis so its lakehouses and warehouses are discovered.',
      });
    }
    const run = await db.getAnalysisRunById(latest.id);
    res.json({ success: true, runId: latest.id, candidates: extractCandidates(run) });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Registering a Fabric item ──
router.post('/sources', async (req, res) => {
  try {
    const { workspaceId, itemId, workspaceName, itemName, itemType, systemLabel, spId } = req.body;
    if (!workspaceId || !itemId) return res.json({ success: false, message: 'Pick an item to register.' });
    if (!spId) return res.json({ success: false, message: 'Pick the tenant this item belongs to.' });

    const sp = await db.getServicePrincipalById(Number.parseInt(spId, 10));
    if (!sp) return res.json({ success: false, message: 'That service principal is no longer configured.' });

    // The connection string is resolved once, at registration, so runs do not have
    // to rediscover it every time.
    let connectionString = null;
    let databaseName = itemName;
    try {
      const pbi = createPowerBIService(sp);
      const endpoint = await pbi.getSqlEndpointInfo(workspaceId, itemId, itemType);
      if (endpoint) {
        connectionString = endpoint.connectionString;
        databaseName = endpoint.database;
      }
    } catch (endpointErr) {
      return res.json({ success: false, message: 'Could not read the SQL endpoint: ' + endpointErr.message });
    }
    if (!connectionString) {
      return res.json({ success: false, message: 'This item does not expose a SQL analytics endpoint.' });
    }

    const id = await repo.saveSource({
      name: itemName || itemId,
      systemLabel: systemLabel || null,
      kind: SOURCE_KIND.FABRIC,
      workspaceId, workspaceName, itemId, itemType,
      spId: sp.id, spName: sp.name, tenantId: sp.tenant_id,
      connectionString, databaseName,
      createdBy: actorOf(req),
    });
    res.json({ success: true, id });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Registering any other SQL Server or Azure SQL database ──
function readExternalBody(body) {
  return {
    id: body.id || null,
    name: (body.name || '').trim(),
    systemLabel: (body.systemLabel || '').trim() || null,
    server: (body.server || '').trim(),
    database: (body.database || '').trim(),
    port: body.port || null,
    authMode: body.authMode === 'sql' ? 'sql' : 'entra',
    username: (body.username || '').trim() || null,
    password: body.password === undefined ? undefined : String(body.password),
  };
}

function validateExternal(input) {
  if (!input.name) return 'Give the source a name.';
  if (!input.server) return 'Enter the server, for example myserver.database.windows.net.';
  if (!input.database) return 'Enter the database name.';
  if (input.authMode === 'sql') {
    if (!input.username) return 'A SQL login needs a username.';
    if (!input.password) return 'A SQL login needs a password.';
    if (!isEncryptionConfigured()) {
      return 'SECRET_ENCRYPTION_KEY is not configured on this application, so a SQL password cannot be stored. Use Entra ID authentication instead, or set that app setting.';
    }
  }
  return null;
}

// Shapes the form input into what the connector reads, so testing and registering
// take exactly the same path — a test that passes cannot then fail on registration.
function externalSourceRow(input, storedPassword) {
  return {
    connection_string: input.server,
    database_name: input.database,
    sql_port: input.port,
    auth_mode: input.authMode,
    sql_username: input.username,
    sql_password: storedPassword,
  };
}

router.post('/sources/external/test', async (req, res) => {
  const input = readExternalBody(req.body);
  const problem = validateExternal(input);
  if (problem) return res.json({ success: false, message: problem });
  try {
    let password = input.password ? encryptSecret(input.password) : null;
    if (input.id && input.password === undefined) {
      // Testing an existing source without retyping its password.
      const existing = await repo.getSourceById(Number.parseInt(input.id, 10));
      password = existing ? existing.sql_password : null;
    }
    const info = await sqlSource.testConnection(externalSourceRow(input, password));
    res.json({ success: true, info });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.post('/sources/external', async (req, res) => {
  const input = readExternalBody(req.body);
  const problem = validateExternal(input);
  if (problem) return res.json({ success: false, message: problem });

  try {
    const password = input.password ? encryptSecret(input.password) : undefined;
    const row = externalSourceRow(input, password === undefined ? null : password);

    // The schema is read now rather than at rule-authoring time, so an unreachable
    // database is reported to the person registering it.
    let datasets;
    try {
      datasets = await sqlSource.readSchema(row);
    } catch (err) {
      return res.json({ success: false, message: 'Could not read the database: ' + err.message });
    }
    if (!datasets.length) {
      return res.json({ success: false, message: 'Connected, but this identity cannot see any tables or views in that database. Grant it read access.' });
    }

    const id = await repo.saveSource({
      id: input.id || null,
      name: input.name,
      systemLabel: input.systemLabel,
      kind: SOURCE_KIND.EXTERNAL,
      connectionString: input.server,
      databaseName: input.database,
      authMode: input.authMode,
      sqlPort: input.port,
      sqlUsername: input.username,
      sqlPassword: password,
      schemaJson: JSON.stringify(datasets),
      createdBy: actorOf(req),
    });
    res.json({ success: true, id, datasets: datasets.length });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/** Re-reads an external source's schema after the database has changed. */
router.post('/sources/:id/refresh-schema', async (req, res) => {
  try {
    const source = await repo.getSourceById(Number.parseInt(req.params.id, 10));
    if (!source) return res.json({ success: false, message: 'Source not found.' });
    if (source.kind !== SOURCE_KIND.EXTERNAL) {
      return res.json({ success: false, message: 'A Fabric item\'s schema comes from an analysis run. Run an analysis to refresh it.' });
    }
    const datasets = await sqlSource.readSchema(source);
    await repo.saveSourceSchema(source.id, JSON.stringify(datasets));
    res.json({ success: true, datasets: datasets.length });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.delete('/sources/:id', async (req, res) => {
  try {
    await repo.deleteSource(Number.parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.get('/sources/:id/datasets', async (req, res) => {
  try {
    const source = await repo.getSourceById(Number.parseInt(req.params.id, 10));
    if (!source) return res.json({ success: false, message: 'Source not found.' });
    const datasets = await loadSourceDatasets(source);
    res.json({
      success: true,
      datasets,
      // Say plainly when the schema has never been captured, rather than showing
      // an empty picker that looks like the source has no tables.
      message: datasets.length ? null : 'No schema captured for this source yet. Run an analysis so its SQL endpoint is read.',
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Rules ──
router.get('/rules', async (req, res) => {
  try {
    const [rules, owners] = await Promise.all([repo.listRules(), repo.listOwners()]);
    view(res, 'reconciliation/rules', { title: 'Reconciliation Rules', user: req.user, rules, owners, error: null });
  } catch (err) {
    view(res, 'reconciliation/rules', { title: 'Reconciliation Rules', user: req.user, rules: [], owners: [], error: err.message });
  }
});

router.get('/rules/new', async (req, res) => {
  try {
    const sources = await repo.listSources();
    view(res, 'reconciliation/rule-form', {
      title: 'New Reconciliation Rule', user: req.user, rule: null, sources, versions: [], error: null,
      operandKinds: OPERAND_KINDS,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/rules/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const [rule, sources, versions] = await Promise.all([
      repo.getRuleById(id), repo.listSources(), repo.getRuleVersions(id),
    ]);
    if (!rule) return res.render('error', { title: 'Error', user: req.user, message: 'Rule not found.' });
    view(res, 'reconciliation/rule-form', {
      title: 'Rule: ' + rule.name, user: req.user, rule, sources, versions, error: null,
      operandKinds: OPERAND_KINDS,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

function readRuleBody(body) {
  let compareFields = [];
  try {
    compareFields = typeof body.compareFields === 'string' ? JSON.parse(body.compareFields) : (body.compareFields || []);
  } catch { compareFields = []; }

  return {
    name: (body.name || '').trim(),
    description: body.description || null,
    businessArea: body.businessArea || null,
    owner: body.owner || null,
    priority: body.priority || 'medium',
    sourceAId: body.sourceAId, sourceBId: body.sourceBId,
    datasetA: body.datasetA, datasetB: body.datasetB,
    keyFieldA: body.keyFieldA, keyFieldB: body.keyFieldB,
    // Keep whatever operand shape the form sent; the engine normalizes legacy rows.
    compareFields: compareFields
      .filter(Boolean)
      .map((field, index) => normalizeCompareField(field, index)),
    duplicateHandling: body.duplicateHandling || 'exception',
    incompleteKeyHandling: body.incompleteKeyHandling || 'exception',
    rowLimit: body.rowLimit || null,
  };
}

function validateRule(rule) {
  if (!rule.name) return 'The rule needs a name.';
  if (!rule.sourceAId || !rule.sourceBId) return 'Both sources must be selected.';
  if (!rule.datasetA || !rule.datasetB) return 'A dataset must be selected in each source.';
  if (!rule.keyFieldA || !rule.keyFieldB) return 'The business key must be named in both sources.';
  if (!rule.compareFields.length) return 'Select at least one value to compare.';
  // Expressions are author-written SQL, so they are checked before the rule can be
  // saved rather than failing at run time against the live source.
  const problems = validateCompareFields(rule.compareFields);
  if (problems.length) return problems.join(' ');
  return null;
}

router.post('/rules', async (req, res) => {
  try {
    const rule = readRuleBody(req.body);
    const problem = validateRule(rule);
    if (problem) return res.json({ success: false, message: problem });
    const id = await repo.createRule(rule, actorOf(req));
    res.json({ success: true, id });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.put('/rules/:id', async (req, res) => {
  try {
    const rule = readRuleBody(req.body);
    const problem = validateRule(rule);
    if (problem) return res.json({ success: false, message: problem });
    const version = await repo.updateRule(Number.parseInt(req.params.id, 10), rule, actorOf(req), req.body.changeNote);
    res.json({ success: true, version });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/**
 * A rule that cannot run must never be presented to operators as active, so
 * activation re-validates the stored definition rather than trusting that it was
 * valid when it was written.
 */
async function activationProblem(id) {
  const rule = await repo.getRuleById(id);
  if (!rule) return 'Rule not found.';
  return validateRule({
    name: rule.name, sourceAId: rule.source_a_id, sourceBId: rule.source_b_id,
    datasetA: rule.dataset_a, datasetB: rule.dataset_b,
    keyFieldA: rule.key_field_a, keyFieldB: rule.key_field_b, compareFields: rule.compareFields,
  });
}

function isKnownStatus(status) {
  return [RULE_STATUS.DRAFT, RULE_STATUS.ACTIVE, RULE_STATUS.RETIRED].includes(status);
}

router.post('/rules/:id/status', async (req, res) => {
  try {
    const status = req.body.status;
    if (!isKnownStatus(status)) return res.json({ success: false, message: 'Unknown rule status.' });

    const id = Number.parseInt(req.params.id, 10);
    if (status === RULE_STATUS.ACTIVE) {
      const problem = await activationProblem(id);
      if (problem) return res.json({ success: false, message: 'Cannot activate: ' + problem });
    }
    await repo.setRuleStatus(id, status, actorOf(req));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/**
 * Applies a status change and/or an owner to several rules at once.
 *
 * Rules are checked individually and reported individually: a batch that includes
 * one incomplete rule should move the others and say which one it could not
 * activate, rather than refusing the whole operation or — worse — activating a
 * control that cannot run.
 */
router.post('/rules/batch', async (req, res) => {
  try {
    const ids = [].concat(req.body.ruleIds || [])
      .map(id => Number.parseInt(id, 10))
      .filter(Number.isFinite);
    if (!ids.length) return res.json({ success: false, message: 'Select at least one rule.' });

    const status = req.body.status || null;
    const assignOwner = req.body.assignOwner === true || req.body.assignOwner === 'true';
    const owner = (req.body.owner || '').trim() || null;
    if (!status && !assignOwner) {
      return res.json({ success: false, message: 'Choose a status to apply, an owner to assign, or both.' });
    }
    if (status && !isKnownStatus(status)) return res.json({ success: false, message: 'Unknown rule status.' });

    const rules = await repo.listRules();
    const byId = new Map(rules.map(rule => [Number(rule.id), rule]));

    const eligible = [];
    const skipped = [];
    for (const id of ids) {
      const rule = byId.get(id);
      if (!rule) { skipped.push({ id, name: 'Rule #' + id, message: 'No longer exists.' }); continue; }
      if (status === RULE_STATUS.ACTIVE) {
        const problem = await activationProblem(id);
        if (problem) { skipped.push({ id, name: rule.name, message: problem }); continue; }
      }
      eligible.push(id);
    }

    const results = eligible.length ? await repo.batchUpdateRules(eligible, { status, owner, assignOwner }, actorOf(req)) : [];
    const failed = results.filter(result => !result.success)
      .map(result => ({ id: result.id, name: (byId.get(result.id) || {}).name, message: result.message }));

    res.json({
      success: true,
      updated: results.filter(result => result.success).length,
      skipped: skipped.concat(failed),
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.delete('/rules/:id', async (req, res) => {
  try {
    await repo.deleteRule(Number.parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Execution ──
/**
 * Reads one side of a comparison, whatever kind of system it is.
 *
 * A Fabric item is reached with its own tenant's service principal; a registered
 * database is reached directly. Both return the same aliased shape, because the
 * projection is planned once and built by the same code for either path.
 */
async function readSourceRows(source, { dataset, selections, rowLimit }) {
  if (source.kind === SOURCE_KIND.EXTERNAL) {
    return sqlSource.readRows(source, { dataset, selections, rowLimit });
  }
  const pbi = await getPbiServiceForSp(source.sp_id);
  return pbi.readSqlEndpointRows(
    { connectionString: source.connection_string, database: source.database_name },
    { dataset, selections, rowLimit }
  );
}

async function executeRule(rule) {
  const [sourceA, sourceB] = await Promise.all([
    repo.getSourceById(rule.source_a_id), repo.getSourceById(rule.source_b_id),
  ]);
  if (!sourceA || !sourceB) throw new Error('One of the rule\'s sources is no longer registered.');

  // Planning decides what each source must SELECT — columns, expressions, aliases —
  // and leaves constants out of the query entirely.
  const plan = planRule({
    keyFieldA: rule.key_field_a,
    keyFieldB: rule.key_field_b,
    compareFields: rule.compareFields,
    duplicateHandling: rule.duplicate_handling,
    incompleteKeyHandling: rule.incomplete_key_handling,
    priority: rule.priority,
  });

  const [rowsA, rowsB] = await Promise.all([
    readSourceRows(sourceA, { dataset: rule.dataset_a, selections: plan.selectionsA, rowLimit: rule.row_limit }),
    readSourceRows(sourceB, { dataset: rule.dataset_b, selections: plan.selectionsB, rowLimit: rule.row_limit }),
  ]);

  return reconcile({ rowsA, rowsB, rule: plan.engineRule });
}

router.post('/run', async (req, res) => {
  const ruleIds = []
    .concat(req.body.ruleIds || req.body.ruleId || [])
    .map(id => Number.parseInt(id, 10))
    .filter(Number.isFinite);
  if (!ruleIds.length) return res.json({ success: false, message: 'Select at least one rule to run.' });

  const results = [];
  try {
    for (const ruleId of ruleIds) {
      const rule = await repo.getRuleById(ruleId);
      if (!rule) {
        results.push({ ruleId, success: false, message: 'Rule not found.' });
        continue;
      }
      if (rule.status !== RULE_STATUS.ACTIVE) {
        results.push({ ruleId, ruleName: rule.name, success: false, message: 'Only active rules can be run.' });
        continue;
      }

      // The run row is created before execution so an interrupted run is still
      // visible in the history rather than disappearing.
      const runId = await repo.createRun({
        ruleId, ruleVersion: rule.version, ruleName: rule.name, runBy: actorOf(req),
      });
      try {
        const outcome = await executeRule(rule);
        const recorded = await repo.recordExceptions(runId, rule, outcome.exceptions);
        await repo.completeRun(runId, { status: 'completed', summary: outcome.summary });
        results.push({
          ruleId, runId, ruleName: rule.name, success: true,
          summary: outcome.summary, recorded,
        });
      } catch (runErr) {
        await repo.completeRun(runId, { status: 'failed', summary: null, error: runErr.message });
        results.push({ ruleId, runId, ruleName: rule.name, success: false, message: runErr.message });
      }
    }
    res.json({ success: true, results });
  } catch (err) {
    res.json({ success: false, message: err.message, results });
  }
});

router.get('/runs', async (req, res) => {
  try {
    const [runs, rules] = await Promise.all([repo.listRuns({}), repo.listRules()]);
    view(res, 'reconciliation/runs', { title: 'Reconciliation Runs', user: req.user, runs, rules, error: null });
  } catch (err) {
    view(res, 'reconciliation/runs', { title: 'Reconciliation Runs', user: req.user, runs: [], rules: [], error: err.message });
  }
});

/**
 * Comparing two runs of the same control.
 *
 * The run list is grouped by rule, because only runs of the same rule can be
 * compared — the page offers the pairs that make sense rather than letting the user
 * assemble a meaningless one and then refusing it.
 */
router.get('/compare', async (req, res) => {
  const fromId = req.query.from ? Number.parseInt(req.query.from, 10) : null;
  const toId = req.query.to ? Number.parseInt(req.query.to, 10) : null;

  const base = { title: 'Compare Reconciliation Runs', user: req.user, verdictDefs: VERDICT_DEFS };
  try {
    const runs = (await repo.listRuns({ limit: 300 })).filter(run => run.status === 'completed');

    // Every rule's own latest pair, so the page opens on "how is each control
    // moving" rather than on an empty form. One read covers all of them.
    let overview = [];
    try {
      const pairRunIds = latestPairsByRule(runs)
        .flatMap(pair => [pair.later, pair.earlier])
        .filter(Boolean)
        .map(run => run.id);
      const findings = await repo.listFindingsForRuns(pairRunIds);
      overview = compareAcrossRules({ runs, findings });
    } catch (overviewErr) {
      console.warn('[Reconciliation] Could not build the per-rule comparison:', overviewErr.message);
    }

    if (!fromId || !toId) {
      return view(res, 'reconciliation/compare', {
        ...base, runs, overview, comparison: null, fromId, toId, error: null, notice: null,
      });
    }

    const [fromRun, toRun] = await Promise.all([repo.getRunById(fromId), repo.getRunById(toId)]);
    if (!fromRun || !toRun) {
      return view(res, 'reconciliation/compare', {
        ...base, runs, overview, comparison: null, fromId, toId, notice: null, error: 'One of the selected runs no longer exists.',
      });
    }

    const [findingsFrom, findingsTo] = await Promise.all([
      repo.listRunFindings(fromId), repo.listRunFindings(toId),
    ]);

    let comparison = null;
    let error = null;
    try {
      comparison = compareRuns({ fromRun, toRun, findingsFrom, findingsTo });
    } catch (compareErr) {
      error = compareErr.message;
    }

    // A run from before per-run findings were kept has none. Its totals still
    // compare, but item-level movement would read as "everything was fixed", so say
    // so rather than presenting an answer that is not true.
    const missingDetail = [];
    if (comparison) {
      if (!findingsFrom.length && Number(fromRun.exception_count) > 0) missingDetail.push('#' + fromRun.id);
      if (!findingsTo.length && Number(toRun.exception_count) > 0) missingDetail.push('#' + toRun.id);
    }
    const notice = missingDetail.length
      ? 'Run ' + missingDetail.join(' and ') + ' recorded exceptions but no per-item detail, because it ran before findings were kept per run. The totals below are accurate; the item lists are not.'
      : null;

    view(res, 'reconciliation/compare', { ...base, runs, overview, comparison, fromId, toId, error, notice });
  } catch (err) {
    view(res, 'reconciliation/compare', {
      ...base, runs: [], overview: [], comparison: null, fromId, toId, notice: null, error: err.message,
    });
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const run = await repo.getRunById(id);
    if (!run) return res.render('error', { title: 'Error', user: req.user, message: 'Run not found.' });
    const exceptions = await repo.listExceptions({ runId: id });
    view(res, 'reconciliation/run-detail', {
      title: 'Run #' + id, user: req.user, run, exceptions, outcomeDefs: OUTCOME_DEFS,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// ── Exceptions ──
router.get('/exceptions', async (req, res) => {
  try {
    const filters = {
      status: req.query.status || null,
      severity: req.query.severity || null,
      outcome: req.query.outcome || null,
      ruleId: req.query.ruleId ? Number.parseInt(req.query.ruleId, 10) : null,
      openOnly: req.query.status ? false : req.query.all !== '1',
    };
    const [exceptions, rules, owners] = await Promise.all([
      repo.listExceptions(filters), repo.listRules(), repo.listOwners(),
    ]);
    view(res, 'reconciliation/exceptions', {
      title: 'Reconciliation Exceptions', user: req.user, exceptions, rules, owners,
      filters: { ...filters, all: req.query.all === '1' },
      outcomeDefs: OUTCOME_DEFS, statusDefs: STATUS_DEFS, severityLevels: SEVERITY_LEVELS, error: null,
    });
  } catch (err) {
    view(res, 'reconciliation/exceptions', {
      title: 'Reconciliation Exceptions', user: req.user, exceptions: [], rules: [], owners: [],
      filters: {}, outcomeDefs: OUTCOME_DEFS, statusDefs: STATUS_DEFS, severityLevels: SEVERITY_LEVELS, error: err.message,
    });
  }
});

/**
 * Applies one decision — owner, severity, status, or a combination — to several
 * exceptions.
 *
 * The lifecycle is still enforced per exception. A selection routinely mixes
 * statuses, so a bulk move to "resolved" is legitimate for the open ones and not
 * for those already closed; the ones that can move do, and the rest are named with
 * the reason. Silently skipping them, or forcing the transition, would both put the
 * audit trail at odds with the process it is meant to evidence.
 */
router.post('/exceptions/batch', async (req, res) => {
  try {
    const ids = [].concat(req.body.ids || [])
      .map(id => Number.parseInt(id, 10))
      .filter(Number.isFinite);
    if (!ids.length) return res.json({ success: false, message: 'Select at least one exception.' });

    const assignOwner = req.body.assignOwner === true || req.body.assignOwner === 'true';
    const owner = (req.body.owner || '').trim() || null;
    const severity = req.body.severity || null;
    const toStatus = req.body.status || null;
    const comment = (req.body.comment || '').trim() || null;
    const reason = (req.body.reason || '').trim() || null;

    if (!assignOwner && !severity && !toStatus && !comment) {
      return res.json({ success: false, message: 'Choose an owner, a severity, a status, or add a comment.' });
    }
    if (severity && !SEVERITY_LEVELS.includes(severity)) {
      return res.json({ success: false, message: 'Unknown severity.' });
    }
    if (toStatus && !STATUS_BY_KEY.has(toStatus)) {
      return res.json({ success: false, message: 'Unknown status.' });
    }
    // Closing requires a recorded reason whether one exception is closed or fifty.
    if (toStatus && (toStatus === EXCEPTION_STATUS.RESOLVED || toStatus === EXCEPTION_STATUS.ACCEPTED) && !reason) {
      return res.json({ success: false, message: 'Record why these exceptions are being closed.' });
    }

    const exceptions = await repo.getExceptionsByIds(ids);
    const found = new Map(exceptions.map(exception => [Number(exception.id), exception]));

    const eligible = [];
    const skipped = [];
    for (const id of ids) {
      const exception = found.get(id);
      if (!exception) { skipped.push({ id, key: '#' + id, message: 'No longer exists.' }); continue; }
      if (toStatus && toStatus !== exception.status && !isStatusTransitionAllowed(exception.status, toStatus)) {
        skipped.push({
          id, key: exception.business_key,
          message: 'Cannot move from "' + exception.status + '" to "' + toStatus + '".',
        });
        continue;
      }
      eligible.push(exception);
    }

    const results = eligible.length
      ? await repo.batchUpdateExceptions(eligible, {
        owner, assignOwner, severity, toStatus, comment, reason, actor: actorOf(req),
      })
      : [];

    const failed = results.filter(result => !result.success).map(result => ({
      id: result.id,
      key: (found.get(result.id) || {}).business_key || ('#' + result.id),
      message: result.message,
    }));

    res.json({
      success: true,
      updated: results.filter(result => result.success && result.changed).length,
      unchanged: results.filter(result => result.success && !result.changed).length,
      skipped: skipped.concat(failed),
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.get('/exceptions/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const [exception, events] = await Promise.all([repo.getExceptionById(id), repo.getExceptionEvents(id)]);
    if (!exception) return res.render('error', { title: 'Error', user: req.user, message: 'Exception not found.' });
    const current = STATUS_BY_KEY.get(exception.status);
    view(res, 'reconciliation/exception-detail', {
      title: 'Exception #' + id, user: req.user, exception, events,
      statusDefs: STATUS_DEFS,
      allowedNext: current ? current.next : [EXCEPTION_STATUS.OPEN],
      outcomeDefs: OUTCOME_DEFS,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.post('/exceptions/:id/status', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const exception = await repo.getExceptionById(id);
    if (!exception) return res.json({ success: false, message: 'Exception not found.' });

    const toStatus = req.body.status;
    if (!STATUS_BY_KEY.has(toStatus)) return res.json({ success: false, message: 'Unknown status.' });
    // The lifecycle is controlled: an unsupported jump is refused so the history
    // cannot record a transition the process does not allow.
    if (!isStatusTransitionAllowed(exception.status, toStatus)) {
      return res.json({
        success: false,
        message: 'Cannot move an exception from "' + exception.status + '" to "' + toStatus + '".',
      });
    }
    const closing = toStatus === EXCEPTION_STATUS.RESOLVED || toStatus === EXCEPTION_STATUS.ACCEPTED;
    if (closing && !(req.body.reason || '').trim()) {
      return res.json({ success: false, message: 'Record why this exception is being closed.' });
    }

    await repo.updateExceptionStatus(id, {
      fromStatus: exception.status, toStatus,
      owner: req.body.owner || null, comment: req.body.comment || null,
      reason: req.body.reason || null, actor: actorOf(req),
    });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.post('/exceptions/:id/assign', async (req, res) => {
  try {
    await repo.assignException(Number.parseInt(req.params.id, 10), req.body.owner || null, actorOf(req));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.post('/exceptions/:id/comment', async (req, res) => {
  try {
    const comment = (req.body.comment || '').trim();
    if (!comment) return res.json({ success: false, message: 'Enter a comment.' });
    await repo.commentOnException(Number.parseInt(req.params.id, 10), comment, actorOf(req));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
