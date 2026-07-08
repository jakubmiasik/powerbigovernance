const express = require('express');
const router = express.Router();
const {
  getConfig,
  updatePowerBIConfig,
  updateEntraConfig,
  isPowerBIConfigured,
  isEntraConfigured,
} = require('../config/settings');
const { resetAuthCache } = require('../services/authService');
const { getAccessToken } = require('../services/authService');

router.get('/', (req, res) => {
  const config = getConfig();
  res.render('config', {
    title: 'Settings',
    user: req.user,
    config,
    isPowerBIConfigured: isPowerBIConfigured(),
    isEntraConfigured: isEntraConfigured(),
    success: req.flash('success'),
    error: req.flash('error'),
  });
});

router.post('/powerbi', (req, res) => {
  const { clientId, clientSecret, tenantId } = req.body;

  if (!clientId || !clientSecret || !tenantId) {
    req.flash('error', 'All Power BI service principal fields are required.');
    return res.redirect('/settings');
  }

  updatePowerBIConfig({ clientId, clientSecret, tenantId });
  resetAuthCache();
  req.flash('success', 'Power BI service principal configuration saved.');
  res.redirect('/settings');
});

router.post('/entra', (req, res) => {
  const { clientId, clientSecret, tenantId } = req.body;

  if (!clientId || !clientSecret || !tenantId) {
    req.flash('error', 'All Entra ID fields are required.');
    return res.redirect('/settings');
  }

  updateEntraConfig({ clientId, clientSecret, tenantId });
  req.flash('success', 'Entra ID configuration saved. Restart the app for changes to take effect.');
  res.redirect('/settings');
});

router.post('/test-connection', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ success: true, message: 'Successfully connected to Power BI API.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
