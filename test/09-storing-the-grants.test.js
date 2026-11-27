/* eslint-disable no-unused-vars */
const {
  assert, http, test, app, request, postJson, convertScheduleToUtc, scheduler, runMetrics, workspaceDeletion, dbService, stubDeletionDb, sampleRun, tenantRun, pbi, httpError, itemDetails, stubPbi, insights, SCAN_DATE, ws, findingKeys, dbPrivate, httpErrors, pipelineService, requireAuth, recon, INVOICE_RULE, runProgress, progressThrough, sqlSource, reconCompare, RUN_A, RUN_B, finding, reconRepo, fakeSqlPrimitives, withFakeSql, mdm, PERSON_FIELDS, personRecord, SURVIVOR_MODEL, survivorRecords, CUSTOMER_MODEL, RAW_CUSTOMERS, analysisModel, SCAN_RESULT, guide, jobProgress, workspaceAccess, analysisScope, scheduleDue, ACCESS_FIXTURE, analysisLauncher, analysisScheduleService, DUE_DAILY, namingService, NAMING, withServer, securityGroups, sgMapping, sgRepo, perms, sections, TENANTS, resolveFor, permMiddleware, fakeRes, withFakeDirectory, SOFTWAREONE, OTHER_TENANT, outcomeFixture, buildFixtureOutcome, compareFixture, compareResponse,
} = require('./support');


// ── Storing the grants ──
test('saving a user replaces their grants rather than adding to them', async () => {
  const repo = require('../src/services/permissionRepository');
  const { executed } = await withFakeSql(sql => (/OUTPUT INSERTED.id/.test(sql) ? [{ id: 7 }] : []), () =>
    repo.saveUser({ email: ' ANN@X.com ', displayName: 'Ann', role: 'user', tenantIds: ['2', 2, 'x'], sectionKeys: ['workspaces', 'mdm'] })
  );

  const sqls = executed.map(e => e.sql);
  // Unticking a box has to actually remove the grant, so the old rows go first.
  assert.ok(sqls.some(s => /DELETE FROM app_user_tenants/.test(s)));
  assert.ok(sqls.some(s => /DELETE FROM app_user_sections/.test(s)));
  // Duplicates and nonsense are dropped, so two identical tenant ids insert once.
  assert.equal(sqls.filter(s => /INSERT INTO app_user_tenants/.test(s)).length, 1);
  assert.equal(sqls.filter(s => /INSERT INTO app_user_sections/.test(s)).length, 2);

  const insert = executed.find(e => /INSERT INTO app_users/.test(e.sql));
  const email = insert.params.find(p => p.name === 'email');
  assert.equal(email.value, 'ann@x.com', 'the email is stored normalized so sign-in can match it');
});

test('saving an email that already exists is an edit, not a duplicate', async () => {
  const repo = require('../src/services/permissionRepository');
  const { executed } = await withFakeSql(sql => (/SELECT id FROM app_users/.test(sql) ? [{ id: 4 }] : []), () =>
    repo.saveUser({ email: 'ann@x.com', role: 'admin', tenantIds: [], sectionKeys: [] })
  );
  assert.ok(!executed.some(e => /INSERT INTO app_users/.test(e.sql)), 'a second grant must not hit the unique index');
  assert.ok(executed.some(e => /UPDATE app_users/.test(e.sql)));
});

test('only an active administrator counts as one for the bootstrap check', async () => {
  const repo = require('../src/services/permissionRepository');
  const { executed } = await withFakeSql(() => [], () => repo.hasAnyAdmin());
  // A deactivated administrator cannot sign in to fix anything, so counting them
  // would be exactly the lockout the bootstrap exists to prevent.
  assert.match(executed[0].sql, /is_active = 1/);
});

// ── The admin panel and the menu ──
test('the access panel offers every grantable section and no administrator-only one', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/settings/permissions.ejs', {
    currentUser: { name: 'T' }, user: { name: 'T' }, currentPath: '/settings/permissions',
    breadcrumb: [], availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Users & Access',
    users: [{ id: 1, email: 'ann@x.com', display_name: 'Ann "The Boss" X', role: 'user', is_active: true, tenantIds: [2], sectionKeys: ['workspaces'] }],
    tenants: [{ id: 2, name: 'Fabrikam', tenant_id: 'abc' }],
    sections: sections.GRANTABLE_SECTIONS,
    bootstrap: false, success: [], error: [],
    permissions: { isAdmin: true }, visibleSections: sections.APP_SECTIONS,
  });

  for (const section of sections.GRANTABLE_SECTIONS) {
    assert.match(html, new RegExp('value="' + section.key + '"'), 'missing ' + section.key);
  }
  assert.doesNotMatch(html, /value="settings"/, 'Configuration must never be grantable');
  assert.match(html, /Fabrikam/);
  // A name with quotes in it must not break the row out of its attribute — the
  // User 360 lesson, applied here before it can bite.
  assert.doesNotMatch(html, /onclick="editUser/);
  assert.match(html, /js-edit-user/);
});

