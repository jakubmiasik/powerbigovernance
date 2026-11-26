const express = require('express');
const router = express.Router();
const { PREREQUISITES } = require('../services/qualityGuideService');
const { getConfig } = require('../config/settings');
const outcomes = require('../services/governanceOutcomeService');

router.get('/', (req, res) => {
  if (!req.user) {
    return res.render('landing', { title: 'Power BI Governance' });
  }
  // The Governance Outcome is loaded by the page from /api/governance/summary, so
  // Home renders at once and shows its own loading and error states. Here we only
  // decide which tenants the reader may pick, with the same rule the API applies.
  const outcomeTenants = outcomes.allowedTenants(req.permissions || res.locals.permissions, res.locals.availableRuns || []);
  const picked = outcomes.pickTenant(undefined, outcomeTenants, {
    defaultTenantId: getConfig().governance.tenantId,
    selectedRun: res.locals.globalRun,
  });
  res.render('home', {
    title: 'Home', user: req.user, breadcrumb: [{ label: 'Home', href: '/' }],
    prerequisites: PREREQUISITES,
    outcomeTenants,
    outcomeTenantId: picked.tenantId || null,
  });
});

// The onboarding that used to sit on Home, so Home is the governance outcome alone.
router.get('/getting-started', (req, res) => {
  res.render('getting-started', {
    title: 'Getting started', user: req.user,
    breadcrumb: [{ label: 'Home', href: '/' }, { label: 'Getting started', href: '/getting-started' }],
    prerequisites: PREREQUISITES,
  });
});

module.exports = router;
