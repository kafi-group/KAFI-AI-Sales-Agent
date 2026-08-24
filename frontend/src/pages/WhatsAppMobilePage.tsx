import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ActionButton } from "../components/ui/ActionButton";
import { IconRefresh, IconSend, IconWhatsApp } from "../components/icons/AppIcons";

interface WhatsAppMobilePageProps {
  onError: (message: string) => void;
}

function qrImageFromPayload(qr: Record<string, unknown> | null): string | null {
  if (!qr) return null;
  const candidates = [qr.qrDataUrl, qr.dataUrl, qr.qr];
  for (const value of candidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (value.startsWith("data:")) return value;
    return `data:image/png;base64,${value}`;
  }
  return null;
}

function isConnectedStatus(st: Record<string, unknown> | null): boolean {
  if (!st) return false;
  if (Boolean(st.connected)) return true;
  return String(st.status ?? "").toLowerCase() === "connected";
}

export function WhatsAppMobilePage({ onError }: WhatsAppMobilePageProps) {
  const { user } = useAuth();
  const userName = user?.full_name || user?.username || "Your account";

  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [qr, setQr] = useState<Record<string, unknown> | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [toPhone, setToPhone] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const avatarStorageKey = `whatsapp_avatar_${user?.id || "default"}`;
  const [customAvatar, setCustomAvatar] = useState<string | null>(() => {
    return localStorage.getItem(avatarStorageKey) || null;
  });
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [avatarInput, setAvatarInput] = useState("");

  const [imgFailed, setImgFailed] = useState(false);
  const connected = isConnectedStatus(status);
  const statusLabel = String(status?.status ?? (connected ? "connected" : "disconnected"));
  const connectedPhone = status?.phone ? String(status.phone) : null;
  const profilePictureUrl = (
    (status?.profilePictureUrl || status?.profile_picture_url || status?.profilePic) as string
  ) || null;

  const displayAvatarUrl = customAvatar || (!imgFailed ? profilePictureUrl : null);

  useEffect(() => {
    setImgFailed(false);
  }, [profilePictureUrl]);

  function handleSaveCustomAvatar(url: string) {
    const trimmed = url.trim();
    if (!trimmed) {
      localStorage.removeItem(avatarStorageKey);
      setCustomAvatar(null);
    } else {
      localStorage.setItem(avatarStorageKey, trimmed);
      setCustomAvatar(trimmed);
    }
    setEditingAvatar(false);
    setImgFailed(false);
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const res = evt.target?.result as string;
      if (res) {
        handleSaveCustomAvatar(res);
      }
    };
    reader.readAsDataURL(file);
  }
  const qrPending = statusLabel.toLowerCase() === "qr-pending";
  const qrImage = qrImageFromPayload(qr);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [st, session] = await Promise.all([
        client.getWhatsAppPersonalStatus(),
        client.getWhatsAppPersonalSession(),
      ]);
      setStatus(st);
      setSessionId(session.session_id);

      if (isConnectedStatus(st)) {
        setQr(null);
        return;
      }

      try {
        const qrData = await client.getWhatsAppPersonalQr();
        setQr(qrData);
      } catch {
        setQr(null);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not load WhatsApp Mobile status");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pollMs = useMemo(() => {
    if (connected) return 15_000;
    if (qrPending || !qrImage) return 3_000;
    return 6_000;
  }, [connected, qrPending, qrImage]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, refresh]);

  async function handlePair() {
    setPairing(true);
    setNotice(null);
    try {
      const qrData = await client.pairWhatsAppPersonal();
      setQr(qrData);
      setStatus((prev) => ({ ...(prev ?? {}), connected: false, status: "qr-pending" }));
      setNotice(`Scan this QR code with WhatsApp on ${userName}'s mobile phone.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not generate QR code");
    } finally {
      setPairing(false);
    }
  }

  async function handleDisconnect() {
    if (
      !window.confirm(
        `Disconnect mobile WhatsApp for ${userName}? This will ONLY disconnect ${userName}'s session (${sessionId}). Other team members' WhatsApp accounts will remain connected.`
      )
    ) {
      return;
    }
    setLoading(true);
    try {
      await client.disconnectWhatsAppPersonal();
      setNotice(`Disconnected ${userName}'s mobile WhatsApp. Click Generate QR Code to link a number.`);
      setQr(null);
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
      setNotice("Test message sent successfully! It has been logged to your Sales Agent WhatsApp Inbox & Activity history.");
      setMessage("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto py-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <IconWhatsApp className="w-6 h-6 text-emerald-400" />
            <h1 className="text-xl font-bold text-slate-100">WhatsApp Mobile</h1>
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Link your personal or company mobile WhatsApp number by scanning the QR code below. Each user has their own isolated WhatsApp session.
          </p>
        </div>
        <ActionButton icon={IconRefresh} size="md" onClick={() => void refresh()} title="Refresh Status">
          Refresh
        </ActionButton>
      </div>

      {notice ? (
        <div className="text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 flex items-center justify-between">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-slate-400 hover:text-white text-xs">
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Main Connection Container */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Connection Status & QR Code Panel */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-6 flex flex-col justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-200 mb-2">Connection Status</h3>
            
            {connected ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3">
                <div className="flex items-center gap-3.5">
                  <div className="relative shrink-0 group">
                    {displayAvatarUrl ? (
                      <img
                        src={displayAvatarUrl}
                        alt={`${userName}'s WhatsApp profile`}
                        referrerPolicy="no-referrer"
                        onError={() => setImgFailed(true)}
                        className="w-14 h-14 rounded-full object-cover border-2 border-emerald-400 shadow-md ring-2 ring-emerald-500/20"
                      />
                    ) : (
                      <div className="w-14 h-14 rounded-full bg-emerald-500/20 text-emerald-300 font-bold text-lg flex items-center justify-center border-2 border-emerald-400/80 shadow-md ring-2 ring-emerald-500/20">
                        {userName.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-emerald-500 border-2 border-slate-900 rounded-full" />
                    
                    <button
                      type="button"
                      onClick={() => setEditingAvatar(true)}
                      className="absolute inset-0 bg-slate-950/75 text-white rounded-full flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity font-medium"
                      title="Change or upload profile picture"
                    >
                      Edit
                    </button>
                  </div>

                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-bold text-emerald-300">WhatsApp Mobile Connected</h4>
                      <button
                        type="button"
                        onClick={() => setEditingAvatar(true)}
                        className="text-[11px] text-emerald-400/70 hover:text-emerald-300 underline"
                      >
                        Set photo
                      </button>
                    </div>
                    <p className="text-xs text-slate-300 font-mono mt-0.5">
                      {connectedPhone || "Linked via mobile WhatsApp"}
                    </p>
                    <p className="text-[11px] text-emerald-400/80 font-medium mt-0.5">
                      Account Owner: {userName}
                    </p>
                  </div>
                </div>

                {editingAvatar && (
                  <div className="p-3 rounded-lg bg-slate-950/80 border border-slate-700 text-xs space-y-2">
                    <p className="text-slate-300 font-medium">Set WhatsApp Profile Picture</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="Paste image URL..."
                        value={avatarInput}
                        onChange={(e) => setAvatarInput(e.target.value)}
                        className="flex-1 rounded bg-slate-900 border border-slate-700 px-2 py-1 text-slate-200 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveCustomAvatar(avatarInput)}
                        className="px-2.5 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-500 font-medium"
                      >
                        Save
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                      <label className="cursor-pointer text-emerald-400 hover:underline">
                        Upload image file
                        <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                      </label>
                      {customAvatar && (
                        <button
                          type="button"
                          onClick={() => handleSaveCustomAvatar("")}
                          className="text-red-400 hover:underline"
                        >
                          Remove custom photo
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingAvatar(false)}
                        className="text-slate-400 hover:text-white"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                )}
                <p className="text-xs text-slate-400 border-t border-emerald-500/20 pt-2.5">
                  Your mobile WhatsApp is active. Post-call follow-ups and 2-way inbox messages sync directly with this account.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                <h4 className="text-sm font-bold text-amber-300">Not Connected</h4>
                <p className="text-xs text-slate-300 mt-1">
                  Scan the QR code to pair your mobile WhatsApp number with your sales account.
                </p>
              </div>
            )}
          </div>

          {!connected ? (
            <div className="space-y-4 text-center py-2">
              {loading && !qrImage ? (
                <div className="py-8 text-slate-500 text-sm animate-pulse">
                  Initializing WhatsApp Mobile bridge session…
                </div>
              ) : qrImage ? (
                <div className="space-y-3">
                  <div className="relative inline-block">
                    <img
                      src={qrImage}
                      alt="WhatsApp Mobile QR code"
                      className="mx-auto w-60 h-60 rounded-xl bg-white p-3 shadow-2xl border-4 border-emerald-500/40"
                    />
                    <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                      Auto-checking connection…
                    </div>
                  </div>
                </div>
              ) : (
                <div className="py-6 space-y-3">
                  <p className="text-sm text-slate-400">Ready to pair your mobile WhatsApp?</p>
                  <ActionButton
                    icon={IconWhatsApp}
                    variant="primary"
                    size="md"
                    disabled={pairing}
                    onClick={() => void handlePair()}
                    title="Generate QR code"
                    className="w-full justify-center"
                  >
                    {pairing ? "Generating QR Code…" : "Generate QR Code"}
                  </ActionButton>
                </div>
              )}

              {qrImage ? (
                <ActionButton
                  icon={IconRefresh}
                  variant="ghost"
                  size="md"
                  disabled={pairing}
                  onClick={() => void handlePair()}
                  title="Refresh QR code"
                  className="w-full justify-center"
                >
                  {pairing ? "Refreshing QR…" : "Refresh QR Code"}
                </ActionButton>
              ) : null}
            </div>
          ) : (
            <div className="pt-4 border-t border-slate-800">
              <ActionButton
                icon={IconRefresh}
                variant="ghost"
                size="md"
                onClick={() => void handleDisconnect()}
                title="Disconnect personal mobile WhatsApp"
                className="w-full justify-center text-slate-400 hover:text-red-400"
              >
                Disconnect / Unpair Mobile
              </ActionButton>
            </div>
          )}

          <div className="text-[11px] text-slate-500 pt-2 border-t border-slate-800/60 flex items-center justify-between">
            <span>Account Session: <span className="text-emerald-400 font-medium">{userName}</span></span>
            <span>Isolated Multi-User Session</span>
          </div>
        </div>

        {/* Pairing Instructions & Quick Test Sender */}
        <div className="space-y-6 flex flex-col justify-between">
          {/* Instructions */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-200">How to Connect</h3>
            <ol className="space-y-3 text-sm text-slate-300">
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-slate-800 text-emerald-400 font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                  1
                </span>
                <span>Open **WhatsApp** on your mobile phone.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-slate-800 text-emerald-400 font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                  2
                </span>
                <span>
                  Tap **Settings** (on iPhone) or **Menu ⋮** (on Android) → **Linked Devices**.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-slate-800 text-emerald-400 font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                  3
                </span>
                <span>Tap **Link a Device** and scan the QR code on your computer screen.</span>
              </li>
            </ol>
          </div>

          {/* Quick Test Sender */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-200">Quick Test Sender</h3>
            <p className="text-xs text-slate-400">
              Send a test message directly from your linked mobile WhatsApp number to verify.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Recipient Phone Number</label>
                <input
                  value={toPhone}
                  onChange={(e) => setToPhone(e.target.value)}
                  placeholder="e.g. +923001234567"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Message Text</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder="Hello, testing WhatsApp Mobile integration!"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <ActionButton
                icon={IconSend}
                variant="primary"
                size="md"
                disabled={sending || !connected || !toPhone.trim() || !message.trim()}
                onClick={() => void handleSend()}
                className="w-full justify-center"
              >
                {sending ? "Sending Test Message…" : "Send Test Message"}
              </ActionButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
