const express = require('express');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataPath = path.join(__dirname, 'data', 'crm-classroom-test-data.json');
const db = new Database(path.join(__dirname, 'data', 'crm.sqlite'));

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS households (id TEXT PRIMARY KEY, name TEXT NOT NULL, contact_ids TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    household_id TEXT, tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',
    email_opt_in INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (household_id) REFERENCES households(id)
  );
  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, household_id TEXT, plan TEXT NOT NULL, price REAL NOT NULL,
    start_date TEXT, end_date TEXT, payment_status TEXT NOT NULL, payment_code TEXT,
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
  );
  CREATE TABLE IF NOT EXISTS donations (
    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL,
    campaign TEXT NOT NULL DEFAULT '', method TEXT NOT NULL DEFAULT '', payment_code TEXT,
    thank_you_sent INTEGER NOT NULL DEFAULT 0, voided INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '', due_date TEXT, status TEXT NOT NULL,
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
  );
`);

function seedDatabase() {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  db.transaction(() => {
    const addHousehold = db.prepare('INSERT OR IGNORE INTO households (id, name, contact_ids) VALUES (?, ?, ?)');
    const addContact = db.prepare(`INSERT OR IGNORE INTO contacts
      (id, name, email, phone, household_id, tags, notes, email_opt_in, archived)
      VALUES (@id, @name, @email, @phone, @household_id, @tags, @notes, @email_opt_in, @archived)`);
    const addMembership = db.prepare(`INSERT OR IGNORE INTO memberships
      (id, contact_id, household_id, plan, price, start_date, end_date, payment_status, payment_code)
      VALUES (@id, @contact_id, @household_id, @plan, @price, @start_date, @end_date, @payment_status, @payment_code)`);
    const addDonation = db.prepare(`INSERT OR IGNORE INTO donations
      (id, contact_id, amount, date, campaign, method, payment_code, thank_you_sent, voided)
      VALUES (@id, @contact_id, @amount, @date, @campaign, @method, @payment_code, @thank_you_sent, @voided)`);
    const addTask = db.prepare(`INSERT OR IGNORE INTO tasks (id, contact_id, type, title, owner, due_date, status)
      VALUES (@id, @contact_id, @type, @title, @owner, @due_date, @status)`);
    for (const household of data.households || []) addHousehold.run(household.id, household.name, JSON.stringify(household.contact_ids || []));
    for (const contact of data.contacts || []) addContact.run({
      ...contact, email: contact.email || '', phone: contact.phone || '', household_id: contact.household_id || null,
      tags: JSON.stringify(contact.tags || []), notes: contact.notes || '',
      email_opt_in: contact.email_opt_in ? 1 : 0, archived: contact.archived ? 1 : 0
    });
    for (const membership of data.memberships || []) addMembership.run(membership);
    for (const donation of data.donations || []) addDonation.run({ ...donation, thank_you_sent: donation.thank_you_sent ? 1 : 0, voided: donation.voided ? 1 : 0 });
    for (const task of data.tasks || []) addTask.run(task);
  })();
}

if (db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count === 0) seedDatabase();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/overview', (_req, res) => {
  const today = JSON.parse(fs.readFileSync(dataPath, 'utf8')).test_date;
  const contactCount = db.prepare('SELECT COUNT(*) AS count FROM contacts WHERE archived = 0').get().count;
  const householdCount = db.prepare('SELECT COUNT(*) AS count FROM households').get().count;
  const donations = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM donations WHERE voided = 0').get();
  const activeMemberships = db.prepare(`SELECT COUNT(*) AS count FROM memberships
    WHERE payment_status = 'paid' AND start_date <= ? AND end_date >= ?`).get(today, today).count;
  const overdueTasks = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'open' AND due_date < ?").get(today).count;
  const recentDonations = db.prepare(`SELECT d.id, d.amount, d.date, d.campaign, c.name AS contact_name
    FROM donations d JOIN contacts c ON c.id = d.contact_id WHERE d.voided = 0
    ORDER BY d.date DESC, d.id DESC LIMIT 5`).all();
  res.json({ testDate: today, contactCount, householdCount, donationCount: donations.count,
    donationTotal: donations.total, activeMemberships, overdueTasks, recentDonations });
});

app.get('/api/contacts', (req, res) => {
  const search = `%${String(req.query.search || '').trim()}%`;
  const contacts = db.prepare(`SELECT c.id, c.name, c.email, c.phone, c.household_id, c.tags, c.email_opt_in,
      h.name AS household_name,
      (SELECT COUNT(*) FROM donations d WHERE d.contact_id = c.id AND d.voided = 0) AS donation_count,
      (SELECT COALESCE(SUM(d.amount), 0) FROM donations d WHERE d.contact_id = c.id AND d.voided = 0) AS giving_total
    FROM contacts c LEFT JOIN households h ON h.id = c.household_id
    WHERE c.archived = 0 AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.id LIKE ?)
    ORDER BY c.name COLLATE NOCASE LIMIT 100`).all(search, search, search, search)
    .map((contact) => ({ ...contact, tags: JSON.parse(contact.tags) }));
  res.json(contacts);
});

app.post('/api/contacts', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const id = `C-${Date.now().toString(36).toUpperCase()}`;
  db.prepare(`INSERT INTO contacts (id, name, email, phone, tags, notes, email_opt_in)
    VALUES (?, ?, ?, ?, '[]', '', 0)`).run(id, name, email, phone);
  res.status(201).json({ id, name, email, phone, household_id: null, household_name: null,
    tags: [], email_opt_in: 0, donation_count: 0, giving_total: 0 });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong while loading the CRM.' });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Advanced Studies CRM running at http://localhost:${port}`);
  console.log(`Loaded ${db.prepare('SELECT COUNT(*) AS count FROM contacts WHERE archived = 0').get().count} classroom contacts.`);
});
