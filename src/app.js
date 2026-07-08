require('dotenv').config();

const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const path = require('path');
const { getConfig } = require('./config/settings');
const { parseEasyAuthUser } = require('./middleware/auth');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

// Trust Azure load balancer
if (isProduction) {
  app.set('trust proxy', 1);
}

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
    cookie: {
      secure: isProduction,
      sameSite: 'lax',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

app.use(flash());

// Parse EasyAuth user from headers (Azure App Service built-in auth)
app.use(parseEasyAuthUser);

// Make user available to all views
app.use((req, res, next) => {
  res.locals.currentUser = req.user;
  next();
});

// Health check endpoint (Azure App Service)
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API endpoint for client-side auth detection (same pattern as sizing app)
app.get('/api/user', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({
    name: req.user.name,
    email: req.user.email,
    authenticated: true,
  });
});

// Routes
const indexRoutes = require('./routes/index');
const configRoutes = require('./routes/config');
const workspaceRoutes = require('./routes/workspaces');
const governanceRoutes = require('./routes/governance');
const analysisRoutes = require('./routes/analysis');

app.use('/', indexRoutes);
app.use('/settings', configRoutes);
app.use('/workspaces', workspaceRoutes);
app.use('/governance', governanceRoutes);
app.use('/analysis', analysisRoutes);

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
