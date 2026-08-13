const db = require('./databaseService');

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
      return { id, name: name || null, success: false, message: err.message, permissionDenied: isPermissionError(err) };
    }
    // Self-elevate to workspace Admin, then try exactly once more.
    try {
      await elevate(id);
      elevated = true;
    } catch (grantErr) {
      return {
        id,
        name: name || null,
        success: false,
        permissionDenied: true,
        message: `Access denied and the workspace Admin role could not be granted: ${grantErr.message}`,
      };
    }
    try {
      await pbi.deleteWorkspace(id);
    } catch (retryErr) {
      return { id, name: name || null, success: false, message: retryErr.message, permissionDenied: isPermissionError(retryErr) };
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
