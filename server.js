const express = require('express');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
    CREATE UNIQUE INDEX IF NOT EXISTS unique_contact_email ON contacts(email COLLATE NOCASE) WHERE email <> '';
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, record_id TEXT NOT NULL,
      action TEXT NOT NULL, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS demo_users (
      id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('admin','staff','viewer')),
      password_hash TEXT NOT NULL
    );
  `);
}

function createApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(root, 'public')));
  const sessions = new Map();
  const passwordHash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
  const demo = { 'admin-demo': 'admin', 'staff-demo': 'staff', 'viewer-demo': 'viewer' };
  // Fictional local demonstration accounts; never use these credentials for real data.
  for (const [id, role] of Object.entries(demo)) {
    const salt = id + '-classroom-only';
    db.prepare('INSERT OR IGNORE INTO demo_users (id,role,password_hash) VALUES (?,?,?)')
      .run(id, role, passwordHash('demo-' + role, salt));
  }
  app.post('/api/sign-in', (req, res) => {
    const id = String(req.body?.id || '');
    const user = db.prepare('SELECT * FROM demo_users WHERE id = ?').get(id);
    const supplied = passwordHash(String(req.body?.password || ''), id + '-classroom-only');
    if (!user || !crypto.timingSafeEqual(Buffer.from(user.password_hash,'hex'), Buffer.from(supplied,'hex')))
      return res.status(401).json({error:'Invalid test username or password.'});
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, id);
    res.cookie?.('unused', '');
    res.setHeader('Set-Cookie', 'crm_session=' + token + '; HttpOnly; SameSite=Strict; Path=/');
    res.json({id, role:user.role});
  });
  app.post('/api/sign-out', (req,res) => {
    const token = /(?:^|; )crm_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    sessions.delete(token);
    res.setHeader('Set-Cookie','crm_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/');
    res.json({ok:true});
  });
  app.use('/api', (req,res,next) => {
    if (req.path === '/health') return next();
    const token = /(?:^|; )crm_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const id = sessions.get(token);
    req.user = id && db.prepare('SELECT id,role FROM demo_users WHERE id=?').get(id);
    if (!req.user) return res.status(401).json({error:'Sign in to use the CRM.'});
    if (['POST','PUT','PATCH','DELETE'].includes(req.method) && !['admin','staff'].includes(req.user.role))
      return res.status(403).json({error:'Your viewer account cannot make changes.'});
    if (/^\/(users|settings|export|backup|restore|prices)(\/|$)/.test(req.path) && req.user.role !== 'admin')
      return res.status(403).json({error:'Admin permission required.'});
    next();
  });
  app.get('/api/me', (req,res) => res.json(req.user));
  app.get('/api/audit', (req,res) => res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all()));
  app.get('/api/households', (req,res) => res.json(db.prepare('SELECT h.*, COUNT(c.id) AS people FROM households h LEFT JOIN contacts c ON c.household_id=h.id GROUP BY h.id ORDER BY h.id').all()));
  app.get('/api/households/:id', (req,res) => {
    const household=db.prepare('SELECT * FROM households WHERE id=?').get(req.params.id);
    if(!household) return res.status(404).json({error:'Household not found.'});
    res.json({...household,contacts:db.prepare('SELECT id,name,archived FROM contacts WHERE household_id=? ORDER BY name').all(household.id)});
  });
  app.post('/api/load-practice', (req,res) => {
    const data=readReferenceData();
    const seed=db.transaction(() => {
      for(const h of data.households) db.prepare('INSERT OR IGNORE INTO households(id,name) VALUES (?,?)').run(h.id,h.name);
      for(const c of data.contacts) db.prepare('INSERT OR IGNORE INTO contacts(id,name,email,phone,household_id,tags,notes,email_opt_in,archived) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(c.id,c.name,c.email||'',c.phone||'',c.household_id||null,JSON.stringify(c.tags||[]),c.notes||'',c.email_opt_in?1:0,c.archived?1:0);
    });
    seed();
    res.json({stored:db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, active:db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE archived=0').get().n});
  });

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
    const households = db.prepare('SELECT id,name FROM households ORDER BY id').all();
    res.json(households);
  });

  app.get('/api/contacts', (req, res) => {
    const query = String(req.query.search || '').trim();
    const pattern = `%${query}%`;
    const contacts = db.prepare(`SELECT c.id, c.name, c.email, c.phone, c.household_id, c.tags, c.notes,
        c.email_opt_in, c.archived, h.name AS household_name
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
      WHERE c.id = ?`).get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found.' });
    const memberships = db.prepare('SELECT * FROM memberships WHERE contact_id = ? ORDER BY start_date DESC').all(contact.id);
    const donations = db.prepare('SELECT * FROM donations WHERE contact_id = ? ORDER BY date DESC').all(contact.id);
    const tasks = db.prepare('SELECT * FROM tasks WHERE contact_id = ? ORDER BY due_date').all(contact.id);
    res.json({ ...contact, tags: JSON.parse(contact.tags), email_opt_in: Boolean(contact.email_opt_in), memberships, donations, tasks });
  });

  app.put('/api/contacts/:id', (req,res) => {
    const original=db.prepare('SELECT * FROM contacts WHERE id=?').get(req.params.id);
    if(!original) return res.status(404).json({error:'Contact not found.'});
    if(req.body.id !== undefined && String(req.body.id).trim() !== req.params.id)
      return res.status(400).json({error:'Contact ID cannot be changed.'});
    const name=String(req.body.name ?? original.name).trim();
    const email=String(req.body.email ?? original.email).trim();
    if(!name) return res.status(400).json({error:'Enter a name.'});
    if(email && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return res.status(400).json({error:'Enter a valid email address.'});
    if(email && db.prepare('SELECT id FROM contacts WHERE email=? COLLATE NOCASE AND id<>?').get(email,req.params.id))
      return res.status(409).json({error:'Email is already used by another contact.'});
    const household_id=String(req.body.household_id ?? original.household_id ?? '').trim() || null;
    if(household_id && !db.prepare('SELECT 1 FROM households WHERE id=?').get(household_id))
      return res.status(400).json({error:'Choose a valid household.'});
    const tags=Array.isArray(req.body.tags)?req.body.tags:String(req.body.tags ?? JSON.parse(original.tags).join(',')).split(',');
    const normalizedTags=tags.map(t=>String(t).trim()).filter(Boolean);
    try {
      db.transaction(()=>{
        db.prepare('UPDATE contacts SET name=?,email=?,phone=?,household_id=?,tags=?,notes=?,email_opt_in=? WHERE id=?')
          .run(name,email,String(req.body.phone ?? original.phone).trim(),household_id,JSON.stringify(normalizedTags),
            String(req.body.notes ?? original.notes).trim(),req.body.email_opt_in === undefined ? original.email_opt_in : (req.body.email_opt_in === true ? 1 : 0),req.params.id);
        db.prepare('INSERT INTO audit_log(actor,record_id,action) VALUES (?,?,?)').run(req.user.id,req.params.id,'edit');
      })();
      res.json({ok:true,id:req.params.id});
    } catch(e) { res.status(500).json({error:'Save failed; your previous contact details are unchanged.'}); }
  });
  app.post('/api/contacts/:id/archive', (req,res)=>{
    if(!db.prepare('SELECT 1 FROM contacts WHERE id=?').get(req.params.id)) return res.status(404).json({error:'Contact not found.'});
    try {
      db.transaction(()=>{
        db.prepare('UPDATE contacts SET archived=1 WHERE id=?').run(req.params.id);
        db.prepare('INSERT INTO audit_log(actor,record_id,action) VALUES (?,?,?)').run(req.user.id,req.params.id,'archive');
      })();
      res.json({ok:true});
    } catch(e){res.status(500).json({error:'Archive failed; no changes saved.'});}
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
    if (email && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return res.status(400).json({error:'Enter a valid email address.'});
    if (email && db.prepare('SELECT 1 FROM contacts WHERE email=? COLLATE NOCASE').get(email)) return res.status(409).json({error:'Email is already used by another contact.'});
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
      db.prepare('INSERT INTO audit_log(actor,record_id,action) VALUES (?,?,?)').run(req.user.id,id,'add');
    });
    try {
      save();
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'A contact with that ID already exists.' });
      }
      return res.status(500).json({error:'Save failed; neither contact nor household was added.'});
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
  fs.mkdirSync(path.dirname(databasePath), {recursive:true});
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
