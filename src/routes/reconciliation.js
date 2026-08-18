const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const repo = require('../services/reconciliationRepository');
const { createPowerBIService } = require('../services/powerbiService');
const {
  reconcile, OUTCOME_DEFS, STATUS_DEFS, STATUS_BY_KEY, RULE_STATUS,
  isStatusTransitionAllowed, EXCEPTION_STATUS,
} = require('../services/reconciliationService');

function actorOf(req) {
  return (req.user && (req.user.name || req.user.email)) || 'anonymous';
}

async function getPbiService(res) {
  const globalRun = res ? res.locals.globalRun : null;
  let sp;
  if (globalRun && globalRun.sp_id) sp = await db.getServicePrincipalById(globalRun.sp_id);
  if (!sp) {
    const sps = await db.getServicePrincipals();
    if (!sps.length) throw new Error('No service principal configured. Go to Settings to add one.');
    sp = sps[0];
  }
  return createPowerBIService(sp);
}

// ── Source visibility ──
// Candidate sources come from the artifact details already collected by an
// analysis run, so browsing what is available costs nothing and works even when
// the Fabric APIs are unavailable.
async function loadCandidateSources(req, res) {
  const candidates = [];
  const globalRun = res.locals.globalRun;
  if (!globalRun) return candidates;

  const run = await db.getAnalysisRunById(globalRun.id);
  let workspaces = [];
  try {
    workspaces = JSON.parse(run.results_json || '{}').workspaces || [];
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

// The schema captured for an item during the last analysis run, reshaped into the
// datasets and fields a rule author picks from.
async function loadSourceDatasets(source) {
  if (!source || !source.workspace_id || !source.item_id) return [];
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
  try {
    const data = await repo.getDashboardData();
    res.render('reconciliation/dashboard', {
      title: 'Reconciliation', user: req.user, data,
      outcomeDefs: OUTCOME_DEFS, statusDefs: STATUS_DEFS, error: null,
    });
  } catch (err) {
    res.render('reconciliation/dashboard', {
      title: 'Reconciliation', user: req.user, data: null,
      outcomeDefs: OUTCOME_DEFS, statusDefs: STATUS_DEFS, error: err.message,
    });
  }
});

router.get('/sources', async (req, res) => {
  try {
    const [sources, candidates] = await Promise.all([repo.listSources(), loadCandidateSources(req, res)]);
    const datasetsBySource = {};
    for (const source of sources) {
      datasetsBySource[source.id] = await loadSourceDatasets(source);
    }
    res.render('reconciliation/sources', {
      title: 'Reconciliation Sources', user: req.user, sources, candidates, datasetsBySource, error: null,
    });
  } catch (err) {
    res.render('reconciliation/sources', {
      title: 'Reconciliation Sources', user: req.user, sources: [], candidates: [], datasetsBySource: {}, error: err.message,
    });
  }
});

router.post('/sources', async (req, res) => {
  try {
    const { workspaceId, itemId, workspaceName, itemName, itemType, systemLabel } = req.body;
    if (!workspaceId || !itemId) return res.json({ success: false, message: 'Pick an item to register.' });

    // The connection string is resolved once, at registration, so runs do not have
    // to rediscover it every time.
    let connectionString = null;
    let databaseName = itemName;
    try {
      const pbi = await getPbiService(res);
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
      kind: 'fabric-sql',
      workspaceId, workspaceName, itemId, itemType,
      connectionString, databaseName,
      createdBy: actorOf(req),
    });
    res.json({ success: true, id });
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
    const rules = await repo.listRules();
    res.render('reconciliation/rules', { title: 'Reconciliation Rules', user: req.user, rules, error: null });
  } catch (err) {
    res.render('reconciliation/rules', { title: 'Reconciliation Rules', user: req.user, rules: [], error: err.message });
  }
});

