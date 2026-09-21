import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type AiConclusionItem,
  type AiConclusionOverviewResponse,
  type AppUser,
} from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

const DAYS = [
  { id: "monday", label: "Mon" },
  { id: "tuesday", label: "Tue" },
  { id: "wednesday", label: "Wed" },
  { id: "thursday", label: "Thu" },
  { id: "friday", label: "Fri" },
  { id: "saturday", label: "Sat" },
  { id: "sunday", label: "Sun" },
];

interface AiConclusionModalProps {
  open: boolean;
  onClose: () => void;
  onError?: (message: string) => void;
  /** When set, jump straight to this company. */
  initialBuyerId?: number | null;
  selectedDay?: string;
}

function EngagementTable({ item }: { item: AiConclusionItem }) {
  const rows: Array<{ label: string; key: keyof AiConclusionItem["engagement"]["7d"] }> = [
    { label: "Calls", key: "calls" },
    { label: "Emails", key: "emails" },
    { label: "WhatsApp", key: "whatsapp" },
    { label: "Telegram", key: "telegram" },
    { label: "Quotations", key: "quotations" },
    { label: "Follow-ups pending", key: "follow_ups_pending" },
  ];
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-950/80">
      <table className="w-full text-sm text-left">
        <thead>
          <tr className="border-b border-slate-800 text-slate-400">
            <th className="px-3 py-2 font-semibold">Channel</th>
            <th className="px-3 py-2 font-semibold text-center">7 Days</th>
            <th className="px-3 py-2 font-semibold text-center">30 Days</th>
            <th className="px-3 py-2 font-semibold text-center">90 Days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-slate-800/80 last:border-0">
              <td className="px-3 py-2 text-slate-200">{row.label}</td>
              <td className="px-3 py-2 text-center text-slate-100 font-medium">
                {item.engagement["7d"][row.key]}
              </td>
              <td className="px-3 py-2 text-center text-slate-100 font-medium">
                {item.engagement["30d"][row.key]}
              </td>
              <td className="px-3 py-2 text-center text-slate-100 font-medium">
                {item.engagement["90d"][row.key]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConclusionFields({ item }: { item: AiConclusionItem }) {
  const fields: Array<[string, string]> = [
    ["Buyer status", item.buyer_status],
    ["Last contact", item.last_contact],
    ["Pending action", item.pending_action],
    ["Responsible person", item.responsible_person],
    ["Next action", item.next_action],
    ["Management attention", item.management_attention],
  ];
  const attentionRequired = /required/i.test(item.management_attention) &&
    !/not required/i.test(item.management_attention);

  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-4 space-y-2.5">
      <p className="text-xs font-bold uppercase tracking-wider text-violet-300">AI conclusion</p>
      {fields.map(([label, value]) => (
        <div key={label} className="flex flex-wrap gap-x-2 text-sm">
          <span className="text-slate-400 font-medium min-w-[9.5rem]">{label}:</span>
          <span
            className={
              label === "Management attention"
                ? attentionRequired
                  ? "text-amber-300 font-semibold"
                  : "text-emerald-300 font-semibold"
                : "text-slate-100"
            }
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function AiConclusionModal({
  open,
  onClose,
  onError,
  initialBuyerId = null,
  selectedDay,
}: AiConclusionModalProps) {
  const { isAdmin } = useAuth();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<AiConclusionItem[]>([]);
  const [selected, setSelected] = useState<AiConclusionItem | null>(null);
  const [overview, setOverview] = useState<AiConclusionOverviewResponse | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [filterUserId, setFilterUserId] = useState<string>("");
  const [filterCompany, setFilterCompany] = useState("");
  const [filterDay, setFilterDay] = useState(selectedDay || "");
  const [filterAttention, setFilterAttention] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (initialBuyerId) {
        const one = await client.getBuyerAiConclusion(initialBuyerId);
        setItems([one]);
        setSelected(one);
        setOverview(null);
        return;
      }
      if (isAdmin) {
        const [list, ov] = await Promise.all([
          client.listAiConclusions({
            user_id: filterUserId ? Number(filterUserId) : undefined,
            company: filterCompany.trim() || undefined,
            day: filterDay || undefined,
            attention: filterAttention || undefined,
            limit: 60,
          }),
          client.getAiConclusionsOverview(filterDay || undefined),
        ]);
        setItems(list.items);
        setOverview(ov);
        setSelected((prev) => {
          if (prev && list.items.some((i) => i.buyer_id === prev.buyer_id)) {
            return list.items.find((i) => i.buyer_id === prev.buyer_id) || list.items[0] || null;
          }
          return list.items[0] || null;
        });
      } else {
        const list = await client.listAiConclusions({
          company: filterCompany.trim() || undefined,
          day: filterDay || undefined,
          attention: filterAttention || undefined,
          limit: 60,
        });
        setItems(list.items);
        setOverview(null);
        setSelected(list.items[0] || null);
      }
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "Failed to load AI conclusions");
    } finally {
      setLoading(false);
    }
  }, [
    filterAttention,
    filterCompany,
    filterDay,
    filterUserId,
    initialBuyerId,
    isAdmin,
    onError,
  ]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open || !isAdmin) return;
    void client
      .listUsers()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [open, isAdmin]);

  useEffect(() => {
    if (selectedDay) setFilterDay(selectedDay);
  }, [selectedDay]);

  const title = useMemo(() => {
    if (initialBuyerId && selected) return `AI Conclusion — ${selected.company_name}`;
    return isAdmin ? "AI Conclusion — Team overview" : "AI Conclusion — My companies";
  }, [initialBuyerId, isAdmin, selected]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-5xl max-h-[94vh] overflow-hidden flex flex-col rounded-t-2xl sm:rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-conclusion-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 sm:p-5 border-b border-slate-800 flex items-start justify-between gap-3 shrink-0 bg-slate-950/50">
          <div className="min-w-0">
            <h2 id="ai-conclusion-title" className="text-lg font-bold text-white flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-violet-600/30 text-violet-200 text-sm font-black border border-violet-500/40">
                AI
              </span>
              <span className="truncate">{title}</span>
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Buyer status, last contact, pending action, and management attention from live outreach activity.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white text-xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {!initialBuyerId && (
          <div className="px-4 sm:px-5 py-3 border-b border-slate-800 flex flex-wrap gap-2 items-center shrink-0 bg-slate-950/30">
            <input
              type="search"
              value={filterCompany}
              onChange={(e) => setFilterCompany(e.target.value)}
              placeholder="Search company…"
              className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 min-w-[10rem] flex-1"
            />
            <select
              value={filterDay}
              onChange={(e) => setFilterDay(e.target.value)}
              className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-sm text-slate-200"
            >
              <option value="">All days</option>
              {DAYS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <select
              value={filterAttention}
              onChange={(e) => setFilterAttention(e.target.value)}
              className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-sm text-slate-200"
            >
              <option value="">All attention</option>
              <option value="required">Attention required</option>
              <option value="not_required">Not required</option>
            </select>
            {isAdmin && (
              <select
                value={filterUserId}
                onChange={(e) => setFilterUserId(e.target.value)}
                className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-sm text-slate-200"
              >
                <option value="">All users</option>
                {users.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.full_name || u.username}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-semibold disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {isAdmin && overview && !initialBuyerId && (
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <p className="text-[11px] uppercase tracking-wider text-slate-500">Companies</p>
                <p className="text-2xl font-bold text-white">{overview.companies_scanned}</p>
              </div>
              <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3">
                <p className="text-[11px] uppercase tracking-wider text-amber-400/80">Attention required</p>
                <p className="text-2xl font-bold text-amber-200">{overview.attention_required}</p>
              </div>
              <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">By sales person</p>
                <ul className="space-y-0.5 max-h-20 overflow-y-auto text-xs text-slate-300">
                  {(overview.by_user || []).slice(0, 8).map((row) => (
                    <li key={row.responsible_person} className="flex justify-between gap-2">
                      <span className="truncate">{row.responsible_person}</span>
                      <span className="text-amber-300 shrink-0">
                        {row.attention_required}/{row.companies}
                      </span>
                    </li>
                  ))}
                  {(overview.by_user || []).length === 0 && (
                    <li className="text-slate-500">No rows yet</li>
                  )}
                </ul>
              </div>
            </div>
          )}

          {loading && items.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-10">Building AI conclusions…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-10">
              No companies matched these filters.
            </p>
          ) : (
            <div className="grid lg:grid-cols-[220px_1fr] gap-4">
              {!initialBuyerId && (
                <ul className="space-y-1 max-h-[28rem] overflow-y-auto pr-1">
                  {items.map((item) => {
                    const active = selected?.buyer_id === item.buyer_id;
                    const attn =
                      /required/i.test(item.management_attention) &&
                      !/not required/i.test(item.management_attention);
                    return (
                      <li key={item.buyer_id}>
                        <button
                          type="button"
                          onClick={() => setSelected(item)}
                          className={`w-full text-left rounded-lg border px-3 py-2 transition ${
                            active
                              ? "border-violet-500/60 bg-violet-500/15 text-white"
                              : "border-slate-800 bg-slate-950/50 text-slate-300 hover:border-slate-600"
                          }`}
                        >
                          <p className="text-sm font-semibold truncate">{item.company_name}</p>
                          <p className="text-[11px] text-slate-500 truncate mt-0.5">
                            {item.responsible_person}
                            {attn ? " · Attention" : ""}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {selected && (
                <div className="space-y-4 min-w-0">
                  <div>
                    <h3 className="text-lg font-bold text-white">{selected.company_name}</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {[selected.country, selected.stage?.replace(/_/g, " ")].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <EngagementTable item={selected} />
                  <ConclusionFields item={selected} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
