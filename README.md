# Session Ripper v2
**WhatsApp Baileys Session Downloader — Render Hosted**

Connect via pairing code (no QR), then download your `auth_info_baileys/` folder as a ZIP.

---

## Deploy to Render (5 steps)

1. Push this folder to a **GitHub repo** (can be private)
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repo
4. Render auto-detects the `render.yaml` — just confirm:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Click **Deploy** — your public URL is ready in ~2 minutes

---

## File Structure

```
session-ripper/
├── server.js          ← Express + Baileys backend
├── package.json       ← Dependencies
├── render.yaml        ← Render config
├── .gitignore
└── public/
    └── index.html     ← Web UI
```

---

## Usage

1. Open your Render URL
2. Enter phone number (e.g. `+254712345678`)
3. Click **Initialize Connection**
4. Pairing code appears → go to WhatsApp → **Linked Devices → Link a Device → Link with phone number instead** → enter code
5. Green dot = connected
6. Click **Download Session ZIP**
7. Extract → use `auth_info_baileys/` in your bot

---

## Notes

- Each visitor gets an **isolated session** (UUID-based) — safe for public use
- Sessions auto-expire after 15 minutes if not connected
- Render's free tier sleeps after 15 min inactivity — first load may take ~30s to wake
- The `tmp_sessions/` folder is ephemeral on Render — download your session right after connecting
