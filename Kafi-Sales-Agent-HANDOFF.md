# Kafi Sales Agent — Personal Handoff Notes

**Save this file to USB or email it to yourself.**  
It is self-contained — you do not need the repo or Cursor history to understand what was built, what is left, and how to continue.

**Created:** 18 August 2026  
**Author context:** Shumyle — Senior AI Forward Deployed Engineer taking over from junior  
**Client:** Kafi Commodities (Pvt) Ltd — Pakistani FMCG exporter since 1982  
**Product:** Sellara AI / Kafi Sales Agent (sales co-pilot for export team)

---

## How to use this on a new computer

1. Keep this `.md` file (USB, email attachment, cloud drive).
2. Clone the repo from GitHub (see below) or copy the project folder from the old PC.
3. Open the project in **Cursor**.
4. Start a new AI chat and say:

   > I attached my handoff notes. Read `Kafi-Sales-Agent-HANDOFF.md` and help me continue the Sales Agent work.

5. Optionally attach this file to the chat.

---

## Get the code (new PC)

**GitHub (canonical remote on dev machine):**
```
https://github.com/kafi-group/Kafi-Sales-Agent.git
```
Branch: `main`

**Clone:**
```bash
git clone https://github.com/kafi-group/Kafi-Sales-Agent.git
cd Kafi-Sales-Agent
```

**Note:** A Cursor rule in the repo mentions `izoo2003/Kafi-Sales-Agent` — confirm with Kafi IT which GitHub org is official before pushing.

**Where the latest code lived on the old PC (Aug 2026):**
```
D:\First AI World\Cursor Projects\sales, social, hr Aug 2026\Kafi-Sales-Agent
```
*(This folder had uncommitted AI Sales Agent fixes — see § “Not yet deployed” below.)*

**Older partial copy (do not use as primary):**
```
D:\First AI World\agent acquisition\Sales Agent\Kafi-Sales-Agent-main
```

**Env secrets:** Junior left root files named `env` and `env (1)` — copy to `backend/.env` and `frontend/.env`. Never commit these.

**ERP SQL backups (separate from Sales Agent):**
```
D:\First AI World\experiment\
```
Contains `kafigroup_erp.sql` and demo DB dumps — MariaDB, not Supabase.

---

## Production URLs & accounts

| What | Where |
|------|--------|
| **Live app** | https://kafi-sales-agent.vercel.app |
| **Backend API** | https://kafi-sales-agent.up.railway.app |
| **API docs** | https://kafi-sales-agent.up.railway.app/docs |
| **Database** | Supabase PostgreSQL (`DATABASE_URL`) |
| **Bulk email app** | Vercel mailer — URL in `MAILER_PUBLIC_URL` env |
| **Quotation tool** | https://bank-recon-demo.vercel.app/cnf |

**All service accounts** (GitHub, Railway, Vercel, Supabase, Google AI, Meta, Twilio, cPanel) are on **Kafi official email**. Staff have passwords + TFA on shared phones.

**Run locally:**
```bash
cd backend && python run.py    # port 8001, auto-migrates DB
cd frontend && npm run dev
cd mailer && npm run dev       # bulk email sender only
```

---

## What this agent is

A **sales co-pilot, not autopilot** for Kafi’s international sales team.

**Products Kafi exports:** Basmati/non-Basmati rice, chutneys, sauces, pickles, Himalayan pink salt (Essence brand), spices, honey, recipe mixes, etc.  
**Markets:** Middle East, Europe, Africa, North America, Asia.  
**Certs:** ISO, HACCP, Halal.

**Pipeline (how the app thinks):**
1. **Discover** leads — AI search, CSV, manual entry, trade show lists  
2. **Research & score** — website, product fit, AAA/AA/A grading, HOT/WARM/COLD  
3. **Work leads** — calls, email, WhatsApp, bulk campaigns  
4. **Human approval** — AI drafts; humans approve before send  
5. **KPI & lifecycle** — New Lead → Won/Lost, daily reports, follow-ups  

**Core rule:** Outbound messages are **drafts** until a human approves (except admin-enabled AI Mode auto-reply).

