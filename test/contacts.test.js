const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createApp, initializeSchema, readReferenceData, parseCsv } = require('../server');

const practice = readReferenceData();

async function createClient({ file = ':memory:', username = 'staff-demo', password = 'StaffDemo2026!' } = {}) {
  const db = new Database(file);
  initializeSchema(db);
  const server = createApp(db).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password })
  });
  const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
  assert.equal(loginResponse.status, 200, 'demo account should sign in');
  const client = {
    db,
    baseUrl,
    cookie,
    async request(route, { method = 'GET', body } = {}) {
      const headers = {};
      if (this.cookie) headers.cookie = this.cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${baseUrl}${route}`, { method, headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const data = (response.headers.get('content-type') || '').includes('json') ? await response.json() : await response.text();
      return { response, data };
    },
    async loginAs(user, pass) {
      const result = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
      const nextCookie = result.headers.get('set-cookie')?.split(';')[0];
      return { response: result, cookie: nextCookie };
    },
    async close() { server.close(); server.closeAllConnections(); db.close(); }
  };
  return client;
}

async function withClient(run, options) {
  const client = await createClient(options);
  try { await run(client); } finally { await client.close(); }
}

async function addContact(client, values = {}) {
  return client.request('/api/contacts', { method: 'POST', body: {
    id: 'T001', name: 'Test Person', email: 'test@example.com', phone: '555-0199', tags: ['member'], notes: 'Fake record', ...values
  } });
}

test('protected routes require a signed-in session', async () => withClient(async (client) => {
  client.cookie = '';
  const list = await client.request('/api/contacts');
  const save = await client.request('/api/contacts', { method: 'POST', body: { id: 'X1', name: 'Fake' } });
  assert.equal(list.response.status, 401);
  assert.equal(save.response.status, 401);
  assert.match(list.data.error, /Sign in/);
}));

test('staff and admin can write while viewer write/import/export/admin requests are blocked on the server', async () => withClient(async (staff) => {
  const viewer = await staff.loginAs('viewer-demo', 'ViewerDemo2026!');
  const admin = await staff.loginAs('admin-demo', 'AdminDemo2026!');
  assert.equal(viewer.response.status, 200);
  assert.equal(admin.response.status, 200);
  const viewRequest = async (route, options = {}) => {
    const response = await fetch(`${staff.baseUrl}${route}`, { method: options.method || 'GET', headers: {
      cookie: viewer.cookie, ...(options.body ? { 'content-type': 'application/json' } : {})
    }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    return response;
  };
  assert.equal((await viewRequest('/api/contacts')).status, 200);
  await addContact(staff, { id: 'ROLE-TEST', name: 'Fake role test', email: '' });
  assert.equal((await viewRequest('/api/contacts', { method: 'POST', body: { id: 'X1', name: 'Fake' } })).status, 403);
  assert.equal((await viewRequest('/api/contacts/ROLE-TEST', { method: 'PUT', body: { id: 'ROLE-TEST', name: 'Changed' } })).status, 403);
  assert.equal((await viewRequest('/api/contacts/ROLE-TEST/archive', { method: 'POST', body: {} })).status, 403);
  assert.equal((await viewRequest('/api/import/practice-data', { method: 'POST', body: {} })).status, 403);
  assert.equal((await viewRequest('/api/export/contacts.csv')).status, 403);
  assert.equal((await viewRequest('/api/admin/users')).status, 403);
  const staffAdmin = await staff.request('/api/admin/users');
  assert.equal(staffAdmin.response.status, 403);
  const staffExport = await staff.request('/api/export/contacts.csv');
  assert.equal(staffExport.response.status, 403);
  const users = await fetch(`${staff.baseUrl}/api/admin/users`, { headers: { cookie: admin.cookie } });
  assert.equal(users.status, 200);
  const created = await fetch(`${staff.baseUrl}/api/admin/users`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'new-viewer', role: 'viewer', password: 'VeryFakePass123' }) });
  assert.equal(created.status, 201);
  const createdUser = await created.json();
  assert.equal((await viewRequest(`/api/admin/users/${createdUser.id}`, { method: 'PATCH', body: { role: 'staff' } })).status, 403);
  const changedRole = await fetch(`${staff.baseUrl}/api/admin/users/${createdUser.id}`, {
    method: 'PATCH', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'staff' })
  });
  assert.equal(changedRole.status, 200);
  assert.equal((await changedRole.json()).role, 'staff');
  const csv = await fetch(`${staff.baseUrl}/api/export/contacts.csv`, { headers: { cookie: admin.cookie } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
}));

test('contact create trims values, defaults email permission to No, permits blank email and keeps IDs case-sensitive', async () => withClient(async (client) => {
  const first = await addContact(client, { id: ' X1 ', name: '  Fake Name  ', email: ' ', phone: ' 555-0100 ', notes: ' note ' });
  assert.equal(first.response.status, 201);
  assert.equal(first.data.id, 'X1');
  assert.equal(first.data.name, 'Fake Name');
  assert.equal(first.data.email, '');
  assert.equal(first.data.phone, '555-0100');
  assert.equal(first.data.notes, 'note');
  assert.equal(first.data.email_opt_in, false);
  const lowerCaseId = await addContact(client, { id: 'x1', email: '' });
  assert.equal(lowerCaseId.response.status, 201);
}));

test('edit preserves contact ID, trims fields, validates name and email, and enforces case-insensitive email uniqueness', async () => withClient(async (client) => {
  const first = await addContact(client, { id: 'C1', email: 'first@example.com' });
  const second = await addContact(client, { id: 'C2', email: 'second@example.com' });
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  const badEmail = await client.request('/api/contacts/C1', { method: 'PUT', body: { id: 'C1', name: 'Name', email: 'not-email', phone: '1' } });
  assert.equal(badEmail.response.status, 400);
  const duplicateEmail = await client.request('/api/contacts/C1', { method: 'PUT', body: { id: 'C1', name: 'Name', email: ' SECOND@example.com ' } });
  assert.equal(duplicateEmail.response.status, 409);
  const blankName = await client.request('/api/contacts/C1', { method: 'PUT', body: { id: 'C1', name: '   ', email: '' } });
  assert.equal(blankName.response.status, 400);
  assert.equal(blankName.data.error, 'Enter a name.');
  const changeId = await client.request('/api/contacts/C1', { method: 'PUT', body: { id: 'Different', name: 'Name' } });
  assert.equal(changeId.response.status, 400);
  const edited = await client.request('/api/contacts/C1', { method: 'PUT', body: {
    id: 'C1', name: '  Updated Name  ', email: ' FIRST@example.com ', phone: ' 555-0111 ', household_id: '', tags: ' donor, member ', notes: ' edited ', email_opt_in: true
  } });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.data.id, 'C1');
  assert.equal(edited.data.name, 'Updated Name');
  assert.equal(edited.data.phone, '555-0111');
  assert.deepEqual(edited.data.tags, ['donor', 'member']);
  assert.equal(edited.data.email_opt_in, true);
  const other = (await client.request('/api/contacts/C2')).data;
  assert.equal(other.name, 'Test Person');
  assert.equal(other.email, 'second@example.com');
  const history = (await client.request('/api/contacts/C1')).data.history;
  assert.deepEqual(history.map((item) => item.action), ['edit', 'add']);
  assert.ok(history.every((item) => item.actor_name === 'staff-demo' && item.record_id === 'C1' && item.occurred_at));
}));

test('contact and a new household save together or both roll back after a forced write failure', async () => withClient(async (client) => {
  client.db.exec("CREATE TRIGGER fail_contact BEFORE INSERT ON contacts WHEN NEW.id = 'FAIL1' BEGIN SELECT RAISE(ABORT, 'forced test failure'); END;");
  const result = await addContact(client, { id: 'FAIL1', household_id: 'H-FAIL', household_name: 'Fake new household' });
  assert.equal(result.response.status, 500);
  assert.match(result.data.error, /could not be saved/i);
  assert.equal(client.db.prepare("SELECT count(*) count FROM households WHERE id='H-FAIL'").get().count, 0);
  assert.equal(client.db.prepare("SELECT count(*) count FROM contacts WHERE id='FAIL1'").get().count, 0);
  client.db.exec('DROP TRIGGER fail_contact');
  const retried = await addContact(client, { id: 'FAIL1', household_id: 'H-FAIL', household_name: 'Fake new household' });
  assert.equal(retried.response.status, 201);
  assert.equal(client.db.prepare("SELECT count(*) count FROM households WHERE id='H-FAIL'").get().count, 1);
  assert.equal(client.db.prepare("SELECT count(*) count FROM contacts WHERE id='FAIL1'").get().count, 1);
}));

test('a failed edit rolls back changed contact fields and a newly selected household', async () => withClient(async (client) => {
  const original = await addContact(client, { id: 'ROLLBACK1', name: 'Original Name', phone: '555-0001', email: '', household_id: '' });
  assert.equal(original.response.status, 201);
  client.db.exec("CREATE TRIGGER fail_edit_audit BEFORE INSERT ON audit_events WHEN NEW.record_id = 'ROLLBACK1' AND NEW.action = 'edit' BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;");
  const edit = await client.request('/api/contacts/ROLLBACK1', { method: 'PUT', body: {
    id: 'ROLLBACK1', name: 'Changed Name', email: '', phone: '555-9999', household_id: 'H-ROLLBACK', household_name: 'Fake rollback household', tags: ['donor'], notes: 'changed', email_opt_in: true
  } });
  assert.equal(edit.response.status, 500);
  const after = (await client.request('/api/contacts/ROLLBACK1')).data;
  assert.equal(after.name, 'Original Name');
  assert.equal(after.phone, '555-0001');
  assert.equal(after.household_id, null);
  assert.equal(after.notes, 'Fake record');
  assert.equal(after.email_opt_in, false);
  assert.equal(client.db.prepare("SELECT count(*) count FROM households WHERE id='H-ROLLBACK'").get().count, 0);
}));

test('practice import loads 30 people and five households idempotently without overwriting existing contacts', async () => withClient(async (client) => {
  const existing = await addContact(client, { id: 'C101', name: 'My saved Alex', email: 'saved-alex@example.com', phone: '555-7777', notes: 'Keep me' });
  assert.equal(existing.response.status, 201);
  const imported = await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.data.inserted, 29);
  assert.equal(imported.data.skipped, 1);
  assert.equal(client.db.prepare('SELECT count(*) count FROM contacts').get().count, 30);
  assert.equal(client.db.prepare('SELECT count(*) count FROM households').get().count, 5);
  const alex = (await client.request('/api/contacts/C101')).data;
  assert.equal(alex.name, 'My saved Alex');
  assert.equal(alex.phone, '555-7777');
  assert.equal(alex.notes, 'Keep me');
  const lastContact = (await client.request('/api/contacts/C130')).data;
  assert.equal(lastContact.name, practice.contacts.find((item) => item.id === 'C130').name);
  const again = await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  assert.equal(again.data.inserted, 0);
  assert.equal(again.data.skipped, 30);
  assert.equal(client.db.prepare('SELECT count(*) count FROM contacts').get().count, 30);
}));

test('search and tag filters work and opening a household shows its linked people', async () => withClient(async (client) => {
  await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  const alex = await client.request('/api/contacts?search=Alex');
  assert.ok(alex.data.some((item) => item.id === 'C101'));
  const donors = await client.request('/api/contacts?tag=donor');
  assert.ok(donors.data.length > 0);
  assert.ok(donors.data.every((item) => item.tags.includes('donor')));
  const none = await client.request('/api/contacts?search=Nobody');
  assert.deepEqual(none.data, []);
  const household = await client.request('/api/households/H101');
  assert.equal(household.data.people.length, 2);
  assert.deepEqual(household.data.people.map((item) => item.id).sort(), ['C101', 'C102']);
}));

test('archive hides C130 from the active list but retains its details, links, and named history', async () => withClient(async (client) => {
  await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  client.db.prepare("INSERT INTO donations (id, contact_id, amount, date, campaign, method, payment_code) VALUES ('D-FAKE', 'C130', 5, '2026-10-01', 'Fake', 'cash', 'FAKE')").run();
  const before = (await client.request('/api/contacts/C130')).data;
  const archived = await client.request('/api/contacts/C130/archive', { method: 'POST', body: {} });
  assert.equal(archived.response.status, 200);
  const active = await client.request('/api/contacts');
  assert.equal(active.data.length, 29);
  assert.ok(!active.data.some((item) => item.id === 'C130'));
  assert.equal(client.db.prepare('SELECT count(*) count FROM contacts').get().count, 30);
  assert.equal(client.db.prepare('SELECT count(*) count FROM contacts WHERE archived=1').get().count, 1);
  const details = (await client.request('/api/contacts/C130')).data;
  assert.equal(details.archived, true);
  assert.equal(details.notes, before.notes);
  assert.equal(details.donations.length, 1);
  assert.equal(details.history[0].actor_name, 'staff-demo');
  assert.equal(details.history[0].action, 'archive');
  assert.equal(details.history[0].record_id, 'C130');
  assert.ok(details.history[0].occurred_at);
  const archivedList = await client.request('/api/contacts?archived=true');
  assert.deepEqual(archivedList.data.map((item) => item.id), ['C130']);
}));

test('CSV import maps contact_id and household columns, skips existing IDs before validating them, and reports bad rows', async () => withClient(async (client) => {
  const existing = await addContact(client, { id: 'C101', name: 'Saved version', email: 'saved@example.com', phone: '123' });
  assert.equal(existing.response.status, 201);
  const existingCsv = fs.readFileSync(path.join(__dirname, '..', 'data', 'client-data-1', 'data', 'contacts-existing.csv'), 'utf8');
  const skipped = await client.request('/api/import/contacts-csv', { method: 'POST', body: { csv: existingCsv } });
  assert.equal(skipped.data.rows[0].status, 'skipped');
  const preserved = (await client.request('/api/contacts/C101')).data;
  assert.equal(preserved.name, 'Saved version');
  assert.equal(preserved.email, 'saved@example.com');
  const clean = fs.readFileSync(path.join(__dirname, '..', 'data', 'client-data-1', 'data', 'contacts-clean.csv'), 'utf8');
  const cleanResult = await client.request('/api/import/contacts-csv', { method: 'POST', body: { csv: clean } });
  assert.equal(cleanResult.data.added, 2);
  const alexCsv = (await client.request('/api/contacts/C001')).data;
  assert.equal(alexCsv.household_id, 'H001');
  assert.equal(alexCsv.email_opt_in, true);
  const messy = fs.readFileSync(path.join(__dirname, '..', 'data', 'client-data-1', 'data', 'contacts-messy.csv'), 'utf8');
  const errors = await client.request('/api/import/contacts-csv', { method: 'POST', body: { csv: messy } });
  assert.equal(errors.data.added, 1);
  assert.equal(errors.data.errors, 4);
  assert.equal(errors.data.skipped, 2);
  const corrected = fs.readFileSync(path.join(__dirname, '..', 'data', 'client-data-1', 'data', 'contacts-corrected.csv'), 'utf8');
  const imported = await client.request('/api/import/contacts-csv', { method: 'POST', body: { csv: corrected } });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.data.added, 4);
  assert.equal(imported.data.skipped, 2);
  assert.equal(imported.data.errors, 0);
  const jordan = (await client.request('/api/contacts/C003')).data;
  assert.equal(jordan.household_id, 'H002');
  assert.equal(jordan.email, 'jordan@example.com');
  const parsed = parseCsv('contact_id,name,notes\r\nX1,"Name, with comma","quoted ""note"""');
  assert.equal(parsed[0].name, 'Name, with comma');
  assert.equal(parsed[0].notes, 'quoted "note"');
  assert.equal((await client.request('/api/contacts/C007')).data.name, 'Alex Copy');
}));

test('SQLite save persists phone and email permission across app restart without reseeding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-persist-'));
  const file = path.join(dir, 'persist.sqlite');
  const first = await createClient({ file });
  try {
    const added = await addContact(first, { id: 'PERSIST1', email: '', household_id: '' });
    assert.equal(added.response.status, 201);
    const edit = await first.request('/api/contacts/PERSIST1', { method: 'PUT', body: {
      id: 'PERSIST1', name: 'Test Person', email: '', phone: '555-4444', household_id: '', tags: ['donor'], notes: 'Fake record', email_opt_in: true
    } });
    assert.equal(edit.response.status, 200);
  } finally { await first.close(); }
  const second = await createClient({ file });
  try {
    const saved = await second.request('/api/contacts/PERSIST1');
    assert.equal(saved.data.phone, '555-4444');
    assert.equal(saved.data.email_opt_in, true);
    assert.equal(saved.data.notes, 'Fake record');
  } finally { await second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('logout clears the session and the contact form keeps labeled accessible controls for retry', async () => withClient(async (client) => {
  const loggedOut = await client.request('/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(loggedOut.response.status, 200);
  assert.equal((await client.request('/api/contacts')).response.status, 401);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  for (const id of ['contact-id', 'contact-name', 'contact-email', 'contact-phone', 'contact-household', 'contact-tags', 'contact-notes', 'contact-email-opt-in']) assert.match(html, new RegExp(`<label[^>]*for="${id}"`));
  assert.match(html, /id="form-message" role="alert" aria-live="assertive"/);
  assert.match(html, /id="cancel-contact"/);
  assert.match(js, /catch \(error\) \{\s*formMessage\.textContent = error\.message/);
  assert.match(js, /contact-id'\)\.readOnly = Boolean\(contact\)/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  assert.match(html, /id="auth-gate"/);
}));

test('practice membership import gives the October 15 baseline counts and exact date boundaries', async () => withClient(async (client) => {
  const imported = await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.data.memberships, 20);
  const baseline = (await client.request('/api/memberships/summary?date=2026-10-15')).data;
  assert.deepEqual({ active: baseline.active, endingSoon: baseline.endingSoon, ended: baseline.ended, pending: baseline.pending, peopleCovered: baseline.peopleCovered },
    { active: 12, endingSoon: 6, ended: 4, pending: 4, peopleCovered: 14 });
  assert.equal((await client.request('/api/memberships?date=2026-10-15')).data.length, 20);
  assert.equal((await client.request('/api/memberships/summary?date=2026-02-30')).response.status, 400);
  const boundary = await client.request('/api/memberships/M103/renew', { method: 'POST', body: {
    amount: 35, payment_code: 'BOUNDARY-01', payment_date: '2026-10-16', method: 'fake card', payment_status: 'pending'
  } });
  assert.equal(boundary.response.status, 201);
  const onEndDate = (await client.request('/api/memberships/summary?date=2026-10-16')).data;
  assert.equal(onEndDate.ended, 5);
  assert.equal(onEndDate.active, 11);
  const nextEndDate = (await client.request('/api/memberships/summary?date=2026-10-17')).data;
  assert.equal(nextEndDate.ended, 6);
  assert.equal(nextEndDate.active, 10);
}));

test('calendar anniversary handles leap day and December 31; 31-day and end-date counts are exact', async () => withClient(async (client) => {
  await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  const leap = await client.request('/api/memberships', { method: 'POST', body: {
    contact_id: 'C130', plan: 'individual', amount: 35, payment_code: 'LEAP-DAY-01', payment_date: '2028-02-29', method: 'fake cash', payment_status: 'paid'
  } });
  assert.equal(leap.data.end_date, '2029-02-28');
  const yearEnd = await client.request('/api/memberships', { method: 'POST', body: {
    contact_id: 'C129', plan: 'individual', amount: 35, payment_code: 'YEAR-END-01', payment_date: '2026-12-31', method: 'fake cash', payment_status: 'paid'
  } });
  assert.equal(yearEnd.data.end_date, '2027-12-31');
  client.db.prepare(`INSERT INTO memberships (id, contact_id, plan, price, start_date, end_date, payment_status, payment_code)
    VALUES ('M-BOUNDARY', 'C130', 'individual', 35, '2026-10-15', '2026-11-15', 'paid', 'BOUNDARY-31')`).run();
  const payment = client.db.prepare(`INSERT INTO membership_payments (membership_id, payment_code, amount, payment_date, method, status)
    VALUES ('M-BOUNDARY', 'BOUNDARY-31', 35, '2026-10-15', 'fake', 'paid')`).run();
  client.db.prepare('INSERT INTO membership_periods (membership_id, payment_id, start_date, end_date) VALUES (?, ?, ?, ?)')
    .run('M-BOUNDARY', payment.lastInsertRowid, '2026-10-15', '2026-11-15');
  const on31 = (await client.request('/api/memberships?date=2026-10-15')).data.find((item) => item.id === 'M-BOUNDARY');
  assert.equal(on31.status, 'active');
  assert.equal(on31.expiring, false);
  const on30 = (await client.request('/api/memberships?date=2026-10-16')).data.find((item) => item.id === 'M-BOUNDARY');
  assert.equal(on30.status, 'active');
  assert.equal(on30.expiring, true);
  assert.equal(on30.daysRemaining, 30);
  const onEnd = (await client.request('/api/memberships?date=2026-11-15')).data.find((item) => item.id === 'M-BOUNDARY');
  assert.equal(onEnd.status, 'ended');
}));

test('startup migration preserves legacy membership prices and coverage while adding payment history', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE households (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', household_id TEXT, tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', email_opt_in INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE memberships (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, household_id TEXT, plan TEXT NOT NULL, price REAL NOT NULL, start_date TEXT, end_date TEXT, payment_status TEXT NOT NULL, payment_code TEXT);
    INSERT INTO contacts (id,name) VALUES ('OLD-C1','Old fake contact');
    INSERT INTO memberships VALUES ('OLD-M1','OLD-C1',NULL,'family',39.5,'2025-12-31','2026-12-31','paid','OLD-PAY-1');`);
  initializeSchema(db);
  const membership = db.prepare('SELECT * FROM memberships WHERE id = ?').get('OLD-M1');
  assert.equal(membership.price, 39.5);
  assert.equal(membership.end_date, '2026-12-31');
  assert.equal(db.prepare('SELECT count(*) count FROM membership_payments WHERE payment_code = ?').get('OLD-PAY-1').count, 1);
  assert.equal(db.prepare('SELECT count(*) count FROM membership_periods WHERE membership_id = ?').get('OLD-M1').count, 1);
  db.close();
});

