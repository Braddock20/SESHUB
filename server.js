const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const express = require('express');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory session store { sessionId -> sessionState }
const sessions = new Map();

const SESSIONS_BASE = path.join(__dirname, 'tmp_sessions');
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

function getSessionDir(sessionId) {
  return path.join(SESSIONS_BASE, sessionId);
}

function cleanupSession(sessionId) {
  const dir = getSessionDir(sessionId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  sessions.delete(sessionId);
}

// Auto-cleanup sessions older than 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > 15 * 60 * 1000 && s.status !== 'connected') {
      if (s.sock) try { s.sock.end(); } catch (_) {}
      cleanupSession(id);
    }
  }
}, 60 * 1000);

// ─── POST /api/connect ───────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.length < 7) return res.status(400).json({ error: 'Invalid phone number' });

  const sessionId = uuidv4();
  const sessionDir = getSessionDir(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const state = {
    sessionId,
    status: 'starting',
    pairingCode: null,
    phone: null,
    sock: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionId, state);

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Chrome (Linux)', '', ''],
      mobile: false,
    });

    state.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        state.status = 'connected';
        state.phone = sock.user?.id || 'unknown';
        console.log(`[${sessionId.slice(0, 8)}] Connected as: ${state.phone}`);
      } else if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        state.status = reason === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected';
        console.log(`[${sessionId.slice(0, 8)}] Closed. Reason: ${reason}`);
      }
    });

    // Request pairing code
    if (!authState.creds.registered) {
      state.status = 'requesting_code';
      const code = await sock.requestPairingCode(cleaned);
      state.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
      state.status = 'code_ready';
      console.log(`[${sessionId.slice(0, 8)}] Pairing code: ${state.pairingCode}`);
    } else {
      state.status = 'connecting';
    }

    return res.json({ sessionId, status: state.status, pairingCode: state.pairingCode });
  } catch (err) {
    state.status = 'error';
    console.error(`[connect error]`, err.message);
    cleanupSession(sessionId);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/status/:sessionId ──────────────────────────────────────
app.get('/api/status/:sessionId', (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: s.status, pairingCode: s.pairingCode, phone: s.phone });
});

// ─── GET /api/download/:sessionId ────────────────────────────────────
app.get('/api/download/:sessionId', (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status !== 'connected') return res.status(400).json({ error: 'Not connected yet' });

  const sessionDir = getSessionDir(req.params.sessionId);
  if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: 'Session files missing' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="baileys_session.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => {
    console.error('Archive error:', err);
    res.status(500).end();
  });
  archive.pipe(res);
  archive.directory(sessionDir, 'auth_info_baileys');
  archive.finalize();
});

// ─── POST /api/disconnect/:sessionId ─────────────────────────────────
app.post('/api/disconnect/:sessionId', (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (s) {
    if (s.sock) try { s.sock.end(); } catch (_) {}
    cleanupSession(s.sessionId);
  }
  res.json({ status: 'ok' });
});

// ─── Health check for Render ─────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, sessions: sessions.size }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   SESSION GATE — Ready on :${PORT}   ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});