test('the sidebar shows only the sections a user holds', async () => {
  const ejs = require('ejs');
  const granted = sections.APP_SECTIONS.filter(s => s.key === 'workspaces' || s.key === 'reconciliation');
  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/workspaces', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'x',
    visibleSections: granted, permissions: { isAdmin: false },
  });

  assert.match(html, /<span>Workspaces<\/span>/);
  assert.match(html, /<span>Reconciliation<\/span>/);
  assert.doesNotMatch(html, /<span>Master Data<\/span>/);
  assert.doesNotMatch(html, /<span>Deployment Pipelines<\/span>/);
  // Settings holds the credentials and this panel; it is for administrators only.
  assert.doesNotMatch(html, /Users &amp; Access/);
});

test('an administrator sees the Settings block and the access panel link', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/settings/permissions', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'x',
    visibleSections: sections.APP_SECTIONS, permissions: { isAdmin: true },
  });
  assert.match(html, /href="\/settings\/permissions"/);
  assert.match(html, /Users &amp; Access/);
});

test('the no-access page says which section was refused instead of showing an error', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/no-access.ejs', {
    currentUser: { name: 'T' }, user: { name: 'T' }, currentPath: '/mdm', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'No access',
    section: sections.getSection('mdm'), message: null,
    permissions: { isAdmin: false, isKnown: false }, visibleSections: [],
  });
  assert.match(html, /Master Data/);
});

test('only security groups are offered, because a mailing list is not an access decision', async () => {
  const dir = require('../src/services/directoryService');
  const results = await withFakeDirectory({
    searchEntraGroups: async () => ([
      { id: 'g1', displayName: 'BI Admins', securityEnabled: true },
      { id: 'g2', displayName: 'All Staff Newsletter', securityEnabled: false },
    ]),
  }, () => dir.search('bi', 'group'));

  assert.deepEqual(results.map(r => r.objectId), ['g1']);
  assert.equal(results[0].principalType, 'group');
});

test('a person is identified by the address their sign-in token will carry', async () => {
  const dir = require('../src/services/directoryService');
  const results = await withFakeDirectory({
    searchEntraUsers: async () => ([
      { id: 'u1', displayName: 'Ann', userPrincipalName: 'ann@x.com', mail: 'alias@x.com' },
      { id: 'u2', displayName: 'No Address' },
      { displayName: 'Nothing At All' },
    ]),
  }, () => dir.search('ann', 'user'));

  // The alias would never match the token, so the principal name wins. An entry
  // with no address can still be granted on its directory object, but one with
  // neither could never match anything and is not offered.
  assert.deepEqual(results.map(r => r.displayName), ['Ann', 'No Address']);
  assert.equal(results[0].email, 'ann@x.com');
});

test('a quote in a name does not break the directory filter', () => {
  const dir = require('../src/services/directoryService');
  assert.equal(dir._private.escapeODataLiteral("O'Brien"), "O''Brien");
});

test('a search shorter than two characters does not reach the directory', async () => {
  const dir = require('../src/services/directoryService');
  let called = false;
  const results = await withFakeDirectory({
    searchEntraUsers: async () => { called = true; return []; },
  }, () => dir.search('a', 'user'));
  assert.deepEqual(results, []);
  assert.equal(called, false);
});

test('a directory refusal names the Graph permissions that are missing', async () => {
  const dir = require('../src/services/directoryService');
  await withFakeDirectory({
    searchEntraUsers: async () => { throw new Error('Request failed with status code 403'); },
  }, async () => {
    await assert.rejects(dir.search('ann', 'user'), /User.Read.All and GroupMember.Read.All/);
  });
});

test('unreadable group membership is raised, never reported as belonging to no groups', async () => {
  const dir = require('../src/services/directoryService');
  await withFakeDirectory({
    getTransitiveGroupIds: async () => { throw new Error('Request failed with status code 403'); },
  }, async () => {
    // Returning [] here would silently drop every group-based grant, which looks
    // to the user exactly like having been removed from the application.
    await assert.rejects(dir.groupIdsForUser('ann@x.com'), /directory/i);
  });
});

