import { useCallback, useEffect, useState } from "react";
import { client, type TwilioBalance } from "../api/client";
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadTwilioBalance = useCallback(async () => {
    try {
      const data = await client.getTwilioBalance();
      setTwilio(data);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to load Twilio balance");
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await client.getTwilioBalance();
        if (!cancelled) setTwilio(data);
      } catch (err) {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : "Failed to load Twilio balance");
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
      await loadTwilioBalance();
    } finally {
      setRefreshing(false);
    }
  }

  const lowBalance =
    twilio?.ok && twilio.balance != null && twilio.balance < 5;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-100">Settings</h2>
          <p className="mt-1 text-sm text-slate-400">
            Admin-only integration status and prepaid balances.
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
    </div>
  );
}
