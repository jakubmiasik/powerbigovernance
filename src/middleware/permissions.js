/**
 * Loads the signed-in user's permissions and enforces them.
 *
 * Enforcement is here, in front of every route, rather than in the sidebar. Hiding
 * a menu entry is a courtesy; a restriction that only exists in the menu is
 * defeated by typing the URL.
 *
 * Permissions are cached briefly per email. Without it every request would run
 * three extra queries, and the page templates themselves read the result.
 */

const permissions = require('../services/permissionService');
const permissionRepository = require('../services/permissionRepository');
const directoryService = require('../services/directoryService');
const db = require('../services/databaseService');
const { sectionForPath } = require('../services/appSectionService');

const PERMISSION_CACHE_TTL_MS = parseInt(process.env.PERMISSION_CACHE_TTL_MS || '30000', 10);
const cache = new Map();

function clearPermissionCache() {
  cache.clear();
}

/**
 * The security groups this person belongs to, when any group has been granted
 * anything at all.
 *
 * Asking Entra is skipped entirely while no group grants exist, so an application
 * that only names individuals never needs directory read permission. Once a group
 * is granted, a failure to read membership is reported rather than treated as
 * "belongs to nothing" — that would silently drop every group-based grant.
 */
async function readGroupRecords(identity, anyGroupGranted) {
  if (!anyGroupGranted) return [];
  // The object id is preferred because Graph cannot look a guest up by the
  // address they signed in with: their external address is not their principal
  // name in this tenant, so by-address lookup is a 404 and every group grant
  // would appear to confer nothing.
  const groupIds = await directoryService.groupIdsForUser(identity.objectId || identity.email);
  if (!groupIds.length) return [];
  return permissionRepository.getGroupRecords(groupIds);
}

async function readPermissionInputs(identity) {
  const cached = cache.get(identity.cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // Errors are deliberately not swallowed here. Treating an unreadable table as
  // "no administrator exists" would put the whole application into bootstrap mode
  // and hand every signed-in user administrator rights — the exact opposite of
  // what a failure should do. The caller turns a failure into no access instead.
  const [record, anyAdminConfigured, tenants, anyGroupGranted] = await Promise.all([
    permissionRepository.getUserByIdentity({ objectId: identity.objectId, emails: identity.emails }),
    permissionRepository.hasAnyAdmin(),
    db.getServicePrincipals(),
    permissionRepository.hasAnyGroupGrant(),
  ]);

  const groupRecords = await readGroupRecords(identity, anyGroupGranted);

  const value = { record, groupRecords, anyAdminConfigured, tenants };
  cache.set(identity.cacheKey, { expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS, value });
  return value;
}

/**
 * Every way the signed-in person can be recognised.
 *
 * A guest arrives under whichever of their two addresses the tenant puts in the
 * token, so one of them is not enough to find a grant made against the other.
 */
function identityOf(user) {
  const emails = permissions.identityEmails(user);
  const objectId = String((user && user.objectId) || '').trim() || null;
  return {
    objectId,
    emails,
    email: emails[0] || '',
    // Keyed on the object id when there is one: two addresses for the same guest
    // must not become two cache entries that can disagree.
    cacheKey: objectId ? 'oid:' + objectId : 'email:' + (emails[0] || ''),
  };
}

async function loadPermissions(req, res, next) {
  const adminEmails = permissions.parseAdminEmails(process.env.ADMIN_EMAILS);

  // No signed-in user means auth is switched off (local development). Treating
  // that as an administrator keeps the app usable without inventing an identity.
  if (!req.user) {
    req.permissions = permissions.resolvePermissions({ user: null, record: null, adminEmails, anyAdminConfigured: false });
    res.locals.permissions = req.permissions;
    res.locals.visibleSections = permissions.visibleSections(req.permissions);
    return next();
  }

  try {
    const identity = identityOf(req.user);
    const { record, groupRecords, anyAdminConfigured, tenants } = await readPermissionInputs(identity);
    req.permissions = permissions.resolvePermissions({
      user: req.user, record, groupRecords, adminEmails, anyAdminConfigured, tenants,
    });
  } catch (err) {
    // The permission tables being unreadable must not hand out access. The user is
    // told their access could not be determined instead of silently getting none
    // or, worse, all of it.
    console.error('[Permissions] Could not resolve permissions:', err.message);
    req.permissions = {
      email: permissions.normalizeEmail(req.user.email),
      isAdmin: false, isKnown: false, isBootstrap: false, reason: 'error',
      allTenants: false, tenantIds: [], sectionKeys: [], allSections: false,
      error: err.message,
    };
  }

  res.locals.permissions = req.permissions;
  res.locals.visibleSections = permissions.visibleSections(req.permissions);
  next();
}

function requireSectionAccess(req, res, next) {
  if (permissions.canAccessPath(req.permissions, req.path)) return next();

  const section = sectionForPath(req.path);
  const message = req.permissions && req.permissions.reason === 'error'
    ? 'Your access could not be determined right now. Try again shortly.'
    : null;

  // A fetch/XHR call needs an answer it can read, not a page it cannot render.
  const wantsJson = req.xhr
    || (req.get('accept') || '').includes('application/json')
    || req.path.startsWith('/api/');
  if (wantsJson) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: message || 'You do not have access to this section.',
      section: section ? section.key : null,
    });
  }

  res.status(403).render('no-access', {
    title: 'No access',
    user: req.user,
    section,
    message,
    permissions: req.permissions,
    hideRunSelector: true,
  });
}

module.exports = { loadPermissions, requireSectionAccess, clearPermissionCache };
