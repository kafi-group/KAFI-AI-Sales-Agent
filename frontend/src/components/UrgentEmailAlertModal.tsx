import { useState } from "react";
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
  const [currentIndex, setCurrentIndex] = useState(0);

  if (!urgentEmails || urgentEmails.length === 0) return null;

  const currentEmail = urgentEmails[currentIndex] || urgentEmails[0];
  const total = urgentEmails.length;

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl rounded-2xl border-2 border-red-500 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 p-6 shadow-2xl shadow-red-950/80 text-slate-100 space-y-5">
        {/* Glow Header */}
        <div className="flex items-start justify-between border-b border-red-500/30 pb-4">
          <div className="flex items-center gap-3">
            <div className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-red-600/30 border border-red-500 text-2xl shadow-lg shadow-red-600/40">
              <span className="animate-bounce">🚨</span>
              <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-red-500"></span>
              </span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-red-100 tracking-wide">
                  URGENT EMAIL REQUIRES IMMEDIATE REPLY
                </h2>
                {total > 1 && (
                  <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs font-bold text-white shadow">
                    {currentIndex + 1} of {total}
                  </span>
                )}
              </div>
              <p className="text-xs text-red-300/80 mt-0.5">
                This critical enquiry is waiting for your response. This alert remains active until a reply is sent.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
            title="Dismiss for current session"
          >
            ✕
          </button>
        </div>

        {/* Overdue Alert Banner */}
        <div className="flex items-center justify-between rounded-xl bg-red-950/70 border border-red-800/80 px-4 py-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-red-200">
            <span className="text-base">⚠️</span>
            <span>
              {currentEmail.days_ago > 0
                ? `Received ${currentEmail.days_ago} ${currentEmail.days_ago === 1 ? "day" : "days"} ago (${currentEmail.hours_ago} hours) — OVERDUE FOR REPLY!`
                : `Received ${currentEmail.hours_ago} hours ago — Immediate Response Needed`}
            </span>
          </div>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-red-900/60 border border-red-700/50 text-red-300">
            {currentEmail.triage_label || "Urgent"}
          </span>
        </div>

        {/* Email Details Card */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <span className="block text-[10px] uppercase font-bold text-slate-400 mb-0.5">
                Sender / Client
              </span>
              <span className="font-semibold text-slate-100 text-sm">
                {currentEmail.from_name || currentEmail.from_email}
              </span>
              {currentEmail.from_name && (
                <span className="block text-slate-400 text-xs truncate">
                  &lt;{currentEmail.from_email}&gt;
                </span>
              )}
            </div>

            <div>
              <span className="block text-[10px] uppercase font-bold text-slate-400 mb-0.5">
                Date &amp; Time
              </span>
              <span className="text-slate-200">
                {currentEmail.latest_date
                  ? new Date(currentEmail.latest_date).toLocaleString()
                  : "Recent"}
              </span>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-800">
            <span className="block text-[10px] uppercase font-bold text-slate-400 mb-1">
              Subject Line
            </span>
            <div className="text-sm font-bold text-emerald-400 flex items-center gap-2">
              <span className="px-1.5 py-0.5 rounded bg-red-950 text-red-300 border border-red-800/60 text-[10px]">
                {currentEmail.triage_category === "urgent" ? "🚨 URGENT" : "⚡ ACTION REQUIRED"}
              </span>
              <span className="truncate">{currentEmail.subject}</span>
            </div>
          </div>

          {currentEmail.preview && (
            <div className="pt-2 border-t border-slate-800">
              <span className="block text-[10px] uppercase font-bold text-slate-400 mb-1">
                Message Preview
              </span>
              <p className="text-xs text-slate-300 line-clamp-3 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80 leading-relaxed font-sans">
                {currentEmail.preview}
              </p>
            </div>
          )}
        </div>

        {/* Carousel pagination if multiple */}
        {total > 1 && (
          <div className="flex items-center justify-between text-xs text-slate-400 px-1">
            <button
              type="button"
              disabled={currentIndex === 0}
              onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
              className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              ← Previous Urgent Email
            </button>
            <span>
              {currentIndex + 1} of {total} urgent enquiries
            </span>
            <button
              type="button"
              disabled={currentIndex === total - 1}
              onClick={() => setCurrentIndex((prev) => Math.min(total - 1, prev + 1))}
              className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              Next Urgent Email →
            </button>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
          <p className="text-[11px] text-slate-400 italic">
            * Alert will re-appear on every login/refresh until an email reply is sent.
          </p>

          <div className="flex items-center gap-2.5 w-full sm:w-auto">
            <button
              type="button"
              onClick={onDismiss}
              className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl border border-slate-700 bg-slate-800/90 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition"
            >
              Dismiss For Now
            </button>
            <button
              type="button"
              onClick={() => onOpenAndReply(currentEmail)}
              className="flex-1 sm:flex-none px-5 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-xs font-bold text-white shadow-lg shadow-red-600/40 flex items-center justify-center gap-2 transition cursor-pointer"
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
