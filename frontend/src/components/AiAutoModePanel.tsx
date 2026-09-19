import { useCallback, useEffect, useState } from "react";
import { client, type AiSalesAutoModeSettings } from "../api/client";

interface AiAutoModePanelProps {
  onError: (message: string) => void;
  /** When true, show compact panel suitable under unlock / above runners. */
  compact?: boolean;
  onStartAgent?: (persona: "female" | "male") => void;
  startingPersona?: "female" | "male" | null;
}

const DEFAULTS: AiSalesAutoModeSettings = {
  enabled: false,
  study_contacts: true,
  call_mode: true,
  send_email_after_call: true,
  send_whatsapp_after_call: true,
  bulk_email_when_no_call: true,
  study_products: true,
  product_brief: "",
};

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await client.getAiSalesAutoMode();
      setSettings({ ...DEFAULTS, ...data });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load AI Auto Mode");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Partial<AiSalesAutoModeSettings>) {
    setSaving(true);
    setNotice(null);
    try {
      const next = await client.updateAiSalesAutoMode(patch);
      setSettings({ ...DEFAULTS, ...next });
      setNotice("AI Auto Mode settings saved (does not start outreach by itself).");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save AI Auto Mode");
    } finally {
      setSaving(false);
    }
  }

  function toggle(key: keyof AiSalesAutoModeSettings) {
    if (key === "product_brief") return;
    const next = !settings[key];
    void save({ [key]: next });
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-4 text-sm text-slate-400">
        Loading AI Auto Mode…
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl border border-violet-500/40 bg-gradient-to-br from-violet-950/40 to-slate-900/60 p-4 space-y-3 ${
        compact ? "" : "shadow-lg shadow-violet-950/20"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-slate-100">AI Auto Mode</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            The toggle only saves which actions are allowed. Use <strong className="text-slate-300">Start</strong>{" "}
            to run now on that agent&apos;s queue, or <strong className="text-slate-300">Schedule</strong> to
            create recurring processes below.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
                onClick={() => onStartAgent("female")}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
                title="Start Sara now using Auto Mode actions on her queue"
              >
                {startingPersona === "female" ? "Starting…" : "Start Sara"}
              </button>
              <button
                type="button"
                disabled={!settings.enabled || startingPersona === "male"}
                onClick={() => onStartAgent("male")}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40"
                title="Start Rayan now using Auto Mode actions on his queue"
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

        <p className="text-[11px] text-slate-500 pt-1">
          Product study &amp; brief live under{" "}
          <span className="text-slate-300">Call Center → AI Train</span>.
        </p>
      </fieldset>
    </div>
  );
}
