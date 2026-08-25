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
const analysisModel = require('../services/analysisModelRepository');
const { RECONCILIATION_HELP } = require('../services/qualityGuideService');
const jobs = require('../services/jobProgressService');

// How many exceptions one pass of a bulk action handles. Small enough that progress
// moves visibly, large enough that the per-batch overhead stays negligible.
const BULK_PAGE_SIZE = Math.max(50, Number.parseInt(process.env.RECON_BULK_PAGE_SIZE || '500', 10) || 500);

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
  const ruleStatus = STATUS_BY_KEY.has(req.query.ruleStatus) ? req.query.ruleStatus : null;
  const base = {
    title: 'Reconciliation', user: req.user, selectedRunId: runId, ruleStatus,
    outcomeDefs: OUTCOME_DEFS, statusDefs: STATUS_DEFS, helpTopic: RECONCILIATION_HELP,
  };
  try {
    const [data, runs] = await Promise.all([
      repo.getDashboardData({ runId }),
      repo.listRuns({ limit: 200 }),
    ]);

    // The rule hierarchy describes the standing state, so it is only built when the
    // page is not scoped to a single run — where the run breakdown would be one row.
    let rulesOverview = [];
    let orphanedExceptions = 0;
    if (!runId) {
      rulesOverview = await repo.getRulesOverview({ status: ruleStatus }).catch(err => {
        console.warn('[Reconciliation] Could not build the rules overview:', err.message);
        return [];
      });
      orphanedExceptions = await repo.countOrphanedExceptions().catch(() => 0);
    }

    view(res, 'reconciliation/dashboard', { ...base, data, runs, rulesOverview, orphanedExceptions, error: null });
  } catch (err) {
    view(res, 'reconciliation/dashboard', {
      ...base, data: null, runs: [], rulesOverview: [], orphanedExceptions: 0, error: err.message,
    });
  }
});

/**
 * Removes exceptions with no run behind them.
 *
 * Deleting a run now takes its leftovers with it, but an install that deleted runs
 * before that needs a way to clear what was stranded.
 */