router.get('/rules/new', async (req, res) => {
  try {
    const sources = await repo.listSources();
    res.render('reconciliation/rule-form', {
      title: 'New Reconciliation Rule', user: req.user, rule: null, sources, versions: [], error: null,
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
    res.render('reconciliation/rule-form', {
      title: 'Rule: ' + rule.name, user: req.user, rule, sources, versions, error: null,
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
    compareFields: compareFields.filter(f => f && f.fieldA && f.fieldB),
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

router.post('/rules/:id/status', async (req, res) => {
  try {
    const status = req.body.status;
    if (![RULE_STATUS.DRAFT, RULE_STATUS.ACTIVE, RULE_STATUS.RETIRED].includes(status)) {
      return res.json({ success: false, message: 'Unknown rule status.' });
    }
    const id = Number.parseInt(req.params.id, 10);
    if (status === RULE_STATUS.ACTIVE) {
      const rule = await repo.getRuleById(id);
      const problem = rule ? validateRule({
        name: rule.name, sourceAId: rule.source_a_id, sourceBId: rule.source_b_id,
        datasetA: rule.dataset_a, datasetB: rule.dataset_b,
        keyFieldA: rule.key_field_a, keyFieldB: rule.key_field_b, compareFields: rule.compareFields,
      }) : 'Rule not found.';
      // A rule that cannot run should never be presented to operators as active.
      if (problem) return res.json({ success: false, message: 'Cannot activate: ' + problem });
    }
    await repo.setRuleStatus(id, status, actorOf(req));
    res.json({ success: true });
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
async function executeRule(pbi, rule) {
  const [sourceA, sourceB] = await Promise.all([
    repo.getSourceById(rule.source_a_id), repo.getSourceById(rule.source_b_id),
  ]);
  if (!sourceA || !sourceB) throw new Error('One of the rule\'s sources is no longer registered.');

  const columnsA = [rule.key_field_a, ...rule.compareFields.map(f => f.fieldA)];
  const columnsB = [rule.key_field_b, ...rule.compareFields.map(f => f.fieldB)];

  const [rowsA, rowsB] = await Promise.all([
    pbi.readSqlEndpointRows(
      { connectionString: sourceA.connection_string, database: sourceA.database_name },
      { dataset: rule.dataset_a, columns: [...new Set(columnsA)], rowLimit: rule.row_limit }
    ),
    pbi.readSqlEndpointRows(
      { connectionString: sourceB.connection_string, database: sourceB.database_name },
      { dataset: rule.dataset_b, columns: [...new Set(columnsB)], rowLimit: rule.row_limit }
    ),
  ]);

  return reconcile({
    rowsA, rowsB,
    rule: {
      keyFieldA: rule.key_field_a,
      keyFieldB: rule.key_field_b,
      compareFields: rule.compareFields,
      duplicateHandling: rule.duplicate_handling,
      incompleteKeyHandling: rule.incomplete_key_handling,
      priority: rule.priority,
    },
  });
}

router.post('/run', async (req, res) => {
  const ruleIds = []
    .concat(req.body.ruleIds || req.body.ruleId || [])
    .map(id => Number.parseInt(id, 10))
    .filter(Number.isFinite);
  if (!ruleIds.length) return res.json({ success: false, message: 'Select at least one rule to run.' });

  const results = [];
  try {
    const pbi = await getPbiService(res);
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
        const outcome = await executeRule(pbi, rule);
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
    res.render('reconciliation/runs', { title: 'Reconciliation Runs', user: req.user, runs, rules, error: null });
  } catch (err) {
    res.render('reconciliation/runs', { title: 'Reconciliation Runs', user: req.user, runs: [], rules: [], error: err.message });
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const run = await repo.getRunById(id);
    if (!run) return res.render('error', { title: 'Error', user: req.user, message: 'Run not found.' });
    const exceptions = await repo.listExceptions({ runId: id });
    res.render('reconciliation/run-detail', {
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
    const [exceptions, rules] = await Promise.all([repo.listExceptions(filters), repo.listRules()]);
    res.render('reconciliation/exceptions', {
      title: 'Reconciliation Exceptions', user: req.user, exceptions, rules,
      filters: { ...filters, all: req.query.all === '1' },
      outcomeDefs: OUTCOME_DEFS, statusDefs: STATUS_DEFS, error: null,
    });
  } catch (err) {
    res.render('reconciliation/exceptions', {
      title: 'Reconciliation Exceptions', user: req.user, exceptions: [], rules: [],
      filters: {}, outcomeDefs: OUTCOME_DEFS, statusDefs: STATUS_DEFS, error: err.message,
    });
  }
});

router.get('/exceptions/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const [exception, events] = await Promise.all([repo.getExceptionById(id), repo.getExceptionEvents(id)]);
    if (!exception) return res.render('error', { title: 'Error', user: req.user, message: 'Exception not found.' });
    const current = STATUS_BY_KEY.get(exception.status);
    res.render('reconciliation/exception-detail', {
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
