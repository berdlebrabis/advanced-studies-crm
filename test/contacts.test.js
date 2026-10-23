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

async function postContact(body) {
  return fetch(`${await baseUrl}/api/contacts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
}

 test('search is case-insensitive and no matches return an empty list', async () => {
  addFixtureContacts();
  for (const search of ['Alex', 'ALEX']) {
    const result = await fetch(`${await baseUrl}/api/contacts?search=${search}`).then((r) => r.json());
    assert.equal(result[0]?.id, 'C101');
  }
  const none = await fetch(`${await baseUrl}/api/contacts?search=Nobody`).then((r) => r.json());
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
