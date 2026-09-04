import { useMemo, useState } from "react";
import type { KpiActivityItem, KpiCounts } from "../api/client";

interface KpiDrillDownModalProps {
  cardKey: keyof KpiCounts | null;
  cardLabel: string;
  activities: KpiActivityItem[];
  counts: KpiCounts;
  scopeLabel: string;
  dateLabel: string;
  onClose: () => void;
}

function formatCallTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function getCardIcon(cardKey: keyof KpiCounts): string {
  switch (cardKey) {
    case "calls_logged":
      return "📞";
    case "companies_called":
      return "🏢";
    case "outcomes_follow_up":
      return "✅";
    case "outcomes_interested":
      return "🌟";
    case "outcomes_not_interested":
      return "🚫";
    case "outcomes_not_received_call":
      return "⏳";
    case "call_remarks":
      return "📝";
    case "leads_imported":
      return "📥";
    case "table_edits":
      return "✏️";
    case "email_templates_created":
      return "📄";
    case "personal_emails_sent":
      return "✉️";
    case "bulk_emails_sent":
      return "📬";
    case "personal_whatsapp_sent":
      return "💬";
    case "bulk_whatsapp_sent":
      return "📢";
    case "inbox_replies":
      return "📥";
    case "brand_assistant_sessions":
      return "🤖";
    default:
      return "📊";
  }
}

