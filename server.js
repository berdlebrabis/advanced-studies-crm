const express = require('express');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parse: parseCsvText } = require('csv-parse/sync');

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
    CREATE TABLE IF NOT EXISTS membership_plans (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, price REAL NOT NULL CHECK (price >= 0),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS membership_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, membership_id TEXT NOT NULL REFERENCES memberships(id),
      payment_code TEXT NOT NULL UNIQUE, amount REAL NOT NULL CHECK (amount >= 0),
      payment_date TEXT, method TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK (status IN ('paid','pending','failed')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS membership_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT, membership_id TEXT NOT NULL REFERENCES memberships(id),
      payment_id INTEGER NOT NULL UNIQUE REFERENCES membership_payments(id),
      start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      CHECK (start_date < end_date)
    );
    CREATE TABLE IF NOT EXISTS donations (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL,
      campaign TEXT NOT NULL DEFAULT '', method TEXT NOT NULL DEFAULT '', payment_code TEXT,
      thank_you_sent INTEGER NOT NULL DEFAULT 0, voided INTEGER NOT NULL DEFAULT 0,
      voided_by TEXT, voided_at TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '', due_date TEXT, status TEXT NOT NULL,
      source_key TEXT UNIQUE,
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
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'contacts', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'donations', 'voided_by', 'TEXT');
  ensureColumn(db, 'donations', 'voided_at', 'TEXT');
  ensureColumn(db, 'tasks', 'source_key', 'TEXT');
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('viewer_export_allowed', '0')").run();
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_unique_ci ON contacts(lower(trim(email))) WHERE trim(email) <> ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS donations_payment_code_unique ON donations(payment_code) WHERE payment_code IS NOT NULL AND trim(payment_code) <> ''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_source_key_unique ON tasks(source_key) WHERE source_key IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS contacts_household_idx ON contacts(household_id)');
  db.exec('CREATE INDEX IF NOT EXISTS audit_record_idx ON audit_events(record_type, record_id, id DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS membership_period_dates_idx ON membership_periods(membership_id, start_date, end_date)');

  const plans = [
    ['individual', 'One person', 35], ['family', 'Family', 40], ['student_senior', 'Student or senior', 30]
  ];
  const insertPlan = db.prepare('INSERT OR IGNORE INTO membership_plans (id, name, price) VALUES (?, ?, ?)');
  for (const plan of plans) insertPlan.run(...plan);

  // Bring forward preexisting membership rows without changing their saved plan price or dates.
  const legacyRows = db.prepare(`SELECT m.* FROM memberships m
    LEFT JOIN membership_payments p ON p.payment_code = m.payment_code
    WHERE m.payment_code IS NOT NULL AND p.id IS NULL`).all();
  const migrateLegacy = db.transaction(() => {
    for (const row of legacyRows) {
      const payment = db.prepare(`INSERT INTO membership_payments (membership_id, payment_code, amount, payment_date, status)
        VALUES (?, ?, ?, ?, ?)`).run(row.id, row.payment_code, row.price, row.start_date, ['paid', 'pending', 'failed'].includes(row.payment_status) ? row.payment_status : 'pending');
      if (row.payment_status === 'paid' && row.start_date && row.end_date) {
        db.prepare('INSERT INTO membership_periods (membership_id, payment_id, start_date, end_date) VALUES (?, ?, ?, ?)')
          .run(row.id, payment.lastInsertRowid, row.start_date, row.end_date);
      }
    }
  });
  migrateLegacy();

  const insertUser = db.prepare('INSERT OR IGNORE INTO app_users (username, role, password_hash) VALUES (?, ?, ?)');
  const seedUsers = db.transaction(() => {
    for (const user of DEMO_USERS) insertUser.run(user.username, user.role, passwordHash(user.password));
  });
  seedUsers();
}

const CSV_HEADERS = ['contact_id', 'name', 'email', 'phone', 'household', 'tags', 'notes', 'email_opt_in'];

function parseCsvDocument(text) {
  const records = parseCsvText(String(text || ''), { bom: true, skip_empty_lines: true, relax_quotes: false, trim: false });
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((item) => String(item).trim());
  const duplicates = headers.filter((item, index) => headers.indexOf(item) !== index);
  if (duplicates.length) throw new Error(`Repeated CSV header: ${duplicates[0]}.`);
  return { headers, rows: records.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))) };
}

