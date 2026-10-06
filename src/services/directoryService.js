/**
 * Looking people and security groups up in Entra ID.
 *
 * Access is granted to directory objects, not to text somebody typed. A mistyped
 * address in the access table is invisible — it does not fail, it simply never
 * matches, and the person it was meant for is told they have no access while the
 * row sits there looking correct.
 *
 * Graph is reached with an already-configured service principal's application
 * token, which is the only credential this application has. It needs
 * `User.Read.All` and `GroupMember.Read.All` (application) consented; without them
 * the picker says so rather than returning an empty list that looks like "nobody
 * by that name".
 */

const db = require('./databaseService');
const powerbi = require('./powerbiService');
const permissions = require('./permissionService');

// Looked up per call rather than destructured once, so a test can substitute it.
const createPowerBIService = (...args) => powerbi.createPowerBIService(...args);

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Group membership changes rarely and is read on every request of every signed-in
// user, so it is cached briefly. The cost of being a few minutes stale is that a
// just-added member waits; the cost of not caching is a Graph call per request.
const MEMBERSHIP_CACHE_TTL_MS = parseInt(process.env.DIRECTORY_CACHE_TTL_MS || '300000', 10);
const membershipCache = new Map();

function clearDirectoryCache() {
  membershipCache.clear();
}

/**
 * The service principal used to read the directory.
 *
 * Any configured one will do — they all authenticate against the same Entra
 * tenant — so this does not depend on which tenant the signed-in user may see.
 */
async function directoryClient() {
  const servicePrincipals = await db.getServicePrincipals();
  if (!servicePrincipals.length) {
    throw new Error('No service principal is configured, so the directory cannot be searched. Add one under Configuration.');
  }
  return createPowerBIService(servicePrincipals[0]);
}

/**
 * Entra rejects an unescaped single quote in an OData filter, and a name like
 * O'Brien is not an edge case in a directory.
 */
function escapeODataLiteral(value) {
  return String(value || '').replace(/'/g, "''");
}

function explainGraphFailure(err) {
  const message = err && err.message ? err.message : String(err);
  if (/\b403\b|Authorization_RequestDenied|Insufficient privileges/i.test(message)) {
    return new Error(
      'The service principal cannot read the directory. Grant it the Microsoft Graph application '
      + 'permissions User.Read.All and GroupMember.Read.All, and consent to them.',
    );
  }
  if (/\b401\b/.test(message)) {
    return new Error('The service principal could not authenticate to Microsoft Graph. Check its secret has not expired.');
  }
  return new Error(message);
}

/** People, as the picker shows them. */
async function searchUsers(query) {
  try {
    const client = await directoryClient();
    const found = await client.searchEntraUsers(escapeODataLiteral(query));
    return found.map((user) => {
      const upn = permissions.normalizeEmail(user.userPrincipalName);
      const guest = user.userType === 'Guest' || permissions.isGuestUpn(upn);
      // A guest is known by two addresses: the mangled `#EXT#` principal name in
      // this tenant and the real one they were invited by. The real one is shown,
      // because it is the one an administrator recognises, while the grant is
      // keyed on the object id so it matches whichever arrives in the token.
      const external = permissions.normalizeEmail(user.mail) || permissions.externalAddressFromGuestUpn(upn);
      const primary = guest ? (external || upn) : (upn || permissions.normalizeEmail(user.mail));

      return {
        objectId: user.id,
        displayName: user.displayName || primary || 'Unnamed',
        email: primary,
        userPrincipalName: upn,
        isGuest: guest,
        principalType: 'user',
        detail: guest && external && upn && external !== upn
          ? external + ' (guest)'
          : (primary || ''),
      };
    // Somebody with no usable address and no object id could never be matched to
    // a sign-in, so they are not offered.
    }).filter(entry => entry.email || entry.objectId);
  } catch (err) {
    throw explainGraphFailure(err);
  }
}

/**
 * Security groups only.
 *
 * A distribution or Microsoft 365 group is a mailing list: its membership is
 * maintained for delivering mail, not for deciding who may see a tenant. Offering
 * one here would be offering an access decision nobody is maintaining.
 */
async function searchGroups(query) {
  try {
    const client = await directoryClient();
    const found = await client.searchEntraGroups(escapeODataLiteral(query));
    return found
      .filter(group => group.securityEnabled)
      .map(group => ({
        objectId: group.id,
        displayName: group.displayName || 'Unnamed group',
        email: group.mail || '',
        principalType: 'group',
        detail: group.mail || 'Security group',
      }));
  } catch (err) {
    throw explainGraphFailure(err);
  }
}

async function search(query, type) {
  const trimmed = String(query || '').trim();
  // Two characters is where a prefix search stops returning most of the directory.
  if (trimmed.length < 2) return [];
  return type === 'group' ? searchGroups(trimmed) : searchUsers(trimmed);
}

/**
 * Every security group the signed-in user belongs to, including nested ones.
 *
 * Transitive, because a group granted access is almost always a parent of the one
 * people are actually put in. Returning only direct membership would make the
 * grant work for some members and silently not for others.
 */
async function groupIdsForUser(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return [];

  const cached = membershipCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ids;

  let ids = [];
  try {
    const client = await directoryClient();
    ids = await client.getTransitiveGroupIds(key);
  } catch (err) {
    // Membership being unreadable must not look like "belongs to no groups": that
    // would quietly drop every group-based grant. The caller is told instead.
    throw explainGraphFailure(err);
  }

  membershipCache.set(key, { expiresAt: Date.now() + MEMBERSHIP_CACHE_TTL_MS, ids });
  return ids;
}

module.exports = {
  search,
  searchUsers,
  searchGroups,
  groupIdsForUser,
  clearDirectoryCache,
  _private: { escapeODataLiteral, explainGraphFailure, GRAPH_BASE },
};
