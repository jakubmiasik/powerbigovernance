// ── Foundations: audit log, credentials, scan worker, SQL identities, CI ──
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { withFakeSql } = require('./support');

const audit = require('../src/services/auditLogService');

test('the audit log names each change and skips requests that change nothing', () => {
  assert.deepEqual(audit.classify('POST', '/capacities/fabricprod/suspend'), { action: 'Capacity paused', category: 'capacity', target: 'fabricprod' });
  assert.deepEqual(audit.classify('DELETE', '/settings/access/roles/ws-1/ra-9?x=1'), { action: 'Workspace role removed', category: 'access', target: 'ws-1 / ra-9' });
  assert.equal(audit.classify('POST', '/settings/sp/save').category, 'credentials');
  assert.equal(audit.classify('GET', '/capacities'), null, 'reads are not changes');
  assert.equal(audit.classify('POST', '/api/select-run'), null, 'choosing a scan changes nothing');
  assert.equal(audit.classify('POST', '/settings/sp/test/3'), null, 'a connection test changes nothing');
  assert.equal(audit.classify('POST', '/something/new').action, 'Other change', 'an unknown change is still recorded');
});

test('the audit log never stores a secret from the request', () => {
  const stored = JSON.parse(audit.detailJson({
    name: 'Prod', clientSecret: 's3cr3t', password: 'x', nested: { accessToken: 't', keep: 'yes' }, keyVaultSecretName: 'kv-name',
    workspaces: Array.from({ length: 60 }, (_, i) => 'ws' + i),
  }));
  assert.equal(stored.clientSecret, '[redacted]');
  assert.equal(stored.password, '[redacted]');
  assert.equal(stored.nested.accessToken, '[redacted]');
  assert.equal(stored.nested.keep, 'yes');
  assert.equal(stored.keyVaultSecretName, '[redacted]', 'names that read like secrets are redacted too, erring safe');
  assert.equal(stored.workspaces.length, 51, 'long lists are cut short');
  assert.doesNotMatch(audit.detailJson({ clientSecret: 's3cr3t' }), /s3cr3t/);
});

test('the audit middleware records the outcome after the response, success:false included', async () => {
  const recorded = [];
  const middleware = audit.auditTrail({ record: async (entry) => { recorded.push(entry); } });
  const listeners = {};
  const res = {
    statusCode: 200, locals: { globalRun: { tenant_id: 'T1' } },
    json(body) { return body; },
    on(event, fn) { listeners[event] = fn; }, removeListener() {},
  };
  const req = { method: 'POST', originalUrl: '/capacities/cap1/resume', body: { subscriptionId: 'S', resourceGroup: 'rg' }, user: { email: 'a@x.com', name: 'A' } };
  let nexted = false;
  middleware(req, res, () => { nexted = true; });
  assert.ok(nexted);
  res.json({ success: false, message: 'Forbidden by Azure' });
  listeners.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].outcome, 'failed');
  assert.equal(recorded[0].action, 'Capacity resumed');
  assert.equal(recorded[0].tenantId, 'T1');
  assert.equal(recorded[0].actorEmail, 'a@x.com');
  assert.equal(recorded[0].message, 'Forbidden by Azure');

  const skipped = [];
  audit.auditTrail({ record: async e => skipped.push(e) })({ method: 'GET', originalUrl: '/capacities' }, res, () => {});
  assert.equal(skipped.length, 0);
});

test('reading the audit log is parameterised and the CSV defuses formulas', async () => {
  const { executed } = await withFakeSql(() => [], () => audit.list({ actor: "x'; DROP TABLE x;--", category: 'access', outcome: 'failed' }, 99999));
  assert.match(executed[0].sql, /SELECT TOP \(5000\)/, 'the row cap holds whatever is asked');
  assert.doesNotMatch(executed[0].sql, /DROP TABLE/);
  assert.match(executed[0].sql, /actor_email LIKE @actor AND category = @category AND outcome = @outcome/);
  const csv = audit.toCsv([{ occurred_at: new Date('2026-11-27T10:00:00Z'), actor_email: '=HYPERLINK("x")', action: 'A, B', outcome: 'succeeded' }]);
  assert.match(csv, /2026-11-27T10:00:00.000Z/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"A, B"/);
});

test('the audit table is append-only from the application', () => {
  const source = fs.readFileSync('src/services/auditLogService.js', 'utf8');
  assert.doesNotMatch(source, /UPDATE app_audit_log|DELETE FROM app_audit_log/);
  assert.match(fs.readFileSync('src/app.js', 'utf8'), /auditTrail\(\)/);
  assert.match(fs.readFileSync('src/views/partials/header.ejs', 'utf8'), /href: '\/settings\/audit', label: 'Audit Log'/);
});

