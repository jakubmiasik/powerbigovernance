/**
 * Records every change made through the application.
 *
 * One middleware sees every state-changing request, so a new route cannot forget
 * to log itself. The catalog below only names what it saw: a request that
 * matches nothing is still recorded, as "Other change", rather than skipped.
 *
 * What is never recorded: secrets. Request bodies are reduced to their
 * non-sensitive fields before they are stored, and anything that looks like a
 * secret, password, token or key is replaced.
 */

const { _sql } = require('./databaseService');

const { TYPES } = _sql;
const getConnection = (...args) => _sql.getConnection(...args);
const execSql = (...args) => _sql.execSql(...args);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Requests that use POST but change nothing: checks, tests and previews.
const READ_ONLY = [
  /^\/api\/select-run$/,
  /^\/settings\/access\/check$/,
  /^\/settings\/access\/pending$/,
  /^\/settings\/sp\/test\/[^/]+$/,
  /^\/workspaces\/status-check$/,
  /^\/quality\/sources\/external\/test$/,
  /^\/quality\/security-groups\/verify$/,
  /^\/\.auth\//,
];

// [method, pattern, action, category]. The first match wins.
const CATALOG = [
  ['POST', /^\/settings\/access\/roles\/([^/]+)$/, 'Workspace role granted', 'access'],
  ['DELETE', /^\/settings\/access\/roles\/([^/]+)\/([^/]+)$/, 'Workspace role removed', 'access'],
  ['POST', /^\/workspaces\/([^/]+)\/roles$/, 'Workspace role granted', 'access'],
  ['PATCH', /^\/workspaces\/([^/]+)\/roles\/([^/]+)$/, 'Workspace role changed', 'access'],
  ['DELETE', /^\/workspaces\/([^/]+)\/roles\/([^/]+)$/, 'Workspace role removed', 'access'],
  ['POST', /^\/governance\/grant-sp-access$/, 'Service principal added to workspaces', 'access'],
  ['POST', /^\/pipelines\/grant$/, 'Pipeline access granted', 'access'],
  ['POST', /^\/workspaces\/delete$/, 'Workspaces deleted', 'workspace'],
  ['POST', /^\/pipelines\/delete$/, 'Deployment pipeline deleted', 'workspace'],
  ['POST', /^\/migrate\/execute$/, 'Workspaces moved to capacity', 'workspace'],
  ['POST', /^\/capacities\/([^/]+)\/suspend$/, 'Capacity paused', 'capacity'],
  ['POST', /^\/capacities\/([^/]+)\/resume$/, 'Capacity resumed', 'capacity'],
  ['POST', /^\/capacities\/([^/]+)\/schedule$/, 'Capacity schedule created', 'capacity'],
  ['PUT', /^\/capacities\/schedule\/([^/]+)$/, 'Capacity schedule changed', 'capacity'],
  ['DELETE', /^\/capacities\/schedule\/([^/]+)$/, 'Capacity schedule deleted', 'capacity'],
  ['POST', /^\/capacities\/schedule\/([^/]+)\/toggle$/, 'Capacity schedule switched on or off', 'capacity'],
  ['POST', /^\/capacities\/scheduler\/run$/, 'Capacity scheduler run by hand', 'capacity'],
  ['POST', /^\/analysis\/run$/, 'Scan started', 'scan'],
  ['POST', /^\/analysis\/cancel\/([^/]+)$/, 'Scan cancelled', 'scan'],
  ['POST', /^\/analysis\/delete\/([^/]+)$/, 'Scan deleted', 'scan'],
  ['POST', /^\/analysis\/index\/([^/]+)$/, 'Scan indexed', 'scan'],
  ['POST', /^\/analysis\/schedules$/, 'Scan schedule created', 'scan'],
  ['PUT', /^\/analysis\/schedules\/([^/]+)$/, 'Scan schedule changed', 'scan'],
  ['POST', /^\/analysis\/schedules\/([^/]+)\/toggle$/, 'Scan schedule switched on or off', 'scan'],
  ['DELETE', /^\/analysis\/schedules\/([^/]+)$/, 'Scan schedule deleted', 'scan'],
  ['POST', /^\/analysis\/schedules\/([^/]+)\/run$/, 'Scheduled scan run now', 'scan'],
  ['POST', /^\/api\/governance\/summary\/regenerate$/, 'Governance outcome regenerated', 'outcome'],
  ['POST', /^\/settings\/sp\/save$/, 'Service principal saved', 'credentials'],
  ['POST', /^\/settings\/sp\/delete\/([^/]+)$/, 'Service principal deleted', 'credentials'],
  ['POST', /^\/settings\/permissions\/save$/, 'App user permissions saved', 'permissions'],
  ['POST', /^\/settings\/permissions\/delete\/([^/]+)$/, 'App user removed', 'permissions'],
  ['POST', /^\/settings\/governance\/naming$/, 'Naming convention changed', 'rules'],
  ['POST', /^\/reconciliation\/rules(\/.*)?$/, 'Reconciliation rule changed', 'rules'],
  ['PUT', /^\/reconciliation\/rules\/([^/]+)$/, 'Reconciliation rule changed', 'rules'],
  ['DELETE', /^\/reconciliation\/rules\/([^/]+)$/, 'Reconciliation rule deleted', 'rules'],
  ['POST', /^\/reconciliation\/run$/, 'Reconciliation run started', 'data-quality'],
  ['DELETE', /^\/reconciliation\/runs\/([^/]+)$/, 'Reconciliation run deleted', 'data-quality'],
  ['POST', /^\/reconciliation\/runs\/delete-all$/, 'All reconciliation runs deleted', 'data-quality'],
  ['POST', /^\/reconciliation\/exceptions(\/.*)?$/, 'Reconciliation exception updated', 'data-quality'],
  ['POST', /^\/mdm\/(.*)$/, 'Master data changed', 'data-quality'],
  ['PUT', /^\/mdm\/(.*)$/, 'Master data changed', 'data-quality'],
  ['DELETE', /^\/mdm\/(.*)$/, 'Master data deleted', 'data-quality'],
  ['POST', /^\/quality\/security-groups\/(.*)$/, 'Security group mapping changed', 'access'],
  ['POST', /^\/quality\/sources(\/.*)?$/, 'Data source changed', 'data-quality'],
  ['DELETE', /^\/quality\/sources\/([^/]+)$/, 'Data source deleted', 'data-quality'],
];

