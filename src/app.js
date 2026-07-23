require('dotenv').config();

const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const path = require('path');
const { getConfig } = require('./config/settings');
const { parseEasyAuthUser } = require('./middleware/auth');
const db = require('./services/databaseService');

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

// Global context: selected run + available runs, loaded once per request
app.use(async (req, res, next) => {
  res.locals.currentUser = req.user;

  try {
    const runs = await db.getAnalysisRuns();
    const completedRuns = runs.filter(r => r.status === 'completed');
    res.locals.availableRuns = completedRuns;

    // Allow ?runId= query param to switch the selection and persist in session
    if (req.query.runId) {
      req.session.selectedRunId = parseInt(req.query.runId);
    }

    const selectedRunId = req.session.selectedRunId;
    let selectedRun = null;
    if (selectedRunId) {
      selectedRun = completedRuns.find(r => r.id === selectedRunId);
    }
    if (!selectedRun && completedRuns.length > 0) {
      selectedRun = completedRuns[0];
    }
    res.locals.globalRun = selectedRun;
    res.locals.selectedRunId = selectedRun ? selectedRun.id : null;
  } catch {
    res.locals.availableRuns = [];
    res.locals.globalRun = null;
    res.locals.selectedRunId = null;
  }
  next();
});

// API to switch selected run
app.post('/api/select-run', (req, res) => {
  req.session.selectedRunId = parseInt(req.body.runId);
  res.json({ success: true });
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
const migrateRoutes = require('./routes/migrate');
const capacityRoutes = require('./routes/capacities');

app.use('/', indexRoutes);
app.use('/settings', configRoutes);
app.use('/workspaces', workspaceRoutes);
app.use('/governance', governanceRoutes);
app.use('/analysis', analysisRoutes);
app.use('/migrate', migrateRoutes);
app.use('/capacities', capacityRoutes);

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

// Start capacity scheduler
const { startScheduler } = require('./services/schedulerService');
startScheduler();

// Run DB migrations
const { runMigrations } = require('./services/databaseService');
runMigrations().catch(err => console.warn('[App] Migration error:', err.message));

module.exports = app;