**Ideal buyers:** Importers, distributors, wholesalers, supermarket/HORECA chains, individual traders/brokers.

---

## App modules (sidebar)

| Module | What it does |
|--------|----------------|
| Indexes | Reference indexes |
| User Manual | In-app help |
| WhatsApp | Inbox, templates, activity |
| Searched by AI | Web-powered lead discovery |
| Smart Data Clean & Merge | Admin — dedupe/merge (admin only) |
| **Master Table** | Main CRM grid — leads, assign, bulk email, queue AI calls |
| Emails | Inbox, Sent, Drafts, Trash, Archive, Email Activity, templates |
| Bulk Email Sender | Opens Vercel mailer for mass campaigns |
| Call Center | Human calls via Twilio in browser |
| Client History | Timeline per client |
| Helpful Guidance | Coaching + real call exemplars for AI/humans |
| CNF or FOB | External quotation agent |
| Brand assistant | Product chatbot (ESSENCE catalog) |
| FAQ | Management/sales FAQ (external link) |
| AI Mode | Overnight email/WhatsApp auto-reply + company lifecycle |
| **AI Sales Agent** | Rayan & Sara — server-side Twilio AI outbound calls |
| KPI | Daily KPI + manual off-system KPI log |
| Users / Settings | Admin only |

---

## People & logins

| Name | Role | Notes |
|------|------|-------|
| Mr Khalid | Director | Primary stakeholder, admin, impatient |
| Mr Hafeez | Admin & accountant | cPanel access, loyal to Khalid |
| Qaiser | IT | Domain/server politics, loud |
| Shumyle | You — AI FDE | Building/taking over |
| **shumyle** | Test app login | Dummy account for testing |
| Rayan / Sara | **AI personas** | Not human logins — AI phone agents |
| usmankhan / asim | Mailbox KPI labels | Mapped to Rayan / Sara AI |

**ERP (separate system, not in Sales Agent yet):**
- URL: https://erp.kafi-group.com/
- Hosted: HNS / cPanel (hns.net.pk)
- Builder: Mr Sufyan (3rd party)
- DB: MariaDB `kafigroup_erp` — backups in `experiment` folder
- **Status:** Not integrated. Plan was read-only phase first. Needs Khalid sign-off + Qaiser/Hafeez cooperation for cPanel backup.

**Website:** https://kafi-group.com/ — chatbot on site was replaced/improved by your work.

---

## Architecture (for developers)

```
backend/     Python FastAPI — api/ → modules/ → integrations/ + db/
frontend/    React + Vite — src/api/client.ts is the ONLY API layer
mailer/      Next.js on Vercel — SMTP bulk + compose
```

**Rules:**
- `api/` never queries DB directly  
- No LinkedIn scraping  
- No auto-send cold outreach by default  
- Audit log for drafts, edits, approvals, sends  

**Lead intelligence pipeline:** Discover → Research → Product fit → Score HOT/WARM/COLD → Upsell/cross-sell → Comms drafts → Scheduler jobs  

**Product data files:**
- `backend/data/kafi_essence_catalog.json` — 177 ESSENCE SKUs  
- `backend/data/category_price_tiers.json`  
- `backend/data/kafi_carton_dimensions.json`  

---

## DONE — already pushed to GitHub (`main`)

| Commit | What shipped |
|--------|----------------|
| `0051539` | WhatsApp/inbox speed; inbox triage counts; WhatsApp template **View**; mailer paste/images smaller + deletable; larger global font; AI Mode email preview faster |
| `0a638ad` | Email modes **regular / bulk / test**; bulk = one Sent summary in Outlook; Email Activity failure breakdown; KPI test email count |
| `c32c23b` | Master Table: **Assign to** (humans only) separate from **Queue AI calls** (Rayan/Sara); bulk assign keeps rows on Master Table; assign dropdown works for ryan/shumyle |
| `565574a` | Master Table + dashboard performance |
| `26cc6e0` | IVR dialpad (DTMF) on live calls |
| `d353c89` | AI Sales Agent call improvements; Manual KPI columns; bulk email salutations |
| `ec81cc9` | AI Sales Agent locked behind access code |
| `60dd6dd` | **AI Sales Agent module** — Rayan (male) + Sara (female) Twilio outbound queue |