test('membership is read once and then served from the cache', async () => {
  const dir = require('../src/services/directoryService');
  let calls = 0;
  await withFakeDirectory({
    getTransitiveGroupIds: async () => { calls += 1; return ['g1']; },
  }, async () => {
    assert.deepEqual(await dir.groupIdsForUser('ann@x.com'), ['g1']);
    assert.deepEqual(await dir.groupIdsForUser('ANN@x.com'), ['g1']);
    assert.equal(calls, 1, 'the address differs only in case, so it is the same person');
  });
});

test('the directory cannot be searched when no service principal is configured', async () => {
  const dir = require('../src/services/directoryService');
  await withFakeDirectory({}, async () => {
    await assert.rejects(dir.search('ann', 'user'), /No service principal is configured/);
  }, []);
});

test('grants from a person and their groups add up rather than narrowing', () => {
  const permissionService = require('../src/services/permissionService');
  const result = permissionService.resolvePermissions({
    user: { email: 'ann@x.com' },
    record: { email: 'ann@x.com', role: 'user', is_active: true, tenantIds: [1], sectionKeys: ['workspaces'] },
    groupRecords: [
      { display_name: 'BI Readers', principal_type: 'group', role: 'user', is_active: true, tenantIds: [2], sectionKeys: ['reconciliation'] },
    ],
    anyAdminConfigured: true,
    tenants: [{ id: 1 }, { id: 2 }],
  });

  assert.deepEqual(result.tenantIds.sort(), [1, 2]);
  assert.ok(result.sectionKeys.includes('workspaces'));
  assert.ok(result.sectionKeys.includes('reconciliation'));
  assert.deepEqual(result.viaGroups, ['BI Readers']);
});

test('a group may confer administrator, and a deactivated group confers nothing', () => {
  const permissionService = require('../src/services/permissionService');
  const asAdmin = permissionService.resolvePermissions({
    user: { email: 'ann@x.com' },
    record: null,
    groupRecords: [{ display_name: 'BI Admins', role: 'admin', is_active: true, tenantIds: [], sectionKeys: [] }],
    anyAdminConfigured: true,
    tenants: [{ id: 1 }],
  });
  assert.equal(asAdmin.isAdmin, true);

  const deactivated = permissionService.resolvePermissions({
    user: { email: 'ann@x.com' },
    record: null,
    groupRecords: [{ display_name: 'BI Admins', role: 'admin', is_active: false, tenantIds: [1], sectionKeys: ['workspaces'] }],
    anyAdminConfigured: true,
    tenants: [{ id: 1 }],
  });
  assert.equal(deactivated.isAdmin, false);
  assert.deepEqual(deactivated.tenantIds, []);
});

test('group records are looked up by object id, parameterised', async () => {
  const repo = require('../src/services/permissionRepository');
  const { executed } = await withFakeSql(() => [], () => repo.getGroupRecords(['g1', 'g2']));
  const lookup = executed[0];
  // A group name can be changed in Entra; its object id cannot, so the grant
  // survives a rename. And the ids are directory data, so they are bound, not pasted.
  assert.match(lookup.sql, /entra_object_id IN \(@g0, @g1\)/);
  assert.ok(lookup.params.some(p => p.value === 'g1') && lookup.params.some(p => p.value === 'g2'));
});

test('no group lookup is attempted when no group has been granted anything', async () => {
  const repo = require('../src/services/permissionRepository');
  const { executed } = await withFakeSql(() => [], () => repo.getGroupRecords([]));
  assert.equal(executed.length, 0, 'an empty IN list is not a query worth sending');
});

test('a group grant without an object id is refused, as is a person without an address', async () => {
  const repo = require('../src/services/permissionRepository');
  await assert.rejects(
    withFakeSql(() => [], () => repo.saveUser({ principalType: 'group', displayName: 'BI Admins', tenantIds: [], sectionKeys: [] })),
    /group/i,
  );
  await assert.rejects(
    withFakeSql(() => [], () => repo.saveUser({ principalType: 'user', displayName: 'Ann', tenantIds: [], sectionKeys: [] })),
    /email|address/i,
  );
});

