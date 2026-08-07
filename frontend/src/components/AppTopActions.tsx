import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "./ThemeToggle";
import {
  IconBell,
  IconRefresh,
  IconSignOut,
} from "./icons/AppIcons";
import {
  getNotificationMode,
  getNotificationPermission,
  requestNotificationPermission,
  setNotificationMode,
  subscribeNotificationPrefs,
  unlockNotificationAudio,
  type NotificationMode,
} from "../utils/notify";

interface AppTopActionsProps {
  onRefresh: () => void;
  onLogout?: () => void;
  /** Compact strip for the mobile header. */
  compact?: boolean;
}

const MODE_OPTIONS: { value: NotificationMode; label: string; hint: string }[] = [
  {
    value: "popup_sound",
    label: "Popup + sound",
    hint: "In-app popup with alert chime",
  },
  {
    value: "popup_voiceover",
    label: "Popup + voiceover",
    hint: "In-app popup with spoken alert",
  },
  {
    value: "off",
    label: "No popup or voiceover",
    hint: "Silent — no popup, sound, or speech",
  },
];

export function AppTopActions({ onRefresh, onLogout, compact = false }: AppTopActionsProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<NotificationMode>(() => getNotificationMode());
  const [notifPermission, setNotifPermission] = useState(getNotificationPermission());
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribeNotificationPrefs(() => setMode(getNotificationMode()));
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSettingsOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [settingsOpen]);

  function chooseMode(next: NotificationMode) {
    unlockNotificationAudio();
    setNotificationMode(next);
    setMode(next);
  }

  async function enableDesktopNotifications() {
    unlockNotificationAudio();
    const result = await requestNotificationPermission();
    setNotifPermission(result);
  }

  const iconBtn =
    "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition";

  return (
    <div className={`relative flex items-center gap-1.5 ${compact ? "" : ""}`} ref={panelRef}>
      <button
        type="button"
        className={iconBtn}
        title="Notification settings"
        aria-label="Notification settings"
        aria-expanded={settingsOpen}
        onClick={() => {
          unlockNotificationAudio();
          setSettingsOpen((open) => !open);
        }}
      >
        <IconBell size="sm" />
      </button>

      <ThemeToggle compact />

      <button
        type="button"
        className={iconBtn}
        title="Refresh"
        aria-label="Refresh"
        onClick={onRefresh}
      >
        <IconRefresh size="sm" />
      </button>

      {onLogout && (
        <button
          type="button"
          className={iconBtn}
          title="Sign out"
          aria-label="Sign out"
          onClick={onLogout}
        >
          <IconSignOut size="sm" />
        </button>
      )}

      {settingsOpen && (
        <div
          className={`absolute z-50 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-slate-700 bg-slate-950/98 backdrop-blur shadow-2xl p-4 ${
            compact ? "right-0 top-full mt-2" : "right-0 top-full mt-2"
          }`}
          role="dialog"
          aria-label="Notification settings"
        >
          <p className="text-sm font-medium text-slate-100 flex items-center gap-2">
            <IconBell size="sm" className="text-slate-400" />
            Notifications
          </p>
          <p className="text-xs text-slate-500 mt-1 mb-3">
            Applies to email, WhatsApp, and follow-up alerts. Turning this off silences all of them.
          </p>

          <fieldset className="space-y-2">
            <legend className="sr-only">Alert style</legend>
            {MODE_OPTIONS.map((option) => {
              const selected = mode === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition ${
                    selected
                      ? "border-emerald-500/60 bg-emerald-500/10"
                      : "border-slate-800 bg-slate-900/60 hover:border-slate-700"
                  }`}
                >
                  <input
                    type="radio"
                    name="notification-mode"
                    className="mt-1 accent-emerald-500"
                    checked={selected}
                    onChange={() => chooseMode(option.value)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-100">{option.label}</span>
                    <span className="block text-xs text-slate-500 mt-0.5">{option.hint}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {notifPermission !== "unsupported" && (
            <div className="mt-4 pt-3 border-t border-slate-800">
              <p className="text-xs text-slate-400 mb-2">
                Desktop system popups (Windows / macOS), separate from in-app alerts.
              </p>
              {notifPermission === "granted" ? (
                <p className="text-xs text-emerald-400">Desktop notifications enabled</p>
              ) : (
                <button
                  type="button"
                  onClick={() => void enableDesktopNotifications()}
                  className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
                >
                  {notifPermission === "denied"
                    ? "Blocked in browser — check site settings"
                    : "Allow desktop notifications"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
