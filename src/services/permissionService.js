/**
 * Who may see which tenants and which sections.
 *
 * The resolution is deliberately a pure function of (stored record, bootstrap
 * state, environment admins, existing tenants). It decides nothing by reading the
 * database itself, so every rule below is testable without one — and the rule that
 * matters most is the one that keeps the application from locking everybody out.
 *
 * Lockout safety has two independent guards, because a permission system that can
 * lock out its own administrator is worse than no permission system at all:
 *
 *   1. ADMIN_EMAILS always confers administrator rights. It is read from app
 *      configuration, so it stays reachable even if the permissions table is wrong.
 *   2. While no administrator is configured at all, every signed-in user is treated
 *      as one. This is how the panel is reachable the first time. It stops the
 *      moment the first administrator is saved.
 */

const { APP_SECTIONS, SECTION_KEYS, sectionForPath, isAlwaysAllowed } = require('./appSectionService');

const ROLE_ADMIN = 'admin';
const ROLE_USER = 'user';
const ROLES = [ROLE_ADMIN, ROLE_USER];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function parseAdminEmails(raw) {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map(normalizeEmail)
    .filter(Boolean);
}

/**
 * The effective permissions for one signed-in user.
 *
 * @param {object} options
 * @param {object|null} options.user        the signed-in user ({ email, name })
 * @param {object|null} options.record      their row from app_users, with tenantIds/sectionKeys
 * @param {string[]}    options.adminEmails emails that are administrators by configuration
 * @param {boolean}     options.anyAdminConfigured whether any administrator exists yet
 * @param {Array}       options.tenants     every configured tenant (service principal)
 */
function resolvePermissions({ user, record, adminEmails = [], anyAdminConfigured = false, tenants = [] } = {}) {
  const email = normalizeEmail(user && user.email);
  const envAdmin = Boolean(email) && adminEmails.map(normalizeEmail).includes(email);
  // Nobody has been made an administrator yet, so the first arrivals must be able
  // to reach the panel and name one.
  const bootstrap = !anyAdminConfigured;
  const recordAdmin = Boolean(record) && record.is_active !== false && record.role === ROLE_ADMIN;
  const isAdmin = envAdmin || bootstrap || recordAdmin;

  const allTenantIds = tenants.map(tenant => Number(tenant.id));

  if (isAdmin) {
    return {
      email,
      isAdmin: true,
      isBootstrap: bootstrap && !envAdmin && !recordAdmin,
      isKnown: true,
      reason: envAdmin ? 'configured-admin' : (recordAdmin ? 'admin' : 'bootstrap'),
      allTenants: true,
      tenantIds: allTenantIds,
      sectionKeys: SECTION_KEYS.slice(),
      allSections: true,
    };
  }

  // Signed in, but nobody has granted this person anything. They are not an error
  // and not an administrator — they simply have no access yet, and must be told so
  // rather than shown an application with every page empty.
  if (!record || record.is_active === false) {
    return {
      email,
      isAdmin: false,
      isBootstrap: false,
      isKnown: false,
      reason: record ? 'deactivated' : 'unknown',
      allTenants: false,
      tenantIds: [],
      sectionKeys: [],
      allSections: false,
    };
  }

  const tenantIds = [...new Set((record.tenantIds || []).map(Number).filter(Number.isFinite))];
  const sectionKeys = [...new Set((record.sectionKeys || []).filter(key => SECTION_KEYS.includes(key)))]
    // An ordinary user can never hold an admin-only section, whatever the table says.
    .filter(key => {
      const section = APP_SECTIONS.find(candidate => candidate.key === key);
      return section && !section.adminOnly;
    });

  return {
    email,
    isAdmin: false,
    isBootstrap: false,
    isKnown: true,
    reason: 'granted',
    allTenants: false,
    tenantIds,
    sectionKeys,
    allSections: false,
  };
}

function canSeeSection(permissions, key) {
  if (!permissions) return false;
  if (permissions.isAdmin) return true;
  return (permissions.sectionKeys || []).includes(key);
}

function canSeeTenant(permissions, spId) {
  if (!permissions) return false;
  if (permissions.allTenants) return true;
  const wanted = Number(spId);
  if (!Number.isFinite(wanted)) return false;
  return (permissions.tenantIds || []).includes(wanted);
}

/**
 * Whether a request path is permitted. Paths outside every section (the home page,
 * the shared APIs) stay open to any signed-in user; a path inside a section needs
 * that section.
 */
function canAccessPath(permissions, path) {
  if (isAlwaysAllowed(path)) return true;
  const section = sectionForPath(path);
  if (!section) return true;
  if (section.adminOnly) return Boolean(permissions && permissions.isAdmin);
  return canSeeSection(permissions, section.key);
}

function visibleSections(permissions) {
  return APP_SECTIONS.filter(section => (
    section.adminOnly ? Boolean(permissions && permissions.isAdmin) : canSeeSection(permissions, section.key)
  ));
}

/** The tenants this user may act on, in the order they were given. */
function visibleTenants(permissions, tenants = []) {
  if (permissions && permissions.allTenants) return tenants.slice();
  return tenants.filter(tenant => canSeeTenant(permissions, tenant.id));
}

/**
 * Analysis runs belong to the tenant they scanned. A user who cannot see a tenant
 * must not see its scans either, or the tenant restriction would be undone by the
 * run selector on every page.
 */
function visibleRuns(permissions, runs = []) {
  if (permissions && permissions.allTenants) return runs.slice();
  return runs.filter(run => canSeeTenant(permissions, run.sp_id));
}

module.exports = {
  ROLE_ADMIN,
  ROLE_USER,
  ROLES,
  normalizeEmail,
  parseAdminEmails,
  resolvePermissions,
  canSeeSection,
  canSeeTenant,
  canAccessPath,
  visibleSections,
  visibleTenants,
  visibleRuns,
};
