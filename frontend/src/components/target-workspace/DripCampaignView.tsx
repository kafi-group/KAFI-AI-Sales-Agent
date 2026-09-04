import React, { useState, useEffect } from "react";
import { client, type DripCampaignLeadItem } from "../../api/client";

export const DripCampaignView: React.FC = () => {
  const [leads, setLeads] = useState<DripCampaignLeadItem[]>([]);
  const [total, setTotal] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const limit = 50;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDripLeads = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await client.getDripCampaignLeads({
        search: searchQuery.trim() || undefined,
        page,
        limit,
      });
      setLeads(res.leads);
      setTotal(res.total);
    } catch (err: any) {
      setError(err?.message || "Failed to load drip campaign records.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDripLeads();
  }, [page, limit, searchQuery]);

  return (
    <div className="space-y-6">
      {/* ── Header Banner ── */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl backdrop-blur-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl">💧</span>
              <h2 className="text-xl font-bold text-white tracking-tight">
                15-Day Automated Drip Campaign (Replaced Stale Contacts)
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Isolated background campaign for stale & dead emails that were replaced. Dispatches 1 targeted nurture email every 15 days without modifying the active master contact database.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="px-3 py-1.5 rounded-xl bg-teal-500/10 text-teal-300 border border-teal-500/20 text-xs font-semibold">
              Total Enrolled: {total}
            </span>
            <button
              type="button"
              onClick={loadDripLeads}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
            >
              🔄 Refresh
            </button>
          </div>
        </div>

        {/* ── Notice Alert ── */}
        <div className="mt-4 p-3 rounded-xl bg-teal-950/40 border border-teal-800/50 flex items-start gap-2.5 text-xs text-teal-200/90">
          <span className="text-base">🛡️</span>
          <div>
            <strong className="text-teal-300">Master Data Protection Active:</strong>
            <p className="mt-0.5 text-[11px] text-slate-300">
              This drip log stores previous contacts whose response ceased. The main contacts directory retains only newly researched contacts. If a response arrives here, it can be reactivated into active sales.
            </p>
          </div>
        </div>
      </div>

      {/* ── Search Bar ── */}
      <div className="flex items-center justify-between gap-3 bg-slate-900/60 p-3 rounded-xl border border-slate-800">
        <div className="flex items-center gap-2 w-full sm:w-80">
          <input
            type="text"
            placeholder="Search replaced emails, company, designation..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-teal-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                setPage(1);
              }}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ── Drip Table ── */}
      {isLoading ? (
        <div className="py-20 text-center text-slate-400 flex flex-col items-center gap-2">
          <span className="animate-spin text-2xl">⏳</span>
          <p className="text-xs">Loading drip campaign records...</p>
        </div>
      ) : error ? (
        <div className="p-4 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs">
          {error}
        </div>
      ) : leads.length === 0 ? (
        <div className="py-16 text-center rounded-2xl border border-slate-800 bg-slate-900/30 p-8">
          <div className="text-3xl mb-2">💧</div>
          <h4 className="text-base font-semibold text-slate-200">No contacts in Drip Campaign yet</h4>
          <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
            When you replace a dead contact in the Outreach Funnel using "Replace & Drip", the old email will appear here automatically.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/80 shadow-xl">
          <table className="w-full text-left text-xs text-slate-200">
            <thead className="bg-slate-950/80 text-[11px] uppercase font-bold text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">#</th>
                <th className="py-3 px-4">Name of Company</th>
                <th className="py-3 px-4">Product Type</th>
                <th className="py-3 px-4">Contact Person Email / Designation</th>
                <th className="py-3 px-4">Days in Drip Campaign</th>
                <th className="py-3 px-4"># of Emails Sent</th>
                <th className="py-3 px-4">Responses Received</th>
                <th className="py-3 px-4">Cadence / Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {leads.map((lead, idx) => (
                <tr key={lead.id} className="hover:bg-slate-800/40 transition">
                  <td className="py-3.5 px-4 text-slate-500 font-mono text-[11px]">
                    {(page - 1) * limit + idx + 1}
                  </td>
                  <td className="py-3.5 px-4 font-semibold text-white">
                    <div>{lead.company_name}</div>
                    {lead.country && (
                      <span className="text-[10px] text-slate-400 font-normal">🌍 {lead.country}</span>
                    )}
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 text-[11px]">
                      {lead.product_type}
                    </span>
                  </td>
                  <td className="py-3.5 px-4">
                    <div className="font-mono text-cyan-300 text-[11px] font-semibold">{lead.email}</div>
                    <div className="text-slate-400 text-[11px]">
                      {lead.contact_person_name || "Unknown"}
                      {lead.contact_designation ? ` • ${lead.contact_designation}` : ""}
                    </div>
                  </td>
                  <td className="py-3.5 px-4 font-mono text-amber-300">
                    <span className="px-2 py-0.5 rounded bg-amber-950/40 border border-amber-800/40 font-bold">
                      {lead.days_in_drip} days
                    </span>
                  </td>
                  <td className="py-3.5 px-4 font-mono text-slate-300">
                    <span className="font-bold text-white">{lead.drip_emails_sent_count}</span> emails
                  </td>
                  <td className="py-3.5 px-4 font-mono">
                    <span
                      className={`px-2 py-0.5 rounded font-bold ${
                        lead.responses_received_count > 0
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                          : "text-slate-500"
                      }`}
                    >
                      {lead.responses_received_count}
                    </span>
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-teal-950/50 text-teal-300 border border-teal-800/50">
                      <span>🔄</span>
                      <span>{lead.cadence_label || "1 email / 15 days"}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