test('the access panel lets an administrator pick a person or a security group', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/settings/permissions.ejs', {
    currentUser: { name: 'T' }, user: { name: 'T' }, currentPath: '/settings/permissions',
    breadcrumb: [], availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Users & Access',
    users: [{ id: 9, email: null, display_name: 'BI Admins', principal_type: 'group', entra_object_id: 'g1', role: 'user', is_active: true, tenantIds: [], sectionKeys: [] }],
    tenants: [{ id: 2, name: 'Fabrikam', tenant_id: 'abc' }],
    sections: sections.GRANTABLE_SECTIONS,
    bootstrap: false, success: [], error: [],
    permissions: { isAdmin: true }, visibleSections: sections.APP_SECTIONS,
  });

  assert.match(html, /id="principalSearch"/);
  assert.match(html, /id="userPrincipalType"/);
  assert.match(html, /id="userObjectId"/);
  assert.match(html, /name="lookupType"/);
  // A granted group is shown as one, so an administrator is not left wondering
  // why an entry has no address.
  assert.match(html, /Security group/);
  // Sections can be ticked in bulk: a whole tenant row, or one section across
  // every granted tenant.
  assert.match(html, /js-row/);
  assert.match(html, /js-col/);
});

test('the directory search route reports a failure instead of looking like no results', async () => {
  const dir = require('../src/services/directoryService');
  const router = require('../src/routes/permissions');
  const layer = router.stack.find(l => l.route && l.route.path === '/directory/search');
  const handler = layer.route.stack[0].handle;

  const real = dir.search;
  dir.search = async () => { throw new Error('The service principal cannot read the directory.'); };
  try {
    let body = null;
    await handler({ query: { q: 'ann', type: 'user' } }, { json: payload => { body = payload; } });
    // An empty list would read as "nobody by that name"; missing consent is a
    // thing an administrator can act on, so it has to be said out loud.
    assert.equal(body.success, false);
    assert.match(body.message, /cannot read the directory/);
  } finally {
    dir.search = real;
  }
});


test('the access dialog fits its content instead of hiding it below the fold', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/settings/permissions.ejs', {
    currentUser: { name: 'T' }, user: { name: 'T' }, currentPath: '/settings/permissions',
    breadcrumb: [], availableRuns: [], globalRun: null, hideRunSelector: true, title: 'Users & Access',
    users: [],
    tenants: [{ id: 2, name: 'Fabrikam', tenant_id: 'abc' }],
    sections: sections.GRANTABLE_SECTIONS,
    bootstrap: false, success: [], error: [],
    permissions: { isAdmin: true }, visibleSections: sections.APP_SECTIONS,
  });

  // Wide enough for the tenant × section grid, so each tenant's sections sit on its
  // own row rather than in a list stacked below the tenants.
  assert.match(html, /modal-dialog modal-xl/);
  assert.match(html, /id="grantFields"/);
  assert.match(html, /class="table table-sm align-middle mb-0 grant-matrix"/);
  // Granting every tenant at once is one click.
  assert.match(html, /js-all-tenants/);
});

