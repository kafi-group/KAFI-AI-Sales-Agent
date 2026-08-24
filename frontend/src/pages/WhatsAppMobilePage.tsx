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
    <div className="space-y-8 w-full max-w-full px-2 md:px-6 py-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-6 flex-wrap border-b border-slate-800 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <IconWhatsApp className="w-9 h-9 text-emerald-400" />
            <h1 className="text-3xl font-extrabold text-slate-100 tracking-tight">WhatsApp Mobile</h1>
          </div>
          <p className="text-base text-slate-300 mt-2 max-w-3xl leading-relaxed">
            Link your personal or company mobile WhatsApp number by scanning the QR code below. Each user has their own isolated WhatsApp session.
          </p>
        </div>
        <ActionButton icon={IconRefresh} size="md" onClick={() => void refresh()} title="Refresh Status" className="px-5 py-2.5 text-base">
          Refresh Status
        </ActionButton>
      </div>

      {notice ? (
        <div className="text-base text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl px-6 py-4 flex items-center justify-between shadow-lg">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-slate-400 hover:text-white text-sm font-semibold ml-4">
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Main Connection Container - Stretched Full Width */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Connection Status & QR Code Panel (Col 7) */}
        <div className="lg:col-span-7 rounded-3xl border border-slate-800 bg-slate-900/80 p-8 space-y-8 flex flex-col justify-between shadow-2xl">
          <div>
            <h3 className="text-xl font-bold text-slate-100 mb-6 flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse" />
              Connection Status
            </h3>
            
            {connected ? (
              <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-6 space-y-6 shadow-inner">
                {/* 3x Larger Profile Picture & User Info Container */}
                <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 text-center sm:text-left">
                  {/* Avatar: 3X Larger (176px x 176px) */}
                  <div className="relative shrink-0 group">
                    {displayAvatarUrl ? (
                      <img
                        src={displayAvatarUrl}
                        alt={`${userName}'s WhatsApp profile`}
                        referrerPolicy="no-referrer"
                        onError={() => setImgFailed(true)}
                        className="w-44 h-44 rounded-full object-cover border-4 border-emerald-400 shadow-2xl ring-4 ring-emerald-500/20 transition-transform duration-200 group-hover:scale-[1.02]"
                      />
                    ) : (
                      <div className="w-44 h-44 rounded-full bg-emerald-500/20 text-emerald-300 font-extrabold text-5xl flex items-center justify-center border-4 border-emerald-400/80 shadow-2xl ring-4 ring-emerald-500/20">
                        {userName.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="absolute bottom-2 right-2 w-7 h-7 bg-emerald-500 border-4 border-slate-900 rounded-full shadow-md" />
                    
                    <button
                      type="button"
                      onClick={() => setEditingAvatar(true)}
                      className="absolute inset-0 bg-slate-950/80 text-white rounded-full flex flex-col items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity font-semibold px-4 text-center backdrop-blur-sm"
                      title="Change or upload profile picture"
                    >
                      <span className="text-sm font-bold text-emerald-300">Edit Photo</span>
                      <span className="text-[10px] text-slate-300 mt-1">Upload file or URL</span>
                    </button>
                  </div>

                  <div className="space-y-2 pt-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <h4 className="text-2xl font-extrabold text-emerald-300 tracking-tight">WhatsApp Mobile Connected</h4>
                      <button
                        type="button"
                        onClick={() => setEditingAvatar(true)}
                        className="text-xs bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 px-3 py-1 rounded-lg font-medium transition-colors"
                      >
                        Set / Change Photo
                      </button>
                    </div>
                    <p className="text-lg text-slate-100 font-mono font-medium">
                      {connectedPhone || "Linked via mobile WhatsApp"}
                    </p>
                    <p className="text-base text-emerald-400 font-semibold">
                      Account Session: {userName}
                    </p>
                    <p className="text-sm text-slate-300 leading-relaxed pt-2">
                      Your mobile WhatsApp is active. Post-call follow-ups and 2-way inbox messages sync directly with this account.
                    </p>
                  </div>
                </div>

                {editingAvatar && (
                  <div className="p-4 rounded-xl bg-slate-950/90 border border-slate-700 text-sm space-y-3 shadow-xl">
                    <p className="text-slate-200 font-semibold text-base">Set WhatsApp Profile Picture</p>
                    <div className="flex items-center gap-3">
                      <input
                        type="text"
                        placeholder="Paste image URL..."
                        value={avatarInput}
                        onChange={(e) => setAvatarInput(e.target.value)}
                        className="flex-1 rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveCustomAvatar(avatarInput)}
                        className="px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-500 font-semibold text-sm transition-colors"
                      >
                        Save URL
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-400 pt-2 border-t border-slate-800">
                      <label className="cursor-pointer text-emerald-400 hover:text-emerald-300 font-semibold text-sm underline">
                        Upload image file
                        <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                      </label>
                      {customAvatar && (
                        <button
                          type="button"
                          onClick={() => handleSaveCustomAvatar("")}
                          className="text-red-400 hover:underline font-medium text-xs"
                        >
                          Remove custom photo
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingAvatar(false)}
                        className="text-slate-400 hover:text-white font-medium text-xs"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-6">
                <h4 className="text-lg font-bold text-amber-300">Not Connected</h4>
                <p className="text-sm text-slate-200 mt-1.5 leading-relaxed">
                  Scan the QR code below to pair your mobile WhatsApp number with your sales account.
                </p>
              </div>
            )}
          </div>

          {!connected ? (
            <div className="space-y-6 text-center py-4">
              {loading && !qrImage ? (
                <div className="py-12 text-slate-400 text-base font-medium animate-pulse">
                  Initializing WhatsApp Mobile bridge session…
                </div>
              ) : qrImage ? (
                <div className="space-y-4">
                  <div className="relative inline-block">
                    {/* QR Code: Super Large (420px x 420px) */}
                    <img
                      src={qrImage}
                      alt="WhatsApp Mobile QR code"
                      className="mx-auto w-80 h-80 sm:w-[420px] sm:h-[420px] rounded-3xl bg-white p-5 shadow-2xl border-4 border-emerald-500/50 object-contain"
                    />
                    <div className="mt-4 inline-flex items-center gap-2 text-sm text-emerald-400 bg-emerald-500/10 px-4 py-1.5 rounded-full border border-emerald-500/30 font-semibold">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                      Auto-checking connection…
                    </div>
                  </div>
                </div>
              ) : (
                <div className="py-8 space-y-4">
                  <p className="text-base text-slate-300 font-medium">Ready to pair your mobile WhatsApp?</p>
                  <ActionButton
                    icon={IconWhatsApp}
                    variant="primary"
                    size="md"
                    disabled={pairing}
                    onClick={() => void handlePair()}
                    title="Generate QR code"
                    className="w-full justify-center text-base py-3 font-bold"
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
                  className="w-full justify-center text-base py-3"
                >
                  {pairing ? "Refreshing QR…" : "Refresh QR Code"}
                </ActionButton>
              ) : null}
            </div>
          ) : (
            <div className="pt-6 border-t border-slate-800">
              <ActionButton
                icon={IconRefresh}
                variant="ghost"
                size="md"
                onClick={() => void handleDisconnect()}
                title="Disconnect personal mobile WhatsApp"
                className="w-full justify-center text-slate-400 hover:text-red-400 text-base py-3"
              >
                Disconnect / Unpair Mobile
              </ActionButton>
            </div>
          )}

          <div className="text-xs text-slate-400 pt-3 border-t border-slate-800/80 flex items-center justify-between">
            <span>Account Session: <span className="text-emerald-400 font-bold text-sm">{userName}</span></span>
            <span className="bg-slate-800/80 px-2.5 py-1 rounded-full text-slate-300">Isolated Multi-User Session</span>
          </div>
        </div>

        {/* Pairing Instructions & Quick Test Sender (Col 5) */}
        <div className="lg:col-span-5 space-y-8 flex flex-col justify-between">
          {/* How to Connect Box */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-8 space-y-6 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-100">How to Connect</h3>
            <ol className="space-y-4 text-base text-slate-200">
              <li className="flex items-start gap-4">
                <span className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-extrabold text-sm flex items-center justify-center shrink-0 mt-0.5">
                  1
                </span>
                <span className="leading-relaxed">
                  Open <strong className="text-white font-bold">WhatsApp</strong> on your mobile phone.
                </span>
              </li>
              <li className="flex items-start gap-4">
                <span className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-extrabold text-sm flex items-center justify-center shrink-0 mt-0.5">
                  2
                </span>
                <span className="leading-relaxed">
                  Tap <strong className="text-white font-bold">Settings</strong> (on iPhone) or <strong className="text-white font-bold">Menu ⋮</strong> (on Android) → <strong className="text-white font-bold">Linked Devices</strong>.
                </span>
              </li>
              <li className="flex items-start gap-4">
                <span className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-extrabold text-sm flex items-center justify-center shrink-0 mt-0.5">
                  3
                </span>
                <span className="leading-relaxed">
                  Tap <strong className="text-white font-bold">Link a Device</strong> and scan the QR code on your computer screen.
                </span>
              </li>
            </ol>
          </div>

          {/* Quick Test Sender */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-8 space-y-6 shadow-2xl">
            <div>
              <h3 className="text-xl font-bold text-slate-100">Quick Test Sender</h3>
              <p className="text-sm text-slate-400 mt-1">
                Send a test message directly from your linked mobile WhatsApp number to verify.
              </p>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-semibold text-slate-300 block mb-2">Recipient Phone Number</label>
                <input
                  value={toPhone}
                  onChange={(e) => setToPhone(e.target.value)}
                  placeholder="e.g. +923001234567"
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-base text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="text-sm font-semibold text-slate-300 block mb-2">Message Text</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder="Hello, testing WhatsApp Mobile integration!"
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-base text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <ActionButton
                icon={IconSend}
                variant="primary"
                size="md"
                disabled={sending || !connected || !toPhone.trim() || !message.trim()}
                onClick={() => void handleSend()}
                className="w-full justify-center text-base py-3.5 font-bold"
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
