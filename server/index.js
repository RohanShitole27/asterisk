import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pg from 'pg';
import twilio from 'twilio';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { existsSync, readdirSync, statSync, createReadStream, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Asterisk extension auto-provisioning ────────────────────────────────────────
// When an admin assigns a new extension to a user, we write a matching SIP
// endpoint into the project's pjsip.conf/extensions.conf, deploy them to the
// running Asterisk instance, and reload — no manual config editing required.
const PJSIP_CONF_PATH       = join(__dirname, '..', 'asterisk-config', 'pjsip.conf');
const EXTENSIONS_CONF_PATH  = join(__dirname, '..', 'asterisk-config', 'extensions.conf');
const SIP_DEFAULT_PASSWORD  = '1234';

function extensionExists(ext) {
  if (!existsSync(PJSIP_CONF_PATH)) return true; // no local config to manage — assume it's handled elsewhere
  const content = readFileSync(PJSIP_CONF_PATH, 'utf8');
  return new RegExp(`^\\[${ext}\\]`, 'm').test(content);
}

function appendPjsipExtension(ext) {
  const block = `
; ─── Extension ${ext} (auto-provisioned) ──────────────────────────────────────

[${ext}]
type=endpoint
transport=transport-wss
context=internal
disallow=all
allow=opus,ulaw,alaw
auth=${ext}
aors=${ext}
webrtc=yes
dtls_auto_generate_cert=yes
use_avpf=yes
media_encryption=dtls
dtls_verify=no
dtls_setup=actpass
ice_support=yes
rtcp_mux=yes
direct_media=no
force_rport=yes
rewrite_contact=yes
rtp_symmetric=yes

[${ext}]
type=aor
max_contacts=5
remove_existing=yes
qualify_frequency=0

[${ext}]
type=auth
auth_type=userpass
username=${ext}
password=${SIP_DEFAULT_PASSWORD}
`;
  const content = readFileSync(PJSIP_CONF_PATH, 'utf8');
  const marker  = '; ─── Twilio Elastic SIP Trunk';
  const idx     = content.indexOf(marker);
  writeFileSync(PJSIP_CONF_PATH, idx === -1 ? content + block : content.slice(0, idx) + block + '\n' + content.slice(idx));
}

function appendDialplanExtension(ext) {
  const block = `
exten => ${ext},1,Set(RECFILE=/var/spool/asterisk/monitor/\${STRFTIME(\${EPOCH},,"%Y%m%d-%H%M%S")}-\${CALLERID(num)}-${ext}.wav)
 same => n,MixMonitor(\${RECFILE},b,/usr/bin/chmod 644 \${RECFILE})
 same => n,Dial(PJSIP/${ext},30,tT)
 same => n,Hangup()
`;
  const content = readFileSync(EXTENSIONS_CONF_PATH, 'utf8');
  const marker  = '; Echo test';
  const idx     = content.indexOf(marker);
  writeFileSync(EXTENSIONS_CONF_PATH, idx === -1 ? content + block : content.slice(0, idx) + block + '\n' + content.slice(idx));
}

/** Copies the local config files into the running Asterisk instance and reloads. */
async function deployAsteriskConfig() {
  const winToWsl = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
  if (process.platform === 'win32') {
    const pjsipWsl = winToWsl(PJSIP_CONF_PATH);
    const extWsl   = winToWsl(EXTENSIONS_CONF_PATH);
    await execAsync(
      `wsl -u root -e bash -c "cp '${pjsipWsl}' /etc/asterisk/pjsip.conf && cp '${extWsl}' /etc/asterisk/extensions.conf && asterisk -rx 'pjsip reload' && asterisk -rx 'dialplan reload'"`
    );
  } else {
    await execAsync(
      `cp "${PJSIP_CONF_PATH}" /etc/asterisk/pjsip.conf && cp "${EXTENSIONS_CONF_PATH}" /etc/asterisk/extensions.conf && asterisk -rx "pjsip reload" && asterisk -rx "dialplan reload"`
    );
  }
}

/**
 * Ensures a SIP extension exists in Asterisk, provisioning it automatically
 * if it doesn't. Only handles purely-numeric extensions (e.g. "1005") — never
 * touches PSTN numbers. Failures are logged but never block the caller, since
 * account creation shouldn't fail just because Asterisk is unreachable.
 */
async function ensureExtensionProvisioned(ext) {
  if (!ext || !/^\d{2,8}$/.test(ext)) return;
  if (extensionExists(ext)) return;
  try {
    appendPjsipExtension(ext);
    appendDialplanExtension(ext);
    await deployAsteriskConfig();
    console.log(`[asterisk-provision] Auto-provisioned extension ${ext}`);
  } catch (err) {
    console.error(`[asterisk-provision] Failed to provision extension ${ext}:`, err.message);
  }
}

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PGHOST     ?? 'localhost',
  port:     Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'Voip_3_db',
  user:     process.env.PGUSER     ?? 'postgres',
  password: process.env.PGPASSWORD ?? '',
});

const app = express();
// Wildcard CORS is fine for a same-origin deployment (Express serves the built
// frontend), but if the frontend is ever split onto another origin, a bare
// cors() reflecting every origin alongside cookie-based auth is too permissive.
// FRONTEND_ORIGIN restricts it explicitly when set.
app.use(cors(process.env.FRONTEND_ORIGIN
  ? { origin: process.env.FRONTEND_ORIGIN, credentials: true }
  : {}));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded POST bodies

// ── Auth config ────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('⚠ JWT_SECRET not set in .env — using an insecure default. Set one before deploying.');
}
const SESSION_TTL = '12h';