test('a scrollable modal whose body is wrapped in a form can still scroll', async () => {
  const fs = require('fs');
  const css = fs.readFileSync('src/public/css/style.css', 'utf8');
  const view = fs.readFileSync('src/views/settings/permissions.ejs', 'utf8');

  // Bootstrap builds the scrollable layout assuming header, body and footer are
  // direct children of .modal-content. This dialog wraps them in a form, which
  // left the body at its natural height: clipped, with no scrollbar and the Save
  // button cut off the bottom of the screen with no way to reach it.
  assert.match(view, /<div class="modal-content">\s*<form/);
  assert.match(css, /\.modal-dialog-scrollable \.modal-content > form \{[^}]*flex-direction: column/);
  assert.match(css, /\.modal-dialog-scrollable \.modal-content > form \{[^}]*max-height: 100%/);
  assert.match(css, /\.modal-dialog-scrollable \.modal-content > form > \.modal-body \{ overflow-y: auto/);
});

// ── Guest (B2B external) users ──

test('the address hidden in a guest principal name is recovered', () => {
  const p = require('../src/services/permissionService');
  assert.equal(
    p.externalAddressFromGuestUpn('jakub.miasik_softwareone.com#EXT#@SWOTDEMPID302779.onmicrosoft.com'),
    'jakub.miasik@softwareone.com',
  );
  // Only the last underscore becomes the @: ann_marie at contoso.com, never ann
  // at marie_contoso.com.
  assert.equal(
    p.externalAddressFromGuestUpn('ann_marie_contoso.com#EXT#@tenant.onmicrosoft.com'),
    'ann_marie@contoso.com',
  );
  // A member's address is not a guest address and must not be mangled into one.
  assert.equal(p.externalAddressFromGuestUpn('ann@contoso.com'), '');
  assert.equal(p.externalAddressFromGuestUpn(''), '');
});

test('a guest is recognised under either of their two addresses', () => {
  const p = require('../src/services/permissionService');
  const upn = 'jakub.miasik_softwareone.com#EXT#@SWOTDEMPID302779.onmicrosoft.com';

  assert.ok(p.identityEmails({ email: upn }).includes('jakub.miasik@softwareone.com'));
  assert.ok(p.identityEmails({ email: upn }).includes(upn.toLowerCase()));
  // Signed in under the external address, the #EXT# form is not derivable, but
  // the address itself still has to be offered as a match.
  assert.deepEqual(p.identityEmails({ email: 'jakub.miasik@softwareone.com' }), ['jakub.miasik@softwareone.com']);
  assert.ok(p.isGuestUpn(upn));
  assert.ok(!p.isGuestUpn('ann@contoso.com'));
});

test('naming either form of a guest address in ADMIN_EMAILS makes them an administrator', () => {
  const p = require('../src/services/permissionService');
  const upn = 'jakub.miasik_softwareone.com#EXT#@SWOTDEMPID302779.onmicrosoft.com';

  // The lockout safety net has to work for a guest too, and whoever sets
  // ADMIN_EMAILS will write the address they recognise, not the mangled one.
  const byExternal = p.resolvePermissions({
    user: { email: upn }, record: null,
    adminEmails: ['jakub.miasik@softwareone.com'], anyAdminConfigured: true, tenants: [],
  });
  assert.equal(byExternal.isAdmin, true);

  const byUpn = p.resolvePermissions({
    user: { email: upn }, record: null,
    adminEmails: [upn], anyAdminConfigured: true, tenants: [],
  });
  assert.equal(byUpn.isAdmin, true);
});

test('a sign-in token is read for the object id and both address forms', () => {
  const { parseEasyAuthUser } = require('../src/middleware/auth');
  const upn = 'jakub.miasik_softwareone.com#EXT#@SWOTDEMPID302779.onmicrosoft.com';
  const principal = {
    userId: 'x', userDetails: upn, identityProvider: 'aad',
    claims: [
      { typ: 'name', val: 'Jakub Miasik' },
      { typ: 'preferred_username', val: 'jakub.miasik@softwareone.com' },
      { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn', val: upn },
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: 'guest-oid' },
    ],
  };
  const req = { headers: { 'x-ms-client-principal': Buffer.from(JSON.stringify(principal)).toString('base64') } };
  parseEasyAuthUser(req, {}, () => {});

  assert.equal(req.user.objectId, 'guest-oid');
  assert.equal(req.user.email, 'jakub.miasik@softwareone.com');
  assert.equal(req.user.userPrincipalName, upn);
  // Whichever address the grant was recorded against, one of these matches it.
  assert.ok(req.user.alternateEmails.includes(upn));
});

test('a person is found by directory object id as well as by any of their addresses', async () => {
  const repo = require('../src/services/permissionRepository');
  const { executed } = await withFakeSql(() => [], () => repo.getUserByIdentity({
    objectId: 'guest-oid',
    emails: ['jakub.miasik@softwareone.com', 'jakub.miasik_softwareone.com#EXT#@tenant.onmicrosoft.com'],
  }));

  const lookup = executed[0];
  assert.match(lookup.sql, /entra_object_id = @objectId/);
  assert.match(lookup.sql, /email IN \(@e0, @e1\)/);
  // Token data, so bound rather than concatenated into the statement.
  assert.ok(lookup.params.some(p => p.value === 'guest-oid'));
  assert.ok(lookup.params.some(p => p.value === 'jakub.miasik@softwareone.com'));
});

test('the object id wins when an older address-keyed entry sits beside it', async () => {
  const repo = require('../src/services/permissionRepository');
  const rows = [
    { id: 1, email: 'jakub.miasik@softwareone.com', entra_object_id: null, role: 'user', is_active: true, principal_type: 'user' },
    { id: 2, email: null, entra_object_id: 'guest-oid', role: 'admin', is_active: true, principal_type: 'user' },
  ];
  const { result } = await withFakeSql(sql => (/FROM app_users/.test(sql) ? rows : []), () =>
    repo.getUserByIdentity({ objectId: 'guest-oid', emails: ['jakub.miasik@softwareone.com'] }));

  // The object id is the identity that cannot be reassigned, so it decides.
  assert.equal(result.id, 2);
});

test('an identity with nothing to match on does not query at all', async () => {
  const repo = require('../src/services/permissionRepository');
  const { executed, result } = await withFakeSql(() => [], () => repo.getUserByIdentity({ objectId: '', emails: [] }));
  assert.equal(result, null);
  assert.equal(executed.length, 0);
});

test('a guest can be granted access by directory entry alone, without an address', async () => {
  const repo = require('../src/services/permissionRepository');
  const { executed } = await withFakeSql(sql => (/OUTPUT INSERTED.id/.test(sql) ? [{ id: 7 }] : []), () =>
    repo.saveUser({ principalType: 'user', entraObjectId: 'guest-oid', displayName: 'Jakub Miasik', tenantIds: [], sectionKeys: [] }));
  assert.ok(executed.some(e => /INSERT INTO app_users/.test(e.sql)));

  // With neither, there is nothing a sign-in could ever be matched against.
  await assert.rejects(
    withFakeSql(() => [], () => repo.saveUser({ principalType: 'user', displayName: 'Nobody', tenantIds: [], sectionKeys: [] })),
    /email address or a directory entry/i,
  );
});

test('re-granting a guest found under their other address edits the same entry', async () => {
  const repo = require('../src/services/permissionRepository');
  const { executed } = await withFakeSql(sql => (/SELECT id FROM app_users/.test(sql) ? [{ id: 4 }] : []), () =>
    repo.saveUser({ principalType: 'user', email: 'jakub.miasik@softwareone.com', entraObjectId: 'guest-oid', tenantIds: [], sectionKeys: [] }));

  const lookup = executed.find(e => /SELECT id FROM app_users/.test(e.sql));
  assert.match(lookup.sql, /email = @email OR .*entra_object_id = @entraObjectId/s);
  assert.ok(!executed.some(e => /INSERT INTO app_users/.test(e.sql)), 'a second row for the same person is not a new grant');
});

test('the picker shows a guest by the address an administrator recognises', async () => {
  const dir = require('../src/services/directoryService');
  const upn = 'jakub.miasik_softwareone.com#EXT#@SWOTDEMPID302779.onmicrosoft.com';
  const results = await withFakeDirectory({
    searchEntraUsers: async () => ([
      { id: 'guest-oid', displayName: 'Jakub Miasik', userPrincipalName: upn, mail: 'jakub.miasik@softwareone.com', userType: 'Guest' },
      { id: 'member-oid', displayName: 'Ann', userPrincipalName: 'ann@contoso.com', mail: 'ann@contoso.com', userType: 'Member' },
    ]),
  }, () => dir.search('jakub', 'user'));

  const guest = results.find(r => r.objectId === 'guest-oid');
  assert.equal(guest.isGuest, true);
  assert.equal(guest.email, 'jakub.miasik@softwareone.com', 'the #EXT# form is not what anyone recognises');
  assert.equal(guest.userPrincipalName, upn.toLowerCase());
  assert.match(guest.detail, /guest/i);
  assert.equal(results.find(r => r.objectId === 'member-oid').isGuest, false);
});

test('a guest with no mail is still offered, recovered from their principal name', async () => {
  const dir = require('../src/services/directoryService');
  const results = await withFakeDirectory({
    searchEntraUsers: async () => ([
      { id: 'guest-oid', displayName: 'Jakub Miasik', userType: 'Guest',
        userPrincipalName: 'jakub.miasik_softwareone.com#EXT#@tenant.onmicrosoft.com' },
    ]),
  }, () => dir.search('jakub', 'user'));

  assert.equal(results.length, 1);
  assert.equal(results[0].email, 'jakub.miasik@softwareone.com');
});

test('guests are searchable by the address they are actually known by', () => {
  // Their principal name is the mangled #EXT# form, so filtering on it alone
  // could never find them by what an administrator types.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'services', 'powerbiService.js'), 'utf8');
  assert.match(source, /startswith\(mail,/);
  assert.match(source, /userType/);
});

test('group membership for a guest is resolved by object id, not by their address', async () => {
  const dir = require('../src/services/directoryService');
  let askedFor = null;
  await withFakeDirectory({
    getTransitiveGroupIds: async (key) => { askedFor = key; return ['g1']; },
  }, async () => {
    assert.deepEqual(await dir.groupIdsForUser('guest-oid'), ['g1']);
  });
  // Graph cannot find a guest by the external address they signed in with - that
  // is not their principal name in this tenant, and the lookup is a 404.
  assert.equal(askedFor, 'guest-oid');
});

// ── Podavo design system: shell, components and the governance screens ──

test('the sidebar groups sections as Overview, Governance, Operations, Data Quality, Configuration', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/governance', breadcrumb: [],
    availableRuns: [], globalRun: null, hideRunSelector: true, title: 'x',
    visibleSections: sections.APP_SECTIONS, permissions: { isAdmin: true }, navGroups: sections.NAV_GROUPS,
  });
  const titles = [...html.matchAll(/class="pd-nav-title"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(titles, ['Overview', 'Governance', 'Operations', 'Data Quality', 'Configuration']);
  // The active page is announced, not only coloured.
  assert.match(html, /href="\/governance" class="pd-nav-link sidebar-link active" aria-current="page"/);
  // Every section the guard knows about sits in one of the menu's groups, with a Lucide icon.
  for (const section of sections.APP_SECTIONS) {
    assert.ok(sections.NAV_GROUPS.includes(section.group), section.key);
    assert.ok(section.lucide, section.key + ' has no Lucide icon');
  }
  // The application keeps its own name; Podavo is the suite it belongs to.
  assert.match(html, /class="pd-brand-name">Fabric Governance</);
});

test('the shell says which tenant and scan the page describes, and when the data store is down', async () => {
  const ejs = require('ejs');
  const run = { id: 9, sp_name: 'Contoso SP', tenant_id: 'tenant-guid', started_at: '2026-11-25T02:00:00Z', completed_at: '2026-11-25T02:40:00Z' };
  const loaded = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/workspaces', breadcrumb: [], title: 'x',
    availableRuns: [run], globalRun: run, selectedRunId: 9,
  });
  assert.match(loaded, /Contoso SP/);
  assert.match(loaded, /tenant-guid/);
  assert.match(loaded, /Scan data loaded/);
  assert.match(loaded, /<time datetime="2026-11-25T02:40:00.000Z" data-local-time>/);
  // No notification feed exists, so the shell offers no bell.
  assert.doesNotMatch(loaded, /data-lucide="bell"/);

  const down = await ejs.renderFile('src/views/partials/header.ejs', {
    currentUser: { name: 'T' }, currentPath: '/workspaces', breadcrumb: [], title: 'x',
    availableRuns: [], globalRun: null, runsLoadError: true,
  });
  // An unreachable store is not the same as "no scans yet", and must not read as it.
  assert.match(down, /Data store unavailable/);
  assert.doesNotMatch(down, /No completed scan/);
});

