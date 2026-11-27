/**
 * GET  /api/governance/summary?tenantId={id}[&runId={id}] the Governance Outcome (selected scan)
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

  /**
   * The scan to show: `runId` if given, else the scan selected at the top when it
   * belongs to this tenant, else none (the tenant's latest whole-tenant scan). A
   * scan is only accepted from the reader's own list, and only of this tenant.
   */
  function resolveRun(req, res, tenantId) {
    const runs = res.locals.availableRuns || [];
    const sameTenant = run => service.normalizeTenantId(run && run.tenant_id) === tenantId;
    if (req.query.runId !== undefined && req.query.runId !== '') {
      const id = Number.parseInt(req.query.runId, 10);
      const run = Number.isInteger(id) ? runs.find(r => r.id === id) : null;
      if (!run) return { error: 403, message: 'You do not have access to that scan.' };
      if (!sameTenant(run)) return { error: 400, message: 'That scan belongs to another tenant.' };
      return { runId: id };
    }
    const selected = res.locals.globalRun;
    if (selected && sameTenant(selected) && runs.some(r => r.id === selected.id)) return { runId: selected.id };
    return { runId: null };
  }

  async function respond(req, res, options) {
    const picked = resolveTenant(req, res);
    if (picked.error) return res.status(picked.error).json({ error: picked.message });
    const chosen = resolveRun(req, res, picked.tenantId);
    if (chosen.error) return res.status(chosen.error).json({ error: chosen.message });
    try {
      const result = await service.getOutcome(picked.tenantId, { ...options, runId: chosen.runId });
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
