/**
 * Parse Azure App Service EasyAuth user from x-ms-client-principal header.
 * Same pattern as the Fabric Project Sizing app.
 */
function parseEasyAuthUser(req, _res, next) {
  const header = req.headers['x-ms-client-principal'];
  if (header) {
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
      const claims = decoded.claims || [];

      const getClaim = (type) => {
        const claim = claims.find((c) => c.typ === type);
        return claim ? claim.val : null;
      };

      // A guest's identity reaches us in more than one shape: the token may carry
      // the external address, the #EXT# principal name, or both, depending on the
      // tenant. The object id is the same in every case, so it is captured as the
      // identity that actually matches, with the addresses kept as fallbacks.
      const upn = getClaim('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn') || getClaim('upn');
      const preferred = getClaim('preferred_username');
      const emailClaim = getClaim('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress');

      req.user = {
        id: decoded.userId || getClaim('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'),
        objectId:
          getClaim('http://schemas.microsoft.com/identity/claims/objectidentifier') ||
          getClaim('oid') ||
          null,
        name:
          getClaim('name') ||
          getClaim('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') ||
          decoded.userDetails ||
          'User',
        email: preferred || emailClaim || upn || decoded.userDetails || '',
        userPrincipalName: upn || decoded.userDetails || '',
        // Kept so a grant recorded against any address this person is known by
        // still matches — a guest is routinely recorded under a different one.
        alternateEmails: [preferred, emailClaim, upn, decoded.userDetails].filter(Boolean),
        provider: decoded.identityProvider || 'aad',
      };
    } catch {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

// Paths that must stay reachable without a signed-in user: the platform's own
// auth endpoints (otherwise sign-in could never complete) and the health probe.
const PUBLIC_PREFIXES = ['/.auth', '/health', '/favicon.ico'];

function isPublicPath(path) {
  return PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}

// EasyAuth is configured per App Service and can be left on "allow unauthenticated
// access", in which case unauthenticated requests still reach the application.
// This is the in-application enforcement so browsing without signing in is not
// possible regardless of how the platform is configured.
//
// Enforcement is on whenever the app runs on App Service (WEBSITE_SITE_NAME is
// set by the platform) and can be overridden with REQUIRE_AUTH=true|false, so
// local development does not need an auth provider.
function authRequired() {
  const flag = String(process.env.REQUIRE_AUTH || '').toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  return Boolean(process.env.WEBSITE_SITE_NAME);
}

function requireAuth(req, res, next) {
  if (req.user || !authRequired() || isPublicPath(req.path)) return next();

  // A fetch/XHR call must get a machine-readable answer, not a login page it
  // cannot render.
  const wantsJson = req.xhr
    || (req.get('accept') || '').includes('application/json')
    || req.path.startsWith('/api/');
  if (wantsJson) {
    return res.status(401).json({ error: 'Not authenticated', loginUrl: '/.auth/login/aad' });
  }

  const target = encodeURIComponent(req.originalUrl || '/');
  res.redirect('/.auth/login/aad?post_login_redirect_uri=' + target);
}

module.exports = { parseEasyAuthUser, requireAuth };
