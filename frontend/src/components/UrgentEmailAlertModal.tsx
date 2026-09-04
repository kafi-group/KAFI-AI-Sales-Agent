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
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/92 backdrop-blur-xl p-2 sm:p-4 lg:p-6 animate-in fade-in duration-200">
      <div className="relative w-[96vw] max-w-[1550px] max-h-[94vh] overflow-y-auto rounded-3xl border-3 sm:border-4 border-red-500 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 p-6 sm:p-10 lg:p-12 shadow-2xl shadow-red-950/90 text-slate-100 space-y-6 sm:space-y-8 custom-scrollbar">
        
        {/* Glow Header */}
        <div className="flex items-start justify-between border-b-2 border-red-500/40 pb-5 sm:pb-6">
          <div className="flex items-center gap-5 sm:gap-7">
            <div className="relative flex h-18 w-18 sm:h-24 sm:w-24 shrink-0 items-center justify-center rounded-2xl sm:rounded-3xl bg-red-600/30 border-2 sm:border-3 border-red-500 text-4xl sm:text-6xl shadow-2xl shadow-red-600/60">
              <span className="animate-bounce">🚨</span>
              <span className="absolute -top-1.5 -right-1.5 flex h-5 w-5 sm:h-6 sm:w-6">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-5 w-5 sm:h-6 sm:w-6 bg-red-500"></span>
              </span>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-3 sm:gap-5">
                <h2 className="text-2xl sm:text-3xl lg:text-4xl xl:text-5xl font-black text-red-100 tracking-wide">
                  URGENT EMAIL REQUIRES IMMEDIATE REPLY
                </h2>
                {globalTotal > 1 && (
                  <span className="rounded-full bg-red-600 px-4 sm:px-6 py-1.5 sm:py-2 text-sm sm:text-base lg:text-lg font-black text-white shadow-xl shadow-red-600/60">
                    {activeIndex + 1} of {totalInFilter} {selectedUserFilter !== "all" ? `(Total ${globalTotal})` : ""}
                  </span>
                )}
              </div>
              <p className="text-base sm:text-lg lg:text-2xl text-red-300/95 mt-2 font-semibold">
                This critical customer enquiry is waiting for response. Alert remains active until an email reply is sent.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-slate-400 hover:text-white p-3 rounded-2xl hover:bg-slate-800 transition text-3xl sm:text-4xl cursor-pointer"
            title="Dismiss for current session"
          >
            ✕
          </button>
        </div>

        {/* User Category Filter Tabs (For Admin & Multi-User Breakdown) */}
        {userCategories.length > 1 && (
          <div className="space-y-3 rounded-2xl bg-slate-900/90 border-2 border-slate-800 p-4 sm:p-6 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-sm sm:text-base lg:text-lg font-black uppercase tracking-wider text-slate-300">
                Filter by Assigned Sales Profile / Mailbox:
              </span>
              <span className="text-sm sm:text-base text-slate-400 font-semibold">
                {userCategories.length} user mailboxes active
              </span>
            </div>
            <div className="flex flex-wrap gap-3 sm:gap-4 pt-1">
              <button
                type="button"
                onClick={() => {
                  setSelectedUserFilter("all");
                  setCurrentIndex(0);
                }}
                className={`px-5 sm:px-7 py-2.5 sm:py-3.5 rounded-2xl text-sm sm:text-base lg:text-lg font-black transition flex items-center gap-3 cursor-pointer ${
                  selectedUserFilter === "all"
                    ? "bg-red-600 text-white shadow-xl shadow-red-600/50 border-2 border-red-300 scale-105"
                    : "bg-slate-800/90 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700"
                }`}
              >
                <span>👥 All Profiles</span>
                <span className="rounded-full bg-black/60 px-3 py-0.5 text-xs sm:text-base font-mono font-black">
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
                  className={`px-5 sm:px-7 py-2.5 sm:py-3.5 rounded-2xl text-sm sm:text-base lg:text-lg font-bold transition flex items-center gap-3 cursor-pointer ${
                    selectedUserFilter === cat.key
                      ? "bg-amber-600 text-white shadow-xl shadow-amber-600/50 border-2 border-amber-300 font-black scale-105"
                      : "bg-slate-800/90 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700"
                  }`}
                >
                  <span>👤 {cat.label}</span>
                  {cat.email && (
                    <span className="text-xs sm:text-sm opacity-80 hidden md:inline font-mono">
                      ({cat.email})
                    </span>
                  )}
                  <span className="rounded-full bg-black/60 px-3 py-0.5 text-xs sm:text-base font-mono font-black">
                    {cat.count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Assigned Rep & Mailbox Information Banner */}
        <div className="flex flex-wrap items-center justify-between rounded-2xl bg-slate-800/95 border-2 border-slate-700 px-6 sm:px-8 py-4 sm:py-5 text-base sm:text-xl lg:text-2xl gap-3">
          <div className="flex flex-wrap items-center gap-3 sm:gap-4 text-slate-200">
            <span className="text-amber-400 font-black text-lg sm:text-2xl">👤 Assigned User:</span>
            <span className="font-black text-white text-lg sm:text-2xl">
              {currentEmail.user_full_name || currentEmail.user_name || "Sales Agent"}
            </span>
            {currentEmail.mailbox_email && (
              <span className="text-slate-300 text-base sm:text-xl">
                · 📬 <code className="text-sky-300 bg-sky-950/80 px-3 py-1 rounded-xl border border-sky-700/60 font-mono font-bold text-sm sm:text-lg">{currentEmail.mailbox_email}</code>
              </span>
            )}
          </div>
          <span className="text-xs sm:text-base text-slate-300 font-semibold">
            Status: <span className="text-rose-400 font-black uppercase tracking-wider">Awaiting Immediate Response</span>
          </span>
        </div>

        {/* Overdue Alert Banner */}
        <div className="flex flex-wrap items-center justify-between rounded-2xl bg-red-950/95 border-2 sm:border-3 border-red-600 px-6 sm:px-9 py-4 sm:py-6 shadow-inner gap-3">
          <div className="flex items-center gap-4 text-base sm:text-2xl lg:text-3xl font-black text-red-100">
            <span className="text-3xl sm:text-4xl">⚠️</span>
            <span>
              {currentEmail.days_ago > 0
                ? `Received ${currentEmail.days_ago} ${currentEmail.days_ago === 1 ? "day" : "days"} ago (${currentEmail.hours_ago} hours) — OVERDUE FOR REPLY!`
                : `Received ${currentEmail.hours_ago} hours ago — Immediate Response Needed`}
            </span>
          </div>
          <span className="text-xs sm:text-base font-mono font-black px-4 py-2 rounded-xl bg-red-900 border-2 border-red-400 text-red-100 uppercase tracking-wider shadow-lg">
            {currentEmail.triage_label || "Urgent"}
          </span>
        </div>

        {/* Email Details Card */}
        <div className="rounded-2xl border-2 border-slate-700/80 bg-slate-900/95 p-6 sm:p-10 space-y-6 sm:space-y-8 shadow-2xl">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8 text-base sm:text-lg">
            <div>
              <span className="block text-xs sm:text-base uppercase font-black text-slate-400 mb-2 tracking-wider">
                Sender / Client Name &amp; Email
              </span>
              <span className="font-black text-slate-100 text-2xl sm:text-3xl lg:text-4xl block leading-tight">
                {currentEmail.from_name || currentEmail.from_email}
              </span>
              {currentEmail.from_name && (
                <span className="text-sky-300 text-base sm:text-xl lg:text-2xl truncate block mt-2 font-mono font-medium">
                  &lt;{currentEmail.from_email}&gt;
                </span>
              )}
            </div>

            <div>
              <span className="block text-xs sm:text-base uppercase font-black text-slate-400 mb-2 tracking-wider">
                Date &amp; Time Received
              </span>
              <span className="text-slate-200 text-xl sm:text-2xl lg:text-3xl font-bold block mt-2">
                {currentEmail.latest_date
                  ? new Date(currentEmail.latest_date).toLocaleString(undefined, {
                      dateStyle: "full",
                      timeStyle: "short",
                    })
                  : "Recent"}
              </span>
            </div>
          </div>

          <div className="pt-5 border-t-2 border-slate-800">
            <span className="block text-xs sm:text-base uppercase font-black text-slate-400 mb-2 tracking-wider">
              Subject Line
            </span>
            <div className="text-xl sm:text-2xl lg:text-3xl xl:text-4xl font-black text-emerald-300 flex flex-wrap items-center gap-3 sm:gap-4 leading-normal">
              <span className="px-3.5 py-1.5 rounded-xl bg-red-950 text-red-200 border-2 border-red-500 text-xs sm:text-base font-black tracking-wide">
                {currentEmail.triage_category === "urgent" ? "🚨 URGENT" : "⚡ ACTION REQUIRED"}
              </span>
              <span>{currentEmail.subject}</span>
            </div>
          </div>

          {currentEmail.preview && (
            <div className="pt-5 border-t-2 border-slate-800">
              <span className="block text-xs sm:text-base uppercase font-black text-slate-400 mb-2 tracking-wider">
                Message Preview
              </span>
              <p className="text-base sm:text-xl lg:text-2xl leading-relaxed text-slate-100 bg-slate-950 p-6 sm:p-8 rounded-2xl border-2 border-slate-800 font-sans whitespace-pre-wrap max-h-72 sm:max-h-80 overflow-y-auto shadow-inner custom-scrollbar">
                {currentEmail.preview}
              </p>
            </div>
          )}
        </div>

        {/* Carousel pagination if multiple */}
        {totalInFilter > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-4 text-base sm:text-xl text-slate-200 px-2">
            <button
              type="button"
              disabled={activeIndex === 0}
              onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
              className="px-6 sm:px-8 py-3.5 sm:py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-bold flex items-center gap-3 border-2 border-slate-600 shadow-lg cursor-pointer text-sm sm:text-lg"
            >
              ← Previous Urgent Email
            </button>
            <span className="font-black text-slate-100 text-lg sm:text-2xl">
              Showing {activeIndex + 1} of {totalInFilter} urgent enquiries
            </span>
            <button
              type="button"
              disabled={activeIndex === totalInFilter - 1}
              onClick={() => setCurrentIndex((prev) => Math.min(totalInFilter - 1, prev + 1))}
              className="px-6 sm:px-8 py-3.5 sm:py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition font-bold flex items-center gap-3 border-2 border-slate-600 shadow-lg cursor-pointer text-sm sm:text-lg"
            >
              Next Urgent Email →
            </button>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6 pt-4 border-t-2 border-slate-800">
          <p className="text-xs sm:text-base text-slate-400 italic">
            * Alert re-appears on login/refresh until an email reply is sent.
          </p>

          <div className="flex items-center gap-5 w-full sm:w-auto">
            <button
              type="button"
              onClick={onDismiss}
              className="flex-1 sm:flex-none px-8 sm:px-10 py-4 sm:py-5 rounded-2xl border-2 border-slate-600 bg-slate-800/95 hover:bg-slate-700 text-base sm:text-xl font-bold text-slate-200 transition cursor-pointer"
            >
              Dismiss For Now
            </button>
            <button
              type="button"
              onClick={() => onOpenAndReply(currentEmail)}
              className="flex-1 sm:flex-none px-10 sm:px-14 py-4 sm:py-5 rounded-2xl bg-gradient-to-r from-red-600 via-rose-600 to-red-600 hover:from-red-500 hover:to-rose-500 text-lg sm:text-2xl font-black text-white shadow-2xl shadow-red-600/60 flex items-center justify-center gap-3 transition cursor-pointer scale-100 hover:scale-102"
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