// ── Bootstrap ──────────────────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id        SERIAL PRIMARY KEY,
      name      VARCHAR(255) NOT NULL,
      extension VARCHAR(50)  NOT NULL
    )
  `);

  // Seed two default contacts on a fresh database
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM contacts');
  if (rows[0].n === 0) {
    await pool.query(
      `INSERT INTO contacts (name, extension) VALUES
         ('Extension 1001', '1001'),
         ('Extension 1002', '1002')`
    );
    console.log('Seeded default contacts.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS voicemail_messages (
      id          SERIAL PRIMARY KEY,
      caller      VARCHAR(100) NOT NULL,
      duration    INTEGER,
      received_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      is_read     BOOLEAN      NOT NULL DEFAULT FALSE,
      notes       TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_logs (
      id              TEXT        PRIMARY KEY,
      source          VARCHAR(20) NOT NULL DEFAULT 'asterisk',
      direction       VARCHAR(10) NOT NULL,
      remote_identity TEXT        NOT NULL,
      start_time      TIMESTAMPTZ NOT NULL,
      end_time        TIMESTAMPTZ,
      duration        INTEGER,
      status          VARCHAR(10) NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // IVR columns on call_logs (added after initial release)
  await pool.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ivr_option VARCHAR(10)`);
  await pool.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ivr_completed BOOLEAN NOT NULL DEFAULT FALSE`);

  // Recording columns on call_logs
  await pool.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_sid VARCHAR(100)`);
  await pool.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS sip_recording_file TEXT`);

  // Tags each call_logs row with the extension that handled it, so manager/agent
  // views can be filtered to only the calls relevant to them.
  await pool.query(`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS extension VARCHAR(50)`);

  // Recording + transcript columns on voicemail_messages
  await pool.query(`ALTER TABLE voicemail_messages ADD COLUMN IF NOT EXISTS recording_sid VARCHAR(100)`);
  await pool.query(`ALTER TABLE voicemail_messages ADD COLUMN IF NOT EXISTS recording_url TEXT`);
  await pool.query(`ALTER TABLE voicemail_messages ADD COLUMN IF NOT EXISTS transcript TEXT`);
  await pool.query(`ALTER TABLE voicemail_messages ADD COLUMN IF NOT EXISTS transcript_confidence FLOAT`);

  // IVR event log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ivr_events (
      id               UUID        PRIMARY KEY,
      call_sid         VARCHAR(100) NOT NULL,
      event_type       VARCHAR(50)  NOT NULL,
      selected_option  VARCHAR(10),
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ivr_events_call_sid_idx ON ivr_events (call_sid)`);

  // Users — login accounts, roles, and extension assignment
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(255) NOT NULL,
      email         VARCHAR(255) NOT NULL UNIQUE,
      password_hash TEXT         NOT NULL,
      role          VARCHAR(20)  NOT NULL DEFAULT 'agent',
      extension     VARCHAR(50),
      is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  // manager_id: which manager this agent reports to. Admin assigns this from the
  // manager's edit screen, which controls which agents' calls a manager can see.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);

  // Seed one demo account per role on a fresh database so there's always a way in
  // for each role (used by the quick-login buttons on the Login page).
  // Credentials are printed once to the server console — change passwords after first login.
  const { rows: userCount } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (userCount[0].n === 0) {
    const demoUsers = [
      { name: 'Admin',   email: 'admin@company.com',   password: 'admin123',   role: 'admin',   extension: null },
      { name: 'Manager', email: 'manager@company.com', password: 'manager123', role: 'manager', extension: null },
      { name: 'Agent',   email: 'agent@company.com',   password: 'agent123',   role: 'agent',    extension: '1001' },
    ];
    for (const u of demoUsers) {
      const hash = await bcrypt.hash(u.password, 10);
      await pool.query(
        `INSERT INTO users (name, email, password_hash, role, extension) VALUES ($1, $2, $3, $4, $5)`,
        [u.name, u.email, hash, u.role, u.extension]
      );
    }
    console.log('Seeded demo accounts — change these passwords before real use:');
    demoUsers.forEach((u) => console.log(`  ${u.role.padEnd(8)} ${u.email} / ${u.password}`));
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────────

function userToJson(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    extension: u.extension, isActive: u.is_active, managerId: u.manager_id,
  };
}

function signSession(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, extension: user.extension },
    JWT_SECRET,
    { expiresIn: SESSION_TTL }
  );
}

/** Verifies the session cookie and attaches req.user. 401s if missing/invalid/inactive. */
async function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    const user = rows[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Not authenticated' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// In-memory login rate limiter — 10 attempts per email per 15 minutes.
// Resets on server restart and isn't shared across instances, but that's an
// acceptable tradeoff for a single-instance deployment versus having zero
// brute-force protection on the login endpoint at all.
const LOGIN_LIMIT       = 10;
const LOGIN_WINDOW_MS   = 15 * 60 * 1000;
const loginAttempts     = new Map(); // email -> { count, resetAt }
function checkLoginRateLimit(email) {
  const now = Date.now();
  const entry = loginAttempts.get(email);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(email, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= LOGIN_LIMIT;
}

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email?.trim() || !password) return res.status(400).json({ error: 'email and password are required' });
  const normalizedEmail = email.trim().toLowerCase();
  if (!checkLoginRateLimit(normalizedEmail)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    const user = rows[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signSession(user);
    res.cookie('session', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.json({ user: userToJson(user) });
  } catch (err) {
    console.error('POST /api/auth/login:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('session');
  res.status(204).end();
});

// GET /api/auth/me — returns the current session's user, or 401
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: userToJson(req.user) });
});

// ── Users ──────────────────────────────────────────────────────────────────────

