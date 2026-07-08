const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');

// Governance now shows saved analysis results
router.get('/', async (req, res) => {
  try {
    const runs = await db.getAnalysisRuns();
    const latestRun = runs.find(r => r.status === 'completed');
    
    if (!latestRun) {
      return res.render('governance/overview', {
        title: 'Governance Overview',
        user: req.user,
        governance: null,
        page: 1,
        pageSize: 50,
        noData: true,
      });
    }

    // Load the latest completed run
    const fullRun = await db.getAnalysisRunById(latestRun.id);
    let results = null;
    try { results = JSON.parse(fullRun.results_json); } catch { results = null; }

    if (!results || !results.summary) {
      return res.render('governance/overview', {
        title: 'Governance Overview',
        user: req.user,
        governance: null,
        page: 1,
        pageSize: 50,
        noData: true,
      });
    }

    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 50;
    const allWorkspaces = results.workspaces || [];
    const totalPages = Math.ceil(allWorkspaces.length / pageSize);
    const pagedWorkspaces = allWorkspaces.slice((page - 1) * pageSize, page * pageSize);

    res.render('governance/overview', {
      title: 'Governance Overview',
      user: req.user,
      governance: results.summary,
      workspaces: pagedWorkspaces,
      run: fullRun,
      page,
      pageSize,
      totalPages,
      noData: false,
    });
  } catch (err) {
    res.render('error', { title: 'Error', user: req.user, message: err.message });
  }
});

module.exports = router;
