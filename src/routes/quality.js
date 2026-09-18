const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const repo = require('../services/reconciliationRepository');
const mdmRepo = require('../services/mdmRepository');
const { createPowerBIService } = require('../services/powerbiService');
const sqlSource = require('../services/sqlSourceService');
const { isEncryptionConfigured, encryptSecret } = require('../services/secretCryptoService');
const analysisModel = require('../services/analysisModelRepository');
const { HELP_TOPICS, PREREQUISITES } = require('../services/qualityGuideService');
const securityGroups = require('../services/securityGroupGuideService');
const sgMapping = require('../services/securityGroupMappingService');
const sgRepo = require('../services/securityGroupRepository');
const { ACCESS_LEVELS } = require('../services/workspaceAccessService');
// Looked up on each call rather than destructured once, so a test can substitute
// it — destructuring captures the function at load and the stub is ignored.
const powerbi = require('../services/powerbiService');

const SOURCE_KIND = { FABRIC: 'fabric-sql', EXTERNAL: 'external-sql' };

// Quality pages are not tied to an analysis scan, so the global
// "Service Principal / Scan" bar would imply a relationship that does not exist.
function view(res, template, locals) {
  return res.render(template, { hideRunSelector: true, ...locals });
}

function actorOf(req) {
  return (req.user && (req.user.name || req.user.email)) || 'anonymous';
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
 * The datasets and fields a rule or model author picks from.
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

/**
 * The Quality landing page.
 *
 * Reconciliation and master data are two uses of the same registered systems, so
 * the registration lives here rather than inside either of them, and this page is
 * where you see what is configured before going into either discipline.
 */
router.get('/', async (req, res) => {
  const base = { title: 'Data Quality', user: req.user, helpTopics: HELP_TOPICS };
  try {
    const [sources, rules, models, exceptionCount] = await Promise.all([
      repo.listSources(),
      repo.listRules(),
      mdmRepo.listModels(),
      repo.countExceptions({ openOnly: true }).catch(() => 0),
    ]);
    view(res, 'quality/index', {
      ...base, sources, rules, models, exceptionCount,
      writableSources: sources.filter(source => sqlSource.describeWritability(source).writable).length,
      error: null,
    });
  } catch (err) {
    view(res, 'quality/index', {
      ...base, sources: [], rules: [], models: [], exceptionCount: 0, writableSources: 0, error: err.message,
    });
  }
});


/**
 * Which security groups a Fabric tenant should have, who is in them, and whether
 * the tenant agrees.
 *
 * Two halves. The design half is guidance — nothing on it reads or writes the
 * tenant, and the group plan it produces is a list to create in Entra ID. The
 * mapping half is a record: people, the groups their stream and role put them in,
 * the directory group each one really is, the workspaces it should hold a role in,
 * and what the workspace actually says.
 */
router.get('/security-groups', async (req, res) => {
  const plan = securityGroups.securityGroupPlan({
    domain: req.query.domain,
    prefix: req.query.prefix,
    separator: req.query.separator,
    environments: typeof req.query.environments === 'string'
      ? req.query.environments.split(',').map(part => part.trim()).filter(Boolean)
      : null,
  });

  const base = {
    title: 'Security Groups', user: req.user,
    principles: securityGroups.PRINCIPLES,
    roleGroups: securityGroups.ROLE_GROUPS,
    tenantGroups: securityGroups.TENANT_GROUPS,
    antiPatterns: securityGroups.ANTI_PATTERNS,
    defaults: {
      prefix: securityGroups.DEFAULT_PREFIX,
      separator: securityGroups.DEFAULT_SEPARATOR,
      environments: securityGroups.DEFAULT_ENVIRONMENTS,
    },
    plan,
    sourceUrl: 'https://qubexon-pl.github.io/fabricrolesassigment/',
    projectRoles: sgMapping.PROJECT_ROLES,
    environments: sgMapping.ENVIRONMENTS,
    fabricRoles: ACCESS_LEVELS.map(level => level.label),
    rules: sgMapping.DEFAULT_RULES,
    tab: req.query.tab === 'design' ? 'design' : 'mapping',
  };

  try {
    const [{ assignments, groups }, servicePrincipals] = await Promise.all([
      sgRepo.loadMapping(),
      db.getServicePrincipals().catch(() => []),
    ]);
    view(res, 'quality/securityGroups', {
      ...base,
      assignments: decorateAssignments(assignments),
      groups: decorateGroups(groups, assignments),
      servicePrincipals,
      error: null,
    });
  } catch (err) {
    // The design half needs no database at all, so a database that is asleep or
    // unmigrated must not take the whole page down with it.
    view(res, 'quality/securityGroups', {
      ...base, assignments: [], groups: [], servicePrincipals: [], error: err.message,
    });
  }
});

/**
 * Each stored assignment with what the rules make of it: the groups it puts the
 * person in, the role each of those should hold, and why.
 *
 * Derived on the way out rather than stored, so a change to the rules changes
 * every row at once instead of leaving old rows contradicting the new rule.
 */
function decorateAssignments(assignments) {
  return (assignments || []).map(assignment => {
    const groups = sgMapping.groupsForAssignment(assignment, sgMapping.DEFAULT_RULES);
    return {
      ...assignment,
      environments: sgMapping.normalizeEnvironments(assignment.environments),
      groups: groups.map(group => group.name),
      fabricRoles: groups.map(group => group.fabricRole.label + ' (' + group.environment + ')'),
      justification: sgMapping.personJustification(assignment, sgMapping.DEFAULT_RULES),
      groupJustification: groups.length
        ? sgMapping.groupJustification(groups[0], sgMapping.DEFAULT_RULES)
        : null,
    };
  });
}

/**
 * Joins the stored groups to the people the assignments put in them, and to the
 * name and Fabric role the rules derive.
 *
 * Membership is computed here rather than stored: a person's groups follow from
 * their stream, role and environments, so a stored copy would disagree with the
 * assignment the moment either changed.
 */
function decorateGroups(groups, assignments) {
  const computed = sgMapping.buildMapping(assignments || [], sgMapping.DEFAULT_RULES);
  const byIdentity = new Map(computed.groups.map(group =>
    [[group.stream, group.projectRole, group.environment].join('|'), group]));

  return (groups || []).map(group => {
    const derived = byIdentity.get([group.stream, group.projectRole, group.environment].join('|'));
    return {
      ...group,
      suggestedName: sgMapping.groupName(group.stream, group.projectRole, group.environment, sgMapping.DEFAULT_RULES),
      fabricRole: sgMapping.fabricRoleFor(group.stream, group.projectRole, group.environment, sgMapping.DEFAULT_RULES),
      members: derived ? derived.members : [],
      justification: sgMapping.groupJustification(group, sgMapping.DEFAULT_RULES),
    };
  });
}

/** Adds or updates one person's involvement in a stream. */
router.post('/security-groups/assignments', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await sgRepo.saveAssignment({
      stream: body.stream,
      projectRole: body.projectRole,
      name: body.name,
      email: body.email,
      environments: Array.isArray(body.environments) ? body.environments : [],
      note: body.note,
    }, actorOf(req));
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.post('/security-groups/assignments/:id/delete', async (req, res) => {
  try {
    const result = await sgRepo.deleteAssignment(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/**
 * Imports a mapping CSV.
 *
 * The file is read in the browser and posted as text, so no upload handling is
 * needed for what is a few kilobytes. Rows are saved one at a time and the ones
 * that fail are named: an import that silently drops eleven of forty rows produces
 * an access model that is wrong in a way nobody looks for.
 */
router.post('/security-groups/import', async (req, res) => {
  try {
    const parsed = sgMapping.parseMappingCsv((req.body || {}).csv || '');
    if (parsed.error) return res.json({ success: false, message: parsed.error });

    const actor = actorOf(req);
    const failed = [];
    let imported = 0;
    for (const assignment of parsed.assignments) {
      try {
        await sgRepo.saveAssignment(assignment, actor);
        imported += 1;
      } catch (rowErr) {
        failed.push({ name: assignment.name, reason: rowErr.message });
      }
    }

    res.json({ success: true, imported, failed, skipped: parsed.skipped });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.get('/security-groups/export.csv', async (req, res) => {
  try {
    const assignments = await sgRepo.listAssignments();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fabric-security-mapping.csv"');
    res.send(sgMapping.toMappingCsv(assignments, sgMapping.DEFAULT_RULES));
  } catch (err) {
    res.status(500).send('Could not export the mapping: ' + err.message);
  }
});

/** Links a suggested group to the directory group that actually exists. */
router.post('/security-groups/groups/:id/link', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.id) return res.json({ success: false, message: 'Pick a group from the directory first.' });
    await sgRepo.linkEntraGroup(req.params.id, {
      id: body.id, displayName: body.displayName, type: body.groupType || body.type,
    }, actorOf(req));
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.post('/security-groups/groups/:id/unlink', async (req, res) => {
  try {
    await sgRepo.unlinkEntraGroup(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/** Attaches a group to the workspaces it should hold a role in. */
router.post('/security-groups/groups/:id/workspaces', async (req, res) => {
  try {
    const body = req.body || {};
    const workspaces = Array.isArray(body.workspaces) ? body.workspaces : [];
    if (!workspaces.length) return res.json({ success: false, message: 'Select at least one workspace.' });

    const actor = actorOf(req);
    let attached = 0;
    for (const workspace of workspaces) {
      await sgRepo.attachWorkspace(req.params.id, {
        id: workspace.id, name: workspace.name, intendedRole: body.intendedRole || workspace.intendedRole,
      }, actor);
      attached += 1;
    }
    res.json({ success: true, attached });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.post('/security-groups/attachments/:id/detach', async (req, res) => {
  try {
    await sgRepo.detachWorkspace(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/** The workspaces a group can be attached to, from the last completed scan. */
router.get('/security-groups/workspaces', async (req, res) => {
  try {
    const runs = await db.getAnalysisRuns();
    const run = (runs || []).find(candidate => candidate.status === 'completed');
    if (!run) return res.json({ success: true, runId: null, workspaces: [] });

    let rows = await analysisModel.listRunWorkspaces(run.id).catch(() => []);
    if (!rows.length) {
      // A run from before indexing existed still has its document, and attaching a
      // workspace is planning — it should not need a re-scan.
      const full = await db.getAnalysisRunById(run.id);
      let parsed = null;
      try { parsed = full && full.results_json ? JSON.parse(full.results_json) : null; } catch { parsed = null; }
      rows = ((parsed && parsed.workspaces) || []).map(workspace => ({
        workspace_id: workspace.id, name: workspace.name, state: workspace.state,
      }));
    }

    res.json({
      success: true,
      runId: run.id,
      workspaces: rows
        .map(row => ({ id: row.workspace_id || row.id, name: row.name || '(unnamed)', state: row.state || null }))
        .filter(workspace => workspace.id)
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

/**
 * Asks each attached workspace whether the linked group is really in it.
 *
 * A mapping nobody checked against the tenant is a document, not a control. One
 * call per workspace rather than one per attachment — a group is not the unit the
 * API answers about — and the answers are kept apart: present, present with the
 * wrong role, absent, never linked, or unreadable. The last two are not failures
 * of the tenant and are not counted as such.
 */
router.post('/security-groups/verify', async (req, res) => {
  try {
    const groups = await sgRepo.listGroups();
    const targets = [];
    for (const group of groups) {
      for (const attachment of group.workspaces) {
        targets.push({ group, attachment });
      }
    }
    if (!targets.length) {
      return res.json({ success: true, results: [], summary: sgMapping.summarizeChecks([]), checkedAt: new Date().toISOString() });
    }

    const servicePrincipals = await db.getServicePrincipals();
    if (!servicePrincipals.length) return res.json({ success: false, message: 'No service principal configured.' });
    const wanted = Number.parseInt((req.body || {}).spId, 10);
    const sp = (Number.isFinite(wanted) && servicePrincipals.find(candidate => Number(candidate.id) === wanted))
      || servicePrincipals[0];

    const pbi = powerbi.createPowerBIService(sp, {
      keyVaultDelegatedToken: (req.session && req.session.keyVaultDelegatedToken && req.session.keyVaultDelegatedToken.token) || null,
    });

    // One read per workspace, cached across the groups attached to it. Reading the
    // same workspace once per group turns a plan of forty rows into forty calls.
    const roleCache = new Map();
    async function rolesFor(workspaceId) {
      if (roleCache.has(workspaceId)) return roleCache.get(workspaceId);
      let value;
      try {
        value = await pbi.getRoleAssignments(workspaceId);
      } catch (err) {
        // Null, not an empty list: "could not read" and "nobody is in it" are
        // opposite claims and only one of them is a finding.
        value = null;
        console.warn('[SecurityGroups] Could not read roles for', workspaceId, err.message);
      }
      roleCache.set(workspaceId, value);
      return value;
    }

    const results = [];
    for (const { group, attachment } of targets) {
      const comparison = group.entraGroupId
        ? sgMapping.compareAssignment(
          { entraGroupId: group.entraGroupId, intendedRole: attachment.intendedRole },
          await rolesFor(attachment.workspaceId))
        : sgMapping.compareAssignment({ entraGroupId: null }, null);

      results.push({
        attachmentId: attachment.id,
        groupId: group.id,
        groupName: sgMapping.groupName(group.stream, group.projectRole, group.environment, sgMapping.DEFAULT_RULES),
        entraGroupName: group.entraGroupName || null,
        workspaceId: attachment.workspaceId,
        workspaceName: attachment.workspaceName,
        intendedRole: attachment.intendedRole,
        ...comparison,
      });
    }

    await sgRepo.recordChecks(results, actorOf(req)).catch(err =>
      console.warn('[SecurityGroups] Could not record the check:', err.message));

    res.json({
      success: true,
      checkedAt: new Date().toISOString(),
      servicePrincipal: sp.name,
      workspacesRead: roleCache.size,
      results,
      summary: sgMapping.summarizeChecks(results),
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.get('/sources', async (req, res) => {
  const base = {
    title: 'Quality Sources', user: req.user,
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
    view(res, 'quality/sources', {
      ...base, sources, servicePrincipals, scanBySp, datasetsBySource, error: null,
    });
  } catch (err) {
    view(res, 'quality/sources', {
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
    // The indexed items answer this directly. Before, finding a tenant's lakehouses
    // meant loading the whole scan document and walking every workspace in memory.
    const indexed = await analysisModel.getRunModelState(latest.id);
    if (indexed) {
      const rows = await analysisModel.listRunItemsByType(latest.id, ['lakehouse', 'warehouse']);
      return res.json({
        success: true, runId: latest.id,
        candidates: rows.map(row => ({
          workspaceId: row.workspace_id, workspaceName: row.workspace_name,
          itemId: row.item_id, itemName: row.item_name, itemType: row.item_type,
        })),
      });
    }

    // A run from before the tables existed still answers, from its document.
    const run = await db.getAnalysisRunById(latest.id);
    res.json({ success: true, runId: latest.id, candidates: extractCandidates(run), fromDocument: true });
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

module.exports = router;
