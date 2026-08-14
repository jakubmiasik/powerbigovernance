// Deployment pipelines: tenant-wide discovery, per-principal access checks and
// deletion.
//
// Two different Power BI endpoints are involved and they have different
// permission models, which drives the whole UX on the pipelines page:
//   * GET /admin/pipelines        — tenant admin scope. Lists every pipeline
//     even ones this service principal has no access to.
//   * DELETE /myorg/pipelines/{id} — regular scope. Requires the caller to be an
//     Admin *on that pipeline*. There is no admin-scoped delete.
// So a pipeline can be visible but not deletable, and the UI must only enable
// delete once access has actually been confirmed.

const { explainError } = require('./httpErrorService');

// The admin API only reports a numeric stage order. These are the built-in
// names Power BI shows for the classic three-stage pipeline.
const DEFAULT_STAGE_NAMES = ['Development', 'Test', 'Production'];

function stageName(order) {
  if (typeof order !== 'number' || order < 0) return 'Stage';
  return DEFAULT_STAGE_NAMES[order] || ('Stage ' + (order + 1));
}

// The object ID of the enterprise application is what the pipeline users list
// reports for an `App` principal. The client ID will not match.
function principalIdentifier(sp) {
  if (!sp) return null;
  return sp.enterprise_app_object_id || null;
}

function hasPrincipalAccess(users, identifier) {
  if (!identifier) return false;
  const wanted = String(identifier).toLowerCase();
  return (users || []).some((u) => u.identifier
    && String(u.identifier).toLowerCase() === wanted
    && String(u.principalType || '').toLowerCase() === 'app');
}

// Builds workspaceId -> pipeline assignment. A workspace can only belong to one
// stage of one pipeline, so a flat map is enough.
function buildWorkspaceMap(pipelines) {
  const map = new Map();
  for (const pipeline of pipelines || []) {
    for (const stage of pipeline.stages || []) {
      if (!stage.workspaceId) continue;
      map.set(String(stage.workspaceId).toLowerCase(), {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        stageOrder: stage.order,
        stageName: stageName(stage.order),
      });
    }
  }
  return map;
}

// Same as buildWorkspaceMap but returns a plain object, for storing in
// results_json and passing to views.
function buildWorkspaceAssignments(pipelines) {
  const assignments = {};
  for (const [key, value] of buildWorkspaceMap(pipelines).entries()) {
    assignments[key] = value;
  }
  return assignments;
}

function lookupAssignment(assignments, workspaceId) {
  if (!assignments || !workspaceId) return null;
  return assignments[String(workspaceId).toLowerCase()] || null;
}

// Fetches every pipeline and, for each, whether the given service principal is
// an Admin on it. An access probe that fails is reported as `unknown` rather
// than `false` so the UI never offers delete on a guess.
async function listPipelinesWithAccess(pbi, sp) {
  const pipelines = await pbi.getDeploymentPipelines();
  const identifier = principalIdentifier(sp);
  const results = [];
  for (const pipeline of pipelines) {
    const entry = {
      ...pipeline,
      stages: (pipeline.stages || []).map((s) => ({ ...s, stageName: stageName(s.order) })),
      workspaceCount: (pipeline.stages || []).filter((s) => s.workspaceId).length,
      access: 'unknown',
      accessError: null,
      admins: [],
    };
    if (!identifier) {
      entry.accessError = 'The service principal has no enterprise application object ID recorded in Settings, '
        + 'so its pipeline access cannot be checked.';
      results.push(entry);
      continue;
    }
    try {
      const users = await pbi.getDeploymentPipelineUsers(pipeline.id);
      entry.admins = users.filter((u) => String(u.accessRight || '').toLowerCase() === 'admin');
      entry.access = hasPrincipalAccess(users, identifier) ? 'granted' : 'none';
    } catch (err) {
      const info = explainError(err);
      entry.access = 'unknown';
      entry.accessError = err.message;
      entry.accessStatus = info ? info.status : null;
      entry.accessExplanation = info ? info.explanation : null;
    }
    results.push(entry);
  }
  return { pipelines: results, identifier };
}

function failure(pipeline, err) {
  const info = explainError(err);
  return {
    id: pipeline.id,
    name: pipeline.name || pipeline.id,
    success: false,
    error: err.message,
    status: info ? info.status : null,
    statusTitle: info ? info.title : null,
    explanation: info ? info.explanation : null,
    hint: info ? info.hint : null,
  };
}

// Deletes one pipeline. Access must already have been confirmed by the caller —
// this is deliberately not self-elevating, because granting the principal Admin
// on a pipeline just to delete it would hide a genuine permissions problem.
async function deletePipeline(pbi, pipeline) {
  if (!pipeline || !pipeline.id) {
    return { id: null, name: null, success: false, error: 'Pipeline ID is required.' };
  }
  try {
    await pbi.deleteDeploymentPipeline(pipeline.id);
    return { id: pipeline.id, name: pipeline.name || pipeline.id, success: true };
  } catch (err) {
    return failure(pipeline, err);
  }
}

async function deletePipelines(pbi, pipelines) {
  const results = [];
  for (const pipeline of pipelines || []) {
    results.push(await deletePipeline(pbi, pipeline));
  }
  return {
    results,
    deleted: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
  };
}

module.exports = {
  DEFAULT_STAGE_NAMES,
  stageName,
  principalIdentifier,
  hasPrincipalAccess,
  buildWorkspaceMap,
  buildWorkspaceAssignments,
  lookupAssignment,
  listPipelinesWithAccess,
  deletePipeline,
  deletePipelines,
};
