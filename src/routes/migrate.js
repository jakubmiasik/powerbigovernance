const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../services/databaseService');
const { getDelegatedAuthUrl, acquireDelegatedToken } = require('../services/authService');

const PBI_ADMIN = 'https://api.powerbi.com/v1.0/myorg/admin';

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

// ── Main page ──
router.get('/', async (req, res) => {
  try {
    const results = await loadMigrationData(res);
    const workspaces = results ? (results.workspaces || []) : [];
    const capacities = results && results.summary ? (results.summary.capacities || []) : [];
    const hasMigrationToken = !!req.session.pbiMigrationToken;

    res.render('migrate/index', {
      title: 'Migrate Workspaces',
      user: req.user,
      workspaces,
      capacities,
      noData: !results,
      hasMigrationToken,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

// ── Refresh workspace data ──
router.get('/refresh', async (req, res) => {
  try {
    const results = await loadMigrationData(res);
    if (!results) {
      return res.json({ success: false, message: 'No analysis data available.' });
    }
    res.json({ success: true, workspaces: results.workspaces || [] });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── OAuth: redirect user to Azure AD for Power BI admin consent ──
router.get('/auth', async (req, res) => {
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/migrate/auth/callback`;
    const authUrl = await getDelegatedAuthUrl(redirectUri, 'migrate');
    res.redirect(authUrl);
  } catch (err) {
    res.render('error', { title: 'Auth Error', user: req.user, message: err.message });
  }
});

// ── OAuth callback: exchange code for delegated token ──
router.get('/auth/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) {
      return res.render('error', { title: 'Auth Error', user: req.user, message: error_description || error });
    }
    const redirectUri = `${req.protocol}://${req.get('host')}/migrate/auth/callback`;
    const token = await acquireDelegatedToken(code, redirectUri);
    req.session.pbiMigrationToken = token;
    res.redirect('/migrate');
  } catch (err) {
    res.render('error', { title: 'Auth Error', user: req.user, message: err.message });
  }
});

// ── Check auth status (AJAX) ──
router.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!req.session.pbiMigrationToken });
});

// ── Execute migration using delegated user token ──
router.post('/execute', async (req, res) => {
  try {
    const { workspaceIds, targetCapacityId, action } = req.body;

    if (!workspaceIds || !Array.isArray(workspaceIds) || workspaceIds.length === 0) {
      return res.json({ success: false, message: 'No workspaces selected.' });
    }

    const token = req.session.pbiMigrationToken;
    if (!token) {
      return res.json({ success: false, message: 'Not authorized for migration. Click "Authorize as Power BI Admin" first.' });
    }

    if (action === 'assign' && !targetCapacityId) {
      return res.json({ success: false, message: 'No target capacity selected.' });
    }

    // Load workspace names for results
    const results = await loadMigrationData(res);
    const wsMap = new Map();
    if (results && results.workspaces) {
      results.workspaces.forEach(ws => wsMap.set(ws.id, ws.name || 'Unnamed'));
    }

    // For assign: verify capacity is active, get SKU
    let targetSku = '';
    if (action === 'assign') {
      try {
        const capResponse = await axios.get(PBI_ADMIN + '/capacities', {
          headers: { Authorization: 'Bearer ' + token },
          timeout: 30000,
        });
        const capacities = capResponse.data.value || [];
        const targetCap = capacities.find(c => c.id.toLowerCase() === targetCapacityId.toLowerCase());
        if (!targetCap) {
          return res.json({ success: false, message: 'Target capacity not found.' });
        }
        if (targetCap.state !== 'Active') {
          return res.json({ success: false, message: 'Target capacity "' + (targetCap.displayName || targetCapacityId) + '" is ' + targetCap.state + '.' });
        }
        targetSku = targetCap.sku || '';
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        return res.json({ success: false, message: 'Failed to verify capacity: ' + msg });
      }
    }

    const migrationResults = [];

    if (action === 'assign') {
      // Use Admin API: POST /admin/capacities/{capacityId}/AssignWorkspaces
      // This can assign multiple workspaces in one call
      try {
        await axios.post(
          PBI_ADMIN + '/capacities/' + targetCapacityId + '/AssignWorkspaces',
          { workspacesToAssign: workspaceIds },
          {
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            timeout: 120000,
          }
        );
        // API returns 200 on success for the batch
        workspaceIds.forEach(wsId => {
          migrationResults.push({ id: wsId, name: wsMap.get(wsId) || wsId, status: 'success', message: 'Assigned to capacity' });
        });
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
        // If batch fails, try individually
        for (const wsId of workspaceIds) {
          try {
            await axios.post(
              PBI_ADMIN + '/capacities/' + targetCapacityId + '/AssignWorkspaces',
              { workspacesToAssign: [wsId] },
              {
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                timeout: 60000,
              }
            );
            migrationResults.push({ id: wsId, name: wsMap.get(wsId) || wsId, status: 'success', message: 'Assigned to capacity' });
          } catch (indErr) {
            const indMsg = indErr.response?.data?.error?.message || indErr.message;
            migrationResults.push({ id: wsId, name: wsMap.get(wsId) || wsId, status: 'error', message: indMsg });
          }
        }
      }
    } else {
      // Unassign: POST /admin/capacities/UnassignWorkspaces
      try {
        await axios.post(
          PBI_ADMIN + '/capacities/UnassignWorkspaces',
          { workspacesToUnassign: workspaceIds },
          {
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            timeout: 120000,
          }
        );
        workspaceIds.forEach(wsId => {
          migrationResults.push({ id: wsId, name: wsMap.get(wsId) || wsId, status: 'success', message: 'Unassigned from capacity' });
        });
      } catch (err) {
        // Try individually
        for (const wsId of workspaceIds) {
          try {
            await axios.post(
              PBI_ADMIN + '/capacities/UnassignWorkspaces',
              { workspacesToUnassign: [wsId] },
              {
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                timeout: 60000,
              }
            );
            migrationResults.push({ id: wsId, name: wsMap.get(wsId) || wsId, status: 'success', message: 'Unassigned from capacity' });
          } catch (indErr) {
            const indMsg = indErr.response?.data?.error?.message || indErr.message;
            migrationResults.push({ id: wsId, name: wsMap.get(wsId) || wsId, status: 'error', message: indMsg });
          }
        }
      }
    }

    const successCount = migrationResults.filter(r => r.status === 'success').length;
    const errorCount = migrationResults.filter(r => r.status === 'error').length;

    res.json({
      success: true,
      results: migrationResults,
      summary: { total: workspaceIds.length, success: successCount, errors: errorCount },
      targetSku,
    });
  } catch (err) {
    // If token expired, clear it
    if (err.response?.status === 401) {
      req.session.pbiMigrationToken = null;
    }
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
