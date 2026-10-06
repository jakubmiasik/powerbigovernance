const express = require('express');
const router = express.Router();
const db = require('../services/databaseService');
const permissionRepository = require('../services/permissionRepository');
const directory = require('../services/directoryService');
const { clearPermissionCache } = require('../middleware/permissions');
const { GRANTABLE_SECTIONS } = require('../services/appSectionService');
const { ROLE_ADMIN, ROLE_USER, normalizeEmail } = require('../services/permissionService');

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Finds people and security groups in Entra ID.
 *
 * Access is granted to a directory object rather than to typed-in text: a mistyped
 * address does not fail, it simply never matches, and the person it was meant for
 * is told they have no access while the row looks perfectly correct.
 */
router.get('/directory/search', async (req, res) => {
  try {
    const type = req.query.type === 'group' ? 'group' : 'user';
    const results = await directory.search(req.query.q, type);
    res.json({ success: true, results });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

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
  const principalType = req.body.principalType === 'group' ? 'group' : 'user';
  const entraObjectId = String(req.body.entraObjectId || '').trim();

  try {
    if (principalType === 'group') {
      // The object id is what membership is matched against, so a group entry
      // without one would be a grant that can never apply to anybody.
      if (!entraObjectId) {
        req.flash('error', 'Choose the security group from the directory list so it can be matched to its members.');
        return res.redirect('/settings/permissions');
      }
    } else if (!entraObjectId && (!email || !normalizeEmail(email).includes('@'))) {
      // Either identity is enough: the object id is what a guest is matched on,
      // since which of their two addresses the sign-in token carries is not ours
      // to decide.
      req.flash('error', 'Choose the person from the directory list, or enter a valid sign-in email address.');
      return res.redirect('/settings/permissions');
    }

    const isAdmin = role === ROLE_ADMIN;
    await permissionRepository.saveUser({
      id: id || null,
      email,
      displayName: displayName || null,
      principalType,
      entraObjectId: entraObjectId || null,
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
    // A group's membership is cached, and an administrator who has just granted a
    // group expects to be able to test it immediately.
    directory.clearDirectoryCache();
    req.flash('success', 'Access saved for ' + (principalType === 'group' ? (displayName || 'the group') : normalizeEmail(email)) + '.');
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
    directory.clearDirectoryCache();
    req.flash('success', 'User removed.');
  } catch (err) {
    req.flash('error', 'Failed to remove: ' + err.message);
  }
  res.redirect('/settings/permissions');
});

module.exports = router;