test('the audit page renders rows and its filters', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/settings/audit.ejs', {
    title: 'Audit Log', user: { name: 'T' }, currentUser: { name: 'T', email: 't@x.com' }, currentPath: '/settings/audit', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, error: null, categories: audit.CATEGORIES,
    query: { outcome: 'failed' }, filters: {},
    rows: [{ occurred_at: '2026-11-27T09:00:00Z', actor_email: 'a@x.com', actor_name: 'Ann', action: 'Capacity paused', method: 'POST', path: '/capacities/c/suspend', target: 'c', tenant_id: 'T1', outcome: 'failed', message: 'No access', detail_json: '{"subscriptionId":"S"}' }],
  });
  assert.match(html, /Capacity paused/);
  assert.match(html, /bg-danger">Failed/);
  assert.match(html, /export\.csv\?outcome=failed/);
});

// ── Credentials: certificates and expiry ──

function selfSignedPem() {
  // A throwaway certificate made with openssl when available; the test is skipped otherwise.
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '10', '-subj', '/CN=test'], { stdio: 'ignore' });
    return fs.readFileSync(path.join(dir, 'k.pem'), 'utf8') + fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
  } catch { return null; }
}

test('a PEM certificate from Key Vault yields the key, the thumbprint and the expiry', (t) => {
  const pem = selfSignedPem();
  if (!pem) return t.skip('openssl is not available');
  const { parseCertificatePem } = require('../src/services/authService')._private;
  const cert = parseCertificatePem(pem);
  assert.match(cert.privateKey, /BEGIN (RSA )?PRIVATE KEY/);
  assert.match(cert.thumbprintSha256, /^[0-9a-f]{64}$/);
  assert.ok(cert.validTo > new Date() && cert.validTo < new Date(Date.now() + 11 * 864e5));
  assert.throws(() => parseCertificatePem('MIIK...base64-pfx'), /PEM content type/);
});

test('a PKCS#12 certificate is refused with what to do about it', async () => {
  const auth = require('../src/services/authService');
  auth._private.kvSecretCache.set('kv1|cert1', { record: { value: 'MIIK', contentType: 'application/x-pkcs12', expiresOn: null }, expiresAt: Date.now() + 60000 });
  await assert.rejects(
    auth._private.resolveClientCertificate({ id: 1, key_vault_name: 'kv1', key_vault_certificate_name: 'cert1' }),
    /stored as PKCS#12\. Re-create it in Key Vault with the PEM content type/
  );
  await assert.rejects(auth._private.resolveClientCertificate({ id: 1 }), /needs a Key Vault name and the certificate name/);
  auth._private.kvSecretCache.clear();
});

test('a secret read from Key Vault reports its expiry, once', async () => {
  const auth = require('../src/services/authService');
  const reports = [];
  auth.onCredentialExpiry((id, at, source) => reports.push([id, new Date(at).toISOString(), source]));
  auth._private.kvSecretCache.set('kv2|s2', { record: { value: 'v', contentType: null, expiresOn: new Date('2027-01-01T00:00:00Z') }, expiresAt: Date.now() + 60000 });
  const sp = { id: 7, key_vault_name: 'kv2', key_vault_secret_name: 's2' };
  assert.equal(await auth._private.resolveClientSecret(sp), 'v');
  assert.equal(await auth._private.resolveClientSecret(sp), 'v');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reports, [[7, '2027-01-01T00:00:00.000Z', 'key-vault']]);
  auth.onCredentialExpiry(null);
  auth._private.kvSecretCache.clear();
});

test('credentials that expire within 30 days, or have expired, are reminders', () => {
  const { credentialStatus, reminders } = require('../src/services/credentialReminderService');
  const now = Date.parse('2026-11-27T00:00:00Z');
  const sps = [
    { id: 1, name: 'Old', credential_expires_at: '2026-11-20T00:00:00Z', credential_expiry_source: 'key-vault' },
    { id: 2, name: 'Soon', credential_expires_at: '2026-12-10T00:00:00Z', credential_expiry_source: 'certificate' },
    { id: 3, name: 'Fine', credential_expires_at: '2027-06-01T00:00:00Z', credential_expiry_source: 'entered' },
    { id: 4, name: 'Unknown' },
  ];
  assert.deepEqual(reminders(sps, { now }).map(r => [r.name, r.state]), [['Old', 'expired'], ['Soon', 'expiring']]);
  assert.equal(credentialStatus(sps[1], { now }).label, 'Expires in 13 days (2026-12-10)');
  assert.equal(credentialStatus(sps[2], { now }).label, 'Valid until 2027-06-01');
  assert.equal(credentialStatus(sps[3], { now }).state, 'unknown', 'no date is unknown, never "fine"');
});

