require('dotenv').config();

const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const path = require('path');
const { getConfig } = require('./config/settings');
const { parseEasyAuthUser, requireAuth } = require('./middleware/auth');
const { securityHeaders, createRateLimiter } = require('./middleware/security');
const { loadRuns } = require('./middleware/loadRuns');

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
app.use(securityHeaders);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const config = getConfig();
if (isProduction && config.session.secret === 'dev-secret-change-me') {
  console.warn('[App] SESSION_SECRET is using the development default.');
}
if (isProduction) {
  console.warn('[App] Configure a shared session store before scaling beyond one instance.');
}

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
app.use('/api', createRateLimiter({ windowMs: 60 * 1000, max: 120 }));

// Parse EasyAuth user from headers (Azure App Service built-in auth)
app.use(parseEasyAuthUser);

// Global context: current path for sidebar highlighting + auto-breadcrumb
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  // Auto-generate breadcrumb from path segments
  const segments = req.path.split('/').filter(Boolean);
  const labelMap = {
    workspaces: 'Workspaces', governance: 'Governance', analysis: 'Run Analysis',
    migrate: 'Migrate', capacities: 'Capacities', settings: 'Configuration',
    overview: 'Overview', users: 'Users', artifacts: 'Artifacts'
  };
  const breadcrumb = [];
  let href = '';
  segments.forEach((seg, i) => {
    href += '/' + seg;
    const label = labelMap[seg] || (seg.length > 20 ? seg.substring(0, 20) + '…' : seg);
    breadcrumb.push({ label, href });
  });
  res.locals.breadcrumb = breadcrumb;
  next();
});

// Opportunistic scheduler catch-up tick on incoming traffic (throttled internally).
// Registered BEFORE /health on purpose: the App Service health check is the only
// guaranteed periodic traffic, so it must be able to drive the catch-up tick.
const { kickScheduler } = require('./services/schedulerService');
app.use((req, res, next) => {
  kickScheduler();
  next();
});

// Health check BEFORE DB middleware so it always responds instantly
app.get('/health', (_req, res) => {
  const { isEncryptionConfigured } = require('./services/secretCryptoService');
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    // Reports whether the runtime can see SECRET_ENCRYPTION_KEY, without leaking it.
    secretEncryption: isEncryptionConfigured() ? 'configured' : 'missing',
  });
});

// Everything below this line requires a signed-in user. Registered after /health
// so the App Service probe (which sends no user) keeps working.
app.use(requireAuth);

// Global context: selected run + available runs, cached to avoid DB work on every request
app.use(loadRuns);

// API to switch selected run
app.post('/api/select-run', (req, res) => {
  const selectedRunId = Number.parseInt(req.body.runId, 10);
  if (!Number.isInteger(selectedRunId) || selectedRunId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid runId.' });
  }
  req.session.selectedRunId = selectedRunId;
  res.json({ success: true });
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
const migrateRoutes = require('./routes/migrate');
const capacityRoutes = require('./routes/capacities');
const pipelineRoutes = require('./routes/pipelines');

app.use('/', indexRoutes);
app.use('/settings', configRoutes);
app.use('/workspaces', workspaceRoutes);
app.use('/governance', governanceRoutes);
app.use('/analysis', analysisRoutes);
app.use('/migrate', migrateRoutes);
app.use('/capacities', capacityRoutes);
app.use('/pipelines', pipelineRoutes);

// Error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).render('error', {
    title: 'Error',
    user: req.user,
    message: err.message || 'An unexpected error occurred.',
    currentPath: req.path,
    breadcrumb: [{ label: 'Error', href: '#' }],
  });
});

module.exports = app;