test('membership periods, payment details, counts, and change history persist across an app restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-membership-persist-'));
  const file = path.join(dir, 'memberships.sqlite');
  const first = await createClient({ file });
  try {
    await first.request('/api/import/practice-data', { method: 'POST', body: {} });
    const renewal = await first.request('/api/memberships/M101/renew', { method: 'POST', body: {
      amount: 40, payment_code: 'PERSIST-M101', payment_date: '2026-10-15', method: 'fake check', payment_status: 'paid'
    } });
    assert.equal(renewal.response.status, 201);
  } finally { await first.close(); }
  const second = await createClient({ file });
  try {
    const membership = (await second.request('/api/memberships?date=2026-10-15')).data.find((item) => item.id === 'M101');
    assert.equal(membership.periods.length, 2);
    assert.equal(membership.periods[1].payment_code, 'PERSIST-M101');
    assert.equal(membership.periods[1].method, 'fake check');
    assert.equal(membership.history[0].action, 'renewal payment');
    assert.equal(membership.history[0].actor_name, 'staff-demo');
    assert.equal((await second.request('/api/memberships/summary?date=2026-10-15')).data.endingSoon, 5);
  } finally { await second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('early and late renewal preserve prior periods, use the saved price, and reject duplicate payment codes', async () => {
  await withClient(async (client) => {
    await client.request('/api/import/practice-data', { method: 'POST', body: {} });
    const before = (await client.request('/api/memberships?date=2026-10-15')).data.find((item) => item.id === 'M101');
    const renewed = await client.request('/api/memberships/M101/renew', { method: 'POST', body: {
      amount: 40, payment_code: 'R-M101-01', payment_date: '2026-10-15', method: 'fake card', payment_status: 'paid'
    } });
    assert.equal(renewed.response.status, 201);
    assert.equal(renewed.data.start_date, '2026-10-31');
    assert.equal(renewed.data.end_date, '2027-10-31');
    const replay = await client.request('/api/memberships/M101/renew', { method: 'POST', body: {
      amount: 40, payment_code: 'R-M101-01', payment_date: '2026-10-15', method: 'fake card', payment_status: 'paid'
    } });
    assert.equal(replay.response.status, 409);
    const after = (await client.request('/api/memberships?date=2026-10-15')).data.find((item) => item.id === 'M101');
    assert.equal(after.periods.length, 2);
    assert.equal(after.payments.length, 2);
    assert.deepEqual(after.periods[0], before.periods[0]);
    const counts = (await client.request('/api/memberships/summary?date=2026-10-15')).data;
    assert.equal(counts.active, 12);
    assert.equal(counts.peopleCovered, 14);
    assert.equal(counts.endingSoon, 5);
  });
  await withClient(async (client) => {
    await client.request('/api/import/practice-data', { method: 'POST', body: {} });
    const renewed = await client.request('/api/memberships/M113/renew', { method: 'POST', body: {
      amount: 35, payment_code: 'R-M113-LATE', payment_date: '2026-10-15', method: 'fake check', payment_status: 'paid'
    } });
    assert.equal(renewed.response.status, 201);
    assert.equal(renewed.data.start_date, '2026-10-15');
    assert.equal(renewed.data.end_date, '2027-10-15');
    const details = (await client.request('/api/memberships?date=2026-10-15')).data.find((item) => item.id === 'M113');
    assert.equal(details.periods.length, 2);
    assert.equal(details.history[0].actor_name, 'staff-demo');
  });
});

test('new memberships validate plans, contacts, dates, amounts, and payment status before adding time', async () => withClient(async (client) => {
  await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  const dateError = await client.request('/api/memberships', { method: 'POST', body: {
    contact_id: 'C130', plan: 'individual', amount: 35, payment_code: 'BAD-DATE', payment_date: '2026-02-30', method: 'cash', payment_status: 'paid'
  } });
  assert.equal(dateError.response.status, 400);
  const amountError = await client.request('/api/memberships', { method: 'POST', body: {
    contact_id: 'C130', plan: 'individual', amount: 30, payment_code: 'BAD-AMOUNT', payment_date: '2026-10-15', method: 'cash', payment_status: 'paid'
  } });
  assert.equal(amountError.response.status, 400);
  const invalidContact = await client.request('/api/memberships', { method: 'POST', body: {
    contact_id: 'NO-SUCH-PERSON', plan: 'individual', amount: 35, payment_code: 'BAD-LINK', payment_date: '2026-10-15', method: 'cash', payment_status: 'paid'
  } });
  assert.equal(invalidContact.response.status, 400);
  const missingRenewal = await client.request('/api/memberships/M-NOPE/renew', { method: 'POST', body: {
    amount: 35, payment_code: 'NO-MEMBER', payment_date: '2026-10-15', method: 'cash', payment_status: 'paid'
  } });
  assert.equal(missingRenewal.response.status, 404);
  const created = await client.request('/api/memberships', { method: 'POST', body: {
    contact_id: 'C130', plan: 'individual', amount: 35, payment_code: 'NEW-C130-01', payment_date: '2026-10-15', method: 'fake card', payment_status: 'paid'
  } });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.end_date, '2027-10-15');
  const summary = (await client.request('/api/memberships/summary?date=2026-10-15')).data;
  assert.deepEqual({ active: summary.active, endingSoon: summary.endingSoon, peopleCovered: summary.peopleCovered }, { active: 13, endingSoon: 6, peopleCovered: 15 });
  assert.equal(client.db.prepare("SELECT count(*) count FROM membership_payments WHERE payment_code IN ('BAD-DATE','BAD-AMOUNT','BAD-LINK','NO-MEMBER')").get().count, 0);
}));

