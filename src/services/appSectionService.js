/**
 * The application's sections, as the thing that is actually granted.
 *
 * A section is declared once, here, with the paths that belong to it. The sidebar,
 * the admin panel and the server-side guard all read this list, so a section cannot
 * be visible in the menu but unguarded on the server, or guarded under a path the
 * admin panel never offered.
 *
 * `prefixes` are matched longest-first, which is what lets /quality/security-groups
 * be its own section while /quality remains another.
 */

// Listed in menu order. `group` is the sidebar heading a section sits under, and the
// same heading groups the sections in the access panel, so both read the same way.
// `icon` is the Bootstrap Icons class older pages use; `lucide` is the Podavo icon.
const NAV_GROUPS = ['Overview', 'Governance', 'Operations', 'Data Quality', 'Configuration'];

const APP_SECTIONS = [
  {
    key: 'governance', label: 'Governance Overview', icon: 'bi-shield-check', lucide: 'shield-check', href: '/governance',
    group: 'Overview', prefixes: ['/governance'],
  },
  {
    key: 'workspaces', label: 'Workspaces', icon: 'bi-collection', lucide: 'layers', href: '/workspaces',
    group: 'Governance', prefixes: ['/workspaces'],
  },
  {
    key: 'pipelines', label: 'Deployment Pipelines', icon: 'bi-diagram-3', lucide: 'workflow', href: '/pipelines',
    group: 'Governance', prefixes: ['/pipelines'],
  },
  {
    key: 'tenant-settings', label: 'Tenant Settings', icon: 'bi-sliders', lucide: 'sliders-horizontal', href: '/tenant-settings',
    group: 'Governance', prefixes: ['/tenant-settings'],
  },
  {
    key: 'analysis', label: 'Run Analysis', icon: 'bi-play-circle', lucide: 'circle-play', href: '/analysis',
    group: 'Operations', prefixes: ['/analysis'],
  },
  {
    key: 'migrate', label: 'Migrate Workspaces', icon: 'bi-arrow-left-right', lucide: 'arrow-left-right', href: '/migrate',
    group: 'Operations', prefixes: ['/migrate'],
  },
  {
    key: 'capacities', label: 'Capacities', icon: 'bi-lightning', lucide: 'zap', href: '/capacities',
    group: 'Operations', prefixes: ['/capacities'],
  },
  {
    key: 'security-groups', label: 'Security Groups', icon: 'bi-people', lucide: 'users', href: '/quality/security-groups',
    group: 'Data Quality', prefixes: ['/quality/security-groups'],
  },
  {
    key: 'quality', label: 'Quality Configuration', icon: 'bi-patch-check', lucide: 'badge-check', href: '/quality',
    group: 'Data Quality', prefixes: ['/quality'],
  },
  {
    key: 'reconciliation', label: 'Reconciliation', icon: 'bi-clipboard2-check', lucide: 'scale', href: '/reconciliation',
    group: 'Data Quality', prefixes: ['/reconciliation'],
  },
  {
    key: 'mdm', label: 'Master Data', icon: 'bi-fingerprint', lucide: 'fingerprint', href: '/mdm',
    group: 'Data Quality', prefixes: ['/mdm'],
  },
  {
    // Configuration holds the credentials and this very permission panel, so it is
    // reserved for administrators and cannot be granted to an ordinary user.
    key: 'settings', label: 'Configuration', icon: 'bi-gear', lucide: 'settings', href: '/settings',
    group: 'Configuration', prefixes: ['/settings'], adminOnly: true,
  },
];

const SECTION_KEYS = APP_SECTIONS.map(section => section.key);
const GRANTABLE_SECTIONS = APP_SECTIONS.filter(section => !section.adminOnly);

// Paths every signed-in user may reach regardless of grants: the home page, the
// shared APIs the layout itself calls, and the "you have no access" page. Guarding
// these would leave a permitted user staring at a denial on their own landing page.
const ALWAYS_ALLOWED_PREFIXES = ['/', '/home', '/api', '/no-access', '/health', '/.auth', '/favicon.ico'];

function isAlwaysAllowed(path) {
  if (path === '/' || path === '/home') return true;
  return ALWAYS_ALLOWED_PREFIXES
    .filter(prefix => prefix !== '/')
    .some(prefix => path === prefix || path.startsWith(prefix + '/'));
}

// Longest prefix wins, so a more specific section claims the path before a more
// general one that happens to share its opening segment.
const MATCH_ORDER = APP_SECTIONS
  .flatMap(section => section.prefixes.map(prefix => ({ prefix, section })))
  .sort((a, b) => b.prefix.length - a.prefix.length);

function sectionForPath(path) {
  const candidate = String(path || '');
  const hit = MATCH_ORDER.find(({ prefix }) => candidate === prefix || candidate.startsWith(prefix + '/'));
  return hit ? hit.section : null;
}

function getSection(key) {
  return APP_SECTIONS.find(section => section.key === key) || null;
}

function sectionLabel(key) {
  const section = getSection(key);
  return section ? section.label : key;
}

module.exports = {
  NAV_GROUPS,
  APP_SECTIONS,
  SECTION_KEYS,
  GRANTABLE_SECTIONS,
  sectionForPath,
  getSection,
  sectionLabel,
  isAlwaysAllowed,
};
