import { useCallback, useEffect, useState } from "react";
import { client, type AiSalesAutoModeSettings } from "../api/client";

interface AiAutoModePanelProps {
  onError: (message: string) => void;
  /** When true, show compact panel suitable under unlock / above runners. */
  compact?: boolean;
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

export function AiAutoModePanel({ onError, compact = false }: AiAutoModePanelProps) {
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
      setNotice("AI Auto Mode saved.");
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-100">AI Auto Mode</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            When ON, ticked actions run for assigned queue contacts (Sara / Rayan). When OFF, use
            manual Start / Call this as before.
          </p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save({ enabled: !settings.enabled })}
          className={`relative inline-flex h-8 w-14 items-center rounded-full transition ${
            settings.enabled ? "bg-emerald-500" : "bg-slate-700"
          }`}
          aria-pressed={settings.enabled}
          title="Toggle AI Auto Mode"
        >
          <span
            className={`inline-block h-6 w-6 transform rounded-full bg-white transition ${
              settings.enabled ? "translate-x-7" : "translate-x-1"
            }`}
          />
        </button>
      </div>

      {notice ? <p className="text-xs text-emerald-300">{notice}</p> : null}

      <fieldset
        disabled={!settings.enabled || saving}
        className={`space-y-2 ${settings.enabled ? "" : "opacity-50"}`}
      >
        <legend className="text-xs font-semibold uppercase tracking-wide text-violet-300 mb-1">
          Actions when Auto Mode is ON
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
            [
              "study_products",
              "Study our products (quality & packaging) so agents can pitch and answer questions",
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

        {settings.study_products ? (
          <div className="pt-1 space-y-1">
            <label className="text-xs text-slate-400">Product brief (injected into call prompts)</label>
            <textarea
              rows={compact ? 3 : 5}
              value={settings.product_brief || ""}
              onChange={(e) => setSettings((s) => ({ ...s, product_brief: e.target.value }))}
              onBlur={() => void save({ product_brief: settings.product_brief })}
              className="w-full text-xs rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-200"
            />
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}