---

## DONE locally — NOT yet committed or deployed (18 Aug 2026)

**Important:** These fixes exist on the dev PC working copy only. Production may not have them until someone commits, pushes, and redeploys Railway + Vercel.

### AI Sales Agent — phone/name not showing in queue
**User issue:** Queued self to Sara via Master Table but couldn’t see name/number in AI Sales Agent to test a call.

**Why:**
- Queue AI calls dials the **lead row’s contact phone**, not your login name  
- Page requires **access code** before queue loads (default `786786`)  
- Bug: phone in **Primary Mobile** only was not always detected  

**Fixes written (files changed):**
- `backend/modules/calls.py` — detect all phone fields  
- `backend/modules/buyers.py` — same  
- `backend/modules/ai_sales_agent/campaign.py` — auto-link contact; self-test queue helper  
- `backend/api/ai_sales_agent.py` — new endpoint `POST /api/ai-sales-agent/tasks/self-test`  
- `frontend/src/pages/AiSalesAgentPage.tsx` — **“Test call to your phone”** section  
- `frontend/src/pages/LeadsTablePage.tsx` — pass contact IDs when queueing  
- `frontend/src/api/client.ts` — `queueAiSalesAgentSelfTest`  

**Suggested commit message:**  
*Fix AI Sales Agent contact resolution and add self-test call queue*

---

## NOT DONE — backlog / next work

### Urgent
- [ ] Commit + push + deploy AI Sales Agent fixes (above)  
- [ ] Test: unlock AI Sales Agent → self-test call → Start calling (Twilio env on Railway)  
- [ ] Confirm which GitHub remote is official (kafi-group vs izoo2003)  

### Product phases (original roadmap)
- [x] Leads, scoring, Master Table — largely done  
- [ ] Quotations end-to-end in-app (external CNF agent exists)  
- [ ] Approval loop polish (Gmail-first send)  
- [ ] Scheduler — birthdays, national days, follow-ups with consent  
- [ ] Compliance UI — consent, audit viewer, robots.txt enforcement  
- [ ] More integrations — inbound webhooks  
- [ ] LLM prompts replace templates (stub in `llm_client.py`)  
- [ ] Production hardening — auth, monitoring  

### Known gaps
- Bulk email via **in-app template path** may skip per-message Sent but not always add the one summary (mailer bulk path does)  
- **Microsoft Graph OAuth** bulk sends may still save every message to Sent  
- **ERP integration** — political; needs backup from cPanel first  

---

## Feature cheat sheet (from our conversations)

### Email modes

| Mode | Use | Outlook Sent folder |
|------|-----|---------------------|
| **Regular** | One-off compose / inbox reply | Each email saved |
| **Bulk** | Bulk Email Sender from Master Table | Individual bulk emails **not** saved; **one summary** after batch: `[Bulk 45/50] Your subject` with recipient list |
| **Test** | Mailer compose Test mode | Each test saved; goes to test recipients env var |

**Bulk emails are NOT deleted from Outlook** — they are never saved one-by-one; only one summary is appended.

### Master Table — two different buttons

| Button | Meaning |
|--------|---------|
| **Assign to** | Human rep owns the lead (shumyle, ryan, etc.) |
| **Queue AI calls → Rayan/Sara** | AI agent will call the **lead’s phone number** |

These are separate controls (fixed Aug 2026 — AI options removed from Assign dropdown).

### AI Sales Agent — how to test a call