test('the state component renders each kind with the right live-region role', async () => {
  const ejs = require('ejs');
  const dir = 'packages/podavo-ui/ejs/';
  const error = await ejs.renderFile(dir + 'state.ejs', { ui: { kind: 'error', title: 'Failed', message: '<b>x</b>' } });
  assert.match(error, /class="pd-state pd-state--error"/);
  assert.match(error, /role="alert"/);
  assert.doesNotMatch(error, /<b>x<\/b>/, 'messages are escaped');
  const empty = await ejs.renderFile(dir + 'state.ejs', { ui: { kind: 'empty', title: 'Nothing' } });
  assert.match(empty, /role="status"/);
  // A metric with no value says so rather than showing a made-up number.
  const metric = await ejs.renderFile(dir + 'metric-card.ejs', { ui: { label: 'Compliance', value: null } });
  assert.match(metric, /Not evaluated/);
});

test('the governance overview leads with findings and marks unrun checks as not evaluated', async () => {
  const ejs = require('ejs');
  const insights = require('../src/services/workspaceInsightsService');
  const workspaces = [
    { id: 'a', name: 'Nobody', state: 'Active', items: [{ id: '1', name: 'R', type: 'Report', lastUpdated: '2026-07-29T00:00:00Z' }], users: [{ name: 'Bot', role: 'Viewer', type: 'User' }] },
    { id: 'b', name: 'Fine', state: 'Active', items: [{ id: '2', name: 'R', type: 'Report', lastUpdated: '2026-07-29T00:00:00Z' }], users: [{ name: 'Ann', email: 'a@x.com', role: 'Admin', type: 'User' }, { name: 'Ben', email: 'b@x.com', role: 'Admin', type: 'User' }, { name: 'Readers', role: 'Viewer', type: 'Group', principalType: 'Group' }] },
  ];
  const computed = insights.computeWorkspaceInsights({ workspaces }, { referenceDate: '2026-07-30T00:00:00Z' });
  const html = await ejs.renderFile('src/views/governance/overview.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/governance', breadcrumb: [],
    availableRuns: [], globalRun: null, title: 'Governance Overview',
    governance: { totalWorkspaces: 2, workspacesByState: { Active: 2 } }, workspaces,
    run: { id: 3, started_at: '2026-07-30T00:00:00Z' }, noData: false, creatorCount: 0, explorerCount: 0,
    insights: computed, findingDefs: insights.FINDING_DEFS,
    visibleSections: sections.APP_SECTIONS,
  });
  const findingsAt = html.indexOf('Prioritized findings');
  const inventoryAt = html.indexOf('id="inventoryHeading"');
  assert.ok(findingsAt > 0 && findingsAt < inventoryAt, 'findings come before the inventory');
  assert.match(html, /No admin/);
  assert.match(html, /href="\/workspaces\?runId=3&amp;finding=ownerless"/);
  // No convention configured: the naming check was not run, and must not read as clean.
  assert.match(html, /Off-convention names:<\/strong> <span class="pd-not-evaluated">Not evaluated/);
  // Nothing on the page invents a compliance score or a trend.
  assert.doesNotMatch(html, /[Cc]ompliance (score|trend)/);
});

