/**
 * Telegram Mobile bridge — link a real Telegram user account (phone + login code),
 * same role as Baileys for WhatsApp Mobile. Not a Bot API bot.
 *
 * Env:
 *   TELEGRAM_API_ID / TELEGRAM_API_HASH  — from https://my.telegram.org
 *   TELEGRAM_BRIDGE_SECRET              — shared with Sales Agent backend
 *   TELEGRAM_SESSIONS_DIR               — optional; defaults to /data/telegram-sessions or ./sessions
 *   BACKEND_WEBHOOK_URL                 — Sales Agent API base for inbound (optional later)
 *   PORT
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3003;
const BRIDGE_SECRET = (process.env.TELEGRAM_BRIDGE_SECRET || "").trim();
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = (process.env.TELEGRAM_API_HASH || "").trim();

const SESSIONS_DIR = (() => {
  const fromEnv = (process.env.TELEGRAM_SESSIONS_DIR || "").trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync("/data")) return path.join("/data", "telegram-sessions");
  return path.join(__dirname, "sessions");
})();

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}
console.log(`[Telegram Bridge] Sessions directory: ${SESSIONS_DIR}`);

/** @type {Map<string, any>} */
const sessions = new Map();

function requireSecret(req, res, next) {
  if (!BRIDGE_SECRET) return next();
  const got = String(req.headers["x-bridge-secret"] || "").trim();
  if (got !== BRIDGE_SECRET) {
    return res.status(401).json({ error: "Unauthorized bridge secret" });
  }
  return next();
}

