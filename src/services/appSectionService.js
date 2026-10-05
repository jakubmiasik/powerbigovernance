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

const APP_SECTIONS = [
  {
    key: 'workspaces', label: 'Workspaces', icon: 'bi-collection', href: '/workspaces',
    group: 'Main', prefixes: ['/workspaces'],
  },
  {
    key: 'governance', label: 'Governance', icon: 'bi-shield-check', href: '/governance',
    group: 'Main', prefixes: ['/governance'],
  },
  {
    key: 'pipelines', label: 'Deployment Pipelines', icon: 'bi-diagram-3', href: '/pipelines',
    group: 'Main', prefixes: ['/pipelines'],
  },
  {
    key: 'tenant-settings', label: 'Tenant Settings', icon: 'bi-sliders', href: '/tenant-settings',
    group: 'Main', prefixes: ['/tenant-settings'],
  },
  {
    key: 'analysis', label: 'Run Analysis', icon: 'bi-play-circle', href: '/analysis',
    group: 'Operations', prefixes: ['/analysis'],
  },
  {
    key: 'migrate', label: 'Migrate', icon: 'bi-arrow-left-right', href: '/migrate',
    group: 'Operations', prefixes: ['/migrate'],
  },
  {
    key: 'capacities', label: 'Capacities', icon: 'bi-lightning', href: '/capacities',
    group: 'Operations', prefixes: ['/capacities'],
  },
  {
    key: 'security-groups', label: 'Security Groups', icon: 'bi-people', href: '/quality/security-groups',
    group: 'Quality', prefixes: ['/quality/security-groups'],
  },
  {
    key: 'quality', label: 'Quality Configuration', icon: 'bi-patch-check', href: '/quality',
    group: 'Quality', prefixes: ['/quality'],
  },
  {
    key: 'reconciliation', label: 'Reconciliation', icon: 'bi-clipboard2-check', href: '/reconciliation',
    group: 'Quality', prefixes: ['/reconciliation'],
  },
  {
    key: 'mdm', label: 'Master Data', icon: 'bi-fingerprint', href: '/mdm',
    group: 'Quality', prefixes: ['/mdm'],
  },
  {
    // Configuration holds the credentials and this very permission panel, so it is
    // reserved for administrators and cannot be granted to an ordinary user.
    key: 'settings', label: 'Configuration', icon: 'bi-gear', href: '/settings',
    group: 'Settings', prefixes: ['/settings'], adminOnly: true,
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
  APP_SECTIONS,
  SECTION_KEYS,
  GRANTABLE_SECTIONS,
  sectionForPath,
  getSection,
  sectionLabel,
  isAlwaysAllowed,
};