function parseCsv(text) { return parseCsvDocument(text).rows; }

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

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addMembershipYear(date) {
  if (!validIsoDate(date)) throw new Error('Enter a real payment date in YYYY-MM-DD format.');
  const [year, month, day] = date.split('-').map(Number);
  const nextYear = year + 1;
  const isLeap = (nextYear % 4 === 0 && nextYear % 100 !== 0) || nextYear % 400 === 0;
  const nextDay = month === 2 && day === 29 && !isLeap ? 28 : day;
  return `${nextYear}-${String(month).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
}

function daysBetween(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
}

function addDays(date, days) {
  if (!validIsoDate(date)) throw new Error('Enter a real date in YYYY-MM-DD format.');
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function newTaskId(db) {
  return `AUTO-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function addFollowupTask(db, { contactId, type, title, owner, dueDate, sourceKey }) {
  const id = newTaskId(db);
  const result = db.prepare(`INSERT OR IGNORE INTO tasks (id, contact_id, type, title, owner, due_date, status, source_key)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`)
    .run(id, contactId, type, title, owner, dueDate, sourceKey);
  return result.changes ? id : null;
}

function membershipState(db, membershipId, asOf) {
  const periods = db.prepare('SELECT start_date, end_date FROM membership_periods WHERE membership_id = ? ORDER BY start_date').all(membershipId);
  const activePeriods = periods.filter((period) => period.start_date <= asOf && asOf < period.end_date);
  const latestPayment = db.prepare('SELECT status FROM membership_payments WHERE membership_id = ? ORDER BY id DESC LIMIT 1').get(membershipId);
  if (activePeriods.length) {
    let coveredUntil = activePeriods.reduce((latest, period) => period.end_date > latest ? period.end_date : latest, activePeriods[0].end_date);
    let extended = true;
    while (extended) {
      extended = false;
      for (const period of periods) {
        if (period.start_date <= coveredUntil && period.end_date > coveredUntil) { coveredUntil = period.end_date; extended = true; }
      }
    }
    const daysRemaining = daysBetween(asOf, coveredUntil);
    return { status: 'active', daysRemaining, expiring: daysRemaining >= 1 && daysRemaining <= 30 };
  }
  if (periods.some((period) => period.start_date > asOf)) return { status: 'upcoming', daysRemaining: null, expiring: false };
  if (periods.length) return { status: 'ended', daysRemaining: null, expiring: false };
  if (latestPayment?.status === 'pending' || latestPayment?.status === 'failed') return { status: 'pending', daysRemaining: null, expiring: false };
  return { status: 'pending', daysRemaining: null, expiring: false };
}

function summarizeMemberships(db, asOf) {
  const memberships = db.prepare('SELECT id, contact_id, household_id FROM memberships').all();
  const summary = { asOf, active: 0, peopleCovered: 0, endingSoon: 0, ended: 0, pending: 0, upcoming: 0 };
  const covered = new Set();
  for (const membership of memberships) {
    const state = membershipState(db, membership.id, asOf);
    if (state.status === 'active') {
      summary.active += 1;
      if (state.expiring) summary.endingSoon += 1;
      const people = membership.household_id
        ? db.prepare('SELECT id FROM contacts WHERE household_id = ? AND archived = 0').all(membership.household_id)
        : db.prepare('SELECT id FROM contacts WHERE id = ? AND archived = 0').all(membership.contact_id);
      for (const person of people) covered.add(person.id);
    } else if (state.status === 'ended') summary.ended += 1;
    else if (state.status === 'pending') summary.pending += 1;
    else if (state.status === 'upcoming') summary.upcoming += 1;
  }
  summary.peopleCovered = covered.size;
  return summary;
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
    const memberSummary = summarizeMemberships(db, today);
    const donation = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM donations WHERE voided = 0').get();
    const renewalDue = memberSummary.endingSoon;
    const overdueTasks = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'open' AND due_date < ?").get(today).count;
    res.json({ testDate: today, activePeople, activeMemberships: memberSummary.active, donationCount: donation.count,
      donationTotal: donation.total, renewalsDue: renewalDue, overdueTasks });
  });

  app.get('/api/reports', requireAuth, (req, res) => {
    const asOf = String(req.query.date || readReferenceData().test_date);
    if (!validIsoDate(asOf)) return res.status(400).json({ error: 'Choose a real report date in YYYY-MM-DD format.' });
    const gifts = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM donations WHERE voided = 0 AND date <= ?').get(asOf);
    const campaigns = db.prepare('SELECT campaign, SUM(amount) AS total FROM donations WHERE voided = 0 AND date <= ? GROUP BY campaign ORDER BY campaign COLLATE NOCASE').all(asOf);
    const memberships = summarizeMemberships(db, asOf);
    const overdueTasks = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'open' AND due_date < ?").get(asOf).count;
    res.json({ asOf, donations: gifts, campaigns, activeMemberships: memberships.active, peopleCovered: memberships.peopleCovered, overdueTasks });
  });

  app.get('/api/settings/export-permission', requireAuth, (_req, res) => {
    const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'viewer_export_allowed'").get();
    res.json({ viewerExportAllowed: setting?.value === '1' });
  });

  app.patch('/api/admin/settings/viewer-export', requireAuth, allowRoles('admin'), (req, res) => {
    if (typeof req.body.allowed !== 'boolean') return res.status(400).json({ error: 'Choose whether viewers may export.' });
    const value = req.body.allowed ? '1' : '0';
    db.prepare("UPDATE app_settings SET value = ? WHERE key = 'viewer_export_allowed'").run(value);
    audit(req.user, req.body.allowed ? 'allow viewer exports' : 'disable viewer exports', 'setting', 'viewer_export_allowed');
    res.json({ viewerExportAllowed: req.body.allowed });
  });

  function donationSummary({ campaign, from, to }) {
    const where = ['voided = 0']; const values = [];
    if (campaign) { where.push('campaign = ?'); values.push(campaign); }
    if (from) { where.push('date >= ?'); values.push(from); }
    if (to) { where.push('date <= ?'); values.push(to); }
    return db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM donations WHERE ${where.join(' AND ')}`).get(...values);
  }

  app.get('/api/donations', requireAuth, (req, res) => {
    const campaign = String(req.query.campaign || '').trim();
    const from = String(req.query.from || '').trim(); const to = String(req.query.to || '').trim();
    if ((from && !validIsoDate(from)) || (to && !validIsoDate(to))) return res.status(400).json({ error: 'Choose real dates for the date range.' });
    if (from && to && from > to) return res.status(400).json({ error: 'The start date must be on or before the end date.' });
    const where = []; const values = [];
    if (campaign) { where.push('d.campaign = ?'); values.push(campaign); }
    if (from) { where.push('d.date >= ?'); values.push(from); }
    if (to) { where.push('d.date <= ?'); values.push(to); }
    const list = db.prepare(`SELECT d.*, c.name AS donor_name, d.voided_by, d.voided_at FROM donations d JOIN contacts c ON c.id = d.contact_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.date DESC, d.id`).all(...values).map((item) => ({
      ...item, history: db.prepare("SELECT actor_name, action, occurred_at FROM audit_events WHERE record_type = 'donation' AND record_id = ? ORDER BY id DESC").all(item.id)
    }));
    const campaigns = db.prepare('SELECT DISTINCT campaign FROM donations ORDER BY campaign COLLATE NOCASE').all().map((item) => item.campaign);
    res.json({ donations: list, summary: donationSummary({ campaign, from, to }), campaigns });
  });

  app.post('/api/donations', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    const contactId = String(req.body.contact_id || '').trim();
    const contact = db.prepare('SELECT id FROM contacts WHERE id = ? AND archived = 0').get(contactId);
    if (!contact) return res.status(400).json({ error: 'Choose a saved, active donor contact.' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) return res.status(400).json({ error: 'Enter an amount greater than $0 with no more than two decimal places.' });
    const date = String(req.body.date || '').trim();
    if (!validIsoDate(date)) return res.status(400).json({ error: 'Enter a real donation date in YYYY-MM-DD format.' });
    const campaign = String(req.body.campaign || '').trim();
    const method = String(req.body.method || '').trim();
    const paymentCode = String(req.body.payment_code || '').trim();
    if (!campaign) return res.status(400).json({ error: 'Enter a campaign for this donation.' });
    if (!method) return res.status(400).json({ error: 'Enter how the donation was paid.' });
    if (!paymentCode) return res.status(400).json({ error: 'Enter a payment code.' });
    if (db.prepare('SELECT 1 FROM donations WHERE payment_code = ?').get(paymentCode)) return res.status(409).json({ error: 'That payment code has already been used.' });
    const thankYouSent = ['true', 'yes', '1', 'on'].includes(String(req.body.thank_you_sent || '').trim().toLowerCase());
    const id = String(req.body.id || '').trim() || `D-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    if (db.prepare('SELECT 1 FROM donations WHERE id = ?').get(id)) return res.status(409).json({ error: 'A donation with that ID already exists.' });
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO donations (id, contact_id, amount, date, campaign, method, payment_code, thank_you_sent)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, contactId, amount, date, campaign, method, paymentCode, thankYouSent ? 1 : 0);
        audit(req.user, 'add', 'donation', id);
        if (!thankYouSent) {
          const taskId = addFollowupTask(db, { contactId, type: 'Thank-you', title: 'Thank-you for donation', owner: req.user.username,
            dueDate: addDays(date, 7), sourceKey: `donation:${id}:thank-you` });
          if (taskId) audit(req.user, 'create thank-you follow-up', 'task', taskId);
        }
      })();
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That payment code or donation ID is already in use.' });
      console.error(error); return res.status(500).json({ error: 'Donation save failed. No donation or follow-up was kept.' });
    }
    res.status(201).json({ id, message: `Donation ${id} saved.` });
  });

  app.post('/api/donations/:id/void', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    const donation = db.prepare('SELECT id, voided FROM donations WHERE id = ?').get(req.params.id);
    if (!donation) return res.status(404).json({ error: 'Donation not found.' });
    if (donation.voided) return res.status(409).json({ error: 'This donation is already void.' });
    db.transaction(() => {
      db.prepare("UPDATE donations SET voided = 1, voided_by = ?, voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .run(req.user.username, donation.id);
      audit(req.user, 'void', 'donation', donation.id);
      const tasks = db.prepare("SELECT id FROM tasks WHERE source_key = ? AND status = 'open'").all(`donation:${donation.id}:thank-you`);
      db.prepare("UPDATE tasks SET status = 'cancelled' WHERE source_key = ? AND status = 'open'").run(`donation:${donation.id}:thank-you`);
      for (const task of tasks) audit(req.user, 'cancel', 'task', task.id);
    })();
    res.json({ id: donation.id, voided: true, message: `Donation ${donation.id} was voided; its amount is excluded from totals.` });
  });

  function ensureRenewalTasks(asOf, actor) {
    const members = db.prepare('SELECT id, contact_id FROM memberships').all();
    for (const member of members) {
      const state = membershipState(db, member.id, asOf);
      if (!state.expiring) continue;
      const endDate = db.prepare(`SELECT MAX(end_date) AS end_date FROM membership_periods WHERE membership_id = ? AND start_date <= ? AND end_date > ?`)
        .get(member.id, asOf, asOf)?.end_date;
      if (endDate) {
        const taskId = addFollowupTask(db, { contactId: member.contact_id, type: 'Renewal', title: 'Membership renewal follow-up', owner: actor.username,
          dueDate: endDate, sourceKey: `membership:${member.id}:renewal:${endDate}` });
        if (taskId) audit(actor, 'create renewal follow-up', 'task', taskId);
      }
    }
  }

  app.post('/api/tasks/ensure-followups', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    const asOf = String(req.body.date || readReferenceData().test_date);
    if (!validIsoDate(asOf)) return res.status(400).json({ error: 'Choose a real date in YYYY-MM-DD format.' });
    ensureRenewalTasks(asOf, req.user);
    res.json({ ok: true });
  });

  app.get('/api/tasks', requireAuth, (req, res) => {
    const asOf = String(req.query.date || readReferenceData().test_date);
    if (!validIsoDate(asOf)) return res.status(400).json({ error: 'Choose a real date in YYYY-MM-DD format.' });
    const tasks = db.prepare(`SELECT t.*, c.name AS contact_name FROM tasks t JOIN contacts c ON c.id = t.contact_id
      ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'complete' THEN 1 ELSE 2 END, t.due_date, t.id`).all().map((item) => ({
      ...item, history: db.prepare("SELECT actor_name, action, occurred_at FROM audit_events WHERE record_type = 'task' AND record_id = ? ORDER BY id DESC").all(item.id)
    }));
    const counts = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status = 'open' AND due_date < ? THEN 1 ELSE 0 END) AS overdue FROM tasks WHERE type = 'manual'`).get(asOf);
    const allCounts = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status = 'open' AND due_date < ? THEN 1 ELSE 0 END) AS overdue FROM tasks`).get(asOf);
    res.json({ asOf, tasks, counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value || 0])),
      allCounts: Object.fromEntries(Object.entries(allCounts).map(([key, value]) => [key, value || 0])) });
  });

  app.post('/api/tasks', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    const contactId = String(req.body.contact_id || '').trim();
    if (!db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(contactId)) return res.status(400).json({ error: 'Choose a saved contact.' });
    const type = String(req.body.type || 'manual').trim(); const title = String(req.body.title || '').trim();
    const owner = String(req.body.owner || req.user.username).trim(); const dueDate = String(req.body.due_date || '').trim();
    if (!type || !title || !owner) return res.status(400).json({ error: 'Enter a task type, task name, and owner.' });
    if (!validIsoDate(dueDate)) return res.status(400).json({ error: 'Enter a real due date in YYYY-MM-DD format.' });
    const id = String(req.body.id || '').trim() || `T-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    if (db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id)) return res.status(409).json({ error: 'A task with that ID already exists.' });
    try {
      db.transaction(() => { db.prepare("INSERT INTO tasks (id, contact_id, type, title, owner, due_date, status) VALUES (?, ?, ?, ?, ?, ?, 'open')")
        .run(id, contactId, type, title, owner, dueDate); audit(req.user, 'add', 'task', id); })();
    } catch (error) { console.error(error); return res.status(500).json({ error: 'The task was not saved.' }); }
    res.status(201).json({ id, message: `Task ${id} saved.` });
  });

  app.post('/api/tasks/:id/:action', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    const status = req.params.action === 'complete' ? 'complete' : req.params.action === 'cancel' ? 'cancelled' : '';
    if (!status) return res.status(404).json({ error: 'Choose Complete or Cancel.' });
    const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (task.status !== 'open') return res.status(409).json({ error: 'Only an open task can be changed.' });
    db.transaction(() => { db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, task.id); audit(req.user, status, 'task', task.id); })();
    res.json({ id: task.id, status, message: `Task ${task.id} marked ${status}.` });
  });

  app.get('/api/admin/backup', requireAuth, allowRoles('admin'), (_req, res) => {
    const tables = ['households', 'contacts', 'memberships', 'membership_plans', 'membership_payments', 'membership_periods', 'donations', 'tasks', 'audit_events'];
    const backup = { format: 'advanced-studies-crm-backup-v1', created_at: new Date().toISOString(), tables: {} };
    for (const table of tables) backup.tables[table] = db.prepare(`SELECT * FROM ${table}`).all().map((row) =>
      table === 'audit_events' ? { ...row, actor_id: null } : row);
    res.type('application/json').attachment(`crm-backup-${new Date().toISOString().slice(0, 10)}.json`).send(JSON.stringify(backup, null, 2));
  });

  app.post('/api/admin/restore', requireAuth, allowRoles('admin'), (req, res) => {
    const backup = req.body;
    const required = ['households', 'contacts', 'memberships', 'membership_plans', 'membership_payments', 'membership_periods', 'donations', 'tasks', 'audit_events'];
    if (!backup || backup.format !== 'advanced-studies-crm-backup-v1' || !backup.tables || required.some((key) => !Array.isArray(backup.tables[key]))) {
      return res.status(400).json({ error: 'Choose a valid CRM backup made by this app.' });
    }
    const restoreDir = process.env.CRM_RESTORE_DIR || path.join(root, 'data', 'restores');
    fs.mkdirSync(restoreDir, { recursive: true });
    const restoreFile = path.join(restoreDir, `crm-restore-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.sqlite`);
    const restored = new Database(restoreFile);
    try {
      initializeSchema(restored);
      const safeRows = Object.fromEntries(required.map((table) => [table, backup.tables[table]]));
      restored.transaction(() => {
        for (const table of [...required].reverse()) restored.prepare(`DELETE FROM ${table}`).run();
        for (const table of required) {
          const rows = safeRows[table]; if (!rows.length) continue;
          const columns = restored.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
          for (const row of rows) {
            if (!row || typeof row !== 'object' || Object.keys(row).some((key) => !columns.includes(key))) throw new Error(`Backup has an invalid ${table} record.`);
            const keys = Object.keys(row); if (!keys.length) throw new Error(`Backup has an empty ${table} record.`);
            const placeholders = keys.map(() => '?').join(',');
            restored.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders})`).run(...keys.map((key) => row[key]));
          }
        }
      })();
      restored.prepare('INSERT INTO audit_events (actor_name, action, record_type, record_id) VALUES (?, ?, ?, ?)')
        .run(req.user.username, 'restore to separate copy', 'backup', path.basename(restoreFile));
      res.status(201).json({ message: 'Backup restored into a separate database copy. The current database was left unchanged.', file: restoreFile });
    } catch (error) {
      restored.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${restoreFile}${suffix}`, { force: true });
      console.error(error); return res.status(400).json({ error: 'Restore failed. The current database was left unchanged.' });
    }
    restored.close();
  });

  app.get('/api/membership-plans', requireAuth, (_req, res) => {
    res.json(db.prepare('SELECT id, name, price, updated_at FROM membership_plans ORDER BY CASE id WHEN \'individual\' THEN 1 WHEN \'family\' THEN 2 ELSE 3 END').all());
  });

  app.patch('/api/admin/membership-plans/:id', requireAuth, allowRoles('admin'), (req, res) => {
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price <= 0 || Math.round(price * 100) !== price * 100) return res.status(400).json({ error: 'Enter a price greater than $0 with no more than two decimal places.' });
    const plan = db.prepare('SELECT id, name FROM membership_plans WHERE id = ?').get(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Membership plan not found.' });
    db.prepare("UPDATE membership_plans SET price = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(price, plan.id);
    audit(req.user, 'change plan price', 'membership plan', plan.id);
    res.json(db.prepare('SELECT id, name, price, updated_at FROM membership_plans WHERE id = ?').get(plan.id));
  });

  app.get('/api/memberships/summary', requireAuth, (req, res) => {
    const asOf = String(req.query.date || readReferenceData().test_date);
    if (!validIsoDate(asOf)) return res.status(400).json({ error: 'Choose a real date in YYYY-MM-DD format.' });
    res.json(summarizeMemberships(db, asOf));
  });

  app.get('/api/memberships', requireAuth, (req, res) => {
    const asOf = String(req.query.date || readReferenceData().test_date);
    if (!validIsoDate(asOf)) return res.status(400).json({ error: 'Choose a real date in YYYY-MM-DD format.' });
    const memberships = db.prepare(`SELECT m.*, c.name AS contact_name, h.name AS household_name
      FROM memberships m JOIN contacts c ON c.id = m.contact_id LEFT JOIN households h ON h.id = m.household_id
      ORDER BY m.id COLLATE NOCASE`).all().map((membership) => ({
      ...membership,
      ...membershipState(db, membership.id, asOf),
      periods: db.prepare('SELECT p.start_date, p.end_date, pay.amount, pay.payment_code, pay.payment_date, pay.method, pay.status AS payment_status FROM membership_periods p JOIN membership_payments pay ON pay.id = p.payment_id WHERE p.membership_id = ? ORDER BY p.start_date').all(membership.id),
      payments: db.prepare('SELECT payment_code, amount, payment_date, method, status, created_at FROM membership_payments WHERE membership_id = ? ORDER BY id DESC').all(membership.id),
      history: db.prepare("SELECT actor_name, action, record_type, record_id, occurred_at FROM audit_events WHERE record_type IN ('membership', 'membership plan') AND record_id = ? ORDER BY id DESC").all(membership.id)
    }));
    res.json(memberships);
  });

  function prepareMembership(input) {
    const planId = String(input.plan || '').trim();
    const plan = db.prepare('SELECT id, name, price FROM membership_plans WHERE id = ?').get(planId);
    if (!plan) return { error: 'Choose one of the available membership plans.' };
    let contactId = String(input.contact_id || '').trim();
    const householdId = String(input.household_id || '').trim() || null;
    if (planId === 'family') {
      if (!householdId) return { error: 'Choose a household for a family membership.' };
      const household = db.prepare('SELECT id FROM households WHERE id = ?').get(householdId);
      if (!household) return { error: 'Choose an existing household.' };
      if (!contactId) contactId = db.prepare('SELECT id FROM contacts WHERE household_id = ? AND archived = 0 ORDER BY id LIMIT 1').get(householdId)?.id || '';
      const primaryPerson = db.prepare('SELECT id FROM contacts WHERE id = ? AND household_id = ? AND archived = 0').get(contactId, householdId);
      if (!primaryPerson) return { error: 'Choose an active contact from that household.' };
    } else {
      if (householdId) return { error: 'Choose a household only for a family plan.' };
      if (!contactId || !db.prepare('SELECT 1 FROM contacts WHERE id = ? AND archived = 0').get(contactId)) return { error: 'Choose an existing active contact.' };
    }
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) return { error: 'Enter a payment amount greater than $0 with no more than two decimal places.' };
    if (Math.round(amount * 100) !== Math.round(plan.price * 100)) return { error: `The ${plan.name} plan costs $${plan.price.toFixed(2)}. Update the plan price as an admin or enter the correct amount.` };
    const paymentCode = String(input.payment_code || '').trim();
    if (!paymentCode) return { error: 'Enter a payment code.' };
    if (db.prepare('SELECT 1 FROM membership_payments WHERE payment_code = ?').get(paymentCode)) return { error: 'That payment code has already been used.' };
    const paymentDate = String(input.payment_date || '').trim();
    if (!validIsoDate(paymentDate)) return { error: 'Enter a real payment date in YYYY-MM-DD format.' };
    const status = String(input.payment_status || 'paid').trim();
    if (!['paid', 'pending', 'failed'].includes(status)) return { error: 'Choose Paid, Pending, or Failed.' };
    return { membership: { contactId, householdId, plan, amount, paymentCode, paymentDate, method: String(input.method || '').trim(), status } };
  }

  function insertPayment(membershipId, payment, periodStart = null) {
    const endDate = periodStart ? addMembershipYear(periodStart) : null;
    const paymentRow = db.prepare(`INSERT INTO membership_payments (membership_id, payment_code, amount, payment_date, method, status)
      VALUES (?, ?, ?, ?, ?, ?)`).run(membershipId, payment.paymentCode, payment.amount, payment.paymentDate, payment.method, payment.status);
    if (payment.status === 'paid' && periodStart && endDate) {
      db.prepare('INSERT INTO membership_periods (membership_id, payment_id, start_date, end_date) VALUES (?, ?, ?, ?)')
        .run(membershipId, paymentRow.lastInsertRowid, periodStart, endDate);
      db.prepare('UPDATE memberships SET start_date = ?, end_date = ?, payment_status = \'paid\', payment_code = ? WHERE id = ?')
        .run(periodStart, endDate, payment.paymentCode, membershipId);
    } else {
      db.prepare('UPDATE memberships SET payment_status = ?, payment_code = ? WHERE id = ?')
        .run(payment.status, payment.paymentCode, membershipId);
    }
    return { paymentId: paymentRow.lastInsertRowid, endDate };
  }

  app.post('/api/memberships', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    const prepared = prepareMembership(req.body);
    if (prepared.error) return res.status(400).json({ error: prepared.error });
    const { membership } = prepared;
    const id = String(req.body.id || '').trim() || `M${String((db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 100) AS last_id FROM memberships WHERE id GLOB 'M[0-9]*'").get().last_id) + 1).padStart(3, '0')}`;
    if (db.prepare('SELECT 1 FROM memberships WHERE id = ?').get(id)) return res.status(409).json({ error: 'A membership with that ID already exists.' });
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO memberships (id, contact_id, household_id, plan, price, payment_status, payment_code)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, membership.contactId, membership.householdId, membership.plan.id, membership.amount, membership.status, membership.paymentCode);
      insertPayment(id, membership, membership.status === 'paid' ? membership.paymentDate : null);
      if (membership.status === 'paid') {
        const taskId = addFollowupTask(db, { contactId: membership.contactId, type: 'Welcome', title: 'Welcome new member', owner: req.user.username,
          dueDate: membership.paymentDate, sourceKey: `membership:${id}:welcome` });
        if (taskId) audit(req.user, 'create welcome follow-up', 'task', taskId);
      }
      audit(req.user, 'add', 'membership', id);
    });
    try { tx(); } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That payment code or membership ID is already in use.' });
      console.error(error);
      return res.status(500).json({ error: 'The membership could not be saved. No partial record was kept.' });
    }
    res.status(201).json({ id, status: membership.status, end_date: membership.status === 'paid' ? addMembershipYear(membership.paymentDate) : null });
  });

  app.post('/api/memberships/:id/renew', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    const existing = db.prepare('SELECT * FROM memberships WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Membership not found.' });
    const payment = {
      amount: Number(req.body.amount), paymentCode: String(req.body.payment_code || '').trim(),
      paymentDate: String(req.body.payment_date || '').trim(), method: String(req.body.method || '').trim(),
      status: String(req.body.payment_status || 'paid').trim()
    };
    if (!Number.isFinite(payment.amount) || payment.amount <= 0 || Math.round(payment.amount * 100) !== payment.amount * 100) return res.status(400).json({ error: 'Enter a payment amount greater than $0 with no more than two decimal places.' });
    if (Math.round(payment.amount * 100) !== Math.round(existing.price * 100)) return res.status(400).json({ error: `This membership renews at its saved price of $${existing.price.toFixed(2)}.` });
    if (!payment.paymentCode) return res.status(400).json({ error: 'Enter a payment code.' });
    if (db.prepare('SELECT 1 FROM membership_payments WHERE payment_code = ?').get(payment.paymentCode)) return res.status(409).json({ error: 'That payment code has already been used.' });
    if (!validIsoDate(payment.paymentDate)) return res.status(400).json({ error: 'Enter a real payment date in YYYY-MM-DD format.' });
    if (!['paid', 'pending', 'failed'].includes(payment.status)) return res.status(400).json({ error: 'Choose Paid, Pending, or Failed.' });
    const periods = db.prepare('SELECT start_date, end_date FROM membership_periods WHERE membership_id = ? ORDER BY start_date').all(existing.id);
    let periodStart = payment.paymentDate;
    let coveredUntil = periods.filter((period) => period.start_date <= payment.paymentDate && payment.paymentDate <= period.end_date)
      .reduce((latest, period) => period.end_date > latest ? period.end_date : latest, '');
    if (coveredUntil) {
      let extended = true;
      while (extended) {
        extended = false;
        for (const period of periods) if (period.start_date <= coveredUntil && period.end_date > coveredUntil) { coveredUntil = period.end_date; extended = true; }
      }
      periodStart = coveredUntil;
    }
    const tx = db.transaction(() => {
      insertPayment(existing.id, payment, payment.status === 'paid' ? periodStart : null);
      audit(req.user, 'renewal payment', 'membership', existing.id);
    });
    try { tx(); } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That payment code has already been used.' });
      console.error(error);
      return res.status(500).json({ error: 'The renewal could not be saved. Existing membership time was kept.' });
    }
    res.status(201).json({ id: existing.id, payment_status: payment.status, start_date: payment.status === 'paid' ? periodStart : null,
      end_date: payment.status === 'paid' ? addMembershipYear(periodStart) : null });
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
      for (const membership of data.memberships || []) {
        const result = db.prepare(`INSERT OR IGNORE INTO memberships (id, contact_id, household_id, plan, price, start_date, end_date, payment_status, payment_code)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(membership.id, membership.contact_id, membership.household_id || null,
          membership.plan, membership.price, membership.start_date, membership.end_date, membership.payment_status, membership.payment_code);
        if (!result.changes) continue;
        const payment = db.prepare(`INSERT OR IGNORE INTO membership_payments (membership_id, payment_code, amount, payment_date, method, status)
          VALUES (?, ?, ?, ?, 'Practice data', ?)`).run(membership.id, membership.payment_code, membership.price, membership.start_date,
          ['paid', 'pending', 'failed'].includes(membership.payment_status) ? membership.payment_status : 'pending');
        if (membership.payment_status === 'paid' && membership.start_date && membership.end_date && payment.changes) {
          db.prepare('INSERT INTO membership_periods (membership_id, payment_id, start_date, end_date) VALUES (?, ?, ?, ?)')
            .run(membership.id, payment.lastInsertRowid, membership.start_date, membership.end_date);
        }
        audit(_req.user, 'import', 'membership', membership.id);
      }
      for (const donation of data.donations || []) {
        const result = db.prepare(`INSERT OR IGNORE INTO donations (id, contact_id, amount, date, campaign, method, payment_code, thank_you_sent, voided)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(donation.id, donation.contact_id, donation.amount, donation.date,
          donation.campaign || '', donation.method || '', donation.payment_code || null, donation.thank_you_sent ? 1 : 0, donation.voided ? 1 : 0);
        if (result.changes) audit(_req.user, 'import', 'donation', donation.id);
      }
      for (const task of data.tasks || []) {
        const result = db.prepare(`INSERT OR IGNORE INTO tasks (id, contact_id, type, title, owner, due_date, status)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(task.id, task.contact_id, task.type || 'manual', task.title || task.type || 'Follow-up',
          task.owner || '', task.due_date || null, task.status || 'open');
        if (result.changes) audit(_req.user, 'import', 'task', task.id);
      }
    });
    try { tx(); } catch (error) { return res.status(400).json({ error: `Practice-data import was rolled back: ${error.message}` }); }
    ensureRenewalTasks(data.test_date || readReferenceData().test_date, _req.user);
    const importedMembershipCount = (data.memberships || []).filter((membership) => db.prepare('SELECT 1 FROM membership_payments WHERE membership_id = ?').get(membership.id)).length;
    const importedDonationCount = (data.donations || []).filter((donation) => db.prepare('SELECT 1 FROM donations WHERE id = ?').get(donation.id)).length;
    const importedTaskCount = (data.tasks || []).filter((task) => db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(task.id)).length;
    res.json({ inserted: inserted.length, skipped: skipped.length, active: db.prepare('SELECT COUNT(*) count FROM contacts WHERE archived = 0').get().count,
      memberships: importedMembershipCount, donations: importedDonationCount, tasks: importedTaskCount,
      message: `Added ${inserted.length} practice contacts, loaded ${importedMembershipCount} memberships, ${importedDonationCount} donations, and ${importedTaskCount} tasks; kept existing contact records unchanged.` });
  });

  function previewContactCsv(csv) {
    const document = parseCsvDocument(csv);
    if (!document.headers.length) return { error: 'The CSV file has no header row.' };
    const missing = CSV_HEADERS.filter((header) => !document.headers.includes(header));
    const extra = document.headers.filter((header) => !CSV_HEADERS.includes(header));
    if (missing.length || extra.length) return { error: `CSV headers must be exactly: ${CSV_HEADERS.join(', ')}. ${missing.length ? `Missing: ${missing.join(', ')}. ` : ''}${extra.length ? `Unexpected: ${extra.join(', ')}.` : ''}` };
    if (!document.rows.length) return { error: 'The CSV file has no contact rows.' };
    const rows = document.rows.map((row, index) => ({ row: index + 2, id: String(row.contact_id || '').trim(), raw: row, status: '', message: '', contact: null }));
    const idCounts = new Map();
    for (const item of rows) {
      if (item.id && !db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(item.id)) idCounts.set(item.id, (idCounts.get(item.id) || 0) + 1);
    }
    const emailRows = new Map();
    for (const item of rows) {
      if (item.id && db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(item.id)) {
        item.status = 'Duplicate'; item.message = 'This contact ID is already saved; existing details and history will be kept.'; continue;
      }
      if (item.id && idCounts.get(item.id) > 1) {
        item.status = 'Error'; item.message = 'This new contact ID appears more than once in the file.'; continue;
      }
      const consent = String(item.raw.email_opt_in ?? '').trim().toLowerCase();
      if (!['', 'true', 'false'].includes(consent)) { item.status = 'Error'; item.message = 'Email permission must be true, false, or blank.'; continue; }
      const parsed = cleanContact({
        contact_id: item.raw.contact_id, name: item.raw.name, email: item.raw.email, phone: item.raw.phone,
        household: item.raw.household, tags: String(item.raw.tags || '').split(';'), notes: item.raw.notes,
        email_opt_in: consent || 'false'
      });
      if (parsed.error) { item.status = 'Error'; item.message = parsed.error; continue; }
      item.contact = parsed.contact;
      if (item.contact.email) {
        const used = db.prepare('SELECT id FROM contacts WHERE lower(trim(email)) = lower(trim(?)) AND id <> ? LIMIT 1').get(item.contact.email, item.contact.id);
        if (used) { item.status = 'Error'; item.message = `This email is already used by contact ${used.id}.`; continue; }
        const key = item.contact.email.toLowerCase();
        if (!emailRows.has(key)) emailRows.set(key, []);
        emailRows.get(key).push(item);
      }
      item.status = 'New'; item.message = 'Ready to add.';
    }
    for (const group of emailRows.values()) if (group.length > 1) for (const item of group) {
      item.status = 'Error'; item.message = 'This email is repeated for more than one new contact in the file.';
    }
    return { rows: rows.map(({ row, id, status, message, contact }) => ({ row, id, status, message, ...(contact ? { contact } : {}) })) };
  }

  app.post('/api/import/contacts-csv/preview', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    try {
      const result = previewContactCsv(req.body.csv);
      if (result.error) return res.status(400).json({ error: result.error });
      res.json({ rows: result.rows, added: result.rows.filter((item) => item.status === 'New').length,
        duplicates: result.rows.filter((item) => item.status === 'Duplicate').length, errors: result.rows.filter((item) => item.status === 'Error').length });
    } catch (_error) { res.status(400).json({ error: 'Could not read the CSV file. Check its quotes and column counts.' }); }
  });

  app.post('/api/import/contacts-csv', requireAuth, allowRoles('admin', 'staff'), (req, res) => {
    let result;
    try { result = previewContactCsv(req.body.csv); } catch (_error) { return res.status(400).json({ error: 'Could not read the CSV file. Check its quotes and column counts.' }); }
    if (result.error) return res.status(400).json({ error: result.error });
    const errors = result.rows.filter((item) => item.status === 'Error');
    if (errors.length) return res.status(400).json({ error: `Import stopped: ${errors.length} row(s) have errors. Fix them and preview again; no rows were saved.`, rows: result.rows, added: 0, duplicates: result.rows.filter((item) => item.status === 'Duplicate').length, errors: errors.length });
    const filename = path.basename(String(req.body.filename || 'contacts.csv')).replace(/[^\w.-]+/g, '_').slice(0, 100) || 'contacts.csv';
    const newRows = result.rows.filter((item) => item.status === 'New');
    try {
      db.transaction(() => {
        for (const item of newRows) saveContact(item.contact, req.user, 'add');
        audit(req.user, `import file · ${newRows.length} rows added`, 'file import', filename);
      })();
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Import failed. No contacts, households, or import history were saved; you can retry the same file.' });
    }
    res.json({ rows: result.rows, added: newRows.length, duplicates: result.rows.filter((item) => item.status === 'Duplicate').length,
      errors: 0, message: `Imported ${newRows.length} contact(s). ${result.rows.filter((item) => item.status === 'Duplicate').length} existing contact(s) were kept unchanged.` });
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

  function mayExport(user) {
    if (user.role === 'admin') return true;
    const setting = db.prepare("SELECT value FROM app_settings WHERE key = 'viewer_export_allowed'").get();
    return user.role === 'viewer' && setting?.value === '1';
  }

  function exportContacts(req, res, emailList) {
    if (!mayExport(req.user)) return res.status(403).json({ error: 'Your account is not allowed to export records.' });
    const search = String(req.query.search || '').trim(); const tag = String(req.query.tag || '').trim().toLowerCase();
    const archived = String(req.query.archived || 'false') === 'true'; const pattern = `%${search}%`;
    const activeClause = emailList ? 'AND c.archived = 0 AND trim(c.email) <> \'\' AND c.email_opt_in = 1' : 'AND c.archived = ?';
    const values = emailList ? [search, pattern, pattern, pattern, pattern, tag, tag] : [archived ? 1 : 0, search, pattern, pattern, pattern, pattern, tag, tag];
    const contacts = db.prepare(`SELECT c.id, c.name, c.email, c.household_id, c.tags FROM contacts c
      WHERE ${emailList ? '1 = 1' : '1 = 1'} ${activeClause}
        AND (? = '' OR c.id LIKE ? COLLATE NOCASE OR c.name LIKE ? COLLATE NOCASE OR c.email LIKE ? COLLATE NOCASE OR c.phone LIKE ? COLLATE NOCASE)
        AND (? = '' OR EXISTS (SELECT 1 FROM json_each(c.tags) WHERE lower(value) = ?)) ORDER BY c.name COLLATE NOCASE`).all(...values);
    const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const headers = emailList ? ['name', 'email'] : ['contact_id', 'name', 'email', 'household'];
    const lines = [headers.join(','), ...contacts.map((contact) => (emailList
      ? [contact.name, contact.email] : [contact.id, contact.name, contact.email, contact.household_id]).map(quote).join(','))];
    const file = emailList ? 'crm-email-list.csv' : 'crm-contacts.csv';
    audit(req.user, `download ${emailList ? 'email list' : 'contacts CSV'} · ${contacts.length} rows`, 'file export', file);
    res.type('text/csv').attachment(file).send(lines.join('\r\n'));
  }

  app.get('/api/export/contacts.csv', requireAuth, (req, res) => exportContacts(req, res, false));
  app.get('/api/export/email-list.csv', requireAuth, (req, res) => exportContacts(req, res, true));

  app.get('/api/export/donations.csv', requireAuth, allowRoles('admin'), (req, res) => {
    const campaign = String(req.query.campaign || '').trim();
    const from = String(req.query.from || '').trim(); const to = String(req.query.to || '').trim();
    if ((from && !validIsoDate(from)) || (to && !validIsoDate(to))) return res.status(400).json({ error: 'Choose real dates for the date range.' });
    if (from && to && from > to) return res.status(400).json({ error: 'The start date must be on or before the end date.' });
    const where = ['d.voided = 0']; const values = [];
    if (campaign) { where.push('d.campaign = ?'); values.push(campaign); }
    if (from) { where.push('d.date >= ?'); values.push(from); }
    if (to) { where.push('d.date <= ?'); values.push(to); }
    const records = db.prepare(`SELECT d.id AS donation_id, d.contact_id, c.name AS donor, d.amount, d.date, d.campaign, d.payment_code, d.method
      FROM donations d JOIN contacts c ON c.id = d.contact_id WHERE ${where.join(' AND ')} ORDER BY d.date, d.id`).all(...values);
    const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const header = ['donation_id', 'contact_id', 'donor', 'amount', 'date', 'campaign', 'payment_code', 'method'];
    const lines = [header.map(quote).join(','), ...records.map((record) => header.map((key) => quote(record[key])).join(','))];
    const filename = `crm-donations${campaign ? `-${campaign.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''}.csv`;
    const total = records.reduce((sum, record) => sum + record.amount, 0);
    audit(req.user, `download ${campaign || 'all campaigns'} donations CSV · ${records.length} rows · $${total.toFixed(2)}`, 'file export', filename);
    res.type('text/csv').attachment(filename).send(lines.join('\r\n'));
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
