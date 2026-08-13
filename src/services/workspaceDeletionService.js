const db = require('./databaseService');
const { explainError } = require('./httpErrorService');

// Every failure reported to the UI carries an explanation of the status code, so a
// bare "API error (403)" is never the only thing an operator sees.
function failure(id, name, message, err) {
  const info = explainError(err || message);
  return {
    id,
    name: name || null,
    success: false,
    message,
    permissionDenied: isPermissionError(err || { message }),
    status: info ? info.status : null,
    statusTitle: info ? info.title : null,
    explanation: info ? info.explanation : null,
    hint: info ? info.hint : null,
  };
}

/**
 * Fabric's delete endpoint requires the *workspace* Admin role. Being a tenant
 * Fabric administrator does not bypass it, so a service principal that was never
 * added to the workspace gets 403 even with full tenant permissions.
 */
function isPermissionError(err) {
  const message = String((err && err.message) || '');
  return /\(40[13]\)/.test(message)
    || /unauthorized|forbidden|permission|not authorized|principal.*not.*found/i.test(message);
}

/**
 * Delete a workspace in Fabric and record the outcome.
 *
 * The workspace row is never removed from our own storage. On success its state is
 * flipped to 'Deleted' in every stored scan and an audit row is written, so the
 * items, users and findings collected before deletion remain available.
 *
 * `elevate` is an optional callback that grants the caller the workspace Admin role.
 * It is only invoked after a permission failure, so no rights are granted unless the
 * deletion actually needs them.
 */
async function deleteWorkspace(pbi, { id, name, runId, deletedBy, elevate }) {
  if (!id) return { id: id || null, name: name || null, success: false, message: 'Workspace ID is required.' };

  let elevated = false;
  try {
    await pbi.deleteWorkspace(id);
  } catch (err) {
    if (!elevate || !isPermissionError(err)) {
      return failure(id, name, err.message, err);
    }
    // Self-elevate to workspace Admin, then try exactly once more.
    try {
      await elevate(id);
      elevated = true;
    } catch (grantErr) {
      const result = failure(id, name, `Access denied and the workspace Admin role could not be granted: ${grantErr.message}`, grantErr);
      result.permissionDenied = true;
      return result;
    }
    try {
      await pbi.deleteWorkspace(id);
    } catch (retryErr) {
      return failure(id, name, retryErr.message, retryErr);
    }
  }

  // The workspace is gone from the tenant at this point. Bookkeeping failures must
  // not be reported as a failed deletion, or the user would retry a 404.
  let stateWarning = null;
  try {
    await db.markWorkspaceDeleted({ workspaceId: id, workspaceName: name, runId, deletedBy });
  } catch (err) {
    stateWarning = err.message;
  }
  try {
    await db.markWorkspaceDeletedInRuns(id);
  } catch (err) {
    stateWarning = stateWarning || err.message;
  }

  return {
    id,
    name: name || null,
    success: true,
    elevated,
    message: stateWarning
      ? `Workspace deleted, but its state could not be recorded: ${stateWarning}`
      : elevated
        ? 'Workspace deleted (workspace Admin role was granted first).'
        : 'Workspace deleted.',
    stateRecorded: !stateWarning,
  };
}

/**
 * Delete workspaces one after another rather than in parallel: the Fabric API
 * throttles bulk administrative calls, and serial execution keeps one failure from
 * obscuring the rest of the batch.
 */
async function deleteWorkspaces(pbi, workspaces, context = {}) {
  const results = [];
  for (const workspace of workspaces || []) {
    const target = typeof workspace === 'string' ? { id: workspace } : workspace || {};
    results.push(await deleteWorkspace(pbi, { ...target, ...context }));
  }
  return {
    results,
    deletedCount: results.filter(r => r.success).length,
    failedCount: results.filter(r => !r.success).length,
    permissionDeniedCount: results.filter(r => !r.success && r.permissionDenied).length,
  };
}

module.exports = { deleteWorkspace, deleteWorkspaces, isPermissionError };
