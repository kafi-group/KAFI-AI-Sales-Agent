"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { loginFromHandoff, clearSession, getStoredToken } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { TemplatePicker } from "@/components/TemplatePicker";
import {
  AiComposeAssist,
  type ComposeWriteMode,
} from "@/components/AiComposeAssist";
import {
  EmailBodyEditor,
  emailBodyHasContent,
  plainTextToEditorHtml,
} from "@/components/EmailBodyEditor";
import { ensureDearSalutation, personalizeEmailText } from "@/lib/personalizeEmail";
import { appendMailerSentCopy } from "@/lib/syncSent";

type Lead = {
  buyer_id: number;
  company_name: string;
  contact_name?: string | null;
  contact_email: string;
};

type HandoffPreview = {
  username: string;
  mailbox_email: string;
  display_name?: string | null;
  buyer_ids: number[];
  leads: Lead[];
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function BulkInner() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const scheduleMode = params.get("schedule") === "1";
  const { refresh, user } = useAuth();

  const preview = useMemo(() => {
    try {
      const mid = token.split(".")[1];
      if (!mid) return null;
      const json = JSON.parse(atob(mid.replace(/-/g, "+").replace(/_/g, "/")));
      return {
        username: String(json.username || ""),
        mailbox_email: String(json.mailbox_email || ""),
        display_name: json.display_name || null,
        buyer_ids: Array.isArray(json.buyer_ids) ? json.buyer_ids : [],
        leads: Array.isArray(json.leads) ? json.leads : [],
      } as HandoffPreview;
    } catch {
      return null;
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        clearSession();
        await loginFromHandoff(token);
        if (!cancelled) await refresh();
      } catch {
        /* preview still shows; send will prompt login */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, refresh]);

  const [subject, setSubject] = useState(
    "Introduction — Kafi Commodities ({{company_name}})",
  );
  const [body, setBody] = useState(() =>
    plainTextToEditorHtml(
      "Dear {{contact_name}},\n\nI hope you are well. I am reaching out from Kafi Commodities regarding our export range (rice, spices, Essence Himalayan salt, sauces & pickles).\n\nI would welcome a short call at your convenience.\n\nBest regards",
    ),
  );
  const [batchSize, setBatchSize] = useState(10);
  const [messageDelay, setMessageDelay] = useState(2);
  const [batchPause, setBatchPause] = useState(45);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [log, setLog] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [writeMode, setWriteMode] = useState<ComposeWriteMode>("free");
  const [tplNotice, setTplNotice] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");

  const leads: Lead[] = (preview?.leads || []).filter((l) =>
    (l.contact_email || "").includes("@"),
  );

  function pushLog(line: string) {
    setLog((prev) => [...prev, line]);
  }

  async function reportActivity(body: Record<string, unknown>) {
    // Best-effort — posts via mailer server to Sales Agent Email Activity only.
    try {
      await fetch("/api/report-activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          authToken: getStoredToken() || undefined,
          ...body,
        }),
      });
    } catch {
      /* ignore */
    }
  }

  async function runSend() {
    if (!token) {
      pushLog("Missing token — open from Sales Agent Send emails.");
      return;
    }
    if (!leads.length) {
      pushLog("No leads with email in this handoff.");
      return;
    }
    setRunning(true);
    setLog([]);
    setProgress({ done: 0, total: leads.length, current: "" });
    const batches = chunk(leads, Math.max(1, Math.min(15, batchSize)));
    let sentTotal = 0;
    let failTotal = 0;
    // Bulk handoff page always uses bulk mode — CC / multi-recipient on compose stays regular.
    const isBulk = true;
    const recipientEmails = leads.map((l) => l.contact_email);
    pushLog(
      `Starting ${leads.length} emails in ${batches.length} batch(es) as ${preview?.mailbox_email}`,
    );

    if (isBulk) {
      await reportActivity({
        kind: "bulk_started",
        selected_count: leads.length,
        send_mode: "bulk",
      });
    }

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      pushLog(`Batch ${b + 1}/${batches.length} — ${batch.length} message(s)…`);
      try {
        // Prefer one-message requests so Vercel timeouts/crashes don't wipe a whole batch,
        // and so every response is small JSON we can parse reliably.
        for (let i = 0; i < batch.length; i++) {
          const lead = batch[i];
          setProgress({
            done: sentTotal + failTotal,
            total: leads.length,
            current: lead.contact_email,
          });
          try {
            const personalizedSubject = personalizeEmailText(subject, lead);
            const personalizedBody = personalizeEmailText(body, lead);
            const res = await fetch("/api/send", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                token,
                to: lead.contact_email,
                subject: personalizedSubject,
                body: personalizedBody,
                html: true,
                buyer_id: lead.buyer_id,
                company_name: lead.company_name,
                contact_name: lead.contact_name || undefined,
                send_mode: "bulk",
                record_activity: false,
                skip_sent_copy: true,
              }),
            });
            const raw = await res.text();
            let data: { ok?: boolean; error?: string; message?: string } = {};
            try {
              data = raw ? (JSON.parse(raw) as typeof data) : {};
            } catch {
              pushLog(
                `FAIL  ${lead.contact_email}  Server returned non-JSON (${res.status}): ${raw.slice(0, 180)}`,
              );
              failTotal += 1;
              setProgress({
                done: sentTotal + failTotal,
                total: leads.length,
                current: "",
              });
              continue;
            }
            if (!res.ok || data.ok === false) {
              pushLog(
                `FAIL  ${lead.contact_email}  ${data.error || data.message || res.statusText}`,
              );
              failTotal += 1;
            } else {
              pushLog(`OK  ${lead.contact_email}`);
              sentTotal += 1;
            }
            setProgress({
              done: sentTotal + failTotal,
              total: leads.length,
              current: "",
            });
          } catch (e) {
            pushLog(
              `FAIL  ${lead.contact_email}  ${e instanceof Error ? e.message : String(e)}`,
            );
            failTotal += 1;
            setProgress({
              done: sentTotal + failTotal,
              total: leads.length,
              current: "",
            });
          }
          if (i < batch.length - 1 && messageDelay > 0) {
            await sleep(messageDelay * 1000);
          }
        }
      } catch (e) {
        pushLog(`Batch error: ${e instanceof Error ? e.message : String(e)}`);
        failTotal += batch.length;
      }
      if (b < batches.length - 1 && batchPause > 0) {
        pushLog(`Waiting ${batchPause}s before next batch…`);
        await sleep(batchPause * 1000);
      }
    }

    if (isBulk) {
      await reportActivity({
        kind: "bulk_finished",
        selected_count: leads.length,
        sent_count: sentTotal,
        failed_count: failTotal,
        send_mode: "bulk",
        subject,
        recipient_emails: recipientEmails,
      });
      // One Sent-folder summary instead of N copies (keeps mailbox tidy).
      const summaryBody = [
        `Bulk email sent by ${preview?.display_name || preview?.username || "user"}`,
        `Subject: ${subject}`,
        `Sent: ${sentTotal} · Failed: ${failTotal} · Total: ${leads.length}`,
        "",
        "Recipients:",
        ...recipientEmails,
      ].join("\n");
      await appendMailerSentCopy({
        token,
        authToken: getStoredToken() || undefined,
        to: preview?.mailbox_email || recipientEmails[0] || "bulk@local",
        subject: `[Bulk ${sentTotal}/${leads.length}] ${subject.slice(0, 120)}`,
        body: summaryBody,
        html: false,
      });
    }

    pushLog(`Done. Sent ${sentTotal}, failed ${failTotal}.`);
    setProgress({ done: leads.length, total: leads.length, current: "" });
    setRunning(false);
  }

  async function runSchedule() {
    if (!token) {
      pushLog("Missing token — open from Sales Agent Schedule bulk email.");
      return;
    }
    if (!scheduledAt) {
      pushLog("Pick a date and time for the scheduled send.");
      return;
    }
    if (!leads.length) {
      pushLog("No leads with email in this handoff.");
      return;
    }
    const apiBase = (
      process.env.NEXT_PUBLIC_KAFI_API_BASE_URL ||
      process.env.KAFI_API_BASE_URL ||
      "https://kafi-sales-agent.up.railway.app/api"
    )
      .trim()
      .replace(/\/$/, "");
    setScheduling(true);
    setLog([]);
    try {
      const res = await fetch(`${apiBase}/mailer/schedule-bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          subject,
          body,
          scheduled_at: new Date(scheduledAt).toISOString(),
          batch_size: batchSize,
          message_delay_seconds: messageDelay,
          batch_pause_seconds: batchPause,
        }),
      });
      const data = (await res.json()) as { message?: string; detail?: string };
      if (!res.ok) {
        pushLog(`Schedule failed: ${data.detail || data.message || res.statusText}`);
        return;
      }
      pushLog(data.message || "Bulk email scheduled.");
      setTplNotice(data.message || "Scheduled.");
    } catch (e) {
      pushLog(`Schedule failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScheduling(false);
    }
  }

  if (!token) {
    return (
      <div className="wrap">
        <div className="card">
          <h1>Bulk send</h1>
          <p className="muted">
            Open this page from Sales Agent using <strong>Send emails</strong>.
          </p>
          <Link className="btn" href="/inbox">
            Go to inbox
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="card">
        <div className="folder-list-head">
          <h1>{scheduleMode ? "Schedule bulk send" : "Bulk send"}</h1>
          {scheduleMode ? (
            <p className="muted small" style={{ marginTop: "0.25rem" }}>
              Compose your message, pick a date/time below, then click{" "}
              <strong>Schedule N emails</strong>.
            </p>
          ) : null}
          {user && (
            <Link className="btn ghost small" href="/inbox">
              Open inbox
            </Link>
          )}
        </div>
        <p className="muted">
          Sends via SMTP on Vercel. Each recipient gets their own company name — use{" "}
          <code>[Company Name]</code>, <code>[company_name]</code>, or{" "}
          <code>{"{{company_name}}"}</code> (same for contact name / email).
        </p>
        <div className="chips">
          <span className="chip">From: {preview?.mailbox_email || "—"}</span>
          <span className="chip">User: {preview?.username || "—"}</span>
          <span className="chip">Recipients: {leads.length}</span>
        </div>

        {tplNotice && <p className="ok small">{tplNotice}</p>}
        <TemplatePicker
          key={user?.id ?? "pending-auth"}
          value={templateId}
          hint="Placeholders like {{company_name}} are filled per recipient when you send."
          onChange={(id, tpl) => {
            setTemplateId(id);
            if (tpl) {
              setSubject(tpl.subject);
              setBody(ensureDearSalutation(tpl.body, "{{contact_name}}"));
              setWriteMode("free");
              setTplNotice(`Loaded template “${tpl.name}”`);
            } else {
              setTplNotice(null);
            }
          }}
        />

        <AiComposeAssist
          mode={writeMode}
          onModeChange={setWriteMode}
          subject={subject}
          body={body}
          bulkPlaceholders
          contextHint="Bulk campaign — recipients vary; prefer {{contact_name}} and {{company_name}} placeholders."
          onDraft={(draft) => {
            setSubject(draft.subject);
            setBody(draft.body);
          }}
          onNotice={setTplNotice}
          onError={(msg) => setTplNotice(msg ? `Error: ${msg}` : null)}
        />

        <label>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />

        <label>Body</label>
        <EmailBodyEditor value={body} onChange={setBody} rows={12} />

        <div className="row">
          <div>
            <label>Batch size</label>
            <input
              type="number"
              min={1}
              max={15}
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value) || 10)}
            />
          </div>
          <div>
            <label>Delay between messages (sec)</label>
            <input
              type="number"
              min={0}
              step={0.5}
              value={messageDelay}
              onChange={(e) => setMessageDelay(Number(e.target.value) || 0)}
            />
          </div>
          <div>
            <label>Pause between batches (sec)</label>
            <input
              type="number"
              min={0}
              value={batchPause}
              onChange={(e) => setBatchPause(Number(e.target.value) || 0)}
            />
          </div>
        </div>

        <div className="row" style={{ marginTop: "0.75rem" }}>
          <div style={{ flex: 1 }}>
            <label>Schedule for later (optional — your local time)</label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </div>
        </div>

        <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
          <button
            className="btn"
            type="button"
            disabled={running || scheduling || !leads.length || !emailBodyHasContent(body)}
            onClick={() => void runSend()}
          >
            {running
              ? `Sending ${progress.done}/${progress.total}…`
              : `Send ${leads.length} email${leads.length === 1 ? "" : "s"} now`}
          </button>

          <button
            className="btn ghost"
            type="button"
            disabled={
              scheduling ||
              running ||
              !leads.length ||
              !emailBodyHasContent(body) ||
              !scheduledAt
            }
            onClick={() => void runSchedule()}
          >
            {scheduling
              ? "Scheduling…"
              : `Schedule ${leads.length} email${leads.length === 1 ? "" : "s"}`}
          </button>
        </div>

        {running && progress.total > 0 && (
          <div className="bulk-progress" aria-live="polite">
            <div className="bulk-progress-label">
              Personalizing & sending — {progress.done} of {progress.total}
              {progress.current ? ` · ${progress.current}` : ""}
            </div>
            <div className="bulk-progress-track">
              <div
                className="bulk-progress-bar"
                style={{
                  width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%`,
                }}
              />
            </div>
          </div>
        )}

        {log.length > 0 && (
          <div className="log">
            {log.map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith("OK")
                    ? "ok"
                    : line.startsWith("FAIL") || line.includes("failed")
                      ? "bad"
                      : ""
                }
              >
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function BulkPage() {
  return (
    <Suspense fallback={<div className="wrap muted">Loading…</div>}>
      <BulkInner />
    </Suspense>
  );
}
