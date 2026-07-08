const express = require('express');
const router = express.Router();
const pbi = require('../services/powerbiService');

router.get('/', async (req, res) => {
  try {
    // Fetch data in parallel
    const [workspaces, capacities] = await Promise.all([
      pbi.getWorkspaces({ useAdmin: true }).catch(() => pbi.getWorkspaces()),
      pbi.getCapacities(),
    ]);

    // Build governance metrics
    const governance = {
      totalWorkspaces: workspaces.length,
      workspacesByState: {},
      workspacesByType: {},
      capacityCount: capacities.length,
      workspacesOnCapacity: 0,
      workspacesOnSharedCapacity: 0,
      capacities,
    };

    for (const ws of workspaces) {
      const state = ws.state || 'Active';
      const type = ws.type || 'Workspace';
      governance.workspacesByState[state] = (governance.workspacesByState[state] || 0) + 1;
      governance.workspacesByType[type] = (governance.workspacesByType[type] || 0) + 1;

      if (ws.capacityId && ws.capacityId !== '00000000-0000-0000-0000-000000000000') {
        governance.workspacesOnCapacity++;
      } else {
        governance.workspacesOnSharedCapacity++;
      }
    }

    // Sample workspaces for detailed analysis (first 10)
    const sampleWorkspaces = workspaces.slice(0, 10);
    const detailedData = [];

    for (const ws of sampleWorkspaces) {
      try {
        const [reports, datasets, users] = await Promise.all([
          pbi.getReports(ws.id).catch(() => []),
          pbi.getDatasets(ws.id).catch(() => []),
          pbi.getWorkspaceUsers(ws.id).catch(() => []),
        ]);

        const refreshFailures = [];
        for (const ds of datasets.slice(0, 5)) {
          try {
            const history = await pbi.getDatasetRefreshHistory(ws.id, ds.id, 5);
            const failures = history.filter((r) => r.status === 'Failed');
            if (failures.length > 0) {
              refreshFailures.push({ dataset: ds.name, failures });
            }
          } catch {
            // Skip datasets that don't support refresh
          }
        }

        detailedData.push({
          workspace: ws,
          reportCount: reports.length,
          datasetCount: datasets.length,
          userCount: users.length,
          users,
          refreshFailures,
          adminCount: users.filter((u) => u.groupUserAccessRight === 'Admin').length,
        });
      } catch {
        detailedData.push({
          workspace: ws,
          reportCount: '?',
          datasetCount: '?',
          userCount: '?',
          users: [],
          refreshFailures: [],
          adminCount: '?',
        });
      }
    }

    governance.detailedWorkspaces = detailedData;
    governance.totalWorkspacesAnalyzed = sampleWorkspaces.length;

    res.render('governance/overview', {
      title: 'Governance Overview',
      user: req.user,
      governance,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

module.exports = router;
