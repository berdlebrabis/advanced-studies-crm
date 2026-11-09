const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createApp, initializeSchema, readReferenceData } = require('../server');

const db = new Database(':memory:');
initializeSchema(db);
const server = createApp(db).listen(0, '127.0.0.1');
const baseUrl = new Promise((resolve) => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
after(() => { server.close(); db.close(); });

function addFixtureContacts() {
  const insertHousehold = db.prepare('INSERT OR IGNORE INTO households (id, name) VALUES (?, ?)');
  const insertContact = db.prepare(`INSERT INTO contacts (id, name, email, phone, household_id, tags, notes, email_opt_in)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const reference = readReferenceData();
  const tx = db.transaction(() => {
    for (const contact of reference.contacts.slice(0, 5)) {
      const household = reference.households.find((item) => item.id === contact.household_id);
      insertHousehold.run(household.id, household.name);
      insertContact.run(contact.id, contact.name, contact.email, contact.phone, contact.household_id,
        JSON.stringify(contact.tags), contact.notes, contact.email_opt_in ? 1 : 0);
    }
  });
  tx();
}

let cookie;
async function signIn() {
 const r=await fetch(`${await baseUrl}/api/sign-in`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'staff-demo',password:'demo-staff'})});
 assert.equal(r.status,200);
 cookie=r.headers.get('set-cookie').split(';')[0];
}
async function postContact(body) {
 if(!cookie) await signIn();
  return fetch(`${await baseUrl}/api/contacts`, {
    method: 'POST', headers: { 'content-type': 'application/json',cookie }, body: JSON.stringify(body)
  });
}

 test('search is case-insensitive and no matches return an empty list', async () => {
  await signIn();
  addFixtureContacts();
  for (const search of ['Alex', 'ALEX']) {
    const result = await fetch(`${await baseUrl}/api/contacts?search=${search}`,{headers:{cookie}}).then((r) => r.json());
    assert.equal(result[0]?.id, 'C101');
  }
  const none = await fetch(`${await baseUrl}/api/contacts?search=Nobody`,{headers:{cookie}}).then((r) => r.json());
  assert.deepEqual(none, []);
});

test('blank and spaces-only names are rejected without changing five contacts or creating a household', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count, 5);
  const householdsBefore = db.prepare('SELECT COUNT(*) AS count FROM households').get().count;
  for (const name of ['', '   ']) {
    const response = await postContact({ id: 'C900', name, email: 'blank.test@example.com', household_id: 'H105' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Enter a name.');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM households').get().count, householdsBefore);
});

test('one valid contact save creates one sixth contact', async () => {
  const response = await postContact({ id: 'C900', name: 'Test Builder', email: 'blank.test@example.com' });
  assert.equal(response.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count, 6);
});

test('duplicate contact ID returns a useful conflict and does not change count', async () => {
  const before = db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count;
  const response = await postContact({ id: 'C101', name: 'Another Alex' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'A contact with that ID already exists.');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count, before);
});

test('contact form errors are announced assertively to assistive technology', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="form-message" role="alert" aria-live="assertive" aria-atomic="true"/);
});

test('the eight menu destinations match titled screens and unfinished screens stay honest', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const links = [...html.matchAll(/<a class="nav-link" href="#([^"]+)" data-screen="([^"]+)">([\s\S]*?)<\/a>/g)];
  assert.equal(links.length, 8);
  const screenTitles = {
    dashboard: 'Dashboard', contacts: 'Contacts', 'contact-details': 'Contact Details',
    memberships: 'Memberships', donations: 'Donations', tasks: 'Tasks',
    reports: 'Reports', settings: 'Login / Settings'
  };
  for (const [, hash, screen] of links) {
    assert.equal(hash, screen);
    assert.ok(screenTitles[screen]);
    assert.ok(html.includes(`id="screen-${screen}" data-title="${screenTitles[screen]}"`));
  }
  assert.match(appJs, /link\.addEventListener\('click',\s*\(\)\s*=>\s*setScreen\(link\.dataset\.screen\)\)/);
  for (const screen of ['memberships', 'donations', 'tasks', 'reports']) {
    const section = html.match(new RegExp(`<section class="screen placeholder-screen" id="screen-${screen}"[\\s\\S]*?<\\/section>`))?.[0] ?? '';
    assert.match(section, /Not built yet/);
  }
  assert.match(html, /No sample totals are shown here/);
});

test('every contact form control has a visible label and keyboard focus styling', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const controls = ['contact-id', 'contact-name', 'contact-email', 'contact-phone',
    'contact-household', 'contact-tags', 'contact-notes', 'contact-email-opt-in'];
  for (const id of controls) assert.match(html, new RegExp(`<label[^>]*for="${id}"`));
  assert.match(html, /<button[^>]*id="cancel-contact"[^>]*>Cancel<\/button>/);
  assert.match(html, /<button[^>]*type="submit"[^>]*>Save<\/button>/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid/);
});

test('viewer cannot write and editing preserves the ID and other records', async () => {
 const login=await fetch(`${await baseUrl}/api/sign-in`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'viewer-demo',password:'demo-viewer'})});
 const viewerCookie=login.headers.get('set-cookie').split(';')[0];
 const forbidden=await fetch(`${await baseUrl}/api/contacts/C101`,{method:'PUT',headers:{'content-type':'application/json',cookie:viewerCookie},body:JSON.stringify({name:'Changed'})});
 assert.equal(forbidden.status,403);
 const edited=await fetch(`${await baseUrl}/api/contacts/C101`,{method:'PUT',headers:{'content-type':'application/json',cookie},body:JSON.stringify({name:'  Alex Updated  ',phone:'555-9999',email_opt_in:false})});
 assert.equal(edited.status,200);
 assert.equal(db.prepare('SELECT name FROM contacts WHERE id=?').get('C101').name,'Alex Updated');
 assert.equal(db.prepare('SELECT name FROM contacts WHERE id=?').get('C102').name,readReferenceData().contacts[1].name);
});
test('archive hides a contact but keeps its stored details and records audit actor',async()=>{
 const r=await fetch(`${await baseUrl}/api/contacts/C101/archive`,{method:'POST',headers:{cookie}});
 assert.equal(r.status,200);
 assert.equal(db.prepare('SELECT archived FROM contacts WHERE id=?').get('C101').archived,1);
 assert.equal(db.prepare('SELECT actor FROM audit_log ORDER BY id DESC LIMIT 1').get().actor,'staff-demo');
});
test('invalid and duplicate emails cannot be saved',async()=>{
 assert.equal((await postContact({id:'C950',name:'Invalid',email:'bad-email'})).status,400);
 assert.equal((await postContact({id:'C951',name:'Duplicate',email:'PERSON101@EXAMPLE.COM'})).status,409);
});
