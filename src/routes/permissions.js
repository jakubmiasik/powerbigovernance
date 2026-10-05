const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const permissionRepository = require('../services/permissionRepository');
const { clearPermissionCache } = require('../middleware/permissions');
const { GRANTABLE_SECTIONS } = require('../services/appSectionService');
const { ROLE_ADMIN, ROLE_USER, normalizeEmail } = require('../services/permissionService');

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

router.get('/', async (req, res) => {
  try {
    const [users, servicePrincipals] = await Promise.all([
      permissionRepository.listUsers(),
      db.getServicePrincipals(),
    ]);

    res.render('settings/permissions', {
      title: 'Users & Access',
      user: req.user,
      users,
      // Only the identifying fields: this page has no business holding credentials.
      tenants: servicePrincipals.map(sp => ({ id: Number(sp.id), name: sp.name, tenant_id: sp.tenant_id })),
      sections: GRANTABLE_SECTIONS,
      bootstrap: Boolean(req.permissions && req.permissions.isBootstrap),
      success: req.flash('success'),
      error: req.flash('error'),
      hideRunSelector: true,
    });
  } catch (err) {
    res.render('settings/permissions', {
      title: 'Users & Access',
      user: req.user,
      users: [], tenants: [], sections: GRANTABLE_SECTIONS, bootstrap: false,
      success: [], error: [err.message],
      hideRunSelector: true,
    });
  }
});

router.post('/save', async (req, res) => {
  const { id, email, displayName, role } = req.body;
  try {
    if (!email || !normalizeEmail(email).includes('@')) {
      req.flash('error', 'A valid sign-in email address is required.');
      return res.redirect('/settings/permissions');
    }

    const isAdmin = role === ROLE_ADMIN;
    await permissionRepository.saveUser({
      id: id || null,
      email,
      displayName: displayName || null,
      role: isAdmin ? ROLE_ADMIN : ROLE_USER,
      isActive: req.body.isActive !== undefined ? req.body.isActive === 'on' || req.body.isActive === 'true' : true,
      // An administrator's grants are not stored: they see everything by role, and
      // keeping a half-filled list beside that would suggest a restriction that is
      // not being applied.
      tenantIds: isAdmin ? [] : asArray(req.body.tenantIds),
      sectionKeys: isAdmin ? [] : asArray(req.body.sectionKeys),
      actor: req.user ? req.user.email : null,
    });

    clearPermissionCache();
    req.flash('success', 'Access saved for ' + normalizeEmail(email) + '.');
  } catch (err) {
    req.flash('error', 'Failed to save: ' + err.message);
  }
  res.redirect('/settings/permissions');
});

router.post('/delete/:id', async (req, res) => {
  try {
    const targetId = Number.parseInt(req.params.id, 10);
    const users = await permissionRepository.listUsers();
    const target = users.find(candidate => candidate.id === targetId);

    if (target && target.role === ROLE_ADMIN) {
      const remainingAdmins = users.filter(c => c.role === ROLE_ADMIN && c.is_active && c.id !== targetId);
      // Removing the last administrator would leave the panel unreachable except
      // through ADMIN_EMAILS, so it is refused rather than silently allowed.
      if (!remainingAdmins.length) {
        req.flash('error', 'This is the only administrator. Grant administrator rights to someone else first.');
        return res.redirect('/settings/permissions');
      }
    }

    await permissionRepository.deleteUser(targetId);
    clearPermissionCache();
    req.flash('success', 'User removed.');
  } catch (err) {
    req.flash('error', 'Failed to remove: ' + err.message);
  }
  res.redirect('/settings/permissions');
});

module.exports = router;