test('the triage page is a data grid with finding filters and a docked details drawer', async () => {
  const ejs = require('ejs');
  const insights = require('../src/services/workspaceInsightsService');
  const computed = insights.computeWorkspaceInsights({ workspaces: [{ id: 'a', name: 'x</script><b>', state: 'Active', items: [], users: [] }] }, {});
  const html = await ejs.renderFile('src/views/workspaces/list.ejs', {
    user: { name: 'T' }, currentUser: { name: 'T' }, currentPath: '/workspaces', breadcrumb: [],
    availableRuns: [], globalRun: null, title: 'Workspaces', fromSavedData: true, run: null,
    insights: computed, findingDefs: insights.FINDING_DEFS, namingPattern: null,
    workspaceContext: { a: { owner: null, groupCount: 0, peopleCount: 0, usersRead: false, capacityName: null } }, reportCount: 0,
  });
  assert.match(html, /id="triage-table"[\s\S]*?data-grid/);
  assert.match(html, /class="pd-dock"[\s\S]*?id="workspaceDrawer" role="dialog" aria-modal="true"/);
  assert.match(html, /data-filter-key="ownerless"/);
  // The scoring explanation and thresholds moved into a dialog and a popover, with their wording intact.
  assert.match(html, /<dialog class="pd-dialog pd-dialog--lg" id="riskExplainerDialog"/);
  assert.match(html, /id="thresholdsPopover"/);
  // An unreadable access list is "Not available", not a person or a zero.
  assert.match(html, /Not available/);
  // Workspace names are data: they cannot close the script block they are embedded in.
  const script = html.slice(html.indexOf('var triageRows'));
  assert.ok(!script.slice(0, script.indexOf('var findingLabels')).includes('</script'));
});