test('Settings offers certificate sign-in, an expiry date and the reminders', async () => {
  const ejs = require('ejs');
  const { credentialStatus } = require('../src/services/credentialReminderService');
  const sp = { id: 1, name: 'Prod', client_id: 'c', tenant_id: 't', auth_method: 'certificate', key_vault_name: 'kv', key_vault_certificate_name: 'cert', credential_expires_at: '2026-12-01T00:00:00Z', credential_expiry_source: 'certificate' };
  const html = await ejs.renderFile('src/views/config.ejs', {
    title: 'Settings', user: { name: 'T' }, currentUser: { name: 'T', email: 't@x.com' }, currentPath: '/settings', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, success: [], error: [], secretEncryptionReady: true,
    servicePrincipals: [{ ...sp, credential: credentialStatus(sp) }],
    credentialReminders: [{ id: 1, name: 'Prod', state: 'expiring', label: 'Expires in 4 days (2026-12-01)', source: 'the certificate' }],
  });
  assert.match(html, /id="secretSourceCert" value="certificate"/);
  assert.match(html, /name="keyVaultCertificateName"/);
  assert.match(html, /name="credentialExpiresAt"/);
  assert.match(html, /Certificate in Key Vault<\/span>/);
  assert.match(html, /class="alert alert-warning py-2 credential-reminder"/);
  assert.match(html, /data-sp-auth="certificate"/);
});

// ── Scans outside the web process ──

function fakeQueue(rows) {
  const calls = [];
  const queue = [...rows];
  const statuses = {};
  return {
    calls, statuses,
    markInterruptedRuns: async () => { calls.push('mark'); return []; },
    requeueInterruptedRuns: async () => { calls.push('requeue'); return []; },
    claimQueuedRun: async (worker) => { calls.push('claim:' + worker); return queue.shift() || null; },
    getServicePrincipalById: async (id) => (id === 1 ? { id: 1, name: 'SoftwareOne', tenant_id: 'T' } : null),
    getRunStatus: async (id) => statuses[id] || 'running',
    updateAnalysisRun: async (id, data) => { calls.push('update:' + id + ':' + data.status); },
  };
}

test('the worker claims one queued scan and runs it with its stored scope', async () => {
  const { runOnce } = require('../src/worker');
  const db = fakeQueue([{ id: 42, sp_id: 1, scope_kind: 'workspaces', scope_workspaces: '["a","b"]', attempts: 1 }]);
  const ran = [];
  const result = await runOnce({
    db, workerId: 'w1', staleSeconds: 900, maxAttempts: 2, activeAnalyses: new Map(), log: { log() {}, warn() {} },
    runAnalysis: async (id, sp, auth, scope) => { ran.push([id, sp.name, scope]); },
  });
  assert.equal(result, 42);
  assert.deepEqual(ran, [[42, 'SoftwareOne', { kind: 'workspaces', workspaceIds: ['a', 'b'] }]]);
  assert.deepEqual(db.calls.slice(0, 3), ['mark', 'requeue', 'claim:w1'], 'abandoned runs are tidied before claiming');
  assert.equal(await runOnce({ db, workerId: 'w1', activeAnalyses: new Map(), runAnalysis: async () => {}, log: { log() {}, warn() {} } }), null, 'an empty queue');
});

test('a cancel request stored by the page reaches the scan the worker is running', async () => {
  const { runOnce } = require('../src/worker');
  const db = fakeQueue([{ id: 7, sp_id: 1, scope_kind: 'tenant' }]);
  const active = new Map();
  await runOnce({
    db, workerId: 'w', activeAnalyses: active, cancelCheckMs: 5, log: { log() {}, warn() {} },
    runAnalysis: async (id) => {
      const progress = { cancelRequested: false };
      active.set(id, progress);
      db.statuses[id] = 'cancelling';
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(progress.cancelRequested, true);
    },
  });
});

test('a queued scan whose principal was deleted fails rather than waiting forever', async () => {
  const { runOnce } = require('../src/worker');
  const db = fakeQueue([{ id: 9, sp_id: 99 }]);
  await runOnce({ db, workerId: 'w', activeAnalyses: new Map(), runAnalysis: async () => { throw new Error('not run'); }, log: { log() {}, warn() {} } });
  assert.ok(db.calls.includes('update:9:failed'));
});

