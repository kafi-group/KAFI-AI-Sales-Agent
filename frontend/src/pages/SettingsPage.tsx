import { useCallback, useEffect, useState } from "react";
import { client, type TwilioBalance, type VoiceEngineSettings } from "../api/client";
import { ActionButton } from "../components/ui/ActionButton";
import { IconRefresh } from "../components/icons/AppIcons";

interface SettingsPageProps {
  onError: (message: string) => void;
}

function formatBalance(data: TwilioBalance): string {
  if (!data.ok || data.balance == null) return "—";
  const amount = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: (data.currency || "USD").toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(data.balance);
  return amount;
}

function formatFetchedAt(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function SettingsPage({ onError }: SettingsPageProps) {
  const [twilio, setTwilio] = useState<TwilioBalance | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceEngineSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // PIN Secret Protection State
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinAction, setPinAction] = useState<"toggle_vapi" | "save_elevenlabs" | null>(null);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [savingAction, setSavingAction] = useState(false);

  // Drafts
  const [pendingVapiState, setPendingVapiState] = useState<boolean>(true);
  const [elevenLabsDraft, setElevenLabsDraft] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [twData, voiceData] = await Promise.all([
        client.getTwilioBalance(),
        client.getVoiceEngineSettings(),
      ]);
      setTwilio(twData);
      setVoiceSettings(voiceData);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load settings");
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [twData, voiceData] = await Promise.all([
          client.getTwilioBalance(),
          client.getVoiceEngineSettings(),
        ]);
        if (!cancelled) {
          setTwilio(twData);
          setVoiceSettings(voiceData);
        }
      } catch (err) {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : "Failed to load settings");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await loadData();
    } finally {
      setRefreshing(false);
    }
  }

  function promptVapiToggle(newState: boolean) {
    setPendingVapiState(newState);
    setPinAction("toggle_vapi");
    setPinInput("");
    setPinError(null);
    setPinModalOpen(true);
  }

  function promptElevenLabsSave() {
    setPinAction("save_elevenlabs");
    setPinInput("");
    setPinError(null);
    setPinModalOpen(true);
  }

  async function handlePinSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pinInput.trim()) {
      setPinError("Please enter the secret code.");
      return;
    }

    setSavingAction(true);
    setPinError(null);

    try {
      if (pinAction === "toggle_vapi") {
        const res = await client.toggleVapiEngine(pinInput.trim(), pendingVapiState);
        setVoiceSettings((prev) => (prev ? { ...prev, vapi_enabled: res.vapi_enabled } : prev));
        setPinModalOpen(false);
      } else if (pinAction === "save_elevenlabs") {
        const res = await client.updateElevenLabsKey(pinInput.trim(), elevenLabsDraft.trim());
        setVoiceSettings((prev) =>
          prev
            ? {
                ...prev,
                has_elevenlabs_key: res.has_key,
                elevenlabs_key_masked: elevenLabsDraft.trim()
                  ? `••••${elevenLabsDraft.trim().slice(-4)}`
                  : null,
              }
            : prev
        );
        setElevenLabsDraft("");
        setPinModalOpen(false);
      }
    } catch (err) {
      setPinError(err instanceof Error ? err.message : "Invalid secret code");
    } finally {
      setSavingAction(false);
    }
  }

  const lowBalance = twilio?.ok && twilio.balance != null && twilio.balance < 5;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-100">Settings</h2>
          <p className="mt-1 text-sm text-slate-400">
            Admin-only integration status, voice engines, and prepaid balances.
          </p>
        </div>
        <ActionButton
          type="button"
          variant="secondary"
          onClick={() => void handleRefresh()}
          disabled={loading || refreshing}
          icon={IconRefresh}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </ActionButton>
      </div>

      {/* Twilio Voice Credits Section */}
      <section className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium text-slate-100">Twilio voice credits</h3>
            <p className="mt-1 text-sm text-slate-400">
              Used for browser calling from the dashboard. WhatsApp billing is separate (Meta).
            </p>
          </div>
          <a
            href="https://console.twilio.com/us1/billing/manage-billing/billing-overview"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-sky-400 hover:text-sky-300 underline-offset-2 hover:underline"
          >
            Open Twilio billing
          </a>
        </div>

        {loading && !twilio ? (
          <p className="mt-4 text-sm text-slate-400">Loading Twilio balance…</p>
        ) : (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Prepaid balance</p>
              <p
                className={`mt-2 text-2xl font-semibold tabular-nums ${
                  lowBalance ? "text-amber-300" : "text-emerald-300"
                }`}
              >
                {formatBalance(twilio ?? { configured: false, ok: false })}
              </p>
              {lowBalance && (
                <p className="mt-2 text-xs text-amber-200/90">
                  Balance is low — top up in Twilio before call volume increases.
                </p>
              )}
            </div>

            <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Caller ID</p>
              <p className="mt-2 text-sm text-slate-200">
                {twilio?.caller_id_masked || "Not configured"}
              </p>
              <p className="mt-3 text-xs uppercase tracking-wide text-slate-500">Account SID</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-400">
                {twilio?.twilio_account_sid || "—"}
              </p>
            </div>

            <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
              <p className="mt-2 text-sm text-slate-200">
                {twilio?.configured
                  ? twilio.ok
                    ? "Connected — balance fetched live from Twilio"
                    : "Configured — balance unavailable"
                  : "Twilio env vars missing on server"}
              </p>
              {twilio?.message && !twilio.ok && (
                <p className="mt-2 text-xs text-red-300">{twilio.message}</p>
              )}
              {twilio?.fetched_at && (
                <p className="mt-3 text-xs text-slate-500">
                  Last checked: {formatFetchedAt(twilio.fetched_at)}
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* AI Voice Engine Controls (Secret PIN Protected) */}
      <section className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-5 sm:p-6 space-y-6">
        <div>
          <h3 className="text-base font-medium text-slate-100">AI Voice Engine Configuration</h3>
          <p className="mt-1 text-sm text-slate-400">
            Control sub-second Vapi voice agent routing and high-realism ElevenLabs API keys. Protected by secret PIN code.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Vapi Toggle Card */}
          <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-5 flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-slate-200">Vapi AI Voice Engine</span>
                <span
                  className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
                    voiceSettings?.vapi_enabled
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                      : "bg-slate-800 text-slate-400 border-slate-700"
                  }`}
                >
                  {voiceSettings?.vapi_enabled ? "ON (Vapi Active)" : "OFF (Standard TwiML)"}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                When <strong>ON</strong>, AI sales agent calls use Vapi's sub-second voice engine. When <strong>OFF</strong>, calls fall back to standard Twilio TwiML gathering without Vapi.
              </p>
            </div>

            <div className="pt-2 flex items-center justify-between border-t border-slate-800/80">
              <span className="text-xs text-slate-500">Toggle requires code</span>
              <button
                type="button"
                onClick={() => promptVapiToggle(!voiceSettings?.vapi_enabled)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  voiceSettings?.vapi_enabled ? "bg-emerald-600" : "bg-slate-700"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    voiceSettings?.vapi_enabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* ElevenLabs Key Card */}
          <div className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-5 flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-slate-200">ElevenLabs Voice API</span>
                <span
                  className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
                    voiceSettings?.has_elevenlabs_key
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                      : "bg-slate-800 text-slate-400 border-slate-700"
                  }`}
                >
                  {voiceSettings?.has_elevenlabs_key
                    ? `Connected (${voiceSettings.elevenlabs_key_masked || "Active"})`
                    : "Not Configured"}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                Connect your ElevenLabs API Key to give Sara and Rayan ultra-realistic, natural human voice synthesis.
              </p>

              <div className="mt-3 space-y-2">
                <input
                  type="password"
                  placeholder={voiceSettings?.elevenlabs_key_masked ? "Update ElevenLabs Key..." : "Enter ElevenLabs API Key..."}
                  value={elevenLabsDraft}
                  onChange={(e) => setElevenLabsDraft(e.target.value)}
                  className="w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="pt-2 flex items-center justify-between border-t border-slate-800/80">
              <span className="text-xs text-slate-500">Requires secret code</span>
              <button
                type="button"
                onClick={promptElevenLabsSave}
                disabled={!elevenLabsDraft.trim()}
                className="px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-medium hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Save ElevenLabs Key
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Secret PIN Modal Dialog */}
      {pinModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-5">
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-slate-100">
                🔒 Security Verification
              </h3>
              <p className="text-xs text-slate-400">
                {pinAction === "toggle_vapi"
                  ? `Enter secret code to turn Vapi AI Engine ${pendingVapiState ? "ON" : "OFF"}.`
                  : "Enter secret code to update ElevenLabs API Key settings."}
              </p>
            </div>

            <form onSubmit={(e) => void handlePinSubmit(e)} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Secret Code PIN
                </label>
                <input
                  type="password"
                  autoFocus
                  placeholder="Enter 6-digit code..."
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 font-mono tracking-widest focus:border-sky-500 focus:outline-none"
                />
                {pinError && (
                  <p className="mt-2 text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded-md px-3 py-1.5">
                    {pinError}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setPinModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAction}
                  className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                >
                  {savingAction ? "Verifying…" : "Confirm Code"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
