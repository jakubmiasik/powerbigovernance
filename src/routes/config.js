const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const { getAccessTokenForSP } = require('../services/authService');

router.get('/', async (req, res) => {
  try {
    const servicePrincipals = await db.getServicePrincipals();
    res.render('config', {
      title: 'Settings',
      user: req.user,
      servicePrincipals,
      success: req.flash('success'),
      error: req.flash('error'),
    });
  } catch (err) {
    res.render('config', {
      title: 'Settings',
      user: req.user,
      servicePrincipals: [],
      success: [],
      error: [err.message],
    });
  }
});

router.post('/sp/save', async (req, res) => {
  const { id, name, tenantId, clientId, clientSecret, enterpriseAppObjectId } = req.body;
  if (!name || !tenantId || !clientId || !clientSecret) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/settings');
  }
  try {
    await db.saveServicePrincipal({ id: id ? parseInt(id) : null, name, tenantId, clientId, clientSecret, enterpriseAppObjectId: enterpriseAppObjectId || null });
    req.flash('success', 'Service principal saved.');
  } catch (err) {
    req.flash('error', 'Failed to save: ' + err.message);
  }
  res.redirect('/settings');
});

router.post('/sp/delete/:id', async (req, res) => {
  try {
    await db.deleteServicePrincipal(parseInt(req.params.id));
    req.flash('success', 'Service principal deleted.');
  } catch (err) {
    req.flash('error', 'Failed to delete: ' + err.message);
  }
  res.redirect('/settings');
});

router.post('/sp/test/:id', async (req, res) => {
  try {
    const sp = await db.getServicePrincipalById(parseInt(req.params.id));
    if (!sp) return res.json({ success: false, message: 'Service principal not found.' });
    await getAccessTokenForSP(sp);
    res.json({ success: true, message: 'Successfully connected to Power BI API.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