const SENSITIVE_KEY = /secret|password|passwd|token|credential|apikey|api_key|privatekey|private_key|certificate|^key$/i;
const MAX_STRING = 300;
const MAX_ITEMS = 50;
const MAX_JSON = 3800;

function stripQuery(url) {
  return String(url || '').split('?')[0].replace(/\/+$/, '') || '/';
}

/** What a request is, or null when it changes nothing. */
function classify(method, path) {
  const verb = String(method || '').toUpperCase();
  if (!MUTATING.has(verb)) return null;
  const clean = stripQuery(path);
  if (READ_ONLY.some(pattern => pattern.test(clean))) return null;
  for (const [m, pattern, action, category] of CATALOG) {
    if (m !== verb) continue;
    const match = clean.match(pattern);
    if (match) return { action, category, target: match.slice(1).filter(Boolean).join(' / ') || null };
  }
  return { action: 'Other change', category: 'other', target: null };
}

/** A copy of the body with secrets replaced and everything kept short. */
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 3) return '[nested]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map(item => sanitize(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push('… ' + (value.length - MAX_ITEMS) + ' more');
    return items;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? (inner ? '[redacted]' : inner) : sanitize(inner, depth + 1);
    }
    return out;
  }
  return String(value);
}

function detailJson(body) {
  if (!body || typeof body !== 'object' || !Object.keys(body).length) return null;
  const text = JSON.stringify(sanitize(body));
  return text.length > MAX_JSON ? text.slice(0, MAX_JSON) + '…' : text;
}

async function insert(entry) {
  const conn = await getConnection();
  try {
    await execSql(conn, `INSERT INTO app_audit_log
      (actor_email, actor_name, action, category, method, path, target, tenant_id, outcome, status_code, message, detail_json)
      VALUES (@email, @name, @action, @category, @method, @path, @target, @tenant, @outcome, @status, @message, @detail)`, [
      { name: 'email', type: TYPES.NVarChar, value: entry.actorEmail || null },
      { name: 'name', type: TYPES.NVarChar, value: entry.actorName || null },
      { name: 'action', type: TYPES.NVarChar, value: entry.action },
      { name: 'category', type: TYPES.NVarChar, value: entry.category },
      { name: 'method', type: TYPES.NVarChar, value: entry.method },
      { name: 'path', type: TYPES.NVarChar, value: String(entry.path || '').slice(0, 400) },
      { name: 'target', type: TYPES.NVarChar, value: entry.target ? String(entry.target).slice(0, 400) : null },
      { name: 'tenant', type: TYPES.NVarChar, value: entry.tenantId || null },
      { name: 'outcome', type: TYPES.NVarChar, value: entry.outcome },
      { name: 'status', type: TYPES.Int, value: Number.isInteger(entry.statusCode) ? entry.statusCode : null },
      { name: 'message', type: TYPES.NVarChar, value: entry.message ? String(entry.message).slice(0, 1000) : null },
      { name: 'detail', type: TYPES.NVarChar, value: entry.detailJson || null },
    ]);
  } finally {
    conn.close();
  }
}