test('failed and pending payments do not extend paid coverage; replay and invalid payment leave records unchanged', async () => withClient(async (client) => {
  await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  for (const [code, status] of [['FAIL-M101', 'failed'], ['WAIT-M101', 'pending']]) {
    const result = await client.request('/api/memberships/M101/renew', { method: 'POST', body: {
      amount: 40, payment_code: code, payment_date: '2026-10-20', method: 'fake card', payment_status: status
    } });
    assert.equal(result.response.status, 201);
    assert.equal(result.data.start_date, null);
  }
  const bad = await client.request('/api/memberships/M101/renew', { method: 'POST', body: {
    amount: 41, payment_code: 'WRONG-AMOUNT', payment_date: '2026-10-20', method: 'fake card', payment_status: 'paid'
  } });
  assert.equal(bad.response.status, 400);
  const membership = (await client.request('/api/memberships?date=2026-10-15')).data.find((item) => item.id === 'M101');
  assert.equal(membership.periods.length, 1);
  assert.equal(membership.periods[0].end_date, '2026-10-31');
  assert.equal(membership.payments.length, 3);
  assert.equal((await client.request('/api/memberships/summary?date=2026-10-15')).data.active, 12);
}));

test('family memberships count each linked person once and preserve date, payment, and history details', async () => withClient(async (client) => {
  await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  for (const id of ['F900-1', 'F900-2', 'F900-3']) {
    const contact = await addContact(client, { id, name: `Fake family ${id}`, email: '', household_id: 'H900', household_name: 'Fake family test' });
    assert.equal(contact.response.status, 201);
  }
  const membership = await client.request('/api/memberships', { method: 'POST', body: {
    contact_id: 'F900-1', household_id: 'H900', plan: 'family', amount: 40, payment_code: 'FAMILY-H900', payment_date: '2026-10-15', method: 'fake check', payment_status: 'paid'
  } });
  assert.equal(membership.response.status, 201);
  const summary = (await client.request('/api/memberships/summary?date=2026-10-15')).data;
  assert.equal(summary.peopleCovered, 17);
  const detail = (await client.request('/api/memberships?date=2026-10-15')).data.find((item) => item.id === membership.data.id);
  assert.equal(detail.household_id, 'H900');
  assert.equal(detail.periods[0].payment_code, 'FAMILY-H900');
  assert.equal(detail.history[0].action, 'add');
}));