router.post('/exceptions/purge-orphans', async (req, res) => {
  try {
    const removed = await repo.deleteOrphanedExceptions();
    res.json({ success: true, removed });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Source registration moved to the Quality section, because reconciliation and
// master data read the same registered systems. Old links keep working.
router.get('/sources', (req, res) => res.redirect(301, '/quality/sources'));
router.get('/sources/:id/datasets', (req, res) => res.redirect(307, '/quality/sources/' + req.params.id + '/datasets'));

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

    // The page renders immediately with the counts and the size of the list; the
    // list itself is fetched page by page, so a run with tens of thousands of
    // findings shows progress instead of a blank wait.
    const [outcomeCounts, exceptionTotal] = await Promise.all([
      repo.getRunOutcomeCounts(id),
      repo.countExceptions({ runId: id }).catch(() => null),
    ]);
    view(res, 'reconciliation/run-detail', {
      title: 'Run #' + id, user: req.user, run, outcomeCounts, exceptionTotal, outcomeDefs: OUTCOME_DEFS,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

/**
 * What deleting a run would remove, so the confirmation can say it.
 *
 * Deleting is not undoable and the effect is not obvious — an exception is shared
 * between the runs that saw it, so only the ones with no other sighting go.
 */
router.get('/runs/:id/deletion-impact', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const run = await repo.getRunById(id);
    if (!run) return res.json({ success: false, message: 'Run not found.' });
    const impact = await repo.getRunDeletionImpact(id);
    res.json({ success: true, run: { id: run.id, ruleName: run.rule_name, startedAt: run.started_at }, ...impact });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/**
 * Deletes a run and everything belonging only to it.
 *
 * Job-backed: a run with many findings takes longer than a request should wait, and
 * a destructive action is exactly the kind a person wants to watch finish.
 */
router.delete('/runs/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const run = await repo.getRunById(id);
    if (!run) return res.json({ success: false, message: 'Run not found.' });

    const impact = await repo.getRunDeletionImpact(id);
    const job = jobs.runJob({
      kind: 'run-delete', actor: actorOf(req),
      total: impact.exceptionsToDelete + impact.exceptionsToKeep + 1,
      label: 'Deleting run #' + id,
    }, async (running) => {
      running.counters = { exceptions: 0, repaired: 0, findings: 0 };
      const removed = await repo.deleteRun(id, {
        onProgress: (progress) => {
          if (progress.stage === 'exceptions') {
            running.counters.exceptions = progress.done;
            jobs.updateJob(running, { done: progress.done, message: 'Removing exceptions only this run saw...' });
          } else if (progress.stage === 'repaired') {
            running.counters.repaired = progress.done;
            jobs.updateJob(running, {
              done: running.counters.exceptions + progress.done,
              message: 'Repointing exceptions other runs also saw...',
            });
          } else if (progress.stage === 'findings') {
            running.counters.findings = progress.done;
            jobs.updateJob(running, { message: 'Removing the run\'s findings...' });
          }
        },
      });
      jobs.updateJob(running, { done: running.total, message: 'Run #' + id + ' deleted.' });
      return removed;
    });

    res.json({ success: true, jobId: job.id, impact });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/**
 * Deletes every run of a rule, or every run there is.
 *
 * Deleting them one at a time in order keeps each exception's sightings correct as
 * it goes, rather than needing a separate repair pass at the end.
 */
router.post('/runs/delete-all', async (req, res) => {
  try {
    const ruleId = req.body.ruleId ? Number.parseInt(req.body.ruleId, 10) : null;
    const confirmed = req.body.confirm === true || req.body.confirm === 'true';
    if (!ruleId && !confirmed) {
      // Deleting the entire run history is not something to do by accident.
      return res.json({ success: false, message: 'Deleting every run of every rule needs an explicit confirmation.' });
    }

    const runIds = await repo.listRunIds({ ruleId });
    if (!runIds.length) return res.json({ success: false, message: 'There are no runs to delete.' });

    const job = jobs.runJob({
      kind: 'run-delete-all', actor: actorOf(req), total: runIds.length,
      label: 'Deleting ' + runIds.length + ' run(s)',
    }, async (running) => {
      running.counters = { runs: 0, exceptions: 0, repaired: 0, findings: 0 };
      for (const runId of runIds) {
        try {
          const removed = await repo.deleteRun(runId);
          running.counters.exceptions += removed.exceptions;
          running.counters.repaired += removed.repaired;
          running.counters.findings += removed.findings;
        } catch (err) {
          // One run that will not delete should not stop the rest.
          running.problems.push({ key: 'Run #' + runId, message: err.message });
        }
        running.counters.runs += 1;
        jobs.advanceJob(running, 1, running.counters.runs + ' of ' + runIds.length + ' run(s) deleted');
      }
      return { ...running.counters };
    });

    res.json({ success: true, jobId: job.id, total: runIds.length });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/** One page of the exceptions a run found, for the run detail page to stream in. */
router.get('/runs/:id/exceptions', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const page = await repo.listExceptionPage({ runId: id }, {
      after: req.query.after,
      limit: req.query.limit,
    });
    res.json({ success: true, ...page });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Exceptions ──

/**
 * One reading of the filter query, shared by the list, the count and the bulk
 * action. A bulk action that interpreted the filter differently from the list would
 * act on a different set from the one on screen.
 */
function readExceptionFilters(query) {
  const all = query.all === '1' || query.all === true || query.all === 'true';
  return {
    status: query.status || null,
    severity: query.severity || null,
    outcome: query.outcome || null,
    ruleId: query.ruleId ? Number.parseInt(query.ruleId, 10) : null,
    runId: query.runId ? Number.parseInt(query.runId, 10) : null,
    openOnly: query.status ? false : !all,
  };
}

router.get('/exceptions', async (req, res) => {
  try {
    const filters = readExceptionFilters(req.query);
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
/**
 * Validates a bulk decision. Shared by the immediate and the job-backed paths so
 * they cannot disagree about what is allowed.
 */
function readBulkChange(body) {
  const assignOwner = body.assignOwner === true || body.assignOwner === 'true';
  const owner = (body.owner || '').trim() || null;
  const severity = body.severity || null;
  const toStatus = body.status || null;
  const comment = (body.comment || '').trim() || null;
  const reason = (body.reason || '').trim() || null;

  if (!assignOwner && !severity && !toStatus && !comment) {
    return { problem: 'Choose an owner, a severity, a status, or add a comment.' };
  }
  if (severity && !SEVERITY_LEVELS.includes(severity)) return { problem: 'Unknown severity.' };
  if (toStatus && !STATUS_BY_KEY.has(toStatus)) return { problem: 'Unknown status.' };
  // Closing requires a recorded reason whether one exception is closed or fifty
  // thousand.
  if (toStatus && (toStatus === EXCEPTION_STATUS.RESOLVED || toStatus === EXCEPTION_STATUS.ACCEPTED) && !reason) {
    return { problem: 'Record why these exceptions are being closed.' };
  }
  return { change: { assignOwner, owner, severity, toStatus, comment, reason } };
}

/**
 * Applies a decision to one batch, enforcing the lifecycle per exception.
 *
 * A selection routinely mixes statuses, so a move to "resolved" is legitimate for
 * the open ones and not for those already closed; the ones that can move do, and the
 * rest are named with the reason.
 */
async function applyBulkBatch(exceptions, change, actor) {
  const eligible = [];
  const skipped = [];
  for (const exception of exceptions) {
    if (change.toStatus && change.toStatus !== exception.status
        && !isStatusTransitionAllowed(exception.status, change.toStatus)) {
      skipped.push({
        id: exception.id, key: exception.business_key,
        message: 'Cannot move from "' + exception.status + '" to "' + change.toStatus + '".',
      });
      continue;
    }
    eligible.push(exception);
  }

  const results = eligible.length ? await repo.batchUpdateExceptions(eligible, { ...change, actor }) : [];
  const byId = new Map(eligible.map(exception => [Number(exception.id), exception]));
  const failed = results.filter(result => !result.success).map(result => ({
    id: result.id,
    key: (byId.get(result.id) || {}).business_key || ('#' + result.id),
    message: result.message,
  }));

  return {
    considered: exceptions.length,
    updated: results.filter(result => result.success && result.changed).length,
    unchanged: results.filter(result => result.success && !result.changed).length,
    skipped: skipped.concat(failed),
  };
}

/**
 * Applies one decision to several exceptions.
 *
 * A selection of specific rows is applied immediately. "Everything matching the
 * filter" starts a job instead and returns its id: the set has no upper bound, so
 * the request cannot wait for it, and a person applying a decision to tens of
 * thousands of rows deserves to see it move rather than a spinner that may or may
 * not still be alive.
 */
router.post('/exceptions/batch', async (req, res) => {
  try {
    const scope = req.body.scope === 'filter' ? 'filter' : 'selection';
    const ids = [].concat(req.body.ids || [])
      .map(id => Number.parseInt(id, 10))
      .filter(Number.isFinite);
    if (scope === 'selection' && !ids.length) {
      return res.json({ success: false, message: 'Select at least one exception.' });
    }

    const { problem, change } = readBulkChange(req.body);
    if (problem) return res.json({ success: false, message: problem });
    const actor = actorOf(req);

    if (scope === 'selection') {
      const exceptions = await repo.getExceptionsByIds(ids);
      const found = new Map(exceptions.map(exception => [Number(exception.id), exception]));
      const missing = ids.filter(id => !found.has(id)).map(id => ({ id, key: '#' + id, message: 'No longer exists.' }));
      const batch = await applyBulkBatch(exceptions, change, actor);
      return res.json({
        success: true, scope, considered: ids.length,
        updated: batch.updated, unchanged: batch.unchanged,
        skipped: batch.skipped.concat(missing),
      });
    }

    const filters = readExceptionFilters(req.body.filters || {});
    if (!filters.ruleId && !filters.status && !filters.severity && !filters.outcome && !filters.runId) {
      // Acting on every exception in the system is almost never what someone means,
      // and it is not undoable. Require the set to be narrowed first.
      return res.json({ success: false, message: 'Narrow the list to a rule, status, severity or type before applying to the whole set.' });
    }

    const total = await repo.countExceptions(filters);
    if (!total) return res.json({ success: false, message: 'The current filter covers no exceptions.' });

    const job = jobs.runJob({
      kind: 'exception-bulk', actor, total,
      label: 'Updating ' + total + ' exception(s)',
    }, async (running) => {
      running.counters = { updated: 0, unchanged: 0, skipped: 0 };
      let after = 0;
      for (;;) {
        // Paged by id, so the set is walked once and a page costs the same at the
        // end as at the beginning.
        const page = await repo.listExceptionPage(filters, { after, limit: BULK_PAGE_SIZE });
        if (!page.exceptions.length) break;

        const batch = await applyBulkBatch(page.exceptions, change, actor);
        running.counters.updated += batch.updated;
        running.counters.unchanged += batch.unchanged;
        running.counters.skipped += batch.skipped.length;
        running.problems.push(...batch.skipped);

        jobs.advanceJob(running, page.exceptions.length,
          running.done + page.exceptions.length + ' of ' + total + ' processed');

        after = page.nextAfter;
        if (page.done || after === null) break;
      }
      return { ...running.counters };
    });

    res.json({ success: true, scope, jobId: job.id, total });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/** Progress for a job this process is running. */
router.get('/jobs/:id', (req, res) => {
  const summary = jobs.summarize(jobs.getJob(req.params.id));
  if (!summary) {
    return res.json({
      success: false,
      status: 'unknown',
      message: 'No progress is being reported for this job. It may have finished a while ago, or been started by an application instance that has since stopped.',
    });
  }
  res.json({ success: true, ...summary });
});

/** How many exceptions the current filter covers, for the whole-set option's label. */
router.get('/exceptions/count', async (req, res) => {
  try {
    const total = await repo.countExceptions(readExceptionFilters(req.query));
    res.json({ success: true, total });
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
