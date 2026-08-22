const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const BRIDGE_SECRET = (process.env.WHATSAPP_BRIDGE_SECRET || "").trim();
const SESSIONS_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const logger = pino({ level: "silent" });

// In-memory active session tracking
// Map<sessionId, { sock, connected, phone, qr, qrDataUrl, status }
const activeSessions = new Map();

// Security middleware
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/") return next();
  if (BRIDGE_SECRET) {
    const provided = req.headers["x-bridge-secret"] || req.query.secret;
    if (provided !== BRIDGE_SECRET) {
      return res.status(401).json({ error: "Unauthorized: Invalid bridge secret" });
    }
  }
  next();
});

function getSessionDir(sessionId) {
  const safeId = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(SESSIONS_DIR, safeId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

async function initBaileysSession(sessionId, forceNew = false) {
  const safeSessionId = String(sessionId || "default").trim();
  if (!safeSessionId) throw new Error("Session ID is required");

  let existing = activeSessions.get(safeSessionId);
  if (existing && !forceNew) {
    return existing;
  }

  if (existing && existing.sock) {
    try {
      existing.sock.ev.removeAllListeners();
      existing.sock.end();
    } catch (e) {
      // Ignore cleanup error
    }
  }

  const sessionDir = getSessionDir(safeSessionId);

  if (forceNew) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (e) {
      console.error(`[Session ${safeSessionId}] Error clearing directory:`, e);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    defaultQueryTimeoutMs: 60000,
  });

  const sessionObj = {
    sock,
    connected: false,
    phone: null,
    qr: null,
    qrDataUrl: null,
    status: "disconnected",
  };

  activeSessions.set(safeSessionId, sessionObj);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionObj.qr = qr;
      sessionObj.status = "qr-pending";
      sessionObj.connected = false;
      try {
        sessionObj.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (err) {
        console.error(`[Session ${safeSessionId}] Error generating QR data URL:`, err);
      }
    }

    if (connection === "open") {
      sessionObj.connected = true;
      sessionObj.status = "connected";
      sessionObj.qr = null;
      sessionObj.qrDataUrl = null;
      const jid = sock.user?.id || "";
      const rawNum = jid.split("@")[0].split(":")[0];
      sessionObj.phone = rawNum ? `+${rawNum}` : null;
      console.log(`[Session ${safeSessionId}] Connected as ${sessionObj.phone || jid}`);
    }

    if (connection === "close") {
      sessionObj.connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      sessionObj.status = "disconnected";

      console.log(
        `[Session ${safeSessionId}] Closed. Reason: ${statusCode}, reconnecting: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        setTimeout(() => {
          initBaileysSession(safeSessionId, false).catch((err) => {
            console.error(`[Session ${safeSessionId}] Reconnect failed:`, err);
          });
        }, 3000);
      } else {
        // Logged out — purge directory
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) {
          // Ignore
        }
        activeSessions.delete(safeSessionId);
      }
    }
  });

  return sessionObj;
}

// Helper to format recipient phone into JID
function formatJid(phone) {
  let cleaned = String(phone || "").replace(/\D/g, "");
  if (!cleaned) throw new Error("Invalid phone number");
  if (!cleaned.endsWith("@s.whatsapp.net")) {
    cleaned = `${cleaned}@s.whatsapp.net`;
  }
  return cleaned;
}

// --- Endpoints ---

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "kafi-whatsapp-bridge",
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({
    service: "kafi-whatsapp-bridge",
    description: "Baileys WhatsApp Mobile multi-session bridge",
  });
});

app.get("/status", async (req, res) => {
  const sessionId = req.query.session || req.query.sessionId || "default";
  try {
    let sessionObj = activeSessions.get(sessionId);
    if (!sessionObj) {
      sessionObj = await initBaileysSession(sessionId, false);
    }
    return res.json({
      session: sessionId,
      connected: Boolean(sessionObj.connected),
      status: sessionObj.status,
      phone: sessionObj.phone,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, session: sessionId });
  }
});

app.get("/qr", async (req, res) => {
  const sessionId = req.query.session || req.query.sessionId || "default";
  try {
    let sessionObj = activeSessions.get(sessionId);
    if (!sessionObj || sessionObj.connected) {
      sessionObj = await initBaileysSession(sessionId, !sessionObj);
    }

    if (sessionObj.connected) {
      return res.json({
        session: sessionId,
        connected: true,
        status: "connected",
        phone: sessionObj.phone,
        qr: null,
        qrDataUrl: null,
      });
    }

    return res.json({
      session: sessionId,
      connected: false,
      status: sessionObj.status || "qr-pending",
      qr: sessionObj.qr,
      qrDataUrl: sessionObj.qrDataUrl,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, session: sessionId });
  }
});

app.post("/disconnect", async (req, res) => {
  const sessionId = req.body?.session || req.body?.sessionId || req.query?.session || "default";
  try {
    const existing = activeSessions.get(sessionId);
    if (existing && existing.sock) {
      try {
        await existing.sock.logout();
      } catch (e) {
        existing.sock.end();
      }
    }
    const sessionDir = path.join(SESSIONS_DIR, String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_"));
    fs.rmSync(sessionDir, { recursive: true, force: true });
    activeSessions.delete(sessionId);
    return res.json({ ok: true, session: sessionId, connected: false, status: "disconnected" });
  } catch (err) {
    return res.status(500).json({ error: err.message, session: sessionId });
  }
});

app.post("/send", async (req, res) => {
  const sessionId = req.body?.session || req.body?.sessionId || "default";
  const toPhone = req.body?.to || req.body?.phone || req.body?.to_phone;
  const message = req.body?.message || req.body?.text;

  if (!toPhone) return res.status(400).json({ error: "Missing recipient phone number (to)" });
  if (!message) return res.status(400).json({ error: "Missing message text" });

  try {
    let sessionObj = activeSessions.get(sessionId);
    if (!sessionObj || !sessionObj.connected) {
      return res.status(409).json({
        error: "Personal WhatsApp is not connected. Open WhatsApp Mobile and scan QR.",
        connected: false,
      });
    }

    const jid = formatJid(toPhone);
    const sent = await sessionObj.sock.sendMessage(jid, { text: message });

    return res.json({
      status: "sent",
      session: sessionId,
      to: toPhone,
      jid,
      messageId: sent.key.id,
    });
  } catch (err) {
    console.error(`[Session ${sessionId}] Send error:`, err);
    return res.status(500).json({ error: err.message || "Failed to send message" });
  }
});

app.listen(PORT, () => {
  console.log(`[WhatsApp Bridge] Listening on port ${PORT}`);
});