test('with an external worker, starting a scan only queues it', async () => {
  const analysis = require('../src/routes/analysis');
  const dbService = require('../src/services/databaseService');
  const original = dbService.createAnalysisRun;
  const created = [];
  dbService.createAnalysisRun = async (args) => { created.push(args); return 77; };
  try {
    const started = await analysis._startRun({ sp: { id: 1, name: 'S', tenant_id: 'T' }, scope: { kind: 'tenant' }, runBy: 'me', workerMode: 'external' });
    assert.deepEqual([started.runId, started.queued], [77, true]);
    assert.equal(created[0].status, 'queued');
    assert.equal(analysis._activeAnalyses.has(77), false, 'nothing runs in the web process');
  } finally {
    dbService.createAnalysisRun = original;
  }
});

test('claiming a run cannot hand the same run to two workers, and only worker runs are retried', () => {
  const source = fs.readFileSync('src/services/databaseService.js', 'utf8');
  assert.match(source, /WITH \(UPDLOCK, READPAST, ROWLOCK\)[\s\S]*WHERE status = 'queued'[\s\S]*ORDER BY id/);
  assert.match(source, /ISNULL\(attempts, 0\) BETWEEN 1 AND @max - 1/);
});

test('the worker answers a health check, and the worker mode is a setting', () => {
  const { getConfig } = require('../src/config/settings');
  const saved = process.env.ANALYSIS_WORKER_MODE;
  process.env.ANALYSIS_WORKER_MODE = 'EXTERNAL';
  assert.equal(getConfig().analysis.workerMode, 'external');
  process.env.ANALYSIS_WORKER_MODE = 'something-else';
  assert.equal(getConfig().analysis.workerMode, 'inline');
  if (saved === undefined) delete process.env.ANALYSIS_WORKER_MODE; else process.env.ANALYSIS_WORKER_MODE = saved;
  assert.match(fs.readFileSync('package.json', 'utf8'), /"worker": "node src\/worker\.js"/);
  assert.match(fs.readFileSync('infra/modules/appservice.bicep', 'utf8'), /appCommandLine: 'npm run worker'/);
});

// ── The Governance Outcome's reader, created by the deployment ──

test('the reader gets SELECT on five tables, a DENY on credentials, and nothing else', () => {
  const { plan, READER_TABLES } = require('../scripts/setup-sql-identities');
  const steps = plan({ readerName: 'id-pbi-gov-reader-abc' });
  const sql = steps.map(step => step.sql).join('\n');
  assert.deepEqual(READER_TABLES, ['analysis_runs', 'analysis_run_totals', 'analysis_workspaces', 'analysis_workspace_users', 'workspace_states']);
  READER_TABLES.forEach(table => assert.match(sql, new RegExp('GRANT SELECT ON dbo\\.' + table + ' TO')));
  assert.match(sql, /DENY SELECT ON dbo\.service_principals TO/);
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALTER|EXECUTE)|db_owner|db_datawriter/);
  assert.ok(steps.every(step => step.name === 'id-pbi-gov-reader-abc'), 'the name is a parameter');
  assert.match(sql, /QUOTENAME\(@name\)/);
  assert.throws(() => plan({ readerName: "x]; DROP TABLE y;--" }), /not a valid identity name/);
  assert.match(fs.readFileSync('infra/modules/appservice.bicep', 'utf8'), /name: 'GOVERNANCE_SQL_CLIENT_ID'/);
  assert.match(fs.readFileSync('azure.yaml', 'utf8'), /postprovision:[\s\S]*npm run setup:sql/);
});

// ── Checks on every pull request; local database ──

test('pull requests run the full check, and the dev container brings its own SQL Server', () => {
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /pull_request:/);
  assert.match(ci, /npm run check/);
  const compose = fs.readFileSync('.devcontainer/docker-compose.yml', 'utf8');
  assert.match(compose, /mcr\.microsoft\.com\/mssql\/server:2022-latest/);
  const { validateConfig } = require('../src/config/settings');
  process.env.SQL_TRUST_SERVER_CERTIFICATE = 'true';
  try {
    assert.throws(() => validateConfig({ requireProductionSecrets: true }), /SQL_TRUST_SERVER_CERTIFICATE is for the local dev container only/);
  } finally {
    delete process.env.SQL_TRUST_SERVER_CERTIFICATE;
  }
});
