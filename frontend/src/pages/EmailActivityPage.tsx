import { useCallback, useEffect, useState } from "react";
import {
  client,
  type EmailActivityCatalogItem,
  type EmailActivityEvent,
  type EmailActivityInsights,
  type EmailActivityModeStats,
} from "../api/client";
import { Pagination } from "../components/Pagination";
import { useAuth } from "../auth/AuthContext";

interface EmailActivityPageProps {
  onError: (message: string) => void;
  onUnreadChange?: (count: number) => void;
  /** email = Mail → Email Activity; whatsapp = WhatsApp → WhatsApp Activity */
  channel?: "email" | "whatsapp";
}

const PAGE_SIZE = 25;
const POLL_MS = 12_000;

type InsightsPreset = 1 | 7 | 30 | 90 | null | "range";

function isoDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function defaultRangeBounds(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 6);
  return { from: isoDateLocal(from), to: isoDateLocal(to) };
}

function severityClasses(severity: string) {
  switch (severity) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-200";
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-100";
    default:
      return "border-slate-700 bg-slate-900 text-slate-200";
  }
}

function formatWhen(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "neutral" | "good" | "bad" | "accent";
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-100"
      : tone === "bad"
        ? "border-red-500/25 bg-red-500/10 text-red-100"
        : tone === "accent"
          ? "border-sky-500/25 bg-sky-500/10 text-sky-100"
          : "border-slate-700/80 bg-slate-950/60 text-slate-100";
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${toneClass}`}>
      <p className="text-[11px] uppercase tracking-[0.12em] opacity-70">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs opacity-65">{hint}</p> : null}
    </div>
  );
}

function ModeBlock({
  title,
  subtitle,
  stats,
  showBatches,
  showOpens = true,
}: {
  title: string;
  subtitle: string;
  stats: EmailActivityModeStats;
  showBatches?: boolean;
  /** Email open-pixel stats — hide for WhatsApp. */
  showOpens?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-medium text-slate-100">{title}</h4>
        <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {showBatches ? (
          <StatTile
            label="Batches"
            value={stats.batches ?? 0}
            hint={`${stats.batches_partial ?? 0} partial · ${stats.batches_failed ?? 0} failed`}
            tone="accent"
          />
        ) : null}
        <StatTile label="Sent" value={stats.sent} hint={`${stats.success_rate_pct}% success`} tone="good" />
        <StatTile label="Failed" value={stats.failed} tone="bad" />
        {showOpens ? (
          <>
            <StatTile
              label="Opened"
              value={stats.opened}
              hint={`${stats.open_rate_pct}% of sent`}
              tone="accent"
            />
            <StatTile label="Not opened" value={stats.not_opened} />
          </>
        ) : null}
        <StatTile label="Attempted" value={stats.attempted} />
      </div>
    </div>
  );
}

export function EmailActivityPage({
  onError,
  onUnreadChange,
  channel = "email",
}: EmailActivityPageProps) {
  const { isAdmin } = useAuth();
  const isWhatsApp = channel === "whatsapp";
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<EmailActivityEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<EmailActivityCatalogItem[]>([]);
  const [showCatalog, setShowCatalog] = useState(false);
  // Insights open by default for email so mailer + in-app sends are easy to review.
  const [showInsights, setShowInsights] = useState(channel === "email");
  const [insightsPeriod, setInsightsPeriod] = useState<InsightsPreset>(30);
  const [rangeFrom, setRangeFrom] = useState(() => defaultRangeBounds().from);
  const [rangeTo, setRangeTo] = useState(() => defaultRangeBounds().to);
  const [insights, setInsights] = useState<EmailActivityInsights | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await client.listEmailActivity({
        page,
        page_size: PAGE_SIZE,
        unread_only: unreadOnly,
        channel,
      });
      setRows(result.rows);
      setTotal(result.total);
      setTotalPages(result.total_pages);
      setUnreadCount(result.unread_count);
      onUnreadChange?.(result.unread_count);
    } catch (e) {
      onError(
        e instanceof Error
          ? e.message
          : isWhatsApp
            ? "Failed to load WhatsApp activity"
            : "Failed to load email activity",
      );
    } finally {
      setLoading(false);
    }
  }, [channel, isWhatsApp, onError, onUnreadChange, page, unreadOnly]);

  const refreshInsights = useCallback(async () => {
    if (insightsPeriod === "range" && !rangeFrom && !rangeTo) {
      return;
    }
    setInsightsLoading(true);
    try {
      const result =
        insightsPeriod === "range"
          ? await client.getEmailActivityInsights({
              date_from: rangeFrom || undefined,
              date_to: rangeTo || undefined,
              channel,
            })
          : await client.getEmailActivityInsights({
              days: insightsPeriod,
              channel,
            });
      setInsights(result);
    } catch (e) {
      onError(
        e instanceof Error
          ? e.message
          : isWhatsApp
            ? "Failed to load WhatsApp insights"
            : "Failed to load email insights",
      );
    } finally {
      setInsightsLoading(false);
    }
  }, [channel, insightsPeriod, isWhatsApp, onError, rangeFrom, rangeTo]);

  useEffect(() => {
    setPage(1);
    setInsights(null);
    // Email keeps insights open by default; WhatsApp starts collapsed until clicked.
    setShowInsights(channel === "email");
  }, [channel]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    client.listEmailActivityCatalog().then(setCatalog).catch(() => setCatalog([]));
  }, []);

  useEffect(() => {
    if (!showInsights) return;
    void refreshInsights();
  }, [showInsights, refreshInsights]);

  async function markAllRead() {
    try {
      await client.markEmailActivityRead({ mark_all: true, channel });
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to mark notifications read");
    }
  }

  async function markOneRead(eventId: number) {
    try {
      await client.markEmailActivityRead({ event_ids: [eventId], channel });
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to mark notification read");
    }
  }

  return (
    <section className="space-y-5 w-full min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-slate-100">
            {isWhatsApp ? "WhatsApp Activity" : "Email Activity"}
          </h2>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            {isWhatsApp
              ? isAdmin
                ? "Outbound WhatsApp for all users — replies, templates, and bulk campaigns. Use Insights for sent / failed (individual vs bulk)."
                : "Your outbound WhatsApp — replies, templates, and bulk campaigns. Use Insights for sent / failed (individual vs bulk)."
              : isAdmin
                ? "Outbound email for all users — compose, bulk mailer, and in-app sends. Use Insights for sent / failed / opened (individual vs bulk)."
                : "Your outbound email — compose, bulk mailer, and in-app sends. Use Insights for sent / failed / opened (individual vs bulk)."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setShowInsights((v) => !v);
              if (!showInsights) setShowCatalog(false);
            }}
            className={`px-3 py-1.5 rounded-lg text-sm border ${
              showInsights
                ? "bg-sky-600 border-sky-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {showInsights ? "Hide insights" : "Insights"}
          </button>
          <button
            type="button"
            onClick={() => setUnreadOnly((v) => !v)}
            className={`px-3 py-1.5 rounded-lg text-sm border ${
              unreadOnly
                ? "bg-emerald-600 border-emerald-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {unreadOnly ? "Showing unread" : "Show unread only"}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowCatalog((v) => !v);
              if (!showCatalog) setShowInsights(false);
            }}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm text-slate-300"
          >
            {showCatalog ? "Hide event types" : "All event types"}
          </button>
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={unreadCount === 0}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm text-slate-300 disabled:opacity-40"
          >
            Mark all read
          </button>
          <button
            type="button"
            onClick={() => {
              void refresh();
              if (showInsights) void refreshInsights();
            }}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <span className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-slate-300">
          {total} event{total === 1 ? "" : "s"}
        </span>
        <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-200">
          {unreadCount} unread
        </span>
      </div>

      {showInsights && (
        <div className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900 to-slate-950 p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-slate-100">
                {isWhatsApp ? "WhatsApp insights" : "Email insights"}
              </h3>
              <p className="text-xs text-slate-500 mt-1 max-w-xl">
                {isWhatsApp
                  ? "Sent vs failed WhatsApp messages, split by individual replies and bulk template campaigns."
                  : "Sent vs failed, opened vs not opened, split by individual and bulk outreach."}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="flex flex-wrap justify-end gap-1.5">
                {(
                  [
                    [1, "Daily"],
                    [7, "7d"],
                    [30, "30d"],
                    [90, "90d"],
                    [null, "All"],
                    ["range", "Range"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => {
                      if (value === "range") {
                        const bounds = defaultRangeBounds();
                        setRangeFrom((prev) => prev || bounds.from);
                        setRangeTo((prev) => prev || bounds.to);
                      }
                      setInsightsPeriod(value);
                    }}
                    className={`px-2.5 py-1 rounded-md text-xs border ${
                      insightsPeriod === value
                        ? "bg-sky-600 border-sky-500 text-white"
                        : "bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {insightsPeriod === "range" ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>From</span>
                    <input
                      type="date"
                      value={rangeFrom}
                      max={rangeTo || undefined}
                      onChange={(e) => setRangeFrom(e.target.value)}
                      className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>To</span>
                    <input
                      type="date"
                      value={rangeTo}
                      min={rangeFrom || undefined}
                      onChange={(e) => setRangeTo(e.target.value)}
                      className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
                    />
                  </label>
                </div>
              ) : null}
            </div>
          </div>

          {insightsLoading && !insights ? (
            <p className="text-sm text-slate-400">Loading insights…</p>
          ) : insights ? (
            <>
              <div
                className={`grid gap-2.5 sm:grid-cols-2 ${
                  isWhatsApp ? "lg:grid-cols-3" : "lg:grid-cols-5"
                }`}
              >
                <StatTile label="Total sent" value={insights.totals.sent} tone="good" />
                <StatTile label="Total failed" value={insights.totals.failed} tone="bad" />
                {!isWhatsApp ? (
                  <>
                    <StatTile
                      label="Opened"
                      value={insights.totals.opened}
                      hint={`${insights.totals.open_rate_pct}% open rate`}
                      tone="accent"
                    />
                    <StatTile label="Not opened" value={insights.totals.not_opened} />
                  </>
                ) : null}
                <StatTile
                  label="Success rate"
                  value={`${insights.totals.success_rate_pct}%`}
                  hint={`${insights.totals.attempted} attempted`}
                />
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <ModeBlock
                  title={isWhatsApp ? "Individual WhatsApp" : "Individual emails"}
                  subtitle={
                    isWhatsApp
                      ? "One-off replies and personal messages"
                      : "One-off sends to a single lead"
                  }
                  stats={insights.individual}
                  showOpens={!isWhatsApp}
                />
                <ModeBlock
                  title={isWhatsApp ? "Bulk WhatsApp" : "Bulk emails"}
                  subtitle={
                    isWhatsApp
                      ? "Template campaigns from Leads / WhatsApp compose"
                      : "Multi-recipient campaigns from Leads"
                  }
                  stats={insights.bulk}
                  showBatches
                  showOpens={!isWhatsApp}
                />
              </div>

              {isWhatsApp ? (
                <p className="text-xs text-slate-500">
                  Counts Meta Cloud API sends recorded in this feed (free-text inside the 24h
                  window and approved templates). Failed includes invalid numbers, template
                  rejections, and API errors.
                </p>
              ) : !insights.tracking_enabled ? (
                <p className="text-xs text-amber-200/80 border border-amber-500/20 bg-amber-500/10 rounded-lg px-3 py-2">
                  Open tracking needs a public API URL (`PUBLIC_API_BASE_URL`). Opens will stay at
                  0 until emails are sent with that configured on the live backend.
                </p>
              ) : (
                <p className="text-xs text-slate-500">
                  Opens count when the recipient loads the tracking pixel in an HTML email. If
                  images stay blocked (common in Gmail until “Display images”), the open will not
                  register. New sends inject a pixel when the API public URL is configured.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-400">No insight data yet.</p>
          )}
        </div>
      )}

      {showCatalog && (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h3 className="text-sm font-medium text-slate-300 mb-3">
            Notification types this feed can show
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.map((item) => (
              <div
                key={item.event_type}
                className={`rounded-lg border px-3 py-2 ${severityClasses(item.severity)}`}
              >
                <p className="text-sm font-medium">{item.label}</p>
                <p className="text-xs opacity-80 mt-1">{item.description}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-3">
            {isWhatsApp
              ? "WhatsApp send success/failure and bulk template campaign results are logged when Meta accepts or rejects each message."
              : "Opens are recorded via a tracking pixel on outbound HTML emails. SMTP send success/failure and bulk batch results are logged immediately."}
          </p>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <p className="text-slate-400">
          {isWhatsApp ? "Loading WhatsApp activity…" : "Loading email activity…"}
        </p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center">
          <p className="text-slate-300 font-medium">
            {isWhatsApp ? "No WhatsApp activity yet" : "No email activity yet"}
          </p>
          <p className="text-sm text-slate-500 mt-2">
            {isWhatsApp
              ? "Send a WhatsApp template campaign or reply — results show up here."
              : "Send from Leads (Send emails / mailer) or Mail compose — successful and failed sends appear here and in Insights."}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((event) => {
            const unread = !event.read_at;
            return (
              <li
                key={event.id}
                className={`rounded-xl border p-4 ${severityClasses(event.severity)} ${
                  unread ? "ring-1 ring-emerald-500/20" : "opacity-90"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] uppercase tracking-wide opacity-70">
                        {event.event_label}
                      </span>
                      {unread && (
                        <span className="text-[10px] uppercase tracking-wide rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-200">
                          New
                        </span>
                      )}
                      {isAdmin && (event.user_full_name || event.user_username) ? (
                        <span className="text-[10px] uppercase tracking-wide rounded bg-slate-950/40 px-1.5 py-0.5 opacity-80">
                          {event.user_full_name || event.user_username}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm font-medium mt-1">{event.title}</p>
                    <p className="text-sm opacity-90 mt-1 whitespace-pre-wrap">{event.message}</p>
                    <p className="text-xs opacity-60 mt-2">{formatWhen(event.created_at)}</p>
                  </div>
                  {unread && (
                    <button
                      type="button"
                      onClick={() => void markOneRead(event.id)}
                      className="shrink-0 px-2 py-1 rounded bg-black/20 hover:bg-black/30 text-xs"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {total > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          disabled={loading}
        />
      )}
    </section>
  );
}
