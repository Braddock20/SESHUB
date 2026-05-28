const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const express  = require('express');
const archiver = require('archiver');
const path     = require('path');
const fs       = require('fs');
const pino     = require('pino');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions     = new Map();
const SESSIONS_BASE = path.join(__dirname, 'tmp_sessions');
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

const logger = pino({ level: 'silent' });

// ── Hardcoded latest stable WA Web version (avoids fetchLatestBaileysVersion
//    which can return a stale/wrong version on Render's network)
const WA_VERSION = [2, 3000, 1015901307];

function getSessionDir(id) { return path.join(SESSIONS_BASE, id); }

function killSocket(s) {
  if (!s) return;
  try { s.ws?.terminate?.(); } catch (_) {}
  try { s.end?.(); }           catch (_) {}
}

function cleanupSession(id) {
  const s = sessions.get(id);
  if (s?.sock) killSocket(s.sock);
  try { fs.rmSync(getSessionDir(id), { recursive: true, force: true }); } catch (_) {}
  sessions.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > 20 * 60 * 1000) cleanupSession(id);
  }
}, 3 * 60 * 1000);

// ── spawn (or re-spawn) a Baileys socket for a session ──────────────────────
async function spawnSocket(sessionId, sessionDir, state) {
  // Always re-read creds from disk (important for reconnect after pairing)
  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    version: WA_VERSION,
    auth: {
      creds: authState.creds,
      keys:  makeCacheableSignalKeyStore(authState.keys, logger),
    },
    logger,
    printQRInTerminal:              false,
    // Browsers.ubuntu('Chrome') produces the exact header WA Web expects
    browser:                        Browsers.ubuntu('Chrome'),
    mobile:                         false,
    syncFullHistory:                false,
    markOnlineOnConnect:            false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs:            25_000,
    connectTimeoutMs:               60_000,
    defaultQueryTimeoutMs:          60_000,
    getMessage: async () => ({ conversation: '' }),
  });

  state.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    const code = lastDisconnect?.error?.output?.statusCode;
    console.log(`[${sessionId.slice(0,8)}] conn=${connection ?? '?'} code=${code ?? '-'} st=${state.status}`);

    // ── OPEN ──────────────────────────────────────────────────────────────────
    if (connection === 'open') {
      // Reconnect after pairing: user accepted code in WA app
      if (state.pairingCode && !authState.creds.registered) {
        // creds may not be fully saved yet; wait a tick
        await new Promise(r => setTimeout(r, 800));
        // Re-read to get updated registered state
        const fresh = await useMultiFileAuthState(sessionDir);
        if (fresh.state.creds.registered || sock.user) {
          state.status = 'connected';
          state.phone  = sock.user?.id || 'unknown';
          console.log(`[${sessionId.slice(0,8)}] ✓ Connected as ${state.phone}`);
          return;
        }
      }
      // Already registered (session restore)
      if (authState.creds.registered || sock.user) {
        state.status = 'connected';
        state.phone  = sock.user?.id || 'unknown';
        console.log(`[${sessionId.slice(0,8)}] ✓ Restored session: ${state.phone}`);
        return;
      }
      // First-time open: request pairing code
      if (!state.pairingCode && state.status !== 'code_ready') {
        state.status = 'requesting_code';
        try {
          await new Promise(r => setTimeout(r, 600));
          const code = await sock.requestPairingCode(state.cleanedPhone);
          state.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
          state.status      = 'code_ready';
          console.log(`[${sessionId.slice(0,8)}] Code: ${state.pairingCode}`);
        } catch (e) {
          console.error(`[${sessionId.slice(0,8)}] requestPairingCode err:`, e.message);
          state.status   = 'error';
          state.errorMsg = e.message;
        }
      }
    }

    // ── CLOSE ─────────────────────────────────────────────────────────────────
    else if (connection === 'close') {
      // Logged out by WA (440)
      if (code === DisconnectReason.loggedOut) {
        state.status = 'logged_out';
        return;
      }

      // 401 on a cloud server almost always = WA IP ban / rate limit.
      // Back off 8 seconds then retry once.
      if (code === 401) {
        if (state._401retries >= 2) {
          state.status   = 'error';
          state.errorMsg = 'WhatsApp rejected this server (401). Try again in a few minutes.';
          return;
        }
        state._401retries = (state._401retries || 0) + 1;
        console.log(`[${sessionId.slice(0,8)}] 401 — retry ${state._401retries} in 8s`);
        await new Promise(r => setTimeout(r, 8000));
        spawnSocket(sessionId, sessionDir, state).catch(e => {
          state.status = 'error'; state.errorMsg = e.message;
        });
        return;
      }

      // Normal close while waiting for pairing confirmation → WA is doing its
      // reconnect dance. Spawn again.
      if (['code_ready', 'requesting_code', 'connected'].includes(state.status)) {
        console.log(`[${sessionId.slice(0,8)}] Close during ${state.status} — respawning in 2s`);
        await new Promise(r => setTimeout(r, 2000));
        spawnSocket(sessionId, sessionDir, state).catch(e => {
          state.status = 'error'; state.errorMsg = e.message;
        });
        return;
      }

      state.status   = 'error';
      state.errorMsg = `Connection closed (${code})`;
    }
  });

  return sock;
}

// ─── POST /api/connect ───────────────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.length < 7) return res.status(400).json({ error: 'Invalid phone number' });

  const sessionId  = uuidv4();
  const sessionDir = getSessionDir(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const state = {
    sessionId, cleanedPhone: cleaned,
    status: 'starting', pairingCode: null,
    phone: null, sock: null,
    createdAt: Date.now(), _401retries: 0,
  };
  sessions.set(sessionId, state);

  try {
    await spawnSocket(sessionId, sessionDir, state);

    // Wait for code_ready or error, max 30s
    const deadline = Date.now() + 30_000;
    while (!['code_ready', 'error', 'logged_out', 'connected'].includes(state.status)
           && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 400));
    }

    if (state.status === 'error') {
      cleanupSession(sessionId);
      return res.status(500).json({ error: state.errorMsg || 'Connection failed' });
    }

    return res.json({ sessionId, status: state.status, pairingCode: state.pairingCode });
  } catch (err) {
    console.error('[connect fatal]', err.message);
    cleanupSession(sessionId);
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
  if (!s)                       return res.status(404).json({ error: 'Session not found' });
  if (s.status !== 'connected') return res.status(400).json({ error: 'Not connected yet' });

  const dir = getSessionDir(req.params.id);
  if (!fs.existsSync(dir))      return res.status(404).json({ error: 'Session files missing' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="baileys_session.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', e => { console.error(e); res.status(500).end(); });
  archive.pipe(res);
  archive.directory(dir, 'auth_info_baileys');
  archive.finalize();
});

// ─── POST /api/disconnect/:id ────────────────────────────────────────────────
app.post('/api/disconnect/:id', (req, res) => {
  cleanupSession(req.params.id);
  res.json({ status: 'ok' });
});

app.get('/health', (_, res) => res.json({ ok: true, sessions: sessions.size }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   SESSION RIPPER v2.3 — Port ${PORT}   ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});
