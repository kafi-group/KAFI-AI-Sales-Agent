# Kafi WhatsApp Mobile Bridge (Baileys)

Microservice for managing per-user personal WhatsApp Mobile sessions via `@whiskeysockets/baileys`.

## Railway Deployment Instructions

1. Create a new service on **Railway** from this repository directory (`whatsapp_bridge/` root directory or root Dockerfile).
2. Set Environment Variables on Railway:
   - `PORT`: `3001` (or Railway default)
   - `WHATSAPP_BRIDGE_SECRET`: `<AGENT_BRIDGE_SECRET>` (matches backend secret)
   - `BACKEND_WEBHOOK_URL`: `https://kafi-sales-agent.up.railway.app` (URL of backend to sync inbound messages)
3. Copy the generated Railway Service Domain (e.g. `https://kafi-whatsapp-bridge.up.railway.app`).
4. Set `WHATSAPP_BRIDGE_URL` on your main Kafi Sales Agent Railway backend service:
   - `WHATSAPP_BRIDGE_URL`: `https://kafi-whatsapp-bridge.up.railway.app`
   - `WHATSAPP_BRIDGE_SECRET`: `<AGENT_BRIDGE_SECRET>`

## Features
- Multi-account per-user session isolation (`kafi-sales-agent-u1`, `kafi-sales-agent-u2`, etc.).
- 2-Way messaging sync with Sales Agent database (inbound & outbound).
- Auto-reconnect and persistent credentials state.
- Standard REST API endpoints (`/status`, `/qr`, `/disconnect`, `/send`).
