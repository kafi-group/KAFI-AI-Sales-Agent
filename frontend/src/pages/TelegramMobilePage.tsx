import { useCallback, useEffect, useState } from "react";
import { client } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ActionButton } from "../components/ui/ActionButton";
import { IconRefresh, IconSend } from "../components/icons/AppIcons";

interface TelegramMobilePageProps {
  onError: (message: string) => void;
}

type TgStatus = {
  connected?: boolean;
  status?: string;
  phone?: string | null;
  username?: string | null;
  displayName?: string | null;
  needsCode?: boolean;
  needsPassword?: boolean;
  pendingPhone?: string | null;
  configured?: boolean;
  bridge_configured?: boolean;
  message?: string;
  error?: string | null;
};

export function TelegramMobilePage({ onError }: TelegramMobilePageProps) {
  const { user } = useAuth();
  const [status, setStatus] = useState<TgStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testMessage, setTestMessage] = useState("Hello from Kafi Sales Agent Telegram Mobile.");
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const st = (await client.getTelegramPersonalStatus()) as TgStatus;
      setStatus(st);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not load Telegram Mobile status");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void loadStatus();
    const t = window.setInterval(() => void loadStatus(), 8000);
    return () => window.clearInterval(t);
  }, [loadStatus]);

  const connected = Boolean(status?.connected);

  async function startLogin() {
    setBusy(true);
    setNotice(null);
    try {
      const st = (await client.startTelegramPersonalLogin(phone.trim())) as TgStatus;
      setStatus(st);
      setNotice(st.message || "Check Telegram on your phone for the login code.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not start Telegram login");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    setBusy(true);
    setNotice(null);
    try {
      const st = (await client.confirmTelegramPersonalCode(code.trim())) as TgStatus;
      setStatus(st);
      setCode("");
      setNotice(st.message || "Code submitted.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword() {
    setBusy(true);
    setNotice(null);
    try {
      const st = (await client.confirmTelegramPersonalPassword(password)) as TgStatus;
      setStatus(st);
      setPassword("");
      setNotice(st.message || "Connected.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Password failed");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect this Telegram Mobile session?")) return;
    setBusy(true);
    try {
      const st = (await client.disconnectTelegramPersonal()) as TgStatus;
      setStatus(st);
      setNotice("Disconnected.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setNotice(null);
    try {
      await client.sendTelegramPersonal(testTo.trim(), testMessage.trim());
      setNotice("Test message sent.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">
        Loading Telegram Mobile…
      </div>
    );
  }

  const unconfigured = status?.configured === false || status?.bridge_configured === false;

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-5 sm:p-6 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Telegram Mobile</h2>
            <p className="mt-1 text-sm text-slate-400">
              Link the Telegram account on your phone (same idea as WhatsApp Mobile). Messages send
              as <span className="text-slate-200">you</span>, not as a bot.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Signed in as {user?.full_name || user?.username || "user"} · session is per login.
            </p>
          </div>
          <ActionButton
            type="button"
            variant="secondary"
            icon={IconRefresh}
            onClick={() => void loadStatus()}
            disabled={busy}
          >
            Refresh
          </ActionButton>
        </div>

        {notice ? <p className="text-xs text-emerald-300">{notice}</p> : null}
        {status?.error ? <p className="text-xs text-rose-300">{status.error}</p> : null}

        {unconfigured ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100 space-y-2">
            <p className="font-medium">Bridge not configured yet</p>
            <ol className="list-decimal list-inside text-xs text-amber-100/90 space-y-1">
              <li>
                Create an app at{" "}
                <a
                  className="underline text-sky-300"
                  href="https://my.telegram.org"
                  target="_blank"
                  rel="noreferrer"
                >
                  my.telegram.org
                </a>{" "}
                → copy api_id / api_hash
              </li>
              <li>
                Deploy <code className="text-[11px]">telegram_bridge/</code> on Railway with those
                values + <code className="text-[11px]">TELEGRAM_BRIDGE_SECRET</code>
              </li>
              <li>
                Set <code className="text-[11px]">TELEGRAM_BRIDGE_URL</code> and the same secret on
                Sales Agent
              </li>
            </ol>
          </div>
        ) : connected ? (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-3">
            <p className="text-emerald-200 font-semibold text-lg">Telegram Mobile Connected</p>
            <p className="text-sm text-slate-300">
              {status?.displayName || status?.username || "Account"}{" "}
              {status?.phone ? (
                <span className="text-slate-400">· {status.phone}</span>
              ) : null}
              {status?.username ? (
                <span className="text-slate-500"> · @{status.username}</span>
              ) : null}
            </p>
            <ActionButton type="button" variant="secondary" onClick={() => void disconnect()} disabled={busy}>
              Disconnect
            </ActionButton>
          </div>
        ) : status?.needsPassword ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              Two-step verification is enabled. Enter your Telegram cloud password.
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Telegram password"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
            <ActionButton type="button" onClick={() => void submitPassword()} disabled={busy || !password}>
              {busy ? "Checking…" : "Confirm password"}
            </ActionButton>
          </div>
        ) : status?.needsCode ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              Open Telegram on your phone
              {status.pendingPhone ? (
                <>
                  {" "}
                  (<span className="text-slate-200">{status.pendingPhone}</span>)
                </>
              ) : null}{" "}
              and enter the login code.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Login code"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono tracking-widest"
              autoComplete="one-time-code"
            />
            <ActionButton type="button" onClick={() => void submitCode()} disabled={busy || !code.trim()}>
              {busy ? "Verifying…" : "Confirm code"}
            </ActionButton>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              Enter the phone number for the Telegram account already logged in on your phone
              (include country code, e.g. +92…).
            </p>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+92…"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
            <ActionButton
              type="button"
              onClick={() => void startLogin()}
              disabled={busy || phone.trim().length < 8}
            >
              {busy ? "Sending code…" : "Send login code to Telegram"}
            </ActionButton>
          </div>
        )}
      </div>

      {connected ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
          <h3 className="text-sm font-medium text-slate-200">Test send</h3>
          <input
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="Recipient phone or @username"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
          <textarea
            value={testMessage}
            onChange={(e) => setTestMessage(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
          <ActionButton
            type="button"
            icon={IconSend}
            onClick={() => void sendTest()}
            disabled={busy || !testTo.trim() || !testMessage.trim()}
          >
            {busy ? "Sending…" : "Send test message"}
          </ActionButton>
        </div>
      ) : null}
    </div>
  );
}
