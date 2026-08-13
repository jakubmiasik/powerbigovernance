const db = require('./databaseService');

/**
 * Delete a workspace in Fabric and record the outcome.
 *
 * The workspace row is never removed from our own storage. On success its state is
 * flipped to 'Deleted' in every stored scan and an audit row is written, so the
 * items, users and findings collected before deletion remain available.
 */
async function deleteWorkspace(pbi, { id, name, runId, deletedBy }) {
  if (!id) return { id: id || null, name: name || null, success: false, message: 'Workspace ID is required.' };

  try {
    await pbi.deleteWorkspace(id);
  } catch (err) {
    return { id, name: name || null, success: false, message: err.message };
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
    message: stateWarning
      ? `Workspace deleted, but its state could not be recorded: ${stateWarning}`
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
  };
}

module.exports = { deleteWorkspace, deleteWorkspaces };
