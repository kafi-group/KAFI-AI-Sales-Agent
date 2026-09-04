import { useMemo, useState } from "react";
import type { UrgentEmailItem } from "../api/client";

interface UrgentEmailAlertModalProps {
  urgentEmails: UrgentEmailItem[];
  onOpenAndReply: (email: UrgentEmailItem) => void;
  onDismiss: () => void;
}

export function UrgentEmailAlertModal({
  urgentEmails,
  onOpenAndReply,
  onDismiss,
}: UrgentEmailAlertModalProps) {
  const [selectedUserFilter, setSelectedUserFilter] = useState<string>("all");
  const [currentIndex, setCurrentIndex] = useState(0);

  // Group emails by user / category
  const userCategories = useMemo(() => {
    const map = new Map<string, { label: string; email: string; count: number }>();
    for (const item of urgentEmails) {
      const key = item.user_id ? String(item.user_id) : (item.mailbox_email || "default");
      const label = item.user_full_name || item.user_name || item.mailbox_email || "My Inbox";
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, { label, email: item.mailbox_email || "", count: 1 });
      }
    }
    return Array.from(map.entries()).map(([key, data]) => ({
      key,
      ...data,
    }));
  }, [urgentEmails]);

  // Filtered list based on selected category pill
  const filteredList = useMemo(() => {
    if (selectedUserFilter === "all") return urgentEmails;
    return urgentEmails.filter((item) => {
      const key = item.user_id ? String(item.user_id) : (item.mailbox_email || "default");
      return key === selectedUserFilter;
    });
  }, [urgentEmails, selectedUserFilter]);

  if (!urgentEmails || urgentEmails.length === 0) return null;

  const activeIndex = Math.min(currentIndex, Math.max(0, filteredList.length - 1));
  const currentEmail = filteredList[activeIndex] || filteredList[0] || urgentEmails[0];
  const totalInFilter = filteredList.length;
  const globalTotal = urgentEmails.length;

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 sm:p-6 animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl rounded-2xl border-2 border-red-500 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 p-6 sm:p-8 shadow-2xl shadow-red-950/80 text-slate-100 space-y-6">
        {/* Glow Header */}
        <div className="flex items-start justify-between border-b border-red-500/30 pb-4">
          <div className="flex items-center gap-4">
            <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-red-600/30 border border-red-500 text-3xl shadow-lg shadow-red-600/40">
              <span className="animate-bounce">🚨</span>
              <span className="absolute -top-1 -right-1 flex h-4 w-4">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500"></span>
              </span>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl sm:text-2xl font-extrabold text-red-100 tracking-wide">
                  URGENT EMAIL REQUIRES IMMEDIATE REPLY
                </h2>
                {globalTotal > 1 && (
                  <span className="rounded-full bg-red-600 px-3 py-1 text-xs font-bold text-white shadow-md shadow-red-600/50">
                    {activeIndex + 1} of {totalInFilter} {selectedUserFilter !== "all" ? `(Total ${globalTotal})` : ""}
                  </span>
                )}
              </div>
              <p className="text-xs sm:text-sm text-red-300/80 mt-1">
                This critical customer enquiry is waiting for response. Alert remains active until an email reply is sent.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-slate-800 transition text-lg"
            title="Dismiss for current session"
          >
            ✕
          </button>
        </div>

        {/* User Category Filter Tabs (For Admin & Multi-User Breakdown) */}
        {userCategories.length > 1 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Filter by Assigned Sales Profile / Mailbox:
              </span>
              <span className="text-xs text-slate-500">
                {userCategories.length} user mailboxes active
              </span>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setSelectedUserFilter("all");
                  setCurrentIndex(0);
                }}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  selectedUserFilter === "all"
                    ? "bg-red-600 text-white shadow-lg shadow-red-600/40 border border-red-400"
                    : "bg-slate-800/90 text-slate-300 hover:bg-slate-700 border border-slate-700"
                }`}
              >
                <span>👥 All Profiles</span>
                <span className="rounded-full bg-black/40 px-2 py-0.5 text-[11px] font-mono">
                  {globalTotal}
                </span>
              </button>

              {userCategories.map((cat) => (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => {
                    setSelectedUserFilter(cat.key);
                    setCurrentIndex(0);
                  }}
                  className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-2 ${
                    selectedUserFilter === cat.key
                      ? "bg-amber-600 text-white shadow-lg shadow-amber-600/40 border border-amber-400 font-bold"
                      : "bg-slate-800/90 text-slate-300 hover:bg-slate-700 border border-slate-700"
                  }`}
                >
                  <span>👤 {cat.label}</span>
                  {cat.email && (
                    <span className="text-[11px] opacity-75 hidden md:inline">
                      ({cat.email})
                    </span>
                  )}
                  <span className="rounded-full bg-black/40 px-2 py-0.5 text-[11px] font-mono font-bold">
                    {cat.count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Assigned Rep & Mailbox Information Banner */}
        <div className="flex flex-wrap items-center justify-between rounded-xl bg-slate-800/90 border border-slate-700/80 px-4 py-2.5 text-xs sm:text-sm">
          <div className="flex items-center gap-2 text-slate-200">
            <span className="text-amber-400 font-bold">👤 Assigned User:</span>
            <span className="font-semibold text-white">
              {currentEmail.user_full_name || currentEmail.user_name || "Sales Agent"}
            </span>
            {currentEmail.mailbox_email && (
              <span className="text-slate-400 text-xs">
                · 📬 <code className="text-sky-300 bg-sky-950/60 px-1.5 py-0.5 rounded border border-sky-800/50">{currentEmail.mailbox_email}</code>
              </span>
            )}
          </div>
          <span className="text-xs text-slate-400">
            Status: <span className="text-rose-400 font-medium">Awaiting Response</span>
          </span>
        </div>

        {/* Overdue Alert Banner */}
        <div className="flex items-center justify-between rounded-xl bg-red-950/80 border border-red-700 px-5 py-3 shadow-inner">
          <div className="flex items-center gap-3 text-xs sm:text-sm font-bold text-red-100">
            <span className="text-xl">⚠️</span>
            <span>
              {currentEmail.days_ago > 0
                ? `Received ${currentEmail.days_ago} ${currentEmail.days_ago === 1 ? "day" : "days"} ago (${currentEmail.hours_ago} hours) — OVERDUE FOR REPLY!`
                : `Received ${currentEmail.hours_ago} hours ago — Immediate Response Needed`}
            </span>
          </div>
          <span className="text-xs font-mono font-bold px-2.5 py-1 rounded bg-red-900/80 border border-red-600 text-red-200 uppercase">
            {currentEmail.triage_label || "Urgent"}
          </span>
        </div>

        {/* Email Details Card */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/95 p-5 space-y-4 shadow-xl">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs sm:text-sm">
            <div>
              <span className="block text-[11px] uppercase font-bold text-slate-400 mb-1">
                Sender / Client Name &amp; Email
              </span>
              <span className="font-bold text-slate-100 text-base sm:text-lg block">
                {currentEmail.from_name || currentEmail.from_email}
              </span>
              {currentEmail.from_name && (
                <span className="text-slate-400 text-xs sm:text-sm truncate block mt-0.5 font-mono">
                  &lt;{currentEmail.from_email}&gt;
                </span>
              )}
            </div>

            <div>
              <span className="block text-[11px] uppercase font-bold text-slate-400 mb-1">
                Date &amp; Time Received
              </span>
              <span className="text-slate-200 text-sm sm:text-base font-semibold block">
                {currentEmail.latest_date
                  ? new Date(currentEmail.latest_date).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "Recent"}
              </span>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800">
            <span className="block text-[11px] uppercase font-bold text-slate-400 mb-1.5">
              Subject Line
            </span>
            <div className="text-base sm:text-lg font-bold text-emerald-300 flex flex-wrap items-center gap-2.5">
              <span className="px-2 py-0.5 rounded bg-red-950 text-red-300 border border-red-700 text-xs font-extrabold">
                {currentEmail.triage_category === "urgent" ? "🚨 URGENT" : "⚡ ACTION REQUIRED"}
              </span>
              <span>{currentEmail.subject}</span>
            </div>
          </div>

          {currentEmail.preview && (
            <div className="pt-3 border-t border-slate-800">
              <span className="block text-[11px] uppercase font-bold text-slate-400 mb-1.5">
                Message Preview
              </span>
              <p className="text-sm leading-relaxed text-slate-200 bg-slate-950/80 p-4 rounded-xl border border-slate-800 font-sans whitespace-pre-wrap max-h-48 overflow-y-auto">
                {currentEmail.preview}
              </p>
            </div>
          )}
        </div>

        {/* Carousel pagination if multiple */}
        {totalInFilter > 1 && (
          <div className="flex items-center justify-between text-xs sm:text-sm text-slate-300 px-2">
            <button
              type="button"
              disabled={activeIndex === 0}
              onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-medium flex items-center gap-1.5 border border-slate-700"
            >
              ← Previous Urgent Email
            </button>
            <span className="font-semibold text-slate-300">
              Showing {activeIndex + 1} of {totalInFilter} urgent enquiries
            </span>
            <button
              type="button"
              disabled={activeIndex === totalInFilter - 1}
              onClick={() => setCurrentIndex((prev) => Math.min(totalInFilter - 1, prev + 1))}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-medium flex items-center gap-1.5 border border-slate-700"
            >
              Next Urgent Email →
            </button>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-2 border-t border-slate-800/80">
          <p className="text-xs text-slate-400 italic">
            * Alert re-appears on login/refresh until an email reply is sent.
          </p>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <button
              type="button"
              onClick={onDismiss}
              className="flex-1 sm:flex-none px-5 py-3 rounded-xl border border-slate-700 bg-slate-800/90 hover:bg-slate-700 text-xs sm:text-sm font-semibold text-slate-300 transition"
            >
              Dismiss For Now
            </button>
            <button
              type="button"
              onClick={() => onOpenAndReply(currentEmail)}
              className="flex-1 sm:flex-none px-6 py-3 rounded-xl bg-gradient-to-r from-red-600 via-rose-600 to-red-600 hover:from-red-500 hover:to-rose-500 text-xs sm:text-sm font-bold text-white shadow-xl shadow-red-600/40 flex items-center justify-center gap-2 transition cursor-pointer"
            >
              <span>✉️ Open &amp; Reply Now</span>
              <span>→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