1. **Option A:** Master Table → edit row with **your name + mobile** → select row → **Queue AI calls → Sara**  
2. **Option B (after local fixes deploy):** AI Sales Agent page → **Test call to your phone**  
3. Open **AI Sales Agent** → enter code **`786786`**  
4. Filter **Sara** → click **Start calling**  
5. Needs Twilio on Railway: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_WEBHOOK_BASE_URL`

**Personas:**
- **Rayan** (male) — Twilio voice Polly.Matthew — KPI mailbox user `usmankhan`  
- **Sara** (female) — Twilio voice Polly.Joanna — KPI mailbox user `asim`  

---

## Key environment variables (backend)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Supabase Postgres |
| `GEMINI_API_KEY` | AI (also chatbot/KPI key variants) |
| `MAILER_HANDOFF_SECRET` + `MAILER_PUBLIC_URL` | Vercel mailer SMTP |
| Per-user mailboxes | cPanel IMAP/SMTP on Users page |
| `TWILIO_*` | Human browser calls + AI Sales Agent |
| `AI_SALES_AGENT_ACCESS_CODE` | Default `786786` |
| WhatsApp / Meta tokens | WhatsApp inbox |
| `SERPAPI_*` | Lead discovery search |

---

## API routes (quick reference)

- `/api/leads` — Master Table, research, scoring  
- `/api/interactions` — email drafts, approve, bulk  
- `/api/ai-sales-agent` — Rayan/Sara tasks, runners, unlock  
- `/api/ai-mode` — overnight auto-reply, lifecycle  
- `/api/mailer` — bulk handoff, append-sent, schedule  
- `/api/kpi` — daily KPI  
- `/api/quotations` — quotes, products, upsell  

---

## Stakeholders (ERP / office politics)

| Person | Vibe | Topic |
|--------|------|--------|
| Mr Khalid | Impatient | Decisions, AI rollout |
| Mr Hafeez | Loyal | cPanel, ERP backup |
| Qaiser | Loud, grumpy | IT, domain, blocking access |
| Mr Sufyan | Aggressive, lazy | Built ERP |
| Mr Saud | Calm, deflects | Website team |
| Mr Faraz | Quiet, helpful | HNS hosting |

**Your professional stance (from chats):** Asked PC off domain for safety; never asked for ERP/cPanel passwords day one; offered read-only ERP integration phase; no showing Kafi demo to other clients.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| API slow / 502 | Railway warming up — Ctrl+Shift+R, wait 10s |
| AI Sales Agent empty | Enter access code `786786` first |
| No phone in AI queue | Add Primary Mobile on lead row; deploy contact fix |
| Bulk clutter in Sent | Old sends; new bulk via Bulk Email Sender = one summary |
| SMTP error on Railway | Use Vercel mailer or Resend (Hobby blocks SMTP ports) |
| AI calls won’t start | Check all `TWILIO_*` + webhook base URL on Railway |

---

## Session topics we covered (conversation index)

1. Repo takeover from junior — Railway, Vercel, Supabase, Twilio, cPanel setup  
2. Env files `env` / `env (1)` at repo root  
3. ERP files in `experiment` — real MariaDB dumps, ERP app code elsewhere on cPanel  
4. ERP integration politics — Qaiser, Sufyan, Hafeez, Khalid  
5. AI Mode slowness — fixed in 0051539  
6. WhatsApp inbox speed + activity badge — fixed  
7. Email inbox triage counts — fixed  
8. Mailer compose — wider body, smaller pasted images — fixed  
9. Font size increase — fixed  
10. Email failure types — Kafi-side vs external (Email Activity panel)  
11. Master Table assign broken — fixed (c32c23b)  
12. Queue AI vs Assign to — explained + separated  
13. AI Sales Agent — can’t see own number — fix written, not deployed  
14. Bulk email Sent folder — one summary, not deleted individually  

---

## Next checklist when you return

- [ ] Clone or copy repo to new PC  
- [ ] Restore `backend/.env` and `frontend/.env` from safe backup  
- [ ] Open project in Cursor; attach this file to new chat  
- [ ] `git pull` then `git status` — check if AI fixes were ever pushed  
- [ ] If not pushed: recover from old PC folder or re-apply fixes  
- [ ] Deploy → test AI Sales Agent self-test call  
- [ ] Test bulk email → one `[Bulk X/Y]` in Sent only  

---

*Personal handoff — safe to store on USB, email, or cloud. Not a secret document, but do not publish env passwords inside it.*