test('only admins change plan prices; historical paid prices remain fixed and audit records the actor', async () => withClient(async (staff) => {
  await staff.request('/api/import/practice-data', { method: 'POST', body: {} });
  const viewer = await staff.loginAs('viewer-demo', 'ViewerDemo2026!');
  const admin = await staff.loginAs('admin-demo', 'AdminDemo2026!');
  const patch = async (cookie, price) => fetch(`${staff.baseUrl}/api/admin/membership-plans/individual`, { method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ price }) });
  assert.equal((await patch(staff.cookie, 45)).status, 403);
  assert.equal((await patch(viewer.cookie, 45)).status, 403);
  const viewerWrite = await fetch(`${staff.baseUrl}/api/memberships/M101/renew`, { method: 'POST', headers: { cookie: viewer.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 40, payment_code: 'VIEWER-RENEW', payment_date: '2026-10-15', method: 'fake', payment_status: 'paid' }) });
  assert.equal(viewerWrite.status, 403);
  const changed = await patch(admin.cookie, 45);
  assert.equal(changed.status, 200);
  const oldMembership = (await staff.request('/api/memberships?date=2026-10-15')).data.find((item) => item.id === 'M103');
  assert.equal(oldMembership.price, 35);
  const renewal = await staff.request('/api/memberships/M103/renew', { method: 'POST', body: {
    amount: 35, payment_code: 'SAVED-PRICE-RENEW', payment_date: '2026-10-15', method: 'fake cash', payment_status: 'paid'
  } });
  assert.equal(renewal.response.status, 201);
  const audited = (await staff.request('/api/audit')).data.find((item) => item.record_type === 'membership plan');
  assert.equal(audited.actor_name, 'admin-demo');
  assert.equal(audited.action, 'change plan price');
}));

