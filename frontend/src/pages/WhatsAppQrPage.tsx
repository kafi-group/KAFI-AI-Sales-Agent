import { useCallback, useEffect, useState } from "react";
import { client } from "../api/client";
import { ActionButton } from "../components/ui/ActionButton";
import { IconRefresh, IconWhatsApp } from "../components/icons/AppIcons";

interface WhatsAppQrPageProps {
  onError: (message: string) => void;
}

export function WhatsAppQrPage({ onError }: WhatsAppQrPageProps) {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [qr, setQr] = useState<Record<string, unknown> | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [toPhone, setToPhone] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [st, session] = await Promise.all([
        client.getWhatsAppPersonalStatus(),
        client.getWhatsAppPersonalSession(),
      ]);
      setStatus(st);
      setSessionId(session.session_id);
      if (st.connected || String(st.status ?? "").toLowerCase() === "connected") {
        setQr(null);
      } else {
        try {
          const qrData = await client.getWhatsAppPersonalQr();
          setQr(qrData);
        } catch {
          setQr(null);
        }
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not load WhatsApp Personal status");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function handleDisconnect() {
    if (!window.confirm("Disconnect personal WhatsApp on this device? You can scan a new QR after.")) {
      return;
    }
    setLoading(true);
    try {
      await client.disconnectWhatsAppPersonal();
      setNotice("Disconnected — scan a new QR to link your phone.");
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    setSending(true);
    setNotice(null);
    try {
      await client.sendWhatsAppPersonal({ to_phone: toPhone.trim(), message: message.trim() });
      setNotice("Message sent from your personal WhatsApp.");
      setMessage("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  const connected =
    Boolean(status?.connected) ||
    String(status?.status ?? "").toLowerCase() === "connected";
  const qrImage =
    (typeof qr?.qr === "string" && qr.qr) ||
    (typeof qr?.qrDataUrl === "string" && qr.qrDataUrl) ||
    (typeof qr?.dataUrl === "string" && qr.dataUrl) ||
    null;

  return (
    <section className="space-y-4 max-w-2xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-medium text-slate-100">WhatsApp QR (Personal)</h2>
          <p className="text-sm text-slate-500 mt-1">
            Scan with your phone — separate from Meta Business WhatsApp. Session:{" "}
            <code className="text-slate-400">{sessionId || "…"}</code>
          </p>
        </div>
        <ActionButton icon={IconRefresh} size="md" onClick={() => void refresh()} title="Refresh">
          Refresh
        </ActionButton>
      </div>

      {notice ? (
        <p className="text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
          {notice}
        </p>
      ) : null}

      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : connected ? (
          <div className="space-y-2">
            <p className="text-sm text-emerald-300">
              Connected — messages send from your scanned personal WhatsApp number.
            </p>
            <ActionButton
              icon={IconRefresh}
              variant="ghost"
              size="md"
              onClick={() => void handleDisconnect()}
              title="Disconnect and scan another phone"
            >
              Disconnect / scan new QR
            </ActionButton>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-amber-200">
              Not connected. Open WhatsApp on your phone → Linked devices → scan this QR.
            </p>
            {qrImage ? (
              <img
                src={qrImage.startsWith("data:") ? qrImage : `data:image/png;base64,${qrImage}`}
                alt="WhatsApp QR code"
                className="mx-auto w-56 h-56 rounded-lg bg-white p-2"
              />
            ) : (
              <p className="text-xs text-slate-500">
                QR not available yet — ensure WHATSAPP_BRIDGE_URL and WHATSAPP_BRIDGE_SECRET are
                set on Railway (Sales Agent bridge, separate from bank-recon-demo).
              </p>
            )}
          </div>
        )}

        <div className="border-t border-slate-800 pt-4 space-y-3">
          <p className="text-xs text-slate-400">Quick send (personal WhatsApp)</p>
          <input
            value={toPhone}
            onChange={(e) => setToPhone(e.target.value)}
            placeholder="Recipient phone e.g. +923001234567"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          />
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder="Message"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          />
          <ActionButton
            icon={IconWhatsApp}
            variant="primary"
            size="md"
            disabled={sending || !connected || !toPhone.trim() || !message.trim()}
            onClick={() => void handleSend()}
          >
            {sending ? "Sending…" : "Send personal WhatsApp"}
          </ActionButton>
        </div>
      </div>
    </section>
  );
}
