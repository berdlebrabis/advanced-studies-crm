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

test('previous eight-menu structure remains and the unfinished CRM screens are still labeled honestly', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const links = [...html.matchAll(/<a class="nav-link" href="#([^"]+)" data-screen="([^"]+)">/g)];
  assert.equal(links.length, 8);
  for (const [, hash, screen] of links) assert.equal(hash, screen);
  for (const screen of ['memberships', 'donations', 'tasks', 'reports']) {
    const section = html.match(new RegExp(`<section class="screen placeholder-screen" id="screen-${screen}"[\\s\\S]*?<\\/section>`))?.[0] || '';
    assert.match(section, /Not built yet/);
  }
});