function sessionPath(sessionId) {
  const safe = String(sessionId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(SESSIONS_DIR, `${safe}.session.json`);
}

function loadStoredSession(sessionId) {
  const p = sessionPath(sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function saveStoredSession(sessionId, data) {
  fs.writeFileSync(sessionPath(sessionId), JSON.stringify(data, null, 2), "utf8");
}

function deleteStoredSession(sessionId) {
  const p = sessionPath(sessionId);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function getOrCreateState(sessionId) {
  let st = sessions.get(sessionId);
  if (!st) {
    st = {
      sessionId,
      client: null,
      status: "disconnected",
      connected: false,
      phone: null,
      username: null,
      displayName: null,
      phoneCodeHash: null,
      pendingPhone: null,
      error: null,
    };
    sessions.set(sessionId, st);
  }
  return st;
}

async function ensureClient(sessionId, stringSession = "") {
  if (!API_ID || !API_HASH) {
    throw new Error(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH are required (create an app at https://my.telegram.org).",
    );
  }
  const st = getOrCreateState(sessionId);
  if (st.client) return st.client;

  const client = new TelegramClient(new StringSession(stringSession || ""), API_ID, API_HASH, {
    connectionRetries: 5,
  });
  st.client = client;
  return client;
}

async function refreshMe(st) {
  if (!st.client) return;
  try {
    const me = await st.client.getMe();
    st.connected = true;
    st.status = "connected";
    st.phone = me.phone ? `+${me.phone}` : st.phone;
    st.username = me.username || null;
    st.displayName = [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || st.phone;
    st.error = null;
  } catch (err) {
    st.connected = false;
    st.status = "disconnected";
    st.error = err instanceof Error ? err.message : String(err);
  }
}

async function restoreSession(sessionId) {
  const stored = loadStoredSession(sessionId);
  if (!stored?.stringSession) {
    const st = getOrCreateState(sessionId);
    st.status = "disconnected";
    st.connected = false;
    return st;
  }
  const st = getOrCreateState(sessionId);
  try {
    const client = await ensureClient(sessionId, stored.stringSession);
    if (!client.connected) {
      await client.connect();
    }
    const ok = await client.checkAuthorization();
    if (!ok) {
      st.status = "disconnected";
      st.connected = false;
      return st;
    }
    st.phone = stored.phone || null;
    await refreshMe(st);
    return st;
  } catch (err) {
    st.status = "disconnected";
    st.connected = false;
    st.error = err instanceof Error ? err.message : String(err);
    return st;
  }
}

function publicStatus(st) {
  return {
    sessionId: st.sessionId,
    status: st.status,
    connected: Boolean(st.connected),
    phone: st.phone,
    username: st.username,
    displayName: st.displayName,
    needsCode: st.status === "awaiting_code",
    needsPassword: st.status === "awaiting_password",
    pendingPhone: st.pendingPhone,
    error: st.error,
    configured: Boolean(API_ID && API_HASH),
  };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "kafi-telegram-bridge",
    configured: Boolean(API_ID && API_HASH),
  });
});

app.get("/status", requireSecret, async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    let st = sessions.get(sessionId);
    if (!st || !st.connected) {
      st = await restoreSession(sessionId);
    } else {
      await refreshMe(st);
    }
    return res.json(publicStatus(st));
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/start-login", requireSecret, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    let phone = String(req.body?.phone || "").trim().replace(/\s+/g, "");
    if (!sessionId || !phone) {
      return res.status(400).json({ error: "sessionId and phone are required" });
    }
    if (!phone.startsWith("+")) phone = `+${phone.replace(/^\+/, "")}`;

    const st = getOrCreateState(sessionId);
    if (st.client) {
      try {
        await st.client.disconnect();
      } catch {
        /* ignore */
      }
      st.client = null;
    }

    const client = await ensureClient(sessionId, "");
    await client.connect();
    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: API_ID,
        apiHash: API_HASH,
        settings: new Api.CodeSettings({}),
      }),
    );

    st.pendingPhone = phone;
    st.phoneCodeHash = result.phoneCodeHash;
    st.status = "awaiting_code";
    st.connected = false;
    st.error = null;

    return res.json({
      ...publicStatus(st),
      message: "Open Telegram on your phone — enter the login code you received.",
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/confirm-code", requireSecret, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const code = String(req.body?.code || "").trim();
    if (!sessionId || !code) {
      return res.status(400).json({ error: "sessionId and code are required" });
    }
    const st = getOrCreateState(sessionId);
    if (!st.client || !st.pendingPhone || !st.phoneCodeHash) {
      return res.status(400).json({
        error: "No pending login. Enter your phone number first.",
      });
    }

    try {
      await st.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: st.pendingPhone,
          phoneCodeHash: st.phoneCodeHash,
          phoneCode: code,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SESSION_PASSWORD_NEEDED|password/i.test(msg) || err?.errorMessage === "SESSION_PASSWORD_NEEDED") {
        st.status = "awaiting_password";
        st.error = null;
        return res.json({
          ...publicStatus(st),
          message: "Two-step verification is on — enter your Telegram password.",
        });
      }
      throw err;
    }

    const stringSession = st.client.session.save();
    st.phone = st.pendingPhone;
    saveStoredSession(sessionId, {
      stringSession,
      phone: st.phone,
      savedAt: new Date().toISOString(),
    });
    st.phoneCodeHash = null;
    st.pendingPhone = null;
    await refreshMe(st);
    return res.json({
      ...publicStatus(st),
      message: "Telegram Mobile connected.",
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/confirm-password", requireSecret, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const password = String(req.body?.password || "");
    if (!sessionId || !password) {
      return res.status(400).json({ error: "sessionId and password are required" });
    }
    const st = getOrCreateState(sessionId);
    if (!st.client) {
      return res.status(400).json({ error: "No pending login session." });
    }

    const { computeCheck } = require("telegram/Password");
    const passwordSrp = await st.client.invoke(new Api.account.GetPassword());
    const passwordCheck = await computeCheck(passwordSrp, password);
    await st.client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));

    const stringSession = st.client.session.save();
    st.phone = st.pendingPhone || st.phone;
    saveStoredSession(sessionId, {
      stringSession,
      phone: st.phone,
      savedAt: new Date().toISOString(),
    });
    st.phoneCodeHash = null;
    st.pendingPhone = null;
    await refreshMe(st);
    return res.json({
      ...publicStatus(st),
      message: "Telegram Mobile connected.",
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/disconnect", requireSecret, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const st = getOrCreateState(sessionId);
    if (st.client) {
      try {
        await st.client.invoke(new Api.auth.LogOut());
      } catch {
        /* ignore */
      }
      try {
        await st.client.disconnect();
      } catch {
        /* ignore */
      }
    }
    st.client = null;
    st.connected = false;
    st.status = "disconnected";
    st.phone = null;
    st.username = null;
    st.displayName = null;
    st.phoneCodeHash = null;
    st.pendingPhone = null;
    deleteStoredSession(sessionId);
    return res.json(publicStatus(st));
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/send", requireSecret, async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    const to = String(req.body?.to || req.body?.phone || "").trim();
    const text = String(req.body?.text || req.body?.message || "").trim();
    if (!sessionId || !to || !text) {
      return res.status(400).json({ error: "sessionId, to, and text are required" });
    }
    let st = sessions.get(sessionId);
    if (!st?.connected) {
      st = await restoreSession(sessionId);
    }
    if (!st?.client || !st.connected) {
      return res.status(409).json({ error: "Telegram Mobile is not connected for this user." });
    }

    let peer = to;
    if (/^\+?\d{8,15}$/.test(to.replace(/\s+/g, ""))) {
      const digits = to.replace(/\D/g, "");
      peer = `+${digits}`;
    }
    const entity = await st.client.getEntity(peer);
    const sent = await st.client.sendMessage(entity, { message: text });
    return res.json({
      ok: true,
      messageId: String(sent?.id || ""),
      to: peer,
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`[Telegram Bridge] listening on :${PORT}`);
  if (!API_ID || !API_HASH) {
    console.warn(
      "[Telegram Bridge] TELEGRAM_API_ID / TELEGRAM_API_HASH missing — get them at https://my.telegram.org",
    );
  }
});
