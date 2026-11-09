const express = require('express');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
const referencePath = path.join(root, 'data', 'crm-classroom-test-data.json');
const practicePath = path.join(root, 'data', 'client-data-1', 'data', 'crm-classroom-test-data.json');
const databasePath = process.env.CRM_DB_PATH || path.join(root, 'data', 'crm.sqlite');
const DEMO_USERS = [
  { username: 'admin-demo', role: 'admin', password: 'AdminDemo2026!' },
  { username: 'staff-demo', role: 'staff', password: 'StaffDemo2026!' },
  { username: 'viewer-demo', role: 'viewer', password: 'ViewerDemo2026!' }
];
const SESSION_DAYS = 7;

function readReferenceData() {
  return JSON.parse(fs.readFileSync(fs.existsSync(practicePath) ? practicePath : referencePath, 'utf8'));
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const [algorithm, salt, expected] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function ensureColumn(db, table, column, declaration) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
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
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, household_id TEXT, plan TEXT NOT NULL,
      price REAL NOT NULL, start_date TEXT, end_date TEXT, payment_status TEXT NOT NULL, payment_code TEXT,
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
    CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES app_users(id),
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  ensureColumn(db, 'contacts', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_unique_ci ON contacts(lower(trim(email))) WHERE trim(email) <> ''");
  db.exec('CREATE INDEX IF NOT EXISTS contacts_household_idx ON contacts(household_id)');
  db.exec('CREATE INDEX IF NOT EXISTS audit_record_idx ON audit_events(record_type, record_id, id DESC)');

  const insertUser = db.prepare('INSERT OR IGNORE INTO app_users (username, role, password_hash) VALUES (?, ?, ?)');
  const seedUsers = db.transaction(() => {
    for (const user of DEMO_USERS) insertUser.run(user.username, user.role, passwordHash(user.password));
  });
  seedUsers();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted && char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((item) => item.trim() !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((item) => item.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map((item) => item.trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function cleanContact(input) {
  const clean = (value) => String(value ?? '').trim();
  const tags = Array.isArray(input.tags)
    ? input.tags.map(clean).filter(Boolean)
    : clean(input.tags).split(',').map((tag) => tag.trim()).filter(Boolean);
  const consent = input.email_opt_in;
  let emailOptIn = false;
  if (typeof consent === 'boolean') emailOptIn = consent;
  else if (['true', 'yes', '1', 'on'].includes(clean(consent).toLowerCase())) emailOptIn = true;
  else if (['false', 'no', '0', '', 'off'].includes(clean(consent).toLowerCase())) emailOptIn = false;
  else return { error: 'Email permission must be Yes or No.' };
  const contact = {
    id: clean(input.id ?? input.contact_id),
    name: clean(input.name),
    email: clean(input.email),
    phone: clean(input.phone),
    household_id: clean(input.household_id ?? input.household) || null,
    household_name: clean(input.household_name),
    tags,
    notes: clean(input.notes),
    email_opt_in: emailOptIn
  };
  if (!contact.id) return { error: 'Enter a contact ID.' };
  if (!contact.name) return { error: 'Enter a name.' };
  if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) return { error: 'Enter a valid email address or leave email blank.' };
  return { contact };
}

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(root, 'public')));

  function requireAuth(req, res, next) {
    const raw = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('crm_session='))?.slice('crm_session='.length);
    if (!raw) return res.status(401).json({ error: 'Sign in to use the CRM.' });
    const tokenHash = crypto.createHash('sha256').update(decodeURIComponent(raw)).digest('hex');
    const user = db.prepare(`SELECT u.id, u.username, u.role FROM sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.active = 1`).get(tokenHash);
    if (!user) return res.status(401).json({ error: 'Your sign-in expired. Please sign in again.' });
    req.user = user;
    next();
  }

  function allowRoles(...roles) {
    return (req, res, next) => {
      if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Your account does not have permission to do that.' });
      next();
    };
  }

  function audit(actor, action, recordType, recordId) {
    db.prepare(`INSERT INTO audit_events (actor_id, actor_name, action, record_type, record_id)
      VALUES (?, ?, ?, ?, ?)`).run(actor.id, actor.username, action, recordType, String(recordId));
  }

  const getContact = db.prepare(`SELECT c.id, c.name, c.email, c.phone, c.household_id, c.tags, c.notes,
    c.email_opt_in, c.archived, h.name AS household_name
    FROM contacts c LEFT JOIN households h ON h.id = c.household_id WHERE c.id = ?`);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM app_users WHERE username = ? COLLATE NOCASE AND active = 1').get(username);
    if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Username or password is incorrect.' });
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, user.id, expiresAt);
    res.setHeader('Set-Cookie', `crm_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  });

  app.post('/api/auth/logout', (req, res) => {
    const raw = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('crm_session='))?.slice('crm_session='.length);
    if (raw) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(decodeURIComponent(raw)).digest('hex'));
    res.setHeader('Set-Cookie', 'crm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

  app.get('/api/overview', requireAuth, (_req, res) => {
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

  app.get('/api/households/options', requireAuth, (_req, res) => {
    res.json(db.prepare(`SELECT h.id, h.name, COUNT(c.id) AS people_count FROM households h
      LEFT JOIN contacts c ON c.household_id = h.id GROUP BY h.id ORDER BY h.id COLLATE NOCASE`).all());
  });

  app.get('/api/contact-tags', requireAuth, (_req, res) => {
    const tags = db.prepare('SELECT tags FROM contacts WHERE archived = 0').all()
      .flatMap((row) => JSON.parse(row.tags)).filter(Boolean);
    res.json([...new Set(tags)].sort((a, b) => a.localeCompare(b)));
  });

  app.get('/api/households/:id', requireAuth, (req, res) => {
    const household = db.prepare('SELECT id, name FROM households WHERE id = ?').get(req.params.id);
    if (!household) return res.status(404).json({ error: 'Household not found.' });
    const people = db.prepare(`SELECT id, name, email, phone, household_id, tags, notes, email_opt_in, archived
      FROM contacts WHERE household_id = ? ORDER BY name COLLATE NOCASE`).all(household.id)
      .map((item) => ({ ...item, tags: JSON.parse(item.tags), email_opt_in: Boolean(item.email_opt_in) }));
    res.json({ ...household, people });
  });

  app.get('/api/contacts', requireAuth, (req, res) => {
    const query = String(req.query.search || '').trim();
    const tag = String(req.query.tag || '').trim().toLocaleLowerCase();
    const archived = String(req.query.archived || 'false') === 'true';
    const pattern = `%${query}%`;
    const contacts = db.prepare(`SELECT c.id, c.name, c.email, c.phone, c.household_id, c.tags, c.notes,
        c.email_opt_in, c.archived, h.name AS household_name
      FROM contacts c LEFT JOIN households h ON h.id = c.household_id
      WHERE c.archived = ? AND (? = '' OR c.id LIKE ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE OR c.email LIKE ? COLLATE NOCASE OR c.phone LIKE ? COLLATE NOCASE)
        AND (? = '' OR EXISTS (SELECT 1 FROM json_each(c.tags) WHERE lower(value) = ?))
      ORDER BY c.name COLLATE NOCASE`).all(archived ? 1 : 0, query, pattern, pattern, pattern, pattern, tag, tag)
      .map((contact) => ({ ...contact, tags: JSON.parse(contact.tags), email_opt_in: Boolean(contact.email_opt_in), archived: Boolean(contact.archived) }));
    res.json(contacts);
  });

  app.get('/api/contacts/:id', requireAuth, (req, res) => {
    const contact = getContact.get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found.' });
    const memberships = db.prepare('SELECT * FROM memberships WHERE contact_id = ? ORDER BY start_date DESC').all(contact.id);
    const donations = db.prepare('SELECT * FROM donations WHERE contact_id = ? ORDER BY date DESC').all(contact.id);
    const tasks = db.prepare('SELECT * FROM tasks WHERE contact_id = ? ORDER BY due_date').all(contact.id);
    const history = db.prepare(`SELECT actor_name, action, record_type, record_id, occurred_at
      FROM audit_events WHERE record_type = 'contact' AND record_id = ? ORDER BY id DESC`).all(contact.id);
    res.json({ ...contact, archived: Boolean(contact.archived), tags: JSON.parse(contact.tags), email_opt_in: Boolean(contact.email_opt_in), memberships, donations, tasks, history });
  });

  function validateHousehold(householdId, requestedName) {
    if (!householdId) return null;
    const household = db.prepare('SELECT id, name FROM households WHERE id = ?').get(householdId);
    return household || { id: householdId, name: requestedName || householdId };
  }

  function saveContact(contact, actor, action) {
    const household = validateHousehold(contact.household_id, contact.household_name);
    const tx = db.transaction(() => {
      if (household) db.prepare('INSERT OR IGNORE INTO households (id, name) VALUES (?, ?)').run(household.id, household.name);
      if (action === 'add') {
        db.prepare(`INSERT INTO contacts (id, name, email, phone, household_id, tags, notes, email_opt_in)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(contact.id, contact.name, contact.email, contact.phone,
          contact.household_id, JSON.stringify(contact.tags), contact.notes, contact.email_opt_in ? 1 : 0);
      } else {
        db.prepare(`UPDATE contacts SET name = ?, email = ?, phone = ?, household_id = ?, tags = ?, notes = ?, email_opt_in = ? WHERE id = ?`)
          .run(contact.name, contact.email, contact.phone, contact.household_id, JSON.stringify(contact.tags), contact.notes,
            contact.email_opt_in ? 1 : 0, contact.id);
      }
      audit(actor, action, 'contact', contact.id);
    });
    tx();
    return getContact.get(contact.id);
  }

  app.post('/api/contacts', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    const parsed = cleanContact(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const contact = parsed.contact;
    if (db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(contact.id)) return res.status(409).json({ error: 'A contact with that ID already exists.' });
    try {
      const saved = saveContact(contact, req.user, 'add');
      res.status(201).json({ ...saved, tags: JSON.parse(saved.tags), email_opt_in: Boolean(saved.email_opt_in), archived: Boolean(saved.archived) });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That contact ID or email is already in use.' });
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return res.status(400).json({ error: 'Choose a valid household.' });
      console.error(error);
      res.status(500).json({ error: 'The contact could not be saved. Your entered values are still available; please retry.' });
    }
  });

  app.put('/api/contacts/:id', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    const existing = getContact.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Contact not found.' });
    if (req.body.id !== undefined && String(req.body.id).trim() !== existing.id) return res.status(400).json({ error: 'A contact ID cannot be changed.' });
    const parsed = cleanContact({ ...req.body, id: existing.id });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    try {
      const saved = saveContact(parsed.contact, req.user, 'edit');
      res.json({ ...saved, tags: JSON.parse(saved.tags), email_opt_in: Boolean(saved.email_opt_in), archived: Boolean(saved.archived) });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That email is already used by another contact.' });
      console.error(error);
      res.status(500).json({ error: 'The contact could not be saved. Your entered values are still available; please retry.' });
    }
  });

  app.post('/api/contacts/:id/archive', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    const tx = db.transaction(() => {
      const contact = db.prepare('SELECT id, archived FROM contacts WHERE id = ?').get(req.params.id);
      if (!contact) return false;
      if (!contact.archived) {
        db.prepare('UPDATE contacts SET archived = 1 WHERE id = ?').run(contact.id);
        audit(req.user, 'archive', 'contact', contact.id);
      }
      return true;
    });
    if (!tx()) return res.status(404).json({ error: 'Contact not found.' });
    res.json({ ok: true, id: req.params.id, archived: true });
  });

  app.post('/api/import/practice-data', requireAuth, allowRoles('admin', 'staff'), (_req, res) => {
    const data = readReferenceData();
    const inserted = [];
    const skipped = [];
    const tx = db.transaction(() => {
      const householdInsert = db.prepare('INSERT OR IGNORE INTO households (id, name) VALUES (?, ?)');
      const contactInsert = db.prepare(`INSERT OR IGNORE INTO contacts (id, name, email, phone, household_id, tags, notes, email_opt_in, archived)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const household of data.households) householdInsert.run(household.id.trim(), household.name.trim());
      for (const original of data.contacts) {
        const contact = cleanContact(original).contact;
        if (db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(contact.id)) { skipped.push(contact.id); continue; }
        try {
          const result = contactInsert.run(contact.id, contact.name, contact.email, contact.phone, contact.household_id,
            JSON.stringify(contact.tags), contact.notes, contact.email_opt_in ? 1 : 0, original.archived ? 1 : 0);
          if (result.changes) { inserted.push(contact.id); audit(_req.user, 'add', 'contact', contact.id); }
          else skipped.push(contact.id);
        } catch (error) {
          if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error(`Practice data contains an email already used by another record (${contact.email}).`);
          throw error;
        }
      }
    });
    try { tx(); } catch (error) { return res.status(400).json({ error: `Practice-data import was rolled back: ${error.message}` }); }
    res.json({ inserted: inserted.length, skipped: skipped.length, active: db.prepare('SELECT COUNT(*) count FROM contacts WHERE archived = 0').get().count,
      message: `Added ${inserted.length} practice contacts; kept ${skipped.length} existing contact records unchanged.` });
  });

  app.post('/api/import/contacts-csv', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    let rows;
    try { rows = parseCsv(req.body.csv); } catch (_error) { return res.status(400).json({ error: 'Could not read the CSV file.' }); }
    if (!rows.length) return res.status(400).json({ error: 'The CSV file has no contact rows.' });
    const outcome = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const id = String(row.contact_id ?? row.id ?? '').trim();
      if (id && db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(id)) { outcome.push({ row: index + 2, id, status: 'skipped', message: 'That ID is already saved; existing data was kept.' }); continue; }
      const parsed = cleanContact(row);
      if (parsed.error) { outcome.push({ row: index + 2, id, status: 'error', message: parsed.error }); continue; }
      const contact = parsed.contact;
      try {
        saveContact(contact, req.user, 'add');
        outcome.push({ row: index + 2, id: contact.id, status: 'added', message: 'Contact added.' });
      } catch (error) {
        const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'That email is already used by another contact.' : error.status ? error.message : 'Could not save this contact.';
        outcome.push({ row: index + 2, id: contact.id, status: 'error', message });
      }
    }
    res.json({ rows: outcome, added: outcome.filter((item) => item.status === 'added').length,
      errors: outcome.filter((item) => item.status === 'error').length, skipped: outcome.filter((item) => item.status === 'skipped').length });
  });

  app.get('/api/audit', requireAuth, (_req, res) => {
    res.json(db.prepare('SELECT actor_name, action, record_type, record_id, occurred_at FROM audit_events ORDER BY id DESC LIMIT 200').all());
  });

  app.get('/api/admin/users', requireAuth, allowRoles('admin'), (_req, res) => {
    res.json(db.prepare('SELECT id, username, role, active, created_at FROM app_users ORDER BY username COLLATE NOCASE').all());
  });

  app.post('/api/admin/users', requireAuth, allowRoles('admin'), (req, res) => {
    const username = String(req.body.username || '').trim();
    const role = String(req.body.role || '');
    const password = String(req.body.password || '');
    if (!username) return res.status(400).json({ error: 'Enter a username.' });
    if (!['admin', 'staff', 'viewer'].includes(role)) return res.status(400).json({ error: 'Choose admin, staff, or viewer.' });
    if (password.length < 10) return res.status(400).json({ error: 'Use a password with at least 10 characters.' });
    try {
      const result = db.prepare('INSERT INTO app_users (username, role, password_hash) VALUES (?, ?, ?)').run(username, role, passwordHash(password));
      audit(req.user, 'create user', 'user', result.lastInsertRowid);
      res.status(201).json({ id: result.lastInsertRowid, username, role, active: 1 });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That username is already in use.' });
      console.error(error);
      res.status(500).json({ error: 'Could not create the user.' });
    }
  });

  app.patch('/api/admin/users/:id', requireAuth, allowRoles('admin'), (req, res) => {
    const role = String(req.body.role || '');
    if (!['admin', 'staff', 'viewer'].includes(role)) return res.status(400).json({ error: 'Choose admin, staff, or viewer.' });
    const target = db.prepare('SELECT id, username, role, active FROM app_users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin access.' });
    db.prepare('UPDATE app_users SET role = ? WHERE id = ?').run(role, target.id);
    audit(req.user, 'change user role', 'user', target.id);
    res.json({ ...target, role });
  });

  app.get('/api/export/contacts.csv', requireAuth, allowRoles('admin'), (_req, res) => {
    const contacts = db.prepare('SELECT id, name, email, phone, household_id, tags, notes, email_opt_in, archived FROM contacts ORDER BY id').all();
    const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const lines = ['contact_id,name,email,phone,household,tags,notes,email_opt_in,archived', ...contacts.map((contact) => [
      contact.id, contact.name, contact.email, contact.phone, contact.household_id, JSON.parse(contact.tags).join(', '), contact.notes,
      contact.email_opt_in ? 'true' : 'false', contact.archived ? 'true' : 'false'
    ].map(quote).join(','))];
    res.type('text/csv').attachment('crm-contacts.csv').send(lines.join('\r\n'));
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'Something went wrong. Your saved data was not changed.' });
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

module.exports = { createApp, initializeSchema, readReferenceData, parseCsv, cleanContact, DEMO_USERS };

