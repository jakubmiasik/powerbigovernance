const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const repo = require('../services/mdmRepository');
const reconRepo = require('../services/reconciliationRepository');
const sqlSource = require('../services/sqlSourceService');
const mdm = require('../services/mdmService');
const { createPowerBIService } = require('../services/powerbiService');
const { getSqlTokenForSP } = require('../services/authService');

// Master data is not tied to an analysis scan, so the global "Service Principal /
// Scan" bar would imply a relationship that does not exist.
function view(res, template, locals) {
  return res.render(template, { hideRunSelector: true, ...locals });
}

function actorOf(req) {
  return (req.user && (req.user.name || req.user.email)) || 'anonymous';
}

/** Everything the model form needs to describe the available rules. */
function algorithmCatalogue() {
  return {
    standardisers: mdm.STANDARDISER_DEFS,
    blocking: mdm.BLOCKING_DEFS,
    comparators: mdm.COMPARATOR_DEFS,
    nullPolicies: mdm.NULL_POLICY_DEFS,
    survivorship: mdm.SURVIVORSHIP_DEFS,
  };
}

/**
 * Sources come from the same registry reconciliation uses, so a lakehouse or
 * database registered once is available to both. Each is annotated with whether it
 * can be written to, which is the difference between a usable destination and a
 * run that fails at the last step.
 */
async function loadSources() {
  const sources = await reconRepo.listSources();
  return sources.map(source => ({
    ...source,
    writable: sqlSource.describeWritability(source).writable,
    writeBlockedReason: sqlSource.describeWritability(source).reason,
  }));
}

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

/**
 * Reading and writing use the identity that owns the source: this application's own
 * for a registered database, and the source's service principal for a Fabric item.
 */
async function tokenOptionsFor(source) {
  if (source.kind !== 'fabric-sql') return {};
  if (!source.sp_id) {
    throw new Error('This Fabric source has no service principal recorded. Re-register it on the Reconciliation Sources page and pick a tenant.');
  }
  const sp = await db.getServicePrincipalById(source.sp_id);
  if (!sp) throw new Error('The service principal this source was registered under no longer exists.');
  // Proves the credential resolves before a long run starts.
  createPowerBIService(sp);
  return { token: await getSqlTokenForSP(sp) };
}

// ── Pages ──
router.get('/', async (req, res) => {
  try {
    const [models, overview] = await Promise.all([repo.listModels(), repo.getOverview()]);
    view(res, 'mdm/index', { title: 'Master Data', user: req.user, models, overview, error: null });
  } catch (err) {
    view(res, 'mdm/index', { title: 'Master Data', user: req.user, models: [], overview: null, error: err.message });
  }
});

