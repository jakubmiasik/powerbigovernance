const { isEntraConfigured } = require('../config/settings');

function ensureAuthenticated(req, res, next) {
  // If Entra ID is not configured, allow access (development mode)
  if (!isEntraConfigured()) {
    req.user = req.user || { displayName: 'Developer', emails: [{ value: 'dev@local' }] };
    return next();
  }

  if (req.isAuthenticated()) {
    return next();
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/login');
}

module.exports = { ensureAuthenticated };
