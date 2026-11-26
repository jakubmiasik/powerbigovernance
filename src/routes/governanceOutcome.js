/**
 * GET  /api/governance/summary?tenantId={id}             the Governance Outcome
 * POST /api/governance/summary/regenerate?tenantId={id}  generate it again now
 *
 * The tenant is checked here, not by section middleware: /api paths belong to no
 * section. A tenant the reader cannot see is 403 whether or not it exists.
 */

const express = require('express');
const { getConfig } = require('../config/settings');
const outcomes = require('../services/governanceOutcomeService');

function createRouter({ service = outcomes } = {}) {
  const router = express.Router();

  function resolveTenant(req, res) {
    const allowed = service.allowedTenants(req.permissions || res.locals.permissions, res.locals.availableRuns || []);
    return service.pickTenant(req.query.tenantId, allowed, {
      defaultTenantId: getConfig().governance.tenantId,
      selectedRun: res.locals.globalRun,
    });
  }

  async function respond(req, res, options) {
    const picked = resolveTenant(req, res);
    if (picked.error) return res.status(picked.error).json({ error: picked.message });
    try {
      const result = await service.getOutcome(picked.tenantId, options);
      if (result.status !== 200) return res.status(result.status).json({ error: result.message, tenantId: picked.tenantId });
      res.set('Cache-Control', 'no-store');
      return res.json({ ...result.outcome, meta: { ...result.outcome.meta, cached: !!result.cached } });
    } catch (err) {
      console.error('[GovernanceOutcome]', err.message);
      return res.status(500).json({ error: 'The governance outcome could not be generated.' });
    }
  }

  router.get('/summary', (req, res) => respond(req, res, { trigger: 'on-demand' }));

  // JSON only: a cross-site form cannot send it without a preflight, so the
  // button cannot be pressed from another site.
  router.post('/summary/regenerate', (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send this request as application/json.' });
    return respond(req, res, { force: true, trigger: 'on-demand' });
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
