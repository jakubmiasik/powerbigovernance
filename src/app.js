require('dotenv').config();

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { OIDCStrategy } = require('passport-azure-ad');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const path = require('path');
const { getConfig, isEntraConfigured } = require('./config/settings');
const { ensureAuthenticated } = require('./middleware/auth');

const app = express();

// View engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

const config = getConfig();

app.use(
  session({
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  })
);

app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

// Passport serialization
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Configure Entra ID strategy if configured
function setupPassportStrategy() {
  if (isEntraConfigured()) {
    const cfg = getConfig();
    const strategy = new OIDCStrategy(
      {
        identityMetadata: `https://login.microsoftonline.com/${cfg.entra.tenantId}/v2.0/.well-known/openid-configuration`,
        clientID: cfg.entra.clientId,
        clientSecret: cfg.entra.clientSecret,
        responseType: 'code',
        responseMode: 'form_post',
        redirectUrl: `http://localhost:${cfg.port}/auth/callback`,
        allowHttpForRedirectUrl: true,
        scope: ['openid', 'profile', 'email'],
        passReqToCallback: false,
      },
      (iss, sub, profile, accessToken, refreshToken, done) => {
        return done(null, profile);
      }
    );
    passport.use(strategy);
  }
}

setupPassportStrategy();

// Make user available to all views
app.use((req, res, next) => {
  res.locals.currentUser = req.user;
  res.locals.isEntraConfigured = isEntraConfigured();
  next();
});

// Routes
const authRoutes = require('./routes/auth');
const indexRoutes = require('./routes/index');
const configRoutes = require('./routes/config');
const workspaceRoutes = require('./routes/workspaces');
const governanceRoutes = require('./routes/governance');

app.use('/auth', authRoutes);
app.use('/', ensureAuthenticated, indexRoutes);
app.use('/settings', ensureAuthenticated, configRoutes);
app.use('/workspaces', ensureAuthenticated, workspaceRoutes);
app.use('/governance', ensureAuthenticated, governanceRoutes);

// Error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).render('error', {
    title: 'Error',
    user: req.user,
    message: err.message || 'An unexpected error occurred.',
  });
});

module.exports = app;
