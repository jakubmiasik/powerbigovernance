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

// ── Service Principal CRUD ──

router.post('/sp/save', async (req, res) => {
  const { id, name, tenantId, clientId, clientSecret, enterpriseAppObjectId, keyVaultName, keyVaultSecretName } = req.body;
  const hasKv = keyVaultName && keyVaultSecretName;
  if (!name || !tenantId || !clientId || (!clientSecret && !hasKv)) {
    req.flash('error', 'Name, Tenant ID, Client ID, and either a Client Secret or Key Vault details are required.');
    return res.redirect('/settings');
  }
  try {
    await db.saveServicePrincipal({
      id: id ? parseInt(id) : null,
      name, tenantId, clientId,
      clientSecret: clientSecret || null,
      enterpriseAppObjectId: enterpriseAppObjectId || null,
      keyVaultName: keyVaultName || null,
      keyVaultSecretName: keyVaultSecretName || null,
    });
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


// ── Service Principal CRUD (kept for migrate/delegated auth usage) ──

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

// ── User Assigned Managed Identity CRUD ──

router.post('/mi/save', async (req, res) => {
  const { id, name, clientId } = req.body;
  if (!name || !clientId) {
    req.flash('error', 'Name and Client ID are required.');
    return res.redirect('/settings');
  }
  try {
    await db.saveManagedIdentity({ id: id ? parseInt(id) : null, name, clientId });
    req.flash('success', 'Managed Identity saved.');
  } catch (err) {
    req.flash('error', 'Failed to save: ' + err.message);
  }
  res.redirect('/settings');
});

router.post('/mi/delete/:id', async (req, res) => {
  try {
    await db.deleteManagedIdentity(parseInt(req.params.id));
    req.flash('success', 'Managed Identity deleted.');
  } catch (err) {
    req.flash('error', 'Failed to delete: ' + err.message);
  }
  res.redirect('/settings');
});

router.post('/mi/test/:id', async (req, res) => {
  try {
    const mi = await db.getManagedIdentityById(parseInt(req.params.id));
    if (!mi) return res.json({ success: false, message: 'Managed Identity not found.' });
    await getAccessTokenForMI(mi.client_id);
    res.json({ success: true, message: 'Successfully acquired Power BI token using User Assigned Managed Identity.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