// GET /api/users — admin sees everyone; manager sees their own team's roster
// (their assigned agents plus themselves); agent has no use for this.
app.get('/api/users', requireAuth, async (req, res) => {
  if (req.user.role === 'agent') return res.status(403).json({ error: 'Forbidden' });
  try {
    const { rows } = req.user.role === 'admin'
      ? await pool.query('SELECT * FROM users ORDER BY name ASC')
      : await pool.query('SELECT * FROM users WHERE manager_id = $1 OR id = $1 ORDER BY name ASC', [req.user.id]);
    res.json(rows.map(userToJson));
  } catch (err) {
    console.error('GET /api/users:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users — create a new user
app.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, email, password, role, extension } = req.body ?? {};
  if (!name?.trim() || !email?.trim() || !password || !role) {
    return res.status(400).json({ error: 'name, email, password, and role are required' });
  }
  if (!['admin', 'manager', 'agent'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin, manager, or agent' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const ext  = extension?.trim() || null;
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, extension)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), email.trim().toLowerCase(), hash, role, ext]
    );
    if (ext) await ensureExtensionProvisioned(ext);
    res.status(201).json(userToJson(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that email already exists' });
    console.error('POST /api/users:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id — edit name, role, extension, active status (password optional)
app.put('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, role, extension, isActive, password } = req.body ?? {};
  if (!name?.trim() || !role) return res.status(400).json({ error: 'name and role are required' });
  if (!['admin', 'manager', 'agent'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin, manager, or agent' });
  }
  try {
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const ext = extension?.trim() || null;
    const { rows } = await pool.query(
      `UPDATE users
          SET name = $1, role = $2, extension = $3, is_active = $4,
              password_hash = COALESCE($5, password_hash)
        WHERE id = $6
        RETURNING *`,
      [name.trim(), role, ext, isActive ?? true, passwordHash, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (ext) await ensureExtensionProvisioned(ext);
    res.json(userToJson(rows[0]));
  } catch (err) {
    console.error('PUT /api/users/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id — admin only. Can't delete your own account (avoids
// accidental lockout). Agents reporting to a deleted manager are automatically
// unassigned (manager_id FK is ON DELETE SET NULL); their SIP extension stays
// provisioned in Asterisk but becomes "Unassigned" until reassigned.
app.delete('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  try {
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/users/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id/team — set which agents report to this manager.
// Body: { agentIds: number[] }. Full replace: any agent currently assigned to
// this manager but not in the new list gets unassigned (manager_id = NULL).
app.put('/api/users/:id/team', requireAuth, requireRole('admin'), async (req, res) => {
  const managerId = Number(req.params.id);
  const { agentIds } = req.body ?? {};
  if (!Array.isArray(agentIds)) return res.status(400).json({ error: 'agentIds must be an array' });
  try {
    const { rows: managerRows } = await pool.query('SELECT role FROM users WHERE id = $1', [managerId]);
    if (managerRows.length === 0) return res.status(404).json({ error: 'Manager not found' });
    if (managerRows[0].role !== 'manager') return res.status(400).json({ error: 'Target user is not a manager' });

    await pool.query('UPDATE users SET manager_id = NULL WHERE manager_id = $1', [managerId]);
    if (agentIds.length > 0) {
      await pool.query(
        `UPDATE users SET manager_id = $1 WHERE id = ANY($2::int[]) AND role = 'agent'`,
        [managerId, agentIds]
      );
    }
    const { rows } = await pool.query('SELECT * FROM users ORDER BY name ASC');
    res.json(rows.map(userToJson));
  } catch (err) {
    console.error('PUT /api/users/:id/team:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Extension Management (manager only) ─────────────────────────────────────────

/** Reads pjsip.conf and returns every numeric extension provisioned as an endpoint. */
function listProvisionedExtensions() {
  if (!existsSync(PJSIP_CONF_PATH)) return [];
  const content = readFileSync(PJSIP_CONF_PATH, 'utf8');
  const exts = new Set();
  const sectionRe = /^\[(\d+)\]\s*\ntype=endpoint/gm;
  let m;
  while ((m = sectionRe.exec(content)) !== null) exts.add(m[1]);
  return Array.from(exts).sort((a, b) => Number(a) - Number(b));
}

// GET /api/extensions/directory — visible to every logged-in user (any role).
// A read-only company-wide directory of every provisioned SIP extension and
// who it's assigned to. Unlike /api/extensions below, this has no team
// scoping and no reassignment capability — just "who do I dial for X".
app.get('/api/extensions/directory', requireAuth, async (_req, res) => {
  try {
    const extensions = listProvisionedExtensions();
    const { rows: owners } = await pool.query(
      'SELECT name, extension FROM users WHERE extension = ANY($1::text[])',
      [extensions]
    );
    const nameByExt = new Map(owners.map((o) => [o.extension, o.name]));
    res.json(extensions.map((extension) => ({
      extension,
      assignedTo: nameByExt.get(extension) ?? null,
    })));
  } catch (err) {
    console.error('GET /api/extensions/directory:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/contacts
app.get('/api/contacts', requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, extension FROM contacts ORDER BY name ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/contacts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contacts
app.post('/api/contacts', requireAuth, async (req, res) => {
  const { name, extension } = req.body ?? {};
  if (!name?.trim() || !extension?.trim()) {
    return res.status(400).json({ error: 'name and extension are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO contacts (name, extension) VALUES ($1, $2) RETURNING id, name, extension',
      [name.trim(), extension.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/contacts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/contacts/:id
app.put('/api/contacts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { name, extension } = req.body ?? {};
  if (!name?.trim() || !extension?.trim()) {
    return res.status(400).json({ error: 'name and extension are required' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE contacts
          SET name = $1, extension = $2
        WHERE id = $3
        RETURNING id, name, extension`,
      [name.trim(), extension.trim(), id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/contacts/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/contacts/:id
app.delete('/api/contacts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM contacts WHERE id = $1',
      [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Contact not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/contacts/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Voicemail Routes ───────────────────────────────────────────────────────────

// GET /api/voicemails
app.get('/api/voicemails', requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM voicemail_messages ORDER BY received_at DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/voicemails:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voicemails
app.post('/api/voicemails', requireAuth, async (req, res) => {
  const { caller, duration, notes } = req.body ?? {};
  if (!caller?.trim()) return res.status(400).json({ error: 'caller is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO voicemail_messages (caller, duration, notes)
       VALUES ($1, $2, $3) RETURNING *`,
      [caller.trim(), duration ?? null, notes ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/voicemails:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/voicemails/:id/read
app.patch('/api/voicemails/:id/read', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rows } = await pool.query(
      'UPDATE voicemail_messages SET is_read = TRUE WHERE id = $1 RETURNING *',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /api/voicemails/:id/read:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/voicemails/:id
app.delete('/api/voicemails/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM voicemail_messages WHERE id = $1', [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/voicemails/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Call Log Routes ────────────────────────────────────────────────────────────

function rowToLog(r) {
  return {
    id:               r.id,
    direction:        r.direction,
    remoteIdentity:   r.remote_identity,
    startTime:        r.start_time,
    endTime:          r.end_time ?? null,
    duration:         r.duration ?? null,
    status:           r.status,
    ivrOption:        r.ivr_option        ?? null,
    ivrCompleted:     r.ivr_completed     ?? false,
    recordingSid:     r.recording_sid     ?? null,
    sipRecordingFile: r.sip_recording_file ?? null,
    extension:        r.extension          ?? null,
  };
}

// GET /api/call-logs?source=asterisk|twilio
// Visibility by role: admin sees everything; manager sees their team's calls
// (plus their own, if they have an extension); agent sees only their own.
app.get('/api/call-logs', requireAuth, async (req, res) => {
  const { source } = req.query;
  try {
    let extensionFilter = null; // null = no filter (admin)
    if (req.user.role === 'manager') {
      const { rows: team } = await pool.query(
        `SELECT extension FROM users WHERE manager_id = $1 AND extension IS NOT NULL`,
        [req.user.id]
      );
      extensionFilter = team.map((t) => t.extension);
      if (req.user.extension) extensionFilter.push(req.user.extension);
    } else if (req.user.role === 'agent') {
      extensionFilter = req.user.extension ? [req.user.extension] : [];
    }

    const conditions = [];
    const params = [];
    if (source) { params.push(source); conditions.push(`source = $${params.length}`); }
    if (extensionFilter) { params.push(extensionFilter); conditions.push(`extension = ANY($${params.length}::text[])`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM call_logs ${where} ORDER BY start_time DESC`, params);
    res.json(rows.map(rowToLog));
  } catch (err) {
    console.error('GET /api/call-logs:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/call-logs/:id — fetch the latest copy of a single call (used to pick up
// recordingSid/sipRecordingFile that arrive asynchronously after the call ends)
app.get('/api/call-logs/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM call_logs WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const log = rows[0];

    // Same visibility rule as the list endpoint — without this, any
    // authenticated agent could fetch any other agent's call (and its
    // recording SID) just by guessing/iterating call IDs.
    if (req.user.role === 'agent') {
      if (log.extension !== req.user.extension) return res.status(404).json({ error: 'Not found' });
    } else if (req.user.role === 'manager') {
      const { rows: team } = await pool.query(
        `SELECT extension FROM users WHERE manager_id = $1 AND extension IS NOT NULL`,
        [req.user.id]
      );
      const allowed = new Set(team.map((t) => t.extension));
      if (req.user.extension) allowed.add(req.user.extension);
      if (!log.extension || !allowed.has(log.extension)) return res.status(404).json({ error: 'Not found' });
    }

    res.json(rowToLog(log));
  } catch (err) {
    console.error('GET /api/call-logs/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/call-logs
app.post('/api/call-logs', requireAuth, async (req, res) => {
  const { id, source, direction, remoteIdentity, startTime, endTime, duration, status } = req.body ?? {};
  if (!id || !direction || !remoteIdentity || !startTime || !status) {
    return res.status(400).json({ error: 'id, direction, remoteIdentity, startTime, status are required' });
  }
  try {
    // Extension is attributed server-side from the session, not trusted from the
    // client, so call ownership for manager/agent filtering can't be spoofed.
    const { rows } = await pool.query(
      `INSERT INTO call_logs (id, source, direction, remote_identity, start_time, end_time, duration, status, extension)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE
         SET end_time  = EXCLUDED.end_time,
             duration  = EXCLUDED.duration,
             status    = EXCLUDED.status,
             extension = COALESCE(call_logs.extension, EXCLUDED.extension)
       RETURNING *`,
      [id, source ?? 'asterisk', direction, remoteIdentity, startTime, endTime ?? null, duration ?? null, status, req.user.extension ?? null]
    );
    res.status(201).json(rows[0] ? rowToLog(rows[0]) : {});
  } catch (err) {
    console.error('POST /api/call-logs:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/call-logs?source=asterisk|twilio  (omit source to clear all)
// Destructive + company-wide, so it's admin-only — any authenticated agent
// being able to wipe every call record was a critical broken-access-control gap.
app.delete('/api/call-logs', requireAuth, requireRole('admin'), async (req, res) => {
  const { source } = req.query;
  try {
    if (source) {
      await pool.query('DELETE FROM call_logs WHERE source = $1', [source]);
    } else {
      await pool.query('DELETE FROM call_logs');
    }
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/call-logs:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── IVR Events API ─────────────────────────────────────────────────────────────

// GET /api/recordings/:sid — proxy Twilio recording audio with server-side auth
// The browser <audio> tag cannot add Twilio credentials, so we proxy here.
app.get('/api/recordings/:sid', requireAuth, async (req, res) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET) {
    return res.status(503).json({ error: 'Twilio credentials not configured' });
  }
  const { sid } = req.params;
  if (!/^RE[0-9a-f]{32}$/.test(sid)) return res.status(400).json({ error: 'Invalid recording SID' });

  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Recordings/${sid}.mp3`;
  const auth = Buffer.from(`${TWILIO_API_KEY}:${TWILIO_API_SECRET}`).toString('base64');

  try {
    const upstream = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!upstream.ok) return res.status(upstream.status).end();

    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    // Pipe web ReadableStream → Node response
    const { Readable } = await import('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('[recordings-proxy]', err.message);
    res.status(502).json({ error: 'Failed to fetch recording' });
  }
});

// ── SIP Recording Routes ───────────────────────────────────────────────────────

// Asterisk saves recordings to /var/spool/asterisk/monitor/ inside WSL.
// From Windows, WSL files are accessible via the UNC path \\wsl$\<distro>\...
// We try WSL path first, fall back to native Linux path (when running on Linux).
const WSL_MONITOR_DIR  = '\\\\wsl$\\Ubuntu\\var\\spool\\asterisk\\monitor';
const LINUX_MONITOR_DIR = '/var/spool/asterisk/monitor';
const SIP_MONITOR_DIR  = existsSync(LINUX_MONITOR_DIR) ? LINUX_MONITOR_DIR : WSL_MONITOR_DIR;

// Returns the set of extensions `user` is allowed to see recordings for, or
// `null` to mean "no restriction" (admin). Mirrors the call-logs visibility rule.
async function allowedExtensionsFor(user) {
  if (user.role === 'admin') return null;
  if (user.role === 'agent') return new Set(user.extension ? [user.extension] : []);
  const { rows: team } = await pool.query(
    `SELECT extension FROM users WHERE manager_id = $1 AND extension IS NOT NULL`,
    [user.id]
  );
  const allowed = new Set(team.map((t) => t.extension));
  if (user.extension) allowed.add(user.extension);
  return allowed;
}

// GET /api/sip-recordings — list SIP recording files visible to the caller.
// Without extension scoping here, any authenticated agent could browse and
// play back every other agent's call recordings company-wide.
app.get('/api/sip-recordings', requireAuth, async (req, res) => {
  try {
    if (!existsSync(SIP_MONITOR_DIR)) {
      return res.json([]);
    }
    const allowed = await allowedExtensionsFor(req.user);
    const files = readdirSync(SIP_MONITOR_DIR)
      .filter((f) => f.endsWith('.wav') || f.endsWith('.mp3'))
      .map((filename) => {
        const stat = statSync(join(SIP_MONITOR_DIR, filename));
        // Filename pattern: YYYYMMDD-HHMMSS-{caller}-{callee}.wav
        const parts = filename.replace(/\.(wav|mp3)$/, '').split('-');
        return {
          filename,
          size:      stat.size,
          createdAt: stat.mtime.toISOString(),
          caller:    parts[2] ?? null,
          callee:    parts[3] ?? null,
        };
      })
      .filter((f) => !allowed || f.caller === null && f.callee === null || allowed.has(f.caller) || allowed.has(f.callee))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(files);
  } catch (err) {
    console.error('GET /api/sip-recordings:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sip-recordings/:filename — stream a SIP recording file
app.get('/api/sip-recordings/:filename', requireAuth, async (req, res) => {
  const { filename } = req.params;
  // Sanitise — only allow safe filenames
  if (!/^[\w\-]+\.(wav|mp3)$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = join(SIP_MONITOR_DIR, filename);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'Recording not found' });
  }

  const allowed = await allowedExtensionsFor(req.user);
  if (allowed) {
    const parts = filename.replace(/\.(wav|mp3)$/, '').split('-');
    const caller = parts[2] ?? null;
    const callee = parts[3] ?? null;
    if (!allowed.has(caller) && !allowed.has(callee)) {
      return res.status(404).json({ error: 'Recording not found' });
    }
  }

  const stat = statSync(filePath);
  const ext  = filename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
  res.setHeader('Content-Type', ext);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  createReadStream(filePath).pipe(res);
});

// POST /api/sip-recordings/link — called after a SIP call ends to link the
// recording file to the call log entry (matched by timestamp + identities)
app.post('/api/sip-recordings/link', requireAuth, async (req, res) => {
  const { callId, filename } = req.body ?? {};
  if (!callId || !filename) return res.status(400).json({ error: 'callId and filename required' });
  try {
    await pool.query(
      `UPDATE call_logs SET sip_recording_file = $1 WHERE id = $2`,
      [filename, callId]
    );
    res.status(204).end();
  } catch (err) {
    console.error('POST /api/sip-recordings/link:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ivr-events?call_sid=CA...  (omit for last 200 events across all calls)
app.get('/api/ivr-events', requireAuth, async (req, res) => {
  const { call_sid } = req.query;
  try {
    const { rows } = call_sid
      ? await pool.query(
          'SELECT * FROM ivr_events WHERE call_sid = $1 ORDER BY created_at ASC',
          [call_sid]
        )
      : await pool.query(
          'SELECT * FROM ivr_events ORDER BY created_at DESC LIMIT 200'
        );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/ivr-events:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Twilio Voice SDK Routes ────────────────────────────────────────────────────

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_PHONE_NUMBER,
  TWILIO_AUTH_TOKEN,
} = process.env;

// REST client used for outbound dials (agent ring-out) and call redirects.
// Uses API Key + Secret so no auth token is needed.
const twilioRest = (TWILIO_ACCOUNT_SID && TWILIO_API_KEY && TWILIO_API_SECRET)
  ? twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid: TWILIO_ACCOUNT_SID })
  : null;

// Verifies that an inbound webhook POST actually came from Twilio (checks the
// X-Twilio-Signature header against TWILIO_AUTH_TOKEN). Without this, anyone
// who finds these URLs can forge call/IVR/voicemail events straight into the
// database. Only enforced when TWILIO_AUTH_TOKEN is configured, matching the
// JWT_SECRET pattern elsewhere in this file — but unlike JWT_SECRET there's no
// safe default, so it's a warn-and-allow rather than a hard requirement.
if (!TWILIO_AUTH_TOKEN) {
  console.warn('⚠ TWILIO_AUTH_TOKEN not set — incoming Twilio webhooks are NOT signature-verified. Set it before deploying.');
}
function verifyTwilioSignature(req, res, next) {
  if (!TWILIO_AUTH_TOKEN) return next(); // unconfigured — see warning above
  const signature = req.headers['x-twilio-signature'];
  const url = buildBaseUrl(req) + req.originalUrl;
  const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
  if (!valid) return res.status(403).json({ error: 'Invalid Twilio signature' });
  next();
}

// ── Shared IVR helpers ─────────────────────────────────────────────────────────

function buildBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  return `${proto}://${req.get('host')}`;
}

async function logIvrEvent(callSid, eventType, selectedOption = null) {
  try {
    await pool.query(
      `INSERT INTO ivr_events (id, call_sid, event_type, selected_option)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), callSid, eventType, selectedOption]
    );
  } catch (err) {
    console.error('[ivr-event]', err.message);
  }
}

/** Build the IVR menu <Gather> block and attach it to a VoiceResponse. */
function appendIvrMenu(twiml, actionUrl) {
  const gather = twiml.gather({
    numDigits:  '1',
    action:     actionUrl,
    method:     'POST',
    timeout:    '5',
  });
  gather.say({ voice: 'alice' },
    'Thanks for calling . ' +
    'Press 1 to speak with an agent. ' +
    'Press 2 to leave a voicemail. ' +
    'Press 9 to repeat this menu.'
  );
  return gather;
}

function ivrFailTwiml() {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Sorry, we were unable to process your request. Goodbye.');
  twiml.hangup();
  return twiml.toString();
}

// GET /api/twilio/debug — quick sanity check (never expose in production)
app.get('/api/twilio/debug', requireAuth, requireRole('admin'), (_req, res) => {
  res.json({
    TWILIO_ACCOUNT_SID:    TWILIO_ACCOUNT_SID   ? `${TWILIO_ACCOUNT_SID.slice(0, 6)}…`   : 'MISSING',
    TWILIO_API_KEY:        TWILIO_API_KEY        ? `${TWILIO_API_KEY.slice(0, 6)}…`        : 'MISSING',
    TWILIO_API_SECRET:     TWILIO_API_SECRET     ? '✓ set'                                 : 'MISSING',
    TWILIO_TWIML_APP_SID:  TWILIO_TWIML_APP_SID  ? `${TWILIO_TWIML_APP_SID.slice(0, 6)}…`  : 'MISSING',
    TWILIO_PHONE_NUMBER:   TWILIO_PHONE_NUMBER   ?? 'MISSING',
  });
});

// GET /api/twilio/token  — browser fetches this to register the Twilio Device.
// Identity comes from the logged-in user's assigned extension, not a URL param.
app.get('/api/twilio/token', requireAuth, (req, res) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET) {
    return res.status(503).json({ error: 'Twilio credentials not configured in .env' });
  }
  if (!req.user.extension) {
    return res.status(400).json({ error: 'Your account has no extension assigned — ask an admin to assign one' });
  }
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant  = AccessToken.VoiceGrant;

  const ext      = String(req.user.extension).replace(/\D/g, '').slice(0, 6);
  const identity = `softphone-${ext}`;
  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY,
    TWILIO_API_SECRET,
    { identity, ttl: 3600 }
  );

  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID,
    incomingAllow: true,
  }));

  res.json({ token: token.toJwt() });
});

// POST /api/twilio/voice — Twilio calls this when someone dials your number
// Returns TwiML that rings the browser client named "softphone"
function normalizeDialTarget(to) {
  const raw = String(to ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return raw;

  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw;
}

app.post('/api/twilio/voice', verifyTwilioSignature, (req, res) => {
  const twiml  = new twilio.twiml.VoiceResponse();
  const from   = String(req.body.From ?? '');
  const to     = normalizeDialTarget(req.body.To);

  console.log(`[voice] From=${from} To=${to}`);

  if (from.startsWith('client:') && to) {
    const dial = twiml.dial({ callerId: TWILIO_PHONE_NUMBER, timeout: '30' });
    dial.number(to);
    return res.type('text/xml').send(twiml.toString());
  }

  // Inbound PSTN call (not from a browser client) → hand off to the IVR flow
  // so the caller hears the menu instead of ringing the agent directly.
  const base = buildBaseUrl(req);
  twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/incoming`);
  res.type('text/xml').send(twiml.toString());
});

// POST /api/twilio/transfer — transfer a live PSTN call to a SIP extension
// Body: { callSid, extension }  e.g. { callSid: "CA...", extension: "1002" }
app.post('/api/twilio/transfer', requireAuth, async (req, res) => {
  const { callSid, extension } = req.body ?? {};
  if (!callSid || !extension) return res.status(400).json({ error: 'callSid and extension required' });
  const ext = String(extension).replace(/\D/g, '').slice(0, 6);
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    const dial  = twiml.dial({ timeout: '30' });
    dial.client(`softphone-${ext}`);
    await twilioRest.calls(callSid).update({ twiml: twiml.toString() });
    console.log(`[transfer] ${callSid} → softphone-${ext}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[transfer]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calls/status — Twilio status callback for every call leg
// Twilio POSTs form-encoded fields: CallSid, CallStatus, Direction, From, To, etc.
// We acknowledge with 204 so Twilio stops retrying.  Extend here to persist
// call records, push real-time updates via WebSocket, etc.
app.post('/api/calls/status', verifyTwilioSignature, (req, res) => {
  const { CallSid, CallStatus, Direction, From, To, CallDuration } = req.body ?? {};
  console.log(
    `[call-status] sid=${CallSid} status=${CallStatus} dir=${Direction} from=${From} to=${To} dur=${CallDuration ?? '–'}s`
  );
  res.status(204).end();
});

// POST /api/twilio/outbound — TwiML App calls this for browser-initiated PSTN calls
// Twilio passes the destination number as req.body.To
app.post('/api/twilio/outbound', verifyTwilioSignature, (req, res) => {
  const to    = normalizeDialTarget(req.body.To);
  const twiml = new twilio.twiml.VoiceResponse();

  if (!to) {
    twiml.say('No destination number provided.');
    return res.type('text/xml').send(twiml.toString());
  }

  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host2 = req.get('host');
  const dial = twiml.dial({
    callerId: TWILIO_PHONE_NUMBER,
    timeout: '30',
    record:  'record-from-answer',
    recordingStatusCallback:       `${proto}://${host2}/webhooks/voice/recording-complete`,
    recordingStatusCallbackMethod: 'POST',
  });
  dial.number(to);
  res.type('text/xml').send(twiml.toString());
});

// ── IVR Webhook Routes ─────────────────────────────────────────────────────────
//
// Configure these URLs in Twilio Console → Phone Numbers → your number:
//   Voice webhook (POST): https://<your-ngrok-host>/webhooks/voice/incoming
//
// All inbound PSTN calls enter the IVR. The caller interacts via DTMF.

// POST /webhooks/voice/incoming
// Called by Twilio when an inbound call arrives. Creates the call record and
// presents the IVR menu.
app.post('/webhooks/voice/incoming', verifyTwilioSignature, async (req, res) => {
  const { CallSid, From } = req.body ?? {};
  const base = buildBaseUrl(req);

  // Upsert call record
  try {
    await pool.query(
      `INSERT INTO call_logs (id, source, direction, remote_identity, start_time, status)
       VALUES ($1, 'twilio', 'inbound', $2, NOW(), 'ringing')
       ON CONFLICT (id) DO NOTHING`,
      [CallSid, From ?? 'unknown']
    );
  } catch (err) { console.error('[incoming] db:', err.message); }

  await logIvrEvent(CallSid, 'ivr_entered');

  const twiml = new twilio.twiml.VoiceResponse();
  appendIvrMenu(twiml, `${base}/webhooks/voice/ivr?retries=0`);
  // No input falls through here → treat as first timeout, redirect to /ivr
  twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/ivr?retries=0`);

  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/ivr?retries=N
// Handles digit input (1/2/9), timeouts, and invalid keys.
// Retries are tracked via the query param (max 3 before hanging up).
app.post('/webhooks/voice/ivr', verifyTwilioSignature, async (req, res) => {
  const { CallSid, Digits } = req.body ?? {};
  const retries = Math.min(parseInt(req.query.retries ?? '0', 10), 9);
  const base    = buildBaseUrl(req);

  const MAX_RETRIES = 3;
  const twiml = new twilio.twiml.VoiceResponse();

  if (!Digits) {
    // Timeout — no input received
    await logIvrEvent(CallSid, 'ivr_timeout');
    if (retries >= MAX_RETRIES - 1) {
      return res.type('text/xml').send(ivrFailTwiml());
    }
    twiml.say({ voice: 'alice' }, 'We didn\'t receive your selection.');
    appendIvrMenu(twiml, `${base}/webhooks/voice/ivr?retries=${retries + 1}`);
    twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/ivr?retries=${retries + 1}`);
    return res.type('text/xml').send(twiml.toString());
  }

  if (Digits === '1') {
    await logIvrEvent(CallSid, 'ivr_option_selected', '1');
    await pool.query(
      `UPDATE call_logs SET ivr_option = '1' WHERE id = $1`,
      [CallSid]
    ).catch(() => {});
    twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/connect-agent`);

  } else if (Digits === '2') {
    await logIvrEvent(CallSid, 'ivr_option_selected', '2');
    await pool.query(
      `UPDATE call_logs SET ivr_option = '2' WHERE id = $1`,
      [CallSid]
    ).catch(() => {});
    twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/voicemail`);

  } else if (Digits === '9') {
    await logIvrEvent(CallSid, 'ivr_replayed');
    appendIvrMenu(twiml, `${base}/webhooks/voice/ivr?retries=${retries}`);
    twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/ivr?retries=${retries}`);

  } else {
    // Invalid key
    await logIvrEvent(CallSid, 'ivr_invalid_input', Digits);
    if (retries >= MAX_RETRIES - 1) {
      return res.type('text/xml').send(ivrFailTwiml());
    }
    twiml.say({ voice: 'alice' }, `Sorry, ${Digits} is not a valid option.`);
    appendIvrMenu(twiml, `${base}/webhooks/voice/ivr?retries=${retries + 1}`);
    twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/ivr?retries=${retries + 1}`);
  }

  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/connect-agent
// Directly dials the agent's browser client and bridges it with the caller
// using <Dial><Client> — no Twilio Conference room involved. The caller's
// own call leg rings the agent leg directly; Twilio bridges the two legs
// of the SAME <Dial> the moment the agent answers.
app.post('/webhooks/voice/connect-agent', verifyTwilioSignature, async (req, res) => {
  const { CallSid } = req.body ?? {};
  const base = buildBaseUrl(req);

  await logIvrEvent(CallSid, 'agent_ringing');

  // Look up the real caller's number to pass through as a custom parameter —
  // <Dial><Client> does carry the original caller ID by default, but we pass
  // it explicitly too so the browser never has to guess.
  let realCaller = 'Unknown';
  try {
    const { rows } = await pool.query('SELECT remote_identity FROM call_logs WHERE id = $1', [CallSid]);
    if (rows[0]?.remote_identity) realCaller = rows[0].remote_identity;
  } catch (err) { console.error('[connect-agent] caller lookup:', err.message); }

  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial({
    timeout: 20,
    action:  `${base}/webhooks/voice/agent-dial-status`,
    record:  'record-from-answer',
    recordingStatusCallback:       `${base}/webhooks/voice/recording-complete`,
    recordingStatusCallbackMethod: 'POST',
  });
  // statusCallback on the <Client> noun fires the moment THIS leg is answered —
  // lets us mark the call as answered without any conference bridging.
  const client = dial.client({
    statusCallback:       `${base}/webhooks/voice/agent-answered?callerSid=${encodeURIComponent(CallSid)}`,
    statusCallbackEvent:  'answered',
    statusCallbackMethod: 'POST',
  }, 'softphone-1001');
  client.parameter({ name: 'realCaller',  value: realCaller });
  client.parameter({ name: 'realCallSid', value: CallSid });

  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/agent-answered?callerSid=...
// Fired the instant the agent's client leg connects (statusCallbackEvent=answered).
app.post('/webhooks/voice/agent-answered', verifyTwilioSignature, async (req, res) => {
  const callerSid = decodeURIComponent(req.query.callerSid ?? '');
  await logIvrEvent(callerSid, 'agent_answered');
  await pool.query(
    `UPDATE call_logs SET status = 'answered', ivr_completed = TRUE WHERE id = $1`,
    [callerSid]
  ).catch(() => {});
  res.status(204).end();
});

// POST /webhooks/voice/agent-dial-status
// The <Dial> action callback — fires once the dial to the agent finishes,
// whether answered-then-ended, or never answered.
app.post('/webhooks/voice/agent-dial-status', verifyTwilioSignature, async (req, res) => {
  const { CallSid, DialCallStatus } = req.body ?? {};
  const base = buildBaseUrl(req);

  if (DialCallStatus === 'completed') {
    // Agent answered and the call has now ended normally.
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  if (DialCallStatus === 'canceled') {
    // Agent actively declined — go straight to voicemail.
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/voicemail`);
    return res.type('text/xml').send(twiml.toString());
  }

  // no-answer / busy / failed → offer retry or voicemail.
  const twiml  = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    numDigits: '1',
    action:    `${base}/webhooks/voice/no-agent-response`,
    method:    'POST',
    timeout:   '8',
  });
  gather.say({ voice: 'alice' },
    'No agents are currently available. ' +
    'Press 1 to try again. ' +
    'Press 2 to leave a voicemail.'
  );
  twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/voicemail`);

  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/no-agent-response
// Handles the caller's choice after agent was unavailable.
app.post('/webhooks/voice/no-agent-response', verifyTwilioSignature, async (req, res) => {
  const { CallSid, Digits } = req.body ?? {};
  const base = buildBaseUrl(req);

  const twiml = new twilio.twiml.VoiceResponse();
  if (Digits === '1') {
    twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/connect-agent`);
  } else {
    twiml.redirect({ method: 'POST' }, `${base}/webhooks/voice/voicemail`);
  }
  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/voicemail
// Prompts the caller to leave a message and starts recording.
app.post('/webhooks/voice/voicemail', verifyTwilioSignature, async (req, res) => {
  const { CallSid } = req.body ?? {};
  const base = buildBaseUrl(req);

  await logIvrEvent(CallSid, 'voicemail_started');

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Please leave your message after the tone.');
  twiml.record({
    maxLength:           120,
    action:              `${base}/webhooks/voice/voicemail-complete`,
    method:              'POST',
    transcribe:          'true',
    transcribeCallback:  `${base}/webhooks/voice/transcription-callback`,
    playBeep:            'true',
  });
  // Fallback if recording returns immediately (e.g. caller hangs up at beep)
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/voicemail-complete
// Twilio posts here after the recording ends. Saves the voicemail to DB.
app.post('/webhooks/voice/voicemail-complete', verifyTwilioSignature, async (req, res) => {
  const {
    CallSid,
    From,
    RecordingSid,
    RecordingUrl,
    RecordingDuration,
  } = req.body ?? {};

  await logIvrEvent(CallSid, 'voicemail_completed');
  await pool.query(
    `UPDATE call_logs
     SET status = 'answered', ivr_completed = TRUE
     WHERE id = $1`,
    [CallSid]
  ).catch(() => {});

  try {
    await pool.query(
      `INSERT INTO voicemail_messages
         (caller, duration, recording_sid, recording_url)
       VALUES ($1, $2, $3, $4)`,
      [
        From ?? 'unknown',
        RecordingDuration ? parseInt(RecordingDuration, 10) : null,
        RecordingSid ?? null,
        RecordingUrl  ? `${RecordingUrl}.mp3` : null,
      ]
    );
  } catch (err) {
    console.error('[voicemail-complete] db:', err.message);
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'alice' },
    'Thank you for your message. We will get back to you soon. Goodbye.'
  );
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/transcription-callback
// Twilio fires this when the transcription of a voicemail is ready.
app.post('/webhooks/voice/transcription-callback', verifyTwilioSignature, async (req, res) => {
  const {
    CallSid,
    TranscriptionStatus,
    TranscriptionText,
    TranscriptionScore,
    RecordingSid,
  } = req.body ?? {};

  if (TranscriptionStatus === 'completed' && RecordingSid) {
    await logIvrEvent(CallSid, 'transcription_completed');
    await pool.query(
      `UPDATE voicemail_messages
       SET transcript = $1, transcript_confidence = $2
       WHERE recording_sid = $3`,
      [
        TranscriptionText ?? null,
        TranscriptionScore ? parseFloat(TranscriptionScore) : null,
        RecordingSid,
      ]
    ).catch((err) => console.error('[transcription-cb] db:', err.message));
  }
  res.status(204).end();
});

// POST /webhooks/voice/recording-complete
// Twilio fires this when a call recording is ready. Stores the RecordingSid
// on the call_log row so the UI can play it back via /api/recordings/:sid.
app.post('/webhooks/voice/recording-complete', verifyTwilioSignature, async (req, res) => {
  const { CallSid, RecordingSid, RecordingDuration } = req.body ?? {};
  console.log(`[recording-complete] call=${CallSid} recording=${RecordingSid} dur=${RecordingDuration}s`);
  if (CallSid && RecordingSid) {
    await pool.query(
      `UPDATE call_logs SET recording_sid = $1 WHERE id = $2`,
      [RecordingSid, CallSid]
    ).catch((err) => console.error('[recording-complete] db:', err.message));
  }
  res.status(204).end();
});

// POST /webhooks/voice/caller-hangup
// Optional status callback to mark calls as completed in DB.
app.post('/webhooks/voice/caller-hangup', verifyTwilioSignature, async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body ?? {};
  await logIvrEvent(CallSid, 'caller_hangup');
  await pool.query(
    `UPDATE call_logs
     SET status = $1, end_time = NOW(), duration = $2
     WHERE id = $3`,
    [
      CallStatus === 'completed' ? 'answered' : 'missed',
      CallDuration ? parseInt(CallDuration, 10) : null,
      CallSid,
    ]
  ).catch(() => {});
  res.status(204).end();
});

// ── Serve built frontend ───────────────────────────────────────────────────────
// When `npm run build` has been run, Express serves the React app so the entire
// softphone — including the Twilio Device — is accessible via the ngrok URL.
// This ensures the Device stays registered as long as a browser tab is open.
const distDir = join(__dirname, '..', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA fallback — any non-API path returns index.html
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(join(distDir, 'index.html'));
  });
  console.log(`✓ Serving frontend from ${distDir}`);
} else {
  console.log('ℹ No dist/ folder found — run "npm run build" to serve the frontend from Express');
}

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001);

initDb()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`✓ Contacts API listening on http://localhost:${PORT}`)
    );
  })
  .catch((err) => {
    console.error('✗ Database init failed:', err.message);
    console.error(
      '\nCheck that PostgreSQL is running and that .env has the correct credentials.'
    );
    process.exit(1);
  });
