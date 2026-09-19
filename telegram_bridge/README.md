# Telegram Mobile bridge (Sales Agent)

Links a **real Telegram user account** (the one on your phone) to Sales Agent — same idea as WhatsApp Mobile / Baileys. This is **not** a Telegram Bot.

## Setup

1. Open [https://my.telegram.org](https://my.telegram.org) → API development tools → create an app.
2. Copy **api_id** and **api_hash**.
3. Deploy this folder to Railway (Node) with a volume at `/data`.

### Env vars

| Variable | Required | Notes |
|----------|----------|--------|
| `TELEGRAM_API_ID` | yes | From my.telegram.org |
| `TELEGRAM_API_HASH` | yes | From my.telegram.org |
| `TELEGRAM_BRIDGE_SECRET` | yes | Same value as Sales Agent `TELEGRAM_BRIDGE_SECRET` |
| `TELEGRAM_SESSIONS_DIR` | no | Default `/data/telegram-sessions` when `/data` exists |
| `PORT` | no | Default `3003` |

### Sales Agent backend env

```
TELEGRAM_BRIDGE_URL=https://telegram-bridge-production-780a.up.railway.app
TELEGRAM_BRIDGE_SECRET=<same as Railway service TELEGRAM_BRIDGE_SECRET>
```

## Connect flow (dashboard)

1. Open **Telegram → Telegram Mobile**
2. Enter the phone number for your Telegram account (with country code)
3. Open Telegram on your phone → enter the login code
4. If 2FA is enabled, enter your cloud password
5. Status shows **Connected** — use test send

## Endpoints

- `GET /health`
- `GET /status?sessionId=`
- `POST /start-login` `{ sessionId, phone }`
- `POST /confirm-code` `{ sessionId, code }`
- `POST /confirm-password` `{ sessionId, password }`
- `POST /disconnect` `{ sessionId }`
- `POST /send` `{ sessionId, to, text }`

All mutating routes require header `x-bridge-secret`.