test('donation import totals exclude membership fees; void keeps D002 in history and filters include both date boundaries', async () => withClient(async (client) => {
  await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  const all = await client.request('/api/donations?from=2026-10-01&to=2026-10-10');
  assert.deepEqual(all.data.summary, { count: 20, total: 355 });
  assert.equal((await client.request('/api/donations?campaign=Campaign%20A&from=2026-10-01&to=2026-10-10')).data.summary.total, 155);
  assert.equal((await client.request('/api/donations?campaign=Campaign%20B&from=2026-10-01&to=2026-10-10')).data.summary.total, 200);
  const invalid = await client.request('/api/donations', { method: 'POST', body: { contact_id: 'C101', amount: 0, date: '2026-10-15', campaign: 'Campaign B', method: 'cash', payment_code: 'INVALID' } });
  assert.equal(invalid.response.status, 400);
  assert.equal((await client.request('/api/donations')).data.donations.length, 20);
  assert.equal((await client.request('/api/donations?from=2026-10-15&to=2026-10-15')).data.summary.total, 0);
  const voided = await client.request('/api/donations/D002/void', { method: 'POST', body: {} });
  assert.equal(voided.response.status, 200);
  const history = (await client.request('/api/donations')).data.donations.find((item) => item.id === 'D002');
  assert.equal(history.voided, 1);
  assert.equal(history.voided_by, 'staff-demo');
  assert.ok(history.voided_at);
  assert.equal((await client.request('/api/donations')).data.donations.length, 20);
  assert.equal((await client.request('/api/donations')).data.summary.total, 330);
  assert.equal((await client.request('/api/donations?campaign=Campaign%20A')).data.summary.total, 130);
  assert.equal((await client.request('/api/donations?campaign=Campaign%20B')).data.summary.total, 200);
  const added = await client.request('/api/donations', { method: 'POST', body: { contact_id: 'C121', amount: 12, date: '2026-10-15', campaign: 'Campaign B', method: 'fake cash', payment_code: 'PRACTICE-ADD-12' } });
  assert.equal(added.response.status, 201);
  assert.equal((await client.request('/api/donations?campaign=Campaign%20B&from=2026-10-15&to=2026-10-15')).data.summary.total, 12);
  assert.equal((await client.request('/api/donations')).data.summary.total, 342);
  const duplicate = await client.request('/api/donations', { method: 'POST', body: { contact_id: 'C121', amount: 12, date: '2026-10-15', campaign: 'Campaign B', method: 'cash', payment_code: 'PRACTICE-ADD-12' } });
  assert.equal(duplicate.response.status, 409);
  assert.equal((await client.request('/api/donations')).data.donations.length, 21);
  const thankYou = (await client.request('/api/tasks?date=2026-10-15')).data.tasks.find((task) => task.source_key === `donation:${added.data.id}:thank-you`);
  assert.equal(thankYou.due_date, '2026-10-22');
  assert.equal(thankYou.owner, 'staff-demo');
  await client.request(`/api/donations/${added.data.id}/void`, { method: 'POST', body: {} });
  const cancelled = (await client.request('/api/tasks?date=2026-10-15')).data.tasks.find((task) => task.id === thankYou.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok((await client.request('/api/audit')).data.some((entry) => entry.record_type === 'donation' && entry.record_id === 'D002' && entry.action === 'void'));
}));

test('manual task baseline and completion update counts and overdue status against the chosen date', async () => withClient(async (client) => {
  await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  const baseline = (await client.request('/api/tasks?date=2026-10-15')).data;
  assert.equal(baseline.counts.total, 15);
  assert.equal(baseline.counts.complete, 5);
  assert.equal(baseline.counts.open, 10);
  assert.equal(baseline.counts.overdue, 6);
  const completed = await client.request('/api/tasks/T006/complete', { method: 'POST', body: {} });
  assert.equal(completed.response.status, 200);
  const after = (await client.request('/api/tasks?date=2026-10-15')).data;
  assert.equal(after.counts.complete, 6);
  assert.equal(after.counts.open, 9);
  assert.equal(after.counts.overdue, 5);
  assert.equal(after.tasks.find((task) => task.id === 'T006').status, 'complete');
  await client.request('/api/tasks/T007/cancel', { method: 'POST', body: {} });
  const afterCancel = (await client.request('/api/tasks?date=2026-10-15')).data;
  assert.equal(afterCancel.counts.overdue, 4);
  assert.equal(afterCancel.tasks.find((task) => task.id === 'T007').status, 'cancelled');
  assert.ok((await client.request('/api/audit')).data.some((entry) => entry.record_type === 'task' && entry.record_id === 'T006' && entry.action === 'complete'));
}));

test('follow-up jobs are deduplicated and seeded practice records do not create welcome or thank-you jobs', async () => withClient(async (client) => {
  await client.request('/api/import/practice-data', { method: 'POST', body: {} });
  await client.request('/api/tasks/ensure-followups', { method: 'POST', body: { date: '2026-10-15' } });
  await client.request('/api/tasks/ensure-followups', { method: 'POST', body: { date: '2026-10-15' } });
  let tasks = (await client.request('/api/tasks?date=2026-10-15')).data.tasks;
  assert.equal(tasks.filter((task) => task.type === 'manual').length, 15);
  assert.equal(tasks.filter((task) => task.type === 'Renewal').length, 6);
  assert.equal(tasks.filter((task) => ['Welcome', 'Thank-you'].includes(task.type)).length, 0);
  const membership = await client.request('/api/memberships', { method: 'POST', body: { contact_id: 'C130', plan: 'individual', amount: 35, payment_code: 'WELCOME-ONLY-ONCE', payment_date: '2026-10-15', method: 'fake cash', payment_status: 'paid' } });
  assert.equal(membership.response.status, 201);
  tasks = (await client.request('/api/tasks?date=2026-10-15')).data.tasks;
  const welcome = tasks.filter((task) => task.source_key === `membership:${membership.data.id}:welcome`);
  assert.equal(welcome.length, 1);
  assert.equal(welcome[0].due_date, '2026-10-15');
  assert.equal(welcome[0].owner, 'staff-demo');
  const another = await client.request('/api/memberships', { method: 'POST', body: { id: membership.data.id, contact_id: 'C130', plan: 'individual', amount: 35, payment_code: 'WELCOME-DUPE', payment_date: '2026-10-15', method: 'fake cash', payment_status: 'paid' } });
  assert.equal(another.response.status, 409);
  assert.equal((await client.request('/api/tasks?date=2026-10-15')).data.tasks.filter((task) => task.source_key === welcome[0].source_key).length, 1);
}));

test('viewers cannot change donations, tasks, or backup data; admin restore creates a separate SQLite copy', async () => {
  const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-restore-test-'));
  const previousDir = process.env.CRM_RESTORE_DIR;
  process.env.CRM_RESTORE_DIR = restoreDir;
  try {
    await withClient(async (staff) => {
      await staff.request('/api/import/practice-data', { method: 'POST', body: {} });
      const viewer = await staff.loginAs('viewer-demo', 'ViewerDemo2026!');
      const admin = await staff.loginAs('admin-demo', 'AdminDemo2026!');
      const bodyRequest = async (cookie, route, body = {}) => fetch(`${staff.baseUrl}${route}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal((await fetch(`${staff.baseUrl}/api/admin/backup`, { headers: { cookie: staff.cookie } })).status, 403);
      assert.equal((await bodyRequest(viewer.cookie, '/api/admin/restore', { format: 'nope' })).status, 403);
      const before = staff.db.prepare('SELECT COUNT(*) AS count FROM donations').get().count;
      const beforeAudit = staff.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count;
      assert.equal((await bodyRequest(viewer.cookie, '/api/donations/D001/void')).status, 403);
      assert.equal((await bodyRequest(viewer.cookie, '/api/tasks/T006/complete')).status, 403);
      assert.equal((await bodyRequest(viewer.cookie, '/api/tasks', { contact_id: 'C101', type: 'manual', title: 'blocked', owner: 'viewer', due_date: '2026-10-15' })).status, 403);
      assert.equal(staff.db.prepare('SELECT COUNT(*) AS count FROM donations').get().count, before);
      assert.equal(staff.db.prepare("SELECT status FROM tasks WHERE id = 'T006'").get().status, 'open');
      assert.equal(staff.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, beforeAudit);
      const backupResponse = await fetch(`${staff.baseUrl}/api/admin/backup`, { headers: { cookie: admin.cookie } });
      assert.equal(backupResponse.status, 200);
      const backup = await backupResponse.json();
      assert.equal(backup.tables.donations.length, 20);
      assert.equal(backup.tables.tasks.length, 21);
      assert.equal(backup.tables.tasks.filter((task) => task.type === 'manual').length, 15);
      const originalAuditCount = staff.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count;
      const restoredResponse = await bodyRequest(admin.cookie, '/api/admin/restore', backup);
      assert.equal(restoredResponse.status, 201);
      const restored = await restoredResponse.json();
      assert.ok(fs.existsSync(restored.file));
      const restoredDb = new Database(restored.file);
      assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM contacts').get().count, 30);
      assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM memberships').get().count, 20);
      assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM donations').get().count, 20);
      assert.equal(restoredDb.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 21);
      assert.equal(restoredDb.prepare("SELECT contact_id FROM donations WHERE id='D002'").get().contact_id, 'C101');
      assert.deepEqual(restoredDb.prepare("SELECT amount, date, campaign FROM donations WHERE id='D002'").get(), { amount: 25, date: '2026-10-02', campaign: 'Campaign A' });
      assert.equal(restoredDb.prepare("SELECT status FROM tasks WHERE id='T006'").get().status, 'open');
      assert.equal(restoredDb.prepare("SELECT action FROM audit_events WHERE record_type='backup'").get().action, 'restore to separate copy');
      restoredDb.close();
      assert.equal(staff.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, originalAuditCount);
      assert.equal(staff.db.prepare('SELECT COUNT(*) AS count FROM donations').get().count, 20);
    });
  } finally {
    if (previousDir === undefined) delete process.env.CRM_RESTORE_DIR; else process.env.CRM_RESTORE_DIR = previousDir;
    fs.rmSync(restoreDir, { recursive: true, force: true });
  }
});

test('previous eight-menu structure remains and the unfinished CRM screens are still labeled honestly', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const links = [...html.matchAll(/<a class="nav-link" href="#([^"]+)" data-screen="([^"]+)">/g)];
  assert.equal(links.length, 8);
  for (const [, hash, screen] of links) assert.equal(hash, screen);
  for (const screen of ['reports']) {
    const section = html.match(new RegExp(`<section class="screen placeholder-screen" id="screen-${screen}"[\\s\\S]*?<\\/section>`))?.[0] || '';
    assert.match(section, /Not built yet/);
  }
  assert.match(html, /id="add-membership" type="button" hidden/);
  assert.match(html, /id="membership-plan-editor" hidden/);
  assert.match(html, /id="donation-form"/);
  assert.match(html, /id="task-form"/);
  assert.match(html, /id="backup-tools" hidden/);
  assert.match(app, /function roleCanWrite\(\) \{ return currentUser && \['admin', 'staff'\]\.includes\(currentUser\.role\); \}/);
  assert.match(app, /user\.role !== 'admin'/);
  assert.match(app, /roleCanWrite\(\) \? `<button class="secondary-button renew-membership"/);
});