export function KpiDrillDownModal({
  cardKey,
  cardLabel,
  activities,
  counts,
  scopeLabel,
  dateLabel,
  onClose,
}: KpiDrillDownModalProps) {
  const [searchQuery, setSearchQuery] = useState("");

  // Filter activities matching the clicked KPI card
  const filteredActivities = useMemo(() => {
    if (!cardKey) return [];

    return activities.filter((item) => {
      const type = item.activity_type || "";
      const summary = (item.summary || "").toLowerCase();
      const title = (item.title || "").toLowerCase();
      const outcome = (item.outcome || (item.details?.outcome as string) || "").toLowerCase();

      switch (cardKey) {
        case "calls_logged":
          return type === "call_logged";

        case "companies_called":
          return type === "call_logged" || type === "call_outcome" || type === "call_remarks";

        case "outcomes_follow_up":
          return (
            type === "call_outcome" &&
            (outcome === "follow_up" ||
              summary.includes("follow up") ||
              summary.includes("follow-up") ||
              title.includes("follow"))
          );

        case "outcomes_interested":
          return (
            type === "call_outcome" &&
            (outcome === "interested" || summary.includes("interested") || title.includes("interested"))
          );

        case "outcomes_not_interested":
          return (
            type === "call_outcome" &&
            (outcome === "not_interested" ||
              summary.includes("not interested") ||
              title.includes("not interested"))
          );

        case "outcomes_not_received_call":
          return (
            type === "call_outcome" &&
            (outcome === "not_received_call" ||
              summary.includes("not received") ||
              summary.includes("did not receive") ||
              summary.includes("no answer") ||
              title.includes("not received"))
          );

        case "call_remarks":
          return (
            type === "call_remarks" ||
            Boolean(item.remarks) ||
            summary.includes("remarks")
          );

        case "leads_imported":
          return type === "leads_imported";

        case "table_edits":
          return type === "table_row_edited";

        case "email_templates_created":
          return type === "email_template_created";

        case "personal_emails_sent":
          return type === "personal_emails_sent" || type === "inbox_replied";

        case "bulk_emails_sent":
          return type === "bulk_emails_sent";

        case "personal_whatsapp_sent":
          return type === "personal_whatsapp_sent";

        case "bulk_whatsapp_sent":
          return type === "bulk_whatsapp_sent";

        case "inbox_replies":
          return type === "inbox_replied";

        case "brand_assistant_sessions":
          return type === "brand_assistant_session";

        default:
          return true;
      }
    });
  }, [cardKey, activities]);

  // Group by distinct company if "companies_called"
  const companyGroupedList = useMemo(() => {
    if (cardKey !== "companies_called") return null;

    const map = new Map<
      string,
      {
        company_name: string;
        contact_name: string | null;
        contact_designation: string | null;
        country: string | null;
        phone: string | null;
        agent: string | null;
        call_count: number;
        latest_time: string;
        latest_summary: string;
        latest_outcome: string | null;
      }
    >();

    for (const item of filteredActivities) {
      const cName =
        item.company_name ||
        (item.details?.company_name as string) ||
        (item.summary ? item.summary.replace(/^(Called|Marked|Remarks on call with|Updated)\s+/i, "").split("(")[0].trim() : "Unknown Company");

      const key = cName.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.call_count += 1;
        if (new Date(item.created_at) > new Date(existing.latest_time)) {
          existing.latest_time = item.created_at;
          existing.latest_summary = item.summary;
          if (item.outcome) existing.latest_outcome = item.outcome;
        }
      } else {
        map.set(key, {
          company_name: cName,
          contact_name: item.contact_name || (item.details?.contact_name as string) || null,
          contact_designation: item.contact_designation || null,
          country: item.country || (item.details?.country as string) || null,
          phone: item.phone || (item.details?.phone as string) || null,
          agent: item.full_name || item.username || null,
          call_count: 1,
          latest_time: item.created_at,
          latest_summary: item.summary,
          latest_outcome: item.outcome || (item.details?.outcome as string) || null,
        });
      }
    }

    return Array.from(map.values()).sort(
      (a, b) => new Date(b.latest_time).getTime() - new Date(a.latest_time).getTime()
    );
  }, [cardKey, filteredActivities]);

  // Search filter across results
  const displayedItems = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return filteredActivities;

    return filteredActivities.filter((item) => {
      return (
        (item.company_name && item.company_name.toLowerCase().includes(q)) ||
        (item.contact_name && item.contact_name.toLowerCase().includes(q)) ||
        (item.country && item.country.toLowerCase().includes(q)) ||
        (item.phone && item.phone.toLowerCase().includes(q)) ||
        (item.summary && item.summary.toLowerCase().includes(q)) ||
        (item.remarks && item.remarks.toLowerCase().includes(q)) ||
        (item.full_name && item.full_name.toLowerCase().includes(q))
      );
    });
  }, [filteredActivities, searchQuery]);

  const displayedCompanies = useMemo(() => {
    if (!companyGroupedList) return [];
    const q = searchQuery.toLowerCase().trim();
    if (!q) return companyGroupedList;

    return companyGroupedList.filter((c) => {
      return (
        c.company_name.toLowerCase().includes(q) ||
        (c.contact_name && c.contact_name.toLowerCase().includes(q)) ||
        (c.country && c.country.toLowerCase().includes(q)) ||
        (c.phone && c.phone.toLowerCase().includes(q)) ||
        (c.agent && c.agent.toLowerCase().includes(q))
      );
    });
  }, [companyGroupedList, searchQuery]);

  if (!cardKey) return null;

  const totalCount = cardKey ? counts[cardKey] ?? 0 : 0;
  const isCompanyView = cardKey === "companies_called";

  return (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/85 backdrop-blur-md p-3 sm:p-6 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex flex-col w-[95vw] max-w-6xl max-h-[90vh] rounded-3xl border-2 border-slate-700 bg-slate-950 p-5 sm:p-8 shadow-2xl shadow-black text-slate-100 space-y-4 overflow-hidden">
        
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-950/80 border border-sky-500/50 text-3xl shadow-lg">
              {getCardIcon(cardKey)}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-xl sm:text-2xl font-black text-white tracking-wide">
                  {cardLabel}
                </h3>
                <span className="rounded-full bg-sky-600 px-3.5 py-1 text-xs sm:text-sm font-black text-white shadow-md">
                  {totalCount} Total
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-400 mt-1">
                Showing activity for <span className="text-slate-200 font-bold">{scopeLabel}</span> · {dateLabel}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-slate-800 transition text-2xl cursor-pointer"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Search & Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <input
              type="text"
              placeholder="Search company, contact person, country, phone, remarks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-900/90 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-2.5 text-slate-400 hover:text-white text-sm cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>

          <div className="text-xs text-slate-400">
            {isCompanyView
              ? `Showing ${displayedCompanies.length} of ${companyGroupedList?.length || 0} companies`
              : `Showing ${displayedItems.length} of ${filteredActivities.length} records`}
          </div>
        </div>

        {/* Table Content */}
        <div className="flex-1 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900/60 custom-scrollbar">
          {isCompanyView ? (
            /* Distinct Companies View */
            displayedCompanies.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">
                No company records found matching your query.
              </div>
            ) : (
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="sticky top-0 bg-slate-900 border-b border-slate-800 text-slate-400 uppercase text-[11px] font-extrabold tracking-wider">
                  <tr>
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Company Name</th>
                    <th className="px-4 py-3">Contact Person &amp; Role</th>
                    <th className="px-4 py-3">Country</th>
                    <th className="px-4 py-3">Phone</th>
                    <th className="px-4 py-3">Calls Made</th>
                    <th className="px-4 py-3">Last Call Time</th>
                    <th className="px-4 py-3">Latest Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {displayedCompanies.map((comp, idx) => (
                    <tr key={comp.company_name + idx} className="hover:bg-slate-800/50 transition">
                      <td className="px-4 py-3 text-slate-500 font-mono text-xs">{idx + 1}</td>
                      <td className="px-4 py-3 font-black text-slate-100">
                        <div className="flex items-center gap-2">
                          <span className="text-base">🏢</span>
                          <span>{comp.company_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-200">
                          {comp.contact_name || "—"}
                        </div>
                        {comp.contact_designation && (
                          <div className="text-[11px] text-slate-400 font-normal">
                            {comp.contact_designation}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {comp.country ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-slate-800 border border-slate-700 font-semibold text-slate-200 text-xs">
                            <span>🌍</span>
                            <span>{comp.country}</span>
                          </span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-sky-300">
                        {comp.phone ? (
                          <a href={`tel:${comp.phone}`} className="hover:underline">
                            {comp.phone}
                          </a>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2.5 py-1 rounded-full bg-emerald-950 border border-emerald-500/60 font-black text-emerald-300 text-xs">
                          {comp.call_count} {comp.call_count === 1 ? "call" : "calls"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-300 text-xs whitespace-nowrap">
                        {formatCallTime(comp.latest_time)}
                      </td>
                      <td className="px-4 py-3">
                        {comp.latest_outcome ? (
                          <span className="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 font-bold text-xs uppercase text-slate-200">
                            {comp.latest_outcome.replace(/_/g, " ")}
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs truncate block max-w-[180px]">
                            {comp.latest_summary}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            /* Standard Event List (Calls, Picked Up, Remarks, Emails, etc.) */
            displayedItems.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">
                No activity records found matching this filter for the selected period.
              </div>
            ) : (
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="sticky top-0 bg-slate-900 border-b border-slate-800 text-slate-400 uppercase text-[11px] font-extrabold tracking-wider">
                  <tr>
                    <th className="px-4 py-3">#</th>
                    <th className="px-4 py-3">Time of Call / Action</th>
                    <th className="px-4 py-3">Company Name</th>
                    <th className="px-4 py-3">Contact Person</th>
                    <th className="px-4 py-3">Country</th>
                    <th className="px-4 py-3">Phone / Contact</th>
                    <th className="px-4 py-3">Agent</th>
                    <th className="px-4 py-3">Status / Remarks / Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {displayedItems.map((item, idx) => {
                    const cName =
                      item.company_name ||
                      (item.details?.company_name as string) ||
                      (item.summary ? item.summary.replace(/^(Called|Marked|Remarks on call with|Updated)\s+/i, "").split("(")[0].trim() : "—");

                    const contactName = item.contact_name || (item.details?.contact_name as string) || "—";
                    const designation = item.contact_designation || (item.details?.contact_designation as string);
                    const country = item.country || (item.details?.country as string);
                    const phone = item.phone || (item.details?.phone as string) || (item.details?.lead_phone as string);
                    const outcome = item.outcome || (item.details?.outcome as string);

                    return (
                      <tr key={item.id + "-" + idx} className="hover:bg-slate-800/50 transition">
                        <td className="px-4 py-3 text-slate-500 font-mono text-xs">{idx + 1}</td>
                        <td className="px-4 py-3 text-slate-300 whitespace-nowrap text-xs">
                          {formatCallTime(item.created_at)}
                        </td>
                        <td className="px-4 py-3 font-bold text-slate-100">
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-400">🏢</span>
                            <span>{cName}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-slate-200">
                            {contactName}
                          </div>
                          {designation && (
                            <div className="text-[11px] text-slate-400 font-normal">
                              {designation}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {country ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-800 border border-slate-700 font-medium text-slate-200 text-xs">
                              <span>🌍</span>
                              <span>{country}</span>
                            </span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-sky-300">
                          {phone ? (
                            <a href={`tel:${phone}`} className="hover:underline">
                              {phone}
                            </a>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-300 font-medium text-xs">
                          {item.full_name || item.username || `User #${item.user_id}`}
                        </td>
                        <td className="px-4 py-3">
                          {outcome ? (
                            <span
                              className={`inline-block px-2.5 py-0.5 rounded-lg border font-bold text-xs uppercase tracking-wide ${
                                outcome === "follow_up"
                                  ? "bg-emerald-950 text-emerald-300 border-emerald-600"
                                  : outcome === "interested"
                                    ? "bg-amber-950 text-amber-300 border-amber-500"
                                    : outcome === "not_interested"
                                      ? "bg-rose-950 text-rose-300 border-rose-600"
                                      : "bg-slate-800 text-slate-300 border-slate-700"
                              }`}
                            >
                              {outcome.replace(/_/g, " ")}
                            </span>
                          ) : item.remarks ? (
                            <div className="text-slate-200 text-xs leading-relaxed max-w-xs">
                              {item.remarks}
                            </div>
                          ) : (
                            <div className="text-slate-400 text-xs truncate max-w-xs">
                              {item.summary || item.title}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-slate-800">
          <p className="text-xs text-slate-500">
            Tip: Click any phone number to dial directly or search to filter records.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-bold text-slate-200 transition cursor-pointer border border-slate-600"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
