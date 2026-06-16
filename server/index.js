import express from 'express';
import cors from 'cors';
import pg from 'pg';
import twilio from 'twilio';
import { existsSync, readdirSync, statSync, createReadStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PGHOST     ?? 'localhost',
  port:     Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'Voip_3_db',
  user:     process.env.PGUSER     ?? 'postgres',
  password: process.env.PGPASSWORD ?? '',
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded POST bodies

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
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/contacts
app.get('/api/contacts', async (_req, res) => {
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
app.post('/api/contacts', async (req, res) => {
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
app.put('/api/contacts/:id', async (req, res) => {
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
app.delete('/api/contacts/:id', async (req, res) => {
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
app.get('/api/voicemails', async (_req, res) => {
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
app.post('/api/voicemails', async (req, res) => {
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
app.patch('/api/voicemails/:id/read', async (req, res) => {
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
app.delete('/api/voicemails/:id', async (req, res) => {
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
  };
}

// GET /api/call-logs?source=asterisk|twilio
app.get('/api/call-logs', async (req, res) => {
  const { source } = req.query;
  try {
    const { rows } = source
      ? await pool.query('SELECT * FROM call_logs WHERE source = $1 ORDER BY start_time DESC', [source])
      : await pool.query('SELECT * FROM call_logs ORDER BY start_time DESC');
    res.json(rows.map(rowToLog));
  } catch (err) {
    console.error('GET /api/call-logs:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/call-logs
app.post('/api/call-logs', async (req, res) => {
  const { id, source, direction, remoteIdentity, startTime, endTime, duration, status } = req.body ?? {};
  if (!id || !direction || !remoteIdentity || !startTime || !status) {
    return res.status(400).json({ error: 'id, direction, remoteIdentity, startTime, status are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO call_logs (id, source, direction, remote_identity, start_time, end_time, duration, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE
         SET end_time = EXCLUDED.end_time,
             duration = EXCLUDED.duration,
             status   = EXCLUDED.status
       RETURNING *`,
      [id, source ?? 'asterisk', direction, remoteIdentity, startTime, endTime ?? null, duration ?? null, status]
    );
    res.status(201).json(rows[0] ? rowToLog(rows[0]) : {});
  } catch (err) {
    console.error('POST /api/call-logs:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/call-logs?source=asterisk|twilio  (omit source to clear all)
app.delete('/api/call-logs', async (req, res) => {
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
app.get('/api/recordings/:sid', async (req, res) => {
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

// GET /api/sip-recordings — list all SIP recording files
app.get('/api/sip-recordings', (_req, res) => {
  try {
    if (!existsSync(SIP_MONITOR_DIR)) {
      return res.json([]);
    }
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
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(files);
  } catch (err) {
    console.error('GET /api/sip-recordings:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sip-recordings/:filename — stream a SIP recording file
app.get('/api/sip-recordings/:filename', (req, res) => {
  const { filename } = req.params;
  // Sanitise — only allow safe filenames
  if (!/^[\w\-]+\.(wav|mp3)$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = join(SIP_MONITOR_DIR, filename);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'Recording not found' });
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
app.post('/api/sip-recordings/link', async (req, res) => {
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
app.get('/api/ivr-events', async (req, res) => {
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
} = process.env;

// REST client used for outbound dials (agent ring-out) and call redirects.
// Uses API Key + Secret so no auth token is needed.
const twilioRest = (TWILIO_ACCOUNT_SID && TWILIO_API_KEY && TWILIO_API_SECRET)
  ? twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid: TWILIO_ACCOUNT_SID })
  : null;

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
app.get('/api/twilio/debug', (_req, res) => {
  res.json({
    TWILIO_ACCOUNT_SID:    TWILIO_ACCOUNT_SID   ? `${TWILIO_ACCOUNT_SID.slice(0, 6)}…`   : 'MISSING',
    TWILIO_API_KEY:        TWILIO_API_KEY        ? `${TWILIO_API_KEY.slice(0, 6)}…`        : 'MISSING',
    TWILIO_API_SECRET:     TWILIO_API_SECRET     ? '✓ set'                                 : 'MISSING',
    TWILIO_TWIML_APP_SID:  TWILIO_TWIML_APP_SID  ? `${TWILIO_TWIML_APP_SID.slice(0, 6)}…`  : 'MISSING',
    TWILIO_PHONE_NUMBER:   TWILIO_PHONE_NUMBER   ?? 'MISSING',
  });
});

// GET /api/twilio/token  — browser fetches this to register the Twilio Device
app.get('/api/twilio/token', (req, res) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET) {
    return res.status(503).json({ error: 'Twilio credentials not configured in .env' });
  }
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant  = AccessToken.VoiceGrant;

  const ext      = String(req.query.ext ?? '1001').replace(/\D/g, '').slice(0, 6);
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

app.post('/api/twilio/voice', (req, res) => {
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
app.post('/api/twilio/transfer', async (req, res) => {
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
app.post('/api/calls/status', (req, res) => {
  const { CallSid, CallStatus, Direction, From, To, CallDuration } = req.body ?? {};
  console.log(
    `[call-status] sid=${CallSid} status=${CallStatus} dir=${Direction} from=${From} to=${To} dur=${CallDuration ?? '–'}s`
  );
  res.status(204).end();
});

// POST /api/twilio/outbound — TwiML App calls this for browser-initiated PSTN calls
// Twilio passes the destination number as req.body.To
app.post('/api/twilio/outbound', (req, res) => {
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
app.post('/webhooks/voice/incoming', async (req, res) => {
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
app.post('/webhooks/voice/ivr', async (req, res) => {
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

// GET /webhooks/voice/hold-music
// Conference waitUrl — returns TwiML that plays hold music on loop while
// the caller waits for an agent to join.
app.get('/webhooks/voice/hold-music', (_req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.play({ loop: 99 },
    'https://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3'
  );
  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/connect-agent
// Places the PSTN caller into a named conference room (with hold music),
// then makes a Twilio REST outbound call to the browser softphone so the
// agent can join the same room.  If the agent does not answer within 20 s,
// agent-status redirects the waiting caller to the no-agent menu.
app.post('/webhooks/voice/connect-agent', async (req, res) => {
  const { CallSid } = req.body ?? {};
  const base = buildBaseUrl(req);
  const conferenceName = `ivr_conf_${CallSid}`;

  await logIvrEvent(CallSid, 'agent_ringing');

  // Look up the real caller's number so we can pass it through to the agent's
  // browser — the REST call below rings the agent FROM our own Twilio number,
  // so call.parameters['From'] on that leg would otherwise show our own
  // number instead of the actual caller.
  let realCaller = 'Unknown';
  try {
    const { rows } = await pool.query('SELECT remote_identity FROM call_logs WHERE id = $1', [CallSid]);
    if (rows[0]?.remote_identity) realCaller = rows[0].remote_identity;
  } catch (err) { console.error('[connect-agent] caller lookup:', err.message); }

  // Ring the browser softphone via REST. On answer, agent-join TwiML places
  // the agent into the conference. On no-answer/failure, agent-status
  // redirects the waiting caller out of the conference hold.
  // Query params on the client URI surface as call.customParameters in the
  // Voice JS SDK — this is how we smuggle the real caller ID through.
  if (twilioRest && TWILIO_PHONE_NUMBER) {
    const clientParams = new URLSearchParams({ realCaller, realCallSid: CallSid });
    twilioRest.calls.create({
      to:     `client:softphone-1001?${clientParams.toString()}`,
      from:   TWILIO_PHONE_NUMBER,
      url:    `${base}/webhooks/voice/agent-join?conference=${encodeURIComponent(conferenceName)}&callerSid=${encodeURIComponent(CallSid)}`,
      method: 'POST',
      timeout: 20,
      statusCallback:       `${base}/webhooks/voice/agent-status?callerSid=${encodeURIComponent(CallSid)}&base=${encodeURIComponent(base)}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent:  ['no-answer', 'busy', 'failed', 'canceled'],
    }).catch((err) => console.error('[connect-agent] REST dial:', err.message));
  } else {
    console.warn('[connect-agent] twilioRest not configured — agent will not be rung');
  }

  // Caller waits in conference with hold music until agent joins.
  // startConferenceOnEnter=false: conference has not started yet, caller hears waitUrl.
  // endConferenceOnExit=true: conference ends if the caller hangs up.
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Please hold while we connect you to an agent.');
  const dial = twiml.dial();
  dial.conference(conferenceName, {
    startConferenceOnEnter: 'false',
    endConferenceOnExit:    'true',
    waitUrl:    `${base}/webhooks/voice/hold-music`,
    waitMethod: 'GET',
  });

  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/agent-join?conference=...&callerSid=...
// TwiML served to the browser agent when their outbound call connects.
// Joining with startConferenceOnEnter=true starts the conference and
// bridges the agent with the waiting PSTN caller.
app.post('/webhooks/voice/agent-join', async (req, res) => {
  const { CallSid } = req.body ?? {};
  const conferenceName = decodeURIComponent(req.query.conference ?? '');
  const callerSid      = decodeURIComponent(req.query.callerSid  ?? '');

  await logIvrEvent(callerSid || CallSid, 'agent_answered');
  await pool.query(
    `UPDATE call_logs SET status = 'answered', ivr_completed = TRUE WHERE id = $1`,
    [callerSid]
  ).catch(() => {});

  const twiml = new twilio.twiml.VoiceResponse();
  const dial  = twiml.dial();
  dial.conference(conferenceName, {
    startConferenceOnEnter: 'true',   // starts the conference → caller and agent connected
    endConferenceOnExit:    'true',   // conference ends when agent hangs up
  });
  res.type('text/xml').send(twiml.toString());
});

// POST /webhooks/voice/agent-status?callerSid=...&base=...
// Twilio fires this when the outbound agent call ends without being answered
// (no-answer / busy / failed / canceled).
// Uses the REST API to redirect the waiting caller out of conference hold.
app.post('/webhooks/voice/agent-status', async (req, res) => {
  const callerSid  = decodeURIComponent(req.query.callerSid ?? '');
  const base       = decodeURIComponent(req.query.base      ?? '');
  const callStatus = req.body?.CallStatus ?? '';

  if (callerSid && base && twilioRest) {
    // 'canceled' means agent actively rejected the call → go straight to voicemail.
    // 'no-answer'/'busy'/'failed' → offer retry or voicemail via agent-dial-status.
    const target = callStatus === 'canceled'
      ? `${base}/webhooks/voice/voicemail`
      : `${base}/webhooks/voice/agent-dial-status`;
    try {
      await twilioRest.calls(callerSid).update({ url: target, method: 'POST' });
    } catch (err) {
      console.error('[agent-status] caller redirect failed:', err.message);
    }
  }
  res.status(204).end();
});

// POST /webhooks/voice/agent-dial-status
// Reached when the agent did not answer (redirected here by agent-status).
// Gives the caller the option to try again or leave a voicemail.
app.post('/webhooks/voice/agent-dial-status', async (req, res) => {
  const { CallSid } = req.body ?? {};
  const base = buildBaseUrl(req);

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
app.post('/webhooks/voice/no-agent-response', async (req, res) => {
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
app.post('/webhooks/voice/voicemail', async (req, res) => {
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
app.post('/webhooks/voice/voicemail-complete', async (req, res) => {
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
app.post('/webhooks/voice/transcription-callback', async (req, res) => {
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
app.post('/webhooks/voice/recording-complete', async (req, res) => {
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
app.post('/webhooks/voice/caller-hangup', async (req, res) => {
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
