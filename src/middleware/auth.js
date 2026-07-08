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

      req.user = {
        id: decoded.userId || getClaim('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'),
        name:
          getClaim('name') ||
          getClaim('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') ||
          decoded.userDetails ||
          'User',
        email:
          getClaim('preferred_username') ||
          getClaim('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress') ||
          decoded.userDetails ||
          '',
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

module.exports = { parseEasyAuthUser };