/**
 * Express middleware. Writes one row per state-changing request once the
 * response is finished, so the outcome is known. Never fails the request: an
 * audit write that fails is reported on the console.
 */
function auditTrail({ record = insert } = {}) {
  return function auditMiddleware(req, res, next) {
    const kind = classify(req.method, req.originalUrl || req.url);
    if (!kind) return next();

    // A JSON reply with success:false is a failure even though it is a 200.
    let replied = null;
    const originalJson = res.json && res.json.bind(res);
    if (originalJson) {
      res.json = (body) => { replied = body; return originalJson(body); };
    }

    const finish = () => {
      res.removeListener('finish', finish);
      const status = res.statusCode;
      const failed = status >= 400 || (replied && replied.success === false);
      const run = res.locals ? res.locals.globalRun : null;
      const body = req.body || {};
      const entry = {
        actorEmail: req.user ? req.user.email || null : null,
        actorName: req.user ? req.user.name || null : null,
        action: kind.action,
        category: kind.category,
        method: String(req.method).toUpperCase(),
        path: stripQuery(req.originalUrl || req.url),
        target: kind.target,
        tenantId: body.tenantId || (run ? run.tenant_id : null) || null,
        outcome: failed ? 'failed' : 'succeeded',
        statusCode: status,
        message: replied && typeof replied.message === 'string' ? replied.message : null,
        detailJson: detailJson(body),
      };
      Promise.resolve()
        .then(() => record(entry))
        .catch(err => console.warn('[Audit] Could not record', entry.action, '-', err.message));
    };
    if (typeof res.on === 'function') res.on('finish', finish);
    next();
  };
}

// ── Reading ──

function filtersToSql(filters = {}) {
  const where = [];
  const params = [];
  if (filters.actor) { where.push('actor_email LIKE @actor'); params.push({ name: 'actor', type: TYPES.NVarChar, value: '%' + filters.actor + '%' }); }
  if (filters.category) { where.push('category = @category'); params.push({ name: 'category', type: TYPES.NVarChar, value: filters.category }); }
  if (filters.outcome) { where.push('outcome = @outcome'); params.push({ name: 'outcome', type: TYPES.NVarChar, value: filters.outcome }); }
  if (filters.tenantId) { where.push('tenant_id = @tenant'); params.push({ name: 'tenant', type: TYPES.NVarChar, value: filters.tenantId }); }
  if (filters.from) { where.push('occurred_at >= @from'); params.push({ name: 'from', type: TYPES.DateTime2, value: new Date(filters.from) }); }
  if (filters.to) { where.push('occurred_at < @to'); params.push({ name: 'to', type: TYPES.DateTime2, value: new Date(filters.to) }); }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

async function list(filters = {}, limit = 500) {
  const { where, params } = filtersToSql(filters);
  const top = Math.max(1, Math.min(5000, Number.parseInt(limit, 10) || 500));
  const conn = await getConnection();
  try {
    return await execSql(conn, `SELECT TOP (${top}) id, occurred_at, actor_email, actor_name, action, category, method, path,
        target, tenant_id, outcome, status_code, message, detail_json
      FROM app_audit_log ${where} ORDER BY occurred_at DESC, id DESC`, params);
  } catch (err) {
    if ((err.message || '').includes('Invalid object name')) return [];
    throw err;
  } finally {
    conn.close();
  }
}

const CSV_COLUMNS = ['occurred_at', 'actor_email', 'actor_name', 'action', 'category', 'method', 'path', 'target', 'tenant_id', 'outcome', 'status_code', 'message', 'detail_json'];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  // A cell starting with = + - @ is a formula in a spreadsheet.
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function toCsv(rows) {
  return [CSV_COLUMNS.join(',')]
    .concat((rows || []).map(row => CSV_COLUMNS.map(column => csvCell(row[column])).join(',')))
    .join('\r\n') + '\r\n';
}

const CATEGORIES = ['access', 'workspace', 'capacity', 'scan', 'outcome', 'credentials', 'permissions', 'rules', 'data-quality', 'other'];

module.exports = { classify, sanitize, detailJson, auditTrail, insert, list, toCsv, CATEGORIES, CATALOG };
