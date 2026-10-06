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

/**
 * The original address hidden inside a guest's user principal name.
 *
 * A B2B guest invited as `jakub.miasik@softwareone.com` is stored in the inviting
 * tenant as `jakub.miasik_softwareone.com#EXT#@contoso.onmicrosoft.com`. Which of
 * the two forms arrives in the sign-in token depends on the tenant and the
 * identity provider, so a grant recorded against one of them simply never matches
 * the other — the entry looks correct and the person is told they have no access.
 *
 * Only the part before `#EXT#` is decoded, and only its *last* underscore becomes
 * the `@`: `ann_marie_contoso.com#EXT#@...` is ann_marie at contoso.com, not ann
 * at marie_contoso.com.
 */
function externalAddressFromGuestUpn(upn) {
  const value = normalizeEmail(upn);
  const marker = value.indexOf('#ext#');
  if (marker === -1) return '';

  const local = value.slice(0, marker);
  const split = local.lastIndexOf('_');
  if (split <= 0 || split === local.length - 1) return '';

  const candidate = local.slice(0, split) + '@' + local.slice(split + 1);
  return candidate.includes('.') ? candidate : '';
}

function isGuestUpn(upn) {
  return normalizeEmail(upn).includes('#ext#');
}

/**
 * Every address a signed-in person could be recorded under, best first.
 *
 * Both forms of a guest's identity are included so a grant matches whichever one
 * the token happens to carry, and whichever one the administrator happened to see
 * when they granted it.
 */
function identityEmails(user) {
  const found = [];
  const add = (value) => {
    const email = normalizeEmail(value);
    if (email && email.includes('@') && !found.includes(email)) found.push(email);
  };

  if (user) {
    add(user.email);
    add(user.userPrincipalName);
    add(externalAddressFromGuestUpn(user.email));
    add(externalAddressFromGuestUpn(user.userPrincipalName));
    (user.alternateEmails || []).forEach(add);
  }
  return found;
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
 * Access can be granted to the person directly or to a security group they belong
 * to, so what arrives here is a *set* of matching entries. They are combined
 * additively: the most access any one of them confers is what the person gets.
 * Intersecting instead would make adding somebody to a second group take access
 * away, which is the opposite of what granting means.
 *
 * @param {object} options
 * @param {object|null} options.user        the signed-in user ({ email, name })
 * @param {object|null} options.record      their own row from app_users, with tenantIds/sectionKeys
 * @param {Array}       options.groupRecords rows for security groups they belong to
 * @param {string[]}    options.adminEmails emails that are administrators by configuration
 * @param {boolean}     options.anyAdminConfigured whether any administrator exists yet
 * @param {Array}       options.tenants     every configured tenant (service principal)
 */
function resolvePermissions({
  user, record, groupRecords = [], adminEmails = [], anyAdminConfigured = false, tenants = [],
} = {}) {
  const email = normalizeEmail(user && user.email);
  // Both forms of a guest's address count, so naming either one in ADMIN_EMAILS
  // works regardless of which the sign-in token carries.
  const candidates = identityEmails(user);
  const configured = adminEmails.map(normalizeEmail);
  const envAdmin = candidates.some(candidate => configured.includes(candidate));
  // Nobody has been made an administrator yet, so the first arrivals must be able
  // to reach the panel and name one.
  const bootstrap = !anyAdminConfigured;

  // A deactivated entry grants nothing, whether it is the person's own or a group's.
  const applicable = [record, ...groupRecords].filter(entry => entry && entry.is_active !== false);
  const recordAdmin = applicable.some(entry => entry.role === ROLE_ADMIN);
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
      viaGroups: [],
    };
  }

  // Signed in, but nobody has granted this person anything. They are not an error
  // and not an administrator — they simply have no access yet, and must be told so
  // rather than shown an application with every page empty.
  if (!applicable.length) {
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
      viaGroups: [],
    };
  }

  const tenantIds = [...new Set(
    applicable.flatMap(entry => (entry.tenantIds || []).map(Number)).filter(Number.isFinite),
  )];
  const sectionKeys = [...new Set(applicable.flatMap(entry => entry.sectionKeys || []))]
    .filter(key => SECTION_KEYS.includes(key))
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
    // Which groups did the granting, so the panel and the refusal page can say
    // where somebody's access actually comes from.
    viaGroups: applicable
      .filter(entry => entry.principal_type === 'group')
      .map(entry => entry.display_name || entry.entra_object_id),
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
  externalAddressFromGuestUpn,
  isGuestUpn,
  identityEmails,
  parseAdminEmails,
  resolvePermissions,
  canSeeSection,
  canSeeTenant,
  canAccessPath,
  visibleSections,
  visibleTenants,
  visibleRuns,
};
