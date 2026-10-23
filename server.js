const express = require('express');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const referencePath = path.join(root, 'data', 'crm-classroom-test-data.json');
const databasePath = process.env.CRM_DB_PATH || path.join(root, 'data', 'crm.sqlite');

function readReferenceData() {
  return JSON.parse(fs.readFileSync(referencePath, 'utf8'));
}

function initializeSchema(db) {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      household_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      email_opt_in INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (household_id) REFERENCES households(id)
    );
    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      household_id TEXT,
      plan TEXT NOT NULL,
      price REAL NOT NULL,
      start_date TEXT,
      end_date TEXT,
      payment_status TEXT NOT NULL,
      payment_code TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
    CREATE TABLE IF NOT EXISTS donations (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      campaign TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL DEFAULT '',
      payment_code TEXT,
      thank_you_sent INTEGER NOT NULL DEFAULT 0,
      voided INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      status TEXT NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
  `);
}

function createApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(root, 'public')));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/overview', (_req, res) => {
    const today = readReferenceData().test_date;
    const activePeople = db.prepare('SELECT COUNT(*) AS count FROM contacts WHERE archived = 0').get().count;
    const activeMemberships = db.prepare(`SELECT COUNT(*) AS count FROM memberships
      WHERE payment_status = 'paid' AND start_date <= ? AND end_date >= ?`).get(today, today).count;
    const donation = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM donations WHERE voided = 0').get();
    const renewalDue = db.prepare(`SELECT COUNT(*) AS count FROM memberships
      WHERE payment_status = 'paid' AND end_date >= ? AND end_date <= date(?, '+30 days')`).get(today, today).count;
    const overdueTasks = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'open' AND due_date < ?").get(today).count;
    res.json({ testDate: today, activePeople, activeMemberships, donationCount: donation.count,
      donationTotal: donation.total, renewalsDue: renewalDue, overdueTasks });
  });

  app.get('/api/households/options', (_req, res) => {
    const households = readReferenceData().households.map(({ id, name }) => ({ id, name }));
    res.json(households);
  });

  app.get('/api/contacts', (req, res) => {
    const query = String(req.query.search || '').trim();
    const pattern = `%${query}%`;
    const contacts = db.prepare(`SELECT c.id, c.name, c.email, c.phone, c.household_id, c.tags, c.notes,
        c.email_opt_in, h.name AS household_name
      FROM contacts c LEFT JOIN households h ON h.id = c.household_id
      WHERE c.archived = 0 AND (? = '' OR c.id LIKE ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE OR c.email LIKE ? COLLATE NOCASE)
      ORDER BY c.name COLLATE NOCASE`).all(query, pattern, pattern, pattern)
      .map((contact) => ({ ...contact, tags: JSON.parse(contact.tags), email_opt_in: Boolean(contact.email_opt_in) }));
    res.json(contacts);
  });

  app.get('/api/contacts/:id', (req, res) => {
    const contact = db.prepare(`SELECT c.id, c.name, c.email, c.phone, c.household_id, c.tags, c.notes,
        c.email_opt_in, h.name AS household_name
      FROM contacts c LEFT JOIN households h ON h.id = c.household_id
      WHERE c.id = ? AND c.archived = 0`).get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found.' });
    const memberships = db.prepare('SELECT * FROM memberships WHERE contact_id = ? ORDER BY start_date DESC').all(contact.id);
    const donations = db.prepare('SELECT * FROM donations WHERE contact_id = ? ORDER BY date DESC').all(contact.id);
    const tasks = db.prepare('SELECT * FROM tasks WHERE contact_id = ? ORDER BY due_date').all(contact.id);
    res.json({ ...contact, tags: JSON.parse(contact.tags), email_opt_in: Boolean(contact.email_opt_in), memberships, donations, tasks });
  });

  app.post('/api/contacts', (req, res) => {
    const id = String(req.body.id || '').trim();
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    const phone = String(req.body.phone || '').trim();
    const householdId = String(req.body.household_id || '').trim() || null;
    const notes = String(req.body.notes || '').trim();
    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : String(req.body.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
    const emailOptIn = req.body.email_opt_in === true || req.body.email_opt_in === 'true' || req.body.email_opt_in === 'on';

    if (!id) return res.status(400).json({ error: 'Enter a contact ID.' });
    if (!name) return res.status(400).json({ error: 'Enter a name.' });
    if (db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(id)) {
      return res.status(409).json({ error: 'A contact with that ID already exists.' });
    }
    const householdReference = householdId
      ? readReferenceData().households.find((household) => household.id === householdId)
      : null;
    if (householdId && !householdReference) return res.status(400).json({ error: 'Choose a valid household.' });

    const save = db.transaction(() => {
      if (householdReference) {
        db.prepare('INSERT OR IGNORE INTO households (id, name) VALUES (?, ?)')
          .run(householdReference.id, householdReference.name);
      }
      db.prepare(`INSERT INTO contacts (id, name, email, phone, household_id, tags, notes, email_opt_in)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, name, email, phone, householdId, JSON.stringify(tags), notes, emailOptIn ? 1 : 0
        );
    });
    try {
      save();
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'A contact with that ID already exists.' });
      }
      throw error;
    }
    const householdName = householdReference?.name || null;
    res.status(201).json({ id, name, email, phone, household_id: householdId,
      household_name: householdName, tags, notes, email_opt_in: emailOptIn });
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong while loading the CRM.' });
  });
  return app;
}

if (require.main === module) {
  const db = new Database(databasePath);
  initializeSchema(db);
  const app = createApp(db);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '127.0.0.1', () => {
    console.log(`Advanced Studies CRM running at http://localhost:${port}`);
    console.log(`${db.prepare('SELECT COUNT(*) AS count FROM contacts WHERE archived = 0').get().count} saved contacts.`);
  });
}

module.exports = { createApp, initializeSchema, readReferenceData };
