import { useCallback, useEffect, useState } from "react";
import {
  client,
  type AiSalesAutoModeSettings,
  type AiSalesBulkEmailPersonaSettings,
  type EmailTemplate,
} from "../api/client";

interface AiAutoModePanelProps {
  onError: (message: string) => void;
  /** When true, show compact panel suitable under unlock / above runners. */
  compact?: boolean;
  onStartAgent?: (persona: "female" | "male") => void;
  startingPersona?: "female" | "male" | null;
}

const EMPTY_BULK: AiSalesBulkEmailPersonaSettings = {
  template_id: null,
  from_mailbox_email: "",
  cc: "",
  subject: "",
  body: "",
};

const DEFAULTS: AiSalesAutoModeSettings = {
  enabled: false,
  study_contacts: true,
  call_mode: true,
  send_email_after_call: true,
  send_whatsapp_after_call: true,
  bulk_email_when_no_call: true,
  study_products: true,
  product_brief: "",
  bulk_email_by_persona: {
    female: { ...EMPTY_BULK },
    male: { ...EMPTY_BULK },
  },
};

type MailboxOption = { user_id: number; email: string; label?: string };

export function AiAutoModePanel({
  onError,
  compact = false,
  onStartAgent,
  startingPersona = null,
}: AiAutoModePanelProps) {
  const [settings, setSettings] = useState<AiSalesAutoModeSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [bulkPersona, setBulkPersona] = useState<"female" | "male">("female");
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
  const [bulkDraft, setBulkDraft] = useState<AiSalesBulkEmailPersonaSettings>({
    ...EMPTY_BULK,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await client.getAiSalesAutoMode();
      const merged: AiSalesAutoModeSettings = {
        ...DEFAULTS,
        ...data,
        bulk_email_by_persona: {
          female: {
            ...EMPTY_BULK,
            ...(data.bulk_email_by_persona?.female || {}),
          },
          male: {
            ...EMPTY_BULK,
            ...(data.bulk_email_by_persona?.male || {}),
          },
        },
      };
      setSettings(merged);
      setBulkDraft({
        ...EMPTY_BULK,
        ...(merged.bulk_email_by_persona?.[bulkPersona] || {}),
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load AI Auto Mode");
    } finally {
      setLoading(false);
    }
  }, [onError, bulkPersona]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const [tpls, mbRes] = await Promise.all([
          client.listEmailTemplates().catch(() => [] as EmailTemplate[]),
          client.listInboxSwitchableMailboxes().catch(() => ({
            can_switch: false,
            mailboxes: [] as Array<{ user_id: number; email: string }>,
          })),
        ]);
        setTemplates(Array.isArray(tpls) ? tpls : []);
        const rows = Array.isArray(mbRes?.mailboxes) ? mbRes.mailboxes : [];
        setMailboxes(
          rows
            .map((row) => ({
              user_id: Number(row.user_id),
              email: String(row.email || "").trim(),
              label: String(
                (row as { display_name?: string | null }).display_name ||
                  row.email ||
                  "",
              ),
            }))
            .filter((row) => row.email),
        );
      } catch {
        /* optional */
      }
    })();
  }, []);

  useEffect(() => {
    const saved = settings.bulk_email_by_persona?.[bulkPersona];
    setBulkDraft({ ...EMPTY_BULK, ...(saved || {}) });
  }, [bulkPersona, settings.bulk_email_by_persona]);

  async function save(patch: Partial<AiSalesAutoModeSettings>) {
    setSaving(true);
    setNotice(null);
    try {
      const next = await client.updateAiSalesAutoMode(patch);
      const merged: AiSalesAutoModeSettings = {
        ...DEFAULTS,
        ...next,
        bulk_email_by_persona: {
          female: {
            ...EMPTY_BULK,
            ...(next.bulk_email_by_persona?.female || {}),
          },
          male: {
            ...EMPTY_BULK,
            ...(next.bulk_email_by_persona?.male || {}),
          },
        },
      };
      setSettings(merged);
      setNotice("AI Auto Mode settings saved (does not start outreach by itself).");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save AI Auto Mode");
    } finally {
      setSaving(false);
    }
  }

  function toggle(key: keyof AiSalesAutoModeSettings) {
    if (key === "product_brief" || key === "bulk_email_by_persona") return;
    const next = !settings[key];
    void save({ [key]: next });
  }

  function applyTemplate(templateId: number) {
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) {
      setBulkDraft((prev) => ({ ...prev, template_id: templateId }));
      return;
    }
    setBulkDraft((prev) => ({
      ...prev,
      template_id: templateId,
      subject: tpl.subject || prev.subject,
      body: tpl.body || prev.body,
    }));
  }

  async function saveBulkSetup() {
    if (!bulkDraft.subject.trim() || !bulkDraft.body.trim()) {
      onError("Subject and body are required (pick a template, then edit the signature).");
      return;
    }
    await save({
      bulk_email_by_persona: {
        [bulkPersona]: {
          template_id: bulkDraft.template_id,
          from_mailbox_email: bulkDraft.from_mailbox_email.trim(),
          cc: bulkDraft.cc.trim(),
          subject: bulkDraft.subject,
          body: bulkDraft.body,
        },
      } as AiSalesAutoModeSettings["bulk_email_by_persona"],
    });
  }

  function handleStart(persona: "female" | "male") {
    if (!onStartAgent) return;
    if (
      settings.enabled &&
      !settings.call_mode &&
      settings.bulk_email_when_no_call
    ) {
      const cfg = settings.bulk_email_by_persona?.[persona];
      if (!cfg?.subject?.trim() || !cfg?.body?.trim()) {
        onError(
          `Save bulk email setup for ${persona === "female" ? "Sara" : "Rayan"} first (template, From, CC, signature).`,
        );
        setBulkPersona(persona);
        return;
      }
      const agent = persona === "female" ? "Sara" : "Rayan";
      const ok = window.confirm(
        `Send bulk emails as ${agent}?\n\n` +
          `From: ${cfg.from_mailbox_email || "(your mailbox)"}\n` +
          `CC: ${cfg.cc || "(none)"}\n` +
          `Subject: ${cfg.subject.slice(0, 80)}${cfg.subject.length > 80 ? "…" : ""}\n\n` +
          `Queued Outreach contacts for ${agent} will each get a personalized copy.`,
      );
      if (!ok) return;
    }
    onStartAgent(persona);
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-4 text-sm text-slate-400">
        Loading AI Auto Mode…
      </div>
    );
  }

  const showBulkSetup = settings.enabled && settings.bulk_email_when_no_call;

  return (
    <div
      className={`rounded-xl border border-violet-500/40 bg-gradient-to-br from-violet-950/40 to-slate-900/60 ${
        compact ? "" : "shadow-lg shadow-violet-950/20"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-slate-100">AI Auto Mode</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            The toggle only saves which actions are allowed. Use{" "}
            <strong className="text-slate-300">Start</strong> to run now on that agent&apos;s
            Outreach queue, or <strong className="text-slate-300">Schedule</strong> to create
            recurring processes below.
          </p>
        </div>
        <span className="text-slate-400 text-sm shrink-0 pt-0.5">{open ? "▾" : "▸"}</span>
      </button>

      {open ? (
        <div className="px-4 pb-4 space-y-3 border-t border-violet-500/20 pt-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void save({ enabled: !settings.enabled })}
              className={`relative inline-flex h-8 w-14 items-center rounded-full transition ${
                settings.enabled ? "bg-emerald-500" : "bg-slate-700"
              }`}
              aria-pressed={settings.enabled}
              title="Toggle AI Auto Mode settings"
            >
              <span
                className={`inline-block h-6 w-6 transform rounded-full bg-white transition ${
                  settings.enabled ? "translate-x-7" : "translate-x-1"
                }`}
              />
            </button>
            {!compact && onStartAgent ? (
              <>
                <button
                  type="button"
                  disabled={!settings.enabled || startingPersona === "female"}
                  onClick={() => handleStart("female")}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
                  title="Start Sara now using Auto Mode actions on her Outreach queue"
                >
                  {startingPersona === "female" ? "Starting…" : "Start Sara"}
                </button>
                <button
                  type="button"
                  disabled={!settings.enabled || startingPersona === "male"}
                  onClick={() => handleStart("male")}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40"
                  title="Start Rayan now using Auto Mode actions on his Outreach queue"
                >
                  {startingPersona === "male" ? "Starting…" : "Start Rayan"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    document.getElementById("ai-sales-processes")?.scrollIntoView({
                      behavior: "smooth",
                      block: "start",
                    });
                  }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-violet-400/50 text-violet-100 hover:bg-violet-500/20"
                >
                  Schedule
                </button>
              </>
            ) : null}
          </div>

          {notice ? <p className="text-xs text-emerald-300">{notice}</p> : null}

          <fieldset
            disabled={!settings.enabled || saving}
            className={`space-y-2 ${settings.enabled ? "" : "opacity-50"}`}
          >
            <legend className="text-xs font-semibold uppercase tracking-wide text-violet-300 mb-1">
              Actions used when you Start (or when a process runs)
            </legend>

            {(
              [
                [
                  "study_contacts",
                  "Study each assigned contact (company, person, designation) before acting",
                ],
                ["call_mode", "Call mode — dial contacts in the queue (Sara / Rayan)"],
                ["send_email_after_call", "After call — send email drafted from the call"],
                ["send_whatsapp_after_call", "After call — send WhatsApp personal message"],
                [
                  "bulk_email_when_no_call",
                  "If call mode is OFF — bulk email assigned contacts instead of dialling",
                ],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 cursor-pointer hover:border-violet-500/40"
              >
                <input
                  type="checkbox"
                  checked={Boolean(settings[key])}
                  onChange={() => toggle(key)}
                  className="mt-0.5 rounded border-slate-600 text-violet-500 focus:ring-violet-500"
                />
                <span>{label}</span>
              </label>
            ))}

            {showBulkSetup ? (
              <div className="rounded-lg border border-cyan-500/30 bg-cyan-950/20 p-3 space-y-3 mt-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-cyan-100">
                    Bulk email setup (template · From · CC · signature)
                  </p>
                  <div className="flex gap-1">
                    {(
                      [
                        ["female", "Sara"],
                        ["male", "Rayan"],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setBulkPersona(id)}
                        className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                          bulkPersona === id
                            ? "border-cyan-400/60 bg-cyan-500/25 text-cyan-50"
                            : "border-slate-700 text-slate-400"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-[11px] text-slate-400">
                  Pick a saved Email template, edit the signature (e.g. Sara — Sales Manager), choose
                  From (essence@…) and optional CC (marketing@…). Saved per agent. Merge tags like{" "}
                  {"{{contact_name}}"} / {"{{company_name}}"} still personalize each send.
                </p>

                <label className="block text-xs text-slate-400">
                  Template
                  <select
                    value={bulkDraft.template_id ?? ""}
                    disabled={saving}
                    onChange={(e) => {
                      const id = e.target.value ? Number(e.target.value) : null;
                      if (id) applyTemplate(id);
                      else setBulkDraft((prev) => ({ ...prev, template_id: null }));
                    }}
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                  >
                    <option value="">Select a template…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-xs text-slate-400">
                    From
                    <select
                      value={bulkDraft.from_mailbox_email}
                      disabled={saving}
                      onChange={(e) =>
                        setBulkDraft((prev) => ({
                          ...prev,
                          from_mailbox_email: e.target.value,
                        }))
                      }
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                    >
                      <option value="">My mailbox (operator)</option>
                      {mailboxes.map((m) => (
                        <option key={`${m.user_id}-${m.email}`} value={m.email}>
                          {m.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-slate-400">
                    CC
                    <input
                      type="email"
                      value={bulkDraft.cc}
                      disabled={saving}
                      placeholder="marketing@kafi-group.com"
                      onChange={(e) =>
                        setBulkDraft((prev) => ({ ...prev, cc: e.target.value }))
                      }
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                    />
                  </label>
                </div>

                <label className="block text-xs text-slate-400">
                  Subject
                  <input
                    type="text"
                    value={bulkDraft.subject}
                    disabled={saving}
                    onChange={(e) =>
                      setBulkDraft((prev) => ({ ...prev, subject: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Body (edit signature here)
                  <textarea
                    value={bulkDraft.body}
                    disabled={saving}
                    rows={8}
                    onChange={(e) =>
                      setBulkDraft((prev) => ({ ...prev, body: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 font-sans"
                    placeholder={`Dear {{contact_name}},\n\n…\n\nBest regards,\nSara\nSales Manager`}
                  />
                </label>

                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveBulkSetup()}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40"
                  >
                    {saving
                      ? "Saving…"
                      : `Save ${bulkPersona === "female" ? "Sara" : "Rayan"} bulk email setup`}
                  </button>
                </div>
              </div>
            ) : null}

            {settings.bulk_email_when_no_call && settings.call_mode ? (
              <p className="text-[11px] text-amber-200/90 pt-1">
                Turn <strong>Call mode</strong> OFF before Start so Sara/Rayan send this bulk email
                instead of dialling.
              </p>
            ) : null}

            <p className="text-[11px] text-slate-500 pt-1">
              Product study &amp; brief live under{" "}
              <span className="text-slate-300">Call Center → AI Train</span>.
            </p>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}
