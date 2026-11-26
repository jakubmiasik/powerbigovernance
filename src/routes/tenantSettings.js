const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { fallbackTenant } = require('../services/permissionService');
const { createPowerBIService } = require('../services/powerbiService');
const { summarizeTenantSettings } = require('../services/runMetricsService');

// The live counterpart to the Governance tenant settings page. Governance always
// shows the snapshot captured with an analysis run, so it describes a fixed point
// in time; this page calls the Fabric Admin API on every load and shows the state
// right now. Both render the same view, distinguished by `source`.
async function getPbiService(req, res) {
  const globalRun = res ? res.locals.globalRun : null;
  let sp;
  if (globalRun && globalRun.sp_id) sp = await db.getServicePrincipalById(globalRun.sp_id);
  if (!sp) {
    const sps = await db.getServicePrincipals();
    if (sps.length === 0) throw new Error('No service principal configured. Go to Settings to add one.');
    // The first tenant where this person holds the section, not simply the first
    // configured one: that may be a tenant they were never granted.
    sp = fallbackTenant(res && res.locals ? res.locals.permissions : null, 'tenant-settings', sps);
    if (!sp) throw new Error('No tenant is available to you for Tenant Settings. Ask an administrator to grant one under Users & Access.');
  }
  const keyVaultAuthUrl = `/settings/kv/auth?spId=${encodeURIComponent(String(sp.id))}&returnTo=${encodeURIComponent('/tenant-settings')}`;
  return createPowerBIService(sp, {
    keyVaultDelegatedToken: req.session?.keyVaultDelegatedToken?.token || null,
    keyVaultAuthUrl,
  });
}

router.get('/', async (req, res) => {
  const base = {
    title: 'Tenant Settings (Live)',
    user: req.user,
    source: 'live',
    run: null,
    capturedAt: new Date().toISOString(),
  };
  try {
    const pbi = await getPbiService(req, res);
    const settings = await pbi.getTenantSettings();
    const sorted = [...settings].sort((a, b) =>
      (a.tenantSettingGroup || 'Ungrouped').localeCompare(b.tenantSettingGroup || 'Ungrouped')
      || (a.title || a.settingName || '').localeCompare(b.title || b.settingName || '')
    );
    res.render('governance/tenant-settings', {
      ...base,
      settings: sorted,
      summary: summarizeTenantSettings(settings),
      error: null,
    });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    res.render('governance/tenant-settings', {
      ...base,
      settings: [],
      summary: summarizeTenantSettings([]),
      error: detail,
    });
  }
});

module.exports = router;
