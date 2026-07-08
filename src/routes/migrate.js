const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { createPowerBIService } = require('../services/powerbiService');

// Helper to load workspaces + capacities from saved analysis run
async function loadMigrationData(res) {
  const globalRun = res.locals.globalRun;
  if (!globalRun) return null;
  const fullRun = await db.getAnalysisRunById(globalRun.id);
  if (!fullRun || !fullRun.results_json) return null;
  try {
    return JSON.parse(fullRun.results_json);
  } catch {
    return null;
  }
}

router.get('/', async (req, res) => {
  try {
    const results = await loadMigrationData(res);
    const workspaces = results ? (results.workspaces || []) : [];
    const capacities = results && results.summary ? (results.summary.capacities || []) : [];

    res.render('migrate/index', {
      title: 'Migrate Workspaces',
      user: req.user,
      workspaces,
      capacities,
      noData: !results,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// Execute migration for selected workspaces
router.post('/execute', async (req, res) => {
  try {
    const { workspaceIds, targetCapacityId, action } = req.body;
    // action: 'assign' or 'unassign'

    if (!workspaceIds || !Array.isArray(workspaceIds) || workspaceIds.length === 0) {
      return res.json({ success: false, message: 'No workspaces selected.' });
    }

    if (action === 'assign' && !targetCapacityId) {
      return res.json({ success: false, message: 'No target capacity selected.' });
    }

    // Get the SP config from the current global run
    const globalRun = res.locals.globalRun;
    if (!globalRun) {
      return res.json({ success: false, message: 'No analysis run selected. Run an analysis first.' });
    }

    const sp = await db.getServicePrincipalById(globalRun.sp_id);
    if (!sp) {
      return res.json({ success: false, message: 'Service principal not found (sp_id: ' + globalRun.sp_id + '). Go to Settings to add one.' });
    }

    const pbi = createPowerBIService(sp);

    // For assign action, verify target capacity is active
    let targetSku = '';
    if (action === 'assign') {
      try {
        const capacities = await pbi.getCapacities();
        const targetCap = capacities.find(c => c.id.toLowerCase() === targetCapacityId.toLowerCase());
        if (!targetCap) {
          return res.json({ success: false, message: 'Target capacity not found. It may have been deleted.' });
        }
        if (targetCap.state !== 'Active') {
          return res.json({ success: false, message: 'Target capacity "' + (targetCap.displayName || targetCapacityId) + '" is ' + targetCap.state + '. Please select an active capacity.' });
        }
        targetSku = targetCap.sku || '';
      } catch (err) {
        return res.json({ success: false, message: 'Failed to verify target capacity: ' + err.message });
      }
    }

    // Load workspace names for results
    const results = await loadMigrationData(res);
    const wsMap = new Map();
    if (results && results.workspaces) {
      results.workspaces.forEach(ws => wsMap.set(ws.id, ws.name || 'Unnamed'));
    }

    // Execute migrations sequentially with results
    // For each workspace: add SP as Admin → migrate → remove SP
    const spClientId = sp.client_id;
    const migrationResults = [];
    for (const wsId of workspaceIds) {
      const wsName = wsMap.get(wsId) || wsId;
      let spWasAdded = false;
      try {
        // Step 1: Add SP as workspace Admin via Power BI Admin API
        try {
          await pbi.addWorkspaceAdmin(wsId, spClientId, 'App');
          spWasAdded = true;
        } catch (addErr) {
          // If SP is already an admin, continue without flagging for removal
          if (addErr.message && (addErr.message.includes('400') || addErr.message.includes('409') || addErr.message.includes('already'))) {
            spWasAdded = false;
          } else {
            throw new Error('Failed to add SP as workspace admin: ' + addErr.message);
          }
        }

        // Step 2: Perform migration
        if (action === 'unassign') {
          await pbi.unassignFromCapacity(wsId);
        } else {
          await pbi.assignToCapacity(wsId, targetCapacityId);
        }

        // Step 3: Remove SP from workspace after successful migration
        if (spWasAdded) {
          try {
            await pbi.removeWorkspaceUser(wsId, spClientId);
          } catch (removeErr) {
            migrationResults.push({ id: wsId, name: wsName, status: 'success', message: 'Migrated successfully (note: SP cleanup failed - ' + removeErr.message + ')' });
            continue;
          }
        }

        migrationResults.push({ id: wsId, name: wsName, status: 'success', message: 'Migrated successfully' });
      } catch (err) {
        // If migration failed but SP was added, try to clean up
        if (spWasAdded) {
          try { await pbi.removeWorkspaceUser(wsId, spClientId); } catch (_) { /* best effort */ }
        }
        migrationResults.push({ id: wsId, name: wsName, status: 'error', message: err.message });
      }
    }

    const successCount = migrationResults.filter(r => r.status === 'success').length;
    const errorCount = migrationResults.filter(r => r.status === 'error').length;

    res.json({
      success: true,
      results: migrationResults,
      summary: { total: workspaceIds.length, success: successCount, errors: errorCount },
      targetSku: targetSku,
    });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
