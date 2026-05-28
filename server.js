const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  PHONENUMBER_MCC,
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

const sessions = new Map();
const SESSIONS_BASE = path.join(__dirname, 'tmp_sessions');
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

const logger = pino({ level: 'silent' });

function getSessionDir(id) { return path.join(SESSIONS_BASE, id); }

function cleanupSession(id) {
  const s = sessions.get(id);
  if (s?.sock) { try { s.sock.ws?.close(); } catch (_) {} }
  try { fs.rmSync(getSessionDir(id), { recursive: true, force: true }); } catch (_) {}
  sessions.delete(id);
}

// Auto-cleanup stale sessions every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    const stale = now - s.createdAt > 15 * 60 * 1000;
    const dead  = ['error','logged_out','disconnected'].includes(s.status) && now - s.createdAt > 2 * 60 * 1000;
    if (stale || dead) cleanupSession(id);
  }
}, 2 * 60 * 1000);

// ─── POST /api/connect ───────────────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.length < 7) return res.status(400).json({ error: 'Invalid phone number' });

  // Check MCC support (optional guard)
  const countryCode = cleaned.slice(0, 3);
  const hasMCC = Object.keys(PHONENUMBER_MCC || {}).some(k => countryCode.startsWith(k) || cleaned.startsWith(k));

  const sessionId = uuidv4();
  const sessionDir = getSessionDir(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const state = {
    sessionId, status: 'starting',
    pairingCode: null, phone: null, sock: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionId, state);

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[${sessionId.slice(0,8)}] WA version: ${version.join('.')}`);

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      // Use a known-good browser fingerprint for pairing code
      browser: ['Ubuntu', 'Chrome', '121.0.6167.159'],
      mobile: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      // Required for newer Baileys — prevents missing store errors
      getMessage: async () => ({ conversation: 'hello' }),
    });

    state.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    // Track connection state
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${sessionId.slice(0,8)}] connection.update → ${connection}, code=${code}`);

      if (connection === 'open') {
        state.status = 'connected';
        state.phone  = sock.user?.id || 'unknown';
        console.log(`[${sessionId.slice(0,8)}] ✓ Connected as ${state.phone}`);
      } else if (connection === 'close') {
        if (code === DisconnectReason.loggedOut) {
          state.status = 'logged_out';
        } else if (state.status !== 'code_ready' && state.status !== 'connected') {
          // Only mark error if we haven't gotten a code yet
          state.status = 'error';
          state.errorMsg = `Connection closed (${code})`;
        }
      }
    });

    // CRITICAL: wait for socket to actually open before requesting code
    // Baileys needs the WS handshake to complete first
    if (!authState.creds.registered) {
      state.status = 'waiting_open';

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Socket open timeout')), 15000);

        sock.ev.on('connection.update', ({ connection }) => {
          if (connection === 'connecting') {
            // still waiting
          } else if (connection === 'open' || sock.ws?.readyState === 1) {
            clearTimeout(timeout);
            resolve();
          } else if (connection === 'close') {
            clearTimeout(timeout);
            // Don't reject here — requestPairingCode can still work right after open
            resolve();
          }
        });

        // Also poll ws state as fallback
        const poll = setInterval(() => {
          if (sock.ws?.readyState === 1) {
            clearInterval(poll);
            clearTimeout(timeout);
            resolve();
          }
        }, 200);
        setTimeout(() => clearInterval(poll), 15000);
      });

      // Small buffer after open
      await new Promise(r => setTimeout(r, 500));

      state.status = 'requesting_code';

      const code = await sock.requestPairingCode(cleaned);
      state.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
      state.status = 'code_ready';
      console.log(`[${sessionId.slice(0,8)}] Pairing code: ${state.pairingCode}`);
    } else {
      state.status = 'connecting';
    }

    return res.json({ sessionId, status: state.status, pairingCode: state.pairingCode });

  } catch (err) {
    console.error(`[${sessionId.slice(0,8)}] Error:`, err.message);
    state.status = 'error';
    state.errorMsg = err.message;
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/status/:id ─────────────────────────────────────────────────────
app.get('/api/status/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: s.status, pairingCode: s.pairingCode, phone: s.phone, error: s.errorMsg });
});

// ─── GET /api/download/:id ───────────────────────────────────────────────────
app.get('/api/download/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s)                     return res.status(404).json({ error: 'Session not found' });
  if (s.status !== 'connected') return res.status(400).json({ error: 'Not connected yet' });

  const dir = getSessionDir(req.params.id);
  if (!fs.existsSync(dir))    return res.status(404).json({ error: 'Session files missing' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="baileys_session.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { console.error('Archive error:', err); res.status(500).end(); });
  archive.pipe(res);
  archive.directory(dir, 'auth_info_baileys');
  archive.finalize();
});

// ─── POST /api/disconnect/:id ────────────────────────────────────────────────
app.post('/api/disconnect/:id', (req, res) => {
  cleanupSession(req.params.id);
  res.json({ status: 'ok' });
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, sessions: sessions.size }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   SESSION RIPPER v2.1 — Port ${PORT}   ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});