router.get('/models/new', async (req, res) => {
  try {
    const sources = await loadSources();
    view(res, 'mdm/model-form', {
      title: 'New Master Data Model', user: req.user, model: null, sources, versions: [],
      catalogue: algorithmCatalogue(), error: null,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

router.get('/models/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const [model, sources, versions] = await Promise.all([
      repo.getModelById(id), loadSources(), repo.getModelVersions(id),
    ]);
    if (!model) return res.render('error', { title: 'Error', user: req.user, message: 'Model not found.' });
    view(res, 'mdm/model-form', {
      title: 'Model: ' + model.name, user: req.user, model, sources, versions,
      catalogue: algorithmCatalogue(), error: null,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

/** The datasets and fields a source exposes, for the model form's pickers. */
router.get('/sources/:id/datasets', async (req, res) => {
  try {
    const source = await reconRepo.getSourceById(Number.parseInt(req.params.id, 10));
    if (!source) return res.json({ success: false, message: 'Source not found.' });
    const datasets = await loadSourceDatasets(source);
    res.json({
      success: true,
      datasets,
      writable: sqlSource.describeWritability(source).writable,
      writeBlockedReason: sqlSource.describeWritability(source).reason,
      message: datasets.length ? null : 'No schema captured for this source yet.',
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Model definition ──
function readModelBody(body) {
  let config = {};
  try {
    config = typeof body.config === 'string' ? JSON.parse(body.config) : (body.config || {});
  } catch { config = {}; }

  return {
    name: (body.name || '').trim(),
    description: body.description || null,
    entityType: body.entityType || null,
    sourceId: body.sourceId, sourceDataset: body.sourceDataset,
    destinationId: body.destinationId || null, destinationTable: (body.destinationTable || '').trim() || null,
    crosswalkTable: (body.crosswalkTable || '').trim() || null,
    writeMode: body.writeMode === 'append' ? 'append' : 'replace',
    rowLimit: body.rowLimit || null,
    config,
  };
}

function validateModel(model) {
  const problems = [];
  if (!model.name) problems.push('The model needs a name.');
  if (!model.sourceId) problems.push('Select the source holding the raw records.');
  if (!model.sourceDataset) problems.push('Select the raw table to master.');

  const fields = (model.config && model.config.fields) || [];
  if (!fields.length) problems.push('Add at least one field to compare and master.');
  for (const field of fields) {
    if (!field.column) problems.push('Every field must name a column in the raw table.');
  }
  // A model with no weighted field can never reach its threshold, so it would
  // silently produce one golden record per raw record and look like it worked.
  if (fields.length && !fields.some(field => Number(field.weight) > 0)) {
    problems.push('At least one field needs a matching weight above zero.');
  }

  const auto = Number(model.config.autoMatchThreshold);
  const review = Number(model.config.reviewThreshold);
  if (Number.isFinite(auto) && Number.isFinite(review) && review > auto) {
    problems.push('The review threshold cannot be higher than the automatic match threshold.');
  }
  if (model.destinationTable && !model.destinationId) {
    problems.push('Choose the destination system for that table, or clear the table name.');
  }
  return problems;
}

router.post('/models', async (req, res) => {
  try {
    const model = readModelBody(req.body);
    const problems = validateModel(model);
    if (problems.length) return res.json({ success: false, message: problems.join(' ') });
    const id = await repo.createModel(model, actorOf(req));
    res.json({ success: true, id });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.put('/models/:id', async (req, res) => {
  try {
    const model = readModelBody(req.body);
    const problems = validateModel(model);
    if (problems.length) return res.json({ success: false, message: problems.join(' ') });
    const version = await repo.updateModel(Number.parseInt(req.params.id, 10), model, actorOf(req), req.body.changeNote);
    res.json({ success: true, version });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.post('/models/:id/status', async (req, res) => {
  try {
    const status = req.body.status;
    if (!['draft', 'active', 'retired'].includes(status)) {
      return res.json({ success: false, message: 'Unknown model status.' });
    }
    const id = Number.parseInt(req.params.id, 10);
    if (status === 'active') {
      const model = await repo.getModelById(id);
      if (!model) return res.json({ success: false, message: 'Model not found.' });
      const problems = validateModel({
        name: model.name, sourceId: model.source_id, sourceDataset: model.source_dataset,
        destinationId: model.destination_id, destinationTable: model.destination_table,
        config: model.config,
      });
      if (problems.length) return res.json({ success: false, message: 'Cannot activate: ' + problems.join(' ') });
    }
    await repo.setModelStatus(id, status, actorOf(req));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.delete('/models/:id', async (req, res) => {
  try {
    await repo.deleteModel(Number.parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Execution ──

/** The columns a run must read: every mastered field, plus the model's metadata. */
function columnsFor(model) {
  const config = model.config || {};
  const columns = new Set((config.fields || []).map(field => field.column).filter(Boolean));
  for (const extra of [config.sourceIdField, config.sourceField, config.timestampField]) {
    if (extra) columns.add(extra);
  }
  return [...columns];
}

function engineModel(model) {
  const config = model.config || {};
  return {
    ...config,
    fields: (config.fields || []).map((field, index) => ({
      key: field.key || field.column || 'f' + index,
      column: field.column,
      standardisers: field.standardisers || [],
      comparator: field.comparator || 'exact',
      weight: field.weight,
      required: !!field.required,
      blocker: !!field.blocker,
      minScore: field.minScore,
      nullPolicy: field.nullPolicy || 'skip',
      survivorship: field.survivorship || 'most_complete',
      tolerance: field.tolerance,
      relativeTolerance: field.relativeTolerance,
      toleranceDays: field.toleranceDays,
    })),
  };
}

/**
 * Runs a model.
 *
 * `preview` masters the records and stores the result for review without touching
 * the destination; `publish` also writes it. Preview is the default because
 * publishing replaces a table other systems read, and that should be a deliberate
 * second step rather than a side effect of trying a model out.
 */
async function executeModel(model, { publish }) {
  const source = await reconRepo.getSourceById(model.source_id);
  if (!source) throw new Error('The source holding the raw records is no longer registered.');

  const columns = columnsFor(model);
  if (!columns.length) throw new Error('The model names no columns to read.');

  const readOptions = await tokenOptionsFor(source);
  const rows = await sqlSource.readRows(source, {
    dataset: model.source_dataset,
    columns,
    rowLimit: model.row_limit,
  }, readOptions);

  const result = mdm.buildMasterData(rows, engineModel(model));
  if (!publish) return { ...result, written: null };

  if (!model.destination_id || !model.destination_table) {
    throw new Error('This model has no destination table configured, so there is nothing to publish to.');
  }
  const destination = await reconRepo.getSourceById(model.destination_id);
  if (!destination) throw new Error('The destination system is no longer registered.');

  const writability = sqlSource.describeWritability(destination);
  if (!writability.writable) throw new Error(writability.reason);

  const fields = engineModel(model).fields;
  const goldenColumns = ['golden_id', ...fields.map(field => field.key), 'source_systems', 'source_record_count'];
  const goldenRows = result.golden.map(record => ({
    golden_id: record.goldenId,
    ...Object.fromEntries(fields.map(field => [field.key, record.values[field.key]])),
    source_systems: (record.sourceSystems || []).join(', '),
    source_record_count: record.memberCount,
  }));

  const writeOptions = await tokenOptionsFor(destination);
  const written = await sqlSource.writeRows(destination, {
    table: model.destination_table,
    columns: goldenColumns,
    rows: goldenRows,
    mode: model.write_mode || 'replace',
    createIfMissing: true,
  }, writeOptions);

  // The crosswalk is what makes a published golden record traceable, so it is
  // written whenever the model names a table for it.
  if (model.crosswalk_table) {
    await sqlSource.writeRows(destination, {
      table: model.crosswalk_table,
      columns: ['golden_id', 'source_record_id', 'source_system'],
      rows: result.crosswalk.map(entry => ({
        golden_id: entry.goldenId,
        source_record_id: entry.sourceId === null || entry.sourceId === undefined ? null : String(entry.sourceId),
        source_system: entry.sourceSystem || null,
      })),
      mode: model.write_mode || 'replace',
      createIfMissing: true,
    }, writeOptions);
  }

  return { ...result, written: written.written };
}

router.post('/models/:id/run', async (req, res) => {
  const modelId = Number.parseInt(req.params.id, 10);
  const publish = req.body.mode === 'publish';
  let runId = null;
  try {
    const model = await repo.getModelById(modelId);
    if (!model) return res.json({ success: false, message: 'Model not found.' });
    if (publish && model.status !== 'active') {
      return res.json({ success: false, message: 'Only an active model can publish. Preview it first, then activate it.' });
    }

    // The run row exists before execution, so an interrupted run is still visible
    // in the history rather than disappearing.
    runId = await repo.createRun({
      modelId, modelVersion: model.version, modelName: model.name,
      mode: publish ? 'publish' : 'preview', runBy: actorOf(req),
    });

    const result = await executeModel(model, { publish });
    await repo.saveRunResults(runId, modelId, result);
    await repo.completeRun(runId, { status: 'completed', stats: result.stats, writtenRows: result.written });

    res.json({ success: true, runId, stats: result.stats, written: result.written });
  } catch (err) {
    if (runId) {
      await repo.completeRun(runId, { status: 'failed', stats: null, error: err.message }).catch(() => {});
    }
    res.json({ success: false, runId, message: err.message });
  }
});

router.get('/runs', async (req, res) => {
  try {
    const [runs, models] = await Promise.all([repo.listRuns({}), repo.listModels()]);
    view(res, 'mdm/runs', { title: 'Master Data Runs', user: req.user, runs, models, error: null });
  } catch (err) {
    view(res, 'mdm/runs', { title: 'Master Data Runs', user: req.user, runs: [], models: [], error: err.message });
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const run = await repo.getRunById(id);
    if (!run) return res.render('error', { title: 'Error', user: req.user, message: 'Run not found.' });
    const [golden, review] = await Promise.all([
      repo.listGoldenRecords(id, { limit: 300 }),
      repo.listReviewPairs(id, { decision: 'all', limit: 200 }),
    ]);
    const model = await repo.getModelById(run.model_id);
    view(res, 'mdm/run-detail', {
      title: 'Master Data Run #' + id, user: req.user, run, golden, review,
      fields: model ? ((model.config || {}).fields || []) : [],
      error: null,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

/** The source records behind one golden record. */
router.get('/runs/:id/crosswalk/:goldenId', async (req, res) => {
  try {
    const rows = await repo.listCrosswalk(Number.parseInt(req.params.id, 10), req.params.goldenId);
    res.json({ success: true, rows });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/**
 * A steward's verdict on candidate pairs the model could not decide.
 *
 * These are the judgements worth acting on: pairs confirmed as matches that scored
 * below the threshold say the threshold is too high, and rejected pairs that scored
 * close to it say the opposite.
 */
router.post('/runs/:id/review', async (req, res) => {
  try {
    const ids = [].concat(req.body.ids || []).map(id => Number.parseInt(id, 10)).filter(Number.isFinite);
    if (!ids.length) return res.json({ success: false, message: 'Select at least one pair.' });
    const decision = req.body.decision;
    if (!['match', 'not_match', 'pending'].includes(decision)) {
      return res.json({ success: false, message: 'Decide match or not a match.' });
    }
    const results = await repo.decideReviewPairs(ids, decision, actorOf(req), req.body.note);
    res.json({
      success: true,
      updated: results.filter(result => result.success).length,
      failed: results.filter(result => !result.success),
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