test('the triage owner column reads the same principal rules the checks use', () => {
  const insights = require('../src/services/workspaceInsightsService');
  assert.equal(insights.isPersonPrincipal({ type: 'User' }), true);
  assert.equal(insights.isGroupPrincipal({ type: 'Group' }), true);
  assert.equal(insights.isAdminRole('Admin'), true);
});

test('the design tokens carry the brand colour, focus style and every breakpoint', () => {
  const fs = require('fs');
  const css = ['tokens', 'base', 'components', 'bootstrap-bridge']
    .map(name => fs.readFileSync('packages/podavo-ui/css/' + name + '.css', 'utf8')).join('\n')
    + fs.readFileSync('src/public/css/style.css', 'utf8');
  assert.match(css, /--pd-primary: #0f766e;/);
  assert.match(css, /--bs-primary-rgb: var\(--pd-primary-rgb\);|--bs-primary-rgb: 15, 118, 110;/);
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--pd-primary\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\[data-pd-variant="consumer"\]/);
  for (const width of ['1280px', '1440px', '1920px', '2560px']) assert.match(css, new RegExp('min-width: ' + width));
  // Shared components never hard-code a product colour: products override --pd-accent only.
  const components = fs.readFileSync('packages/podavo-ui/css/components.css', 'utf8');
  assert.doesNotMatch(components, /#0f766e/i);
});

test('the shared package is versioned and only its assets are served', () => {
  const pkg = require('../packages/podavo-ui/package.json');
  assert.equal(pkg.name, '@podavo/ui');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  const appSource = require('fs').readFileSync('src/app.js', 'utf8');
  assert.match(appSource, /'\/podavo-ui\/css'/);
  assert.match(appSource, /'\/podavo-ui\/js'/);
});
