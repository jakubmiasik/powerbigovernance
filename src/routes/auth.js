const express = require('express');
const router = express.Router();
const passport = require('passport');
const { isEntraConfigured } = require('../config/settings');

router.get('/login', (req, res, next) => {
  if (!isEntraConfigured()) {
    req.flash('error', 'Entra ID is not configured. Configure it in Settings first.');
    return res.redirect('/settings');
  }
  passport.authenticate('azuread-openidconnect', {
    failureRedirect: '/',
    failureFlash: true,
  })(req, res, next);
});

router.post('/callback', (req, res, next) => {
  passport.authenticate('azuread-openidconnect', {
    failureRedirect: '/',
    failureFlash: true,
  })(req, res, () => {
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(returnTo);
  });
});

router.get('/callback', (req, res, next) => {
  passport.authenticate('azuread-openidconnect', {
    failureRedirect: '/',
    failureFlash: true,
  })(req, res, () => {
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(returnTo);
  });
});

router.get('/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.redirect('/');
    });
  });
});

module.exports = router;
