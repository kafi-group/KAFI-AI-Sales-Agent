import React, { useState, useEffect, useMemo } from "react";
import {
  client,
  type WorkspaceLeadItem,
  type DayCountryTarget,
  type WorkspaceReviewOptionItem,
  type AppUser,
} from "../../api/client";
import { WhatsAppProofModal } from "./WhatsAppProofModal";

const DAYS_OF_WEEK = [
  { id: "monday", label: "Monday" },
  { id: "tuesday", label: "Tuesday" },
  { id: "wednesday", label: "Wednesday" },
  { id: "thursday", label: "Thursday" },
  { id: "friday", label: "Friday" },
  { id: "saturday", label: "Saturday" },
  { id: "sunday", label: "Sunday" },
];

interface OutreachFunnelViewProps {
  currentUser: AppUser | null;
  isAdmin: boolean;
  selectedDay: string;
  onSelectDay: (day: string) => void;
  onOpenCall?: (phone: string, companyName: string, leadId?: number) => void;
  onOpenEmailComposer?: (email: string, companyName: string, contactName?: string) => void;
}

export const OutreachFunnelView: React.FC<OutreachFunnelViewProps> = ({
  currentUser,
  isAdmin,
  selectedDay,
  onSelectDay,
  onOpenCall,
  onOpenEmailComposer,
}) => {
  const [selectedStage, setSelectedStage] = useState<string>("fresh");
  const [targetCountries, setTargetCountries] = useState<DayCountryTarget[]>([]);
  const [leads, setLeads] = useState<WorkspaceLeadItem[]>([]);
  const [counts, setCounts] = useState({ fresh: 0, needs_follow_up: 0, not_interested: 0, no_response: 0, total: 0 });
  const [reviewOptions, setReviewOptions] = useState<WorkspaceReviewOptionItem[]>([]);
  const [newCountryInput, setNewCountryInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCountryFilter, setSelectedCountryFilter] = useState<string>("all");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal states
  const [proofModalLead, setProofModalLead] = useState<WorkspaceLeadItem | null>(null);

  // Quick action states for changing reasons inline
  const [editingLeadId, setEditingLeadId] = useState<number | null>(null);
  const [inlineReason, setInlineReason] = useState("");
  const [inlineAction, setInlineAction] = useState("call");
  const [inlineRemarks, setInlineRemarks] = useState("");

  const currentFormattedDate = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }, []);

  // Load target countries and review options
  const loadTargetsAndOptions = async () => {
    try {
      const [targetsRes, optionsRes] = await Promise.all([
        client.getTargetWorkspaceTargets(selectedDay),
        client.getWorkspaceReviewOptions(),
      ]);
      setTargetCountries(targetsRes.targets);
      setReviewOptions(optionsRes.options);
    } catch (err: any) {
      console.error("Failed to load targets/options:", err);
    }
  };

  // Load leads based on selected day, stage, country, and search
  const loadLeads = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await client.getWorkspaceLeads({
        day: selectedDay,
        stage: selectedStage,
        country: selectedCountryFilter !== "all" ? selectedCountryFilter : undefined,
        search: searchQuery.trim() || undefined,
        user_id: isAdmin ? undefined : currentUser?.id,
        limit: 100,
      });
      setLeads(res.leads);
      setCounts(res.counts);
    } catch (err: any) {
      setError(err?.message || "Failed to load workspace leads.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadTargetsAndOptions();
  }, [selectedDay]);

  useEffect(() => {
    loadLeads();
  }, [selectedDay, selectedStage, selectedCountryFilter, searchQuery]);

  // Add country target
  const handleAddCountry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCountryInput.trim()) return;
    try {
      await client.addDayCountryTarget({
        day_of_week: selectedDay,
        country: newCountryInput.trim(),
      });
      setNewCountryInput("");
      await loadTargetsAndOptions();
      await loadLeads();
    } catch (err: any) {
      alert(err?.message || "Failed to add country target.");
    }
  };

  // Remove country target
  const handleRemoveCountry = async (targetId: number) => {
    if (!confirm("Remove this country from today's target?")) return;
    try {
      await client.removeDayCountryTarget(targetId);
      await loadTargetsAndOptions();
      await loadLeads();
    } catch (err: any) {
      alert(err?.message || "Failed to remove country target.");
    }
  };

  // Update lead stage
  const handleUpdateStage = async (
    buyerId: number,
    newStage: string,
    extra: Partial<{
      not_interested_reason: string;
      not_interested_remarks: string;
      follow_up_reason: string;
      follow_up_action: string;
      whatsapp_call_tried: boolean;
      whatsapp_call_proof: string;
      searched_internet_email: boolean;
      searched_internet_phone: boolean;
      linkedin_request_sent: boolean;
      linkedin_msg_sent: boolean;
    }> = {}
  ) => {
    try {
      await client.updateWorkspaceLeadStatus({
        buyer_id: buyerId,
        stage: newStage,
        ...extra,
      });
      setEditingLeadId(null);
      await loadLeads();
    } catch (err: any) {
      alert(err?.message || "Failed to update lead stage.");
    }
  };

  // Handle WhatsApp Proof Save
  const handleSaveWhatsAppProof = async (data: {
    buyer_id: number;
    whatsapp_call_tried: boolean;
    whatsapp_call_proof: string;
  }) => {
    await client.updateWorkspaceLeadStatus({
      buyer_id: data.buyer_id,
      stage: "no_response",
      whatsapp_call_tried: data.whatsapp_call_tried,
      whatsapp_call_proof: data.whatsapp_call_proof,
    });
    await loadLeads();
  };

  // Filter options by category
  const followUpOptions = reviewOptions.filter(
    (o) => o.category === "follow_up" || o.category === "follow_up_reason"
  );
  const notInterestedOptions = reviewOptions.filter(
    (o) => o.category === "not_interested" || o.category === "not_interested_reason"
  );

  return (
    <div className="space-y-6">
      {/* ── Day & Target Countries Header Bar ── */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl backdrop-blur-md">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl">📅</span>
              <h2 className="text-xl font-bold text-white tracking-tight">
                Daily Sales Target & Country Workspace
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {selectedDay.toUpperCase()}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Active schedule: <strong className="text-slate-200">{currentFormattedDate}</strong> • Assigned targets & active outreach lifecycle
            </p>
          </div>

          {/* Day Selector Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto bg-slate-950 p-1.5 rounded-xl border border-slate-800">
            {DAYS_OF_WEEK.map((day) => {
              const isSelected = selectedDay.toLowerCase() === day.id;
              return (
                <button
                  key={day.id}
                  type="button"
                  onClick={() => {
                    onSelectDay(day.id);
                    setSelectedCountryFilter("all");
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap ${
                    isSelected
                      ? "bg-emerald-600 text-white font-semibold shadow-md shadow-emerald-950"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
                  }`}
                >
                  {day.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Target Countries for Selected Day */}
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Today's Target Countries:
            </span>
            {targetCountries.length === 0 ? (
              <span className="text-xs text-slate-500 italic">No target countries assigned yet.</span>
            ) : (
              targetCountries.map((tc) => (
                <span
                  key={tc.id}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-semibold bg-slate-800/90 text-slate-100 border border-slate-700 shadow-sm"
                >
                  <span>🌍 {tc.country}</span>
                  {tc.assigned_user_name && (
                    <span className="text-[10px] text-amber-400 font-normal">
                      ({tc.assigned_user_name})
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRemoveCountry(tc.id)}
                    className="text-slate-500 hover:text-rose-400 transition ml-1"
                    title="Remove country"
                  >
                    ✕
                  </button>
                </span>
              ))
            )}
          </div>

          {/* Quick Add Country Input */}
          <form onSubmit={handleAddCountry} className="flex items-center gap-2">
            <input
              type="text"
              placeholder="+ Add Target Country (e.g. China, Tanzania)..."
              value={newCountryInput}
              onChange={(e) => setNewCountryInput(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 w-64"
            />
            <button
              type="submit"
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold transition"
            >
              Add
            </button>
          </form>
        </div>
      </div>

      {/* ── 4 Outreach Funnel Stage Tabs ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Stage 1: Fresh */}
        <button
          type="button"
          onClick={() => setSelectedStage("fresh")}
          className={`p-4 rounded-2xl border text-left transition flex flex-col justify-between ${
            selectedStage === "fresh"
              ? "bg-gradient-to-br from-emerald-950/60 to-slate-900 border-emerald-500/80 ring-2 ring-emerald-500/20 shadow-lg shadow-emerald-950/40"
              : "bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
              1. Fresh / Untouched
            </span>
            <span className="text-lg">🌱</span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-white">{counts.fresh}</div>
            <div className="text-[11px] text-slate-400">Never contacted leads in today's countries</div>
          </div>
        </button>

        {/* Stage 2: Needs Follow Up */}
        <button
          type="button"
          onClick={() => setSelectedStage("needs_follow_up")}
          className={`p-4 rounded-2xl border text-left transition flex flex-col justify-between ${
            selectedStage === "needs_follow_up"
              ? "bg-gradient-to-br from-amber-950/60 to-slate-900 border-amber-500/80 ring-2 ring-amber-500/20 shadow-lg shadow-amber-950/40"
              : "bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
              2. Needs Follow Up
            </span>
            <span className="text-lg">🕒</span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-white">{counts.needs_follow_up}</div>
            <div className="text-[11px] text-slate-400">Approval pending, callback, quotation needed</div>
          </div>
        </button>

        {/* Stage 3: Not Interested */}
        <button
          type="button"
          onClick={() => setSelectedStage("not_interested")}
          className={`p-4 rounded-2xl border text-left transition flex flex-col justify-between ${
            selectedStage === "not_interested"
              ? "bg-gradient-to-br from-purple-950/60 to-slate-900 border-purple-500/80 ring-2 ring-purple-500/20 shadow-lg shadow-purple-950/40"
              : "bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-purple-400">
              3. Not Interested
            </span>
            <span className="text-lg">💡</span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-white">{counts.not_interested}</div>
            <div className="text-[11px] text-slate-400">Objections with Actionable TO DO Strategy</div>
          </div>
        </button>

        {/* Stage 4: No Response */}
        <button
          type="button"
          onClick={() => setSelectedStage("no_response")}
          className={`p-4 rounded-2xl border text-left transition flex flex-col justify-between ${
            selectedStage === "no_response"
              ? "bg-gradient-to-br from-rose-950/60 to-slate-900 border-rose-500/80 ring-2 ring-rose-500/20 shadow-lg shadow-rose-950/40"
              : "bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-rose-400">
              4. No Response / Dead Meter
            </span>
            <span className="text-lg">🔕</span>
          </div>
          <div className="mt-3">
            <div className="text-2xl font-bold text-white">{counts.no_response}</div>
            <div className="text-[11px] text-slate-400">Audit WhatsApp proof & Drip replacement</div>
          </div>
        </button>
      </div>

      {/* ── Search and Secondary Filters ── */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-900/60 p-3 rounded-xl border border-slate-800">
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <input
            type="text"
            placeholder="Search company, contact person, email, phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full sm:w-80 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 self-end sm:self-auto text-xs">
          <span className="text-slate-400 font-medium">Filter Country:</span>
          <select
            value={selectedCountryFilter}
            onChange={(e) => setSelectedCountryFilter(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100 focus:outline-none focus:border-emerald-500"
          >
            <option value="all">All Target Countries ({targetCountries.map((t) => t.country).join(", ") || "All"})</option>
            {targetCountries.map((tc) => (
              <option key={tc.id} value={tc.country}>
                {tc.country}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Leads Content Area ── */}
      {isLoading ? (
        <div className="py-20 text-center text-slate-400 flex flex-col items-center gap-2">
          <span className="animate-spin text-2xl">⏳</span>
          <p className="text-xs">Loading target workspace leads...</p>
        </div>
      ) : error ? (
        <div className="p-4 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs">
          {error}
        </div>
      ) : leads.length === 0 ? (
        <div className="py-16 text-center rounded-2xl border border-slate-800 bg-slate-900/30 p-8">
          <div className="text-3xl mb-2">📋</div>
          <h4 className="text-base font-semibold text-slate-200">No leads in this stage</h4>
          <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
            {selectedStage === "fresh"
              ? "All contacts for today's target countries have been engaged. Check 'Needs Follow Up' or 'No Response' to continue outreach."
              : "No contacts are currently in this funnel stage."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {leads.map((lead) => (
            <div
              key={lead.id}
              className={`rounded-2xl border p-4 transition duration-150 ${
                lead.is_dead_lead_meter_red
                  ? "bg-slate-900/90 border-rose-900/80 shadow-md shadow-rose-950/20"
                  : "bg-slate-900/80 border-slate-800/90 hover:border-slate-700"
              }`}
            >
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                {/* Left Section: Company & Contact details */}
                <div className="space-y-1.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h3 className="text-base font-bold text-slate-50 tracking-tight">
                      {lead.company_name}
                    </h3>
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-800 text-slate-200 border border-slate-600">
                      🌍 {lead.country || "Global"} {lead.city ? `• ${lead.city}` : ""}
                    </span>
                    {lead.product_interest && (
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">
                        📦 {lead.product_interest}
                      </span>
                    )}
                    {lead.assigned_to_name && (
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-indigo-950/60 text-indigo-300 border border-indigo-800/60">
                        👤 Rep: {lead.assigned_to_name}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-4 text-xs text-slate-300 flex-wrap">
                    <div>
                      <span className="text-slate-500">Contact:</span>{" "}
                      <strong className="text-slate-100">{lead.contact_person || "Not specified"}</strong>
                      {lead.designation && <span className="text-slate-400"> ({lead.designation})</span>}
                    </div>
                    {lead.primary_phone && (
                      <div>
                        <span className="text-slate-500">Phone:</span>{" "}
                        <span className="font-mono text-emerald-400">{lead.primary_phone}</span>
                      </div>
                    )}
                    {lead.primary_email && (
                      <div>
                        <span className="text-slate-500">Email:</span>{" "}
                        <span className="font-mono text-cyan-400">{lead.primary_email}</span>
                      </div>
                    )}
                  </div>

                  {/* ── Stage-Specific Context Banners & Matrices ── */}

                  {/* Stage 2: Needs Follow Up Specific Details */}
                  {selectedStage === "needs_follow_up" && (
                    <div className="mt-2 p-2.5 rounded-xl bg-amber-950/30 border border-amber-800/50 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-amber-400 font-semibold">📌 Follow-up Reason:</span>
                        <span className="px-2 py-0.5 rounded bg-amber-900/60 text-amber-200 font-medium">
                          {lead.follow_up_reason || "Call back later"}
                        </span>
                        <span className="text-slate-400 font-semibold">Action:</span>
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200 font-mono uppercase text-[10px]">
                          {lead.follow_up_action || "Call"}
                        </span>
                      </div>
                      <div className="text-[11px] text-amber-300/80">
                        Scheduled: {lead.follow_up_date ? new Date(lead.follow_up_date).toLocaleDateString() : "Pending"}
                      </div>
                    </div>
                  )}

                  {/* Stage 3: Not Interested - Actionable TO DO Matrix */}
                  {selectedStage === "not_interested" && (
                    <div className="mt-2 p-3 rounded-xl bg-purple-950/40 border border-purple-800/60 text-xs space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-purple-300 font-bold">Objection Category:</span>
                        <span className="px-2.5 py-0.5 rounded-md bg-purple-900/70 text-purple-200 font-semibold">
                          {lead.not_interested_reason || "General Objection"}
                        </span>
                        {lead.not_interested_remarks && (
                          <span className="text-slate-400 italic">"{lead.not_interested_remarks}"</span>
                        )}
                      </div>
                      {/* TO DO Strategy Guidance */}
                      <div className="p-2.5 rounded-lg bg-slate-950/80 border border-purple-700/50 flex items-start gap-2">
                        <span className="text-sm">🎯</span>
                        <div>
                          <strong className="text-purple-300 block">Actionable TO DO Strategy:</strong>
                          <p className="text-slate-200 text-[11px] mt-0.5">
                            {lead.todo_action_hint ||
                              "Re-evaluate requirements, check competitor pricing, and offer custom sample package."}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Stage 4: No Response - Dead Meter & WhatsApp Proof & Internet Research */}
                  {selectedStage === "no_response" && (
                    <div className="mt-2 space-y-2">
                      {/* Dead Lead Meter */}
                      <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-3">
                          <span className="text-slate-400 font-semibold">Outreach Stats:</span>
                          <span className="text-slate-300">
                            Calls Attempted: <strong className="text-emerald-400">{lead.calls_made_count}</strong>
                          </span>
                          <span className="text-slate-300">
                            Emails Sent:{" "}
                            <strong className={lead.emails_sent_count >= 20 ? "text-rose-400 font-bold" : "text-cyan-400"}>
                              {lead.emails_sent_count} / 20
                            </strong>
                          </span>
                          <span className="text-slate-300">
                            Silence:{" "}
                            <strong className={lead.days_since_last_response >= 30 ? "text-rose-400 font-bold" : "text-amber-400"}>
                              {lead.days_since_last_response}d
                            </strong>
                          </span>
                        </div>

                        {/* Meter Indicator */}
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-slate-400">Dead Lead Meter:</span>
                          {lead.is_dead_lead_meter_red ? (
                            <span className="px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-bold animate-pulse">
                              🔴 CRITICAL DEAD LEAD (Shift to Drip)
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-semibold">
                              🟡 Active Retry Window
                            </span>
                          )}
                        </div>
                      </div>

                      {/* WhatsApp Proof and Research Checkboxes */}
                      <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
                        {/* WhatsApp Proof Indicator */}
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400 font-medium">WhatsApp Call Proof:</span>
                          <button
                            type="button"
                            onClick={() => setProofModalLead(lead)}
                            className={`px-2.5 py-1 rounded-lg font-semibold text-[11px] transition flex items-center gap-1 ${
                              lead.whatsapp_call_tried
                                ? "bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-600/30"
                                : "bg-slate-800 text-slate-400 border border-slate-700 hover:text-slate-200"
                            }`}
                          >
                            <span>{lead.whatsapp_call_tried ? "✓ Logged (Yes)" : "✕ Not Logged (No)"}</span>
                            <span className="text-[10px] text-slate-400 underline ml-1">
                              {isAdmin ? "Audit Proof" : "Edit Proof"}
                            </span>
                          </button>
                        </div>

                        {/* Internet Research Trackers */}
                        <div className="flex items-center gap-3 text-[11px] text-slate-300 flex-wrap">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={lead.searched_internet_email}
                              onChange={(e) =>
                                handleUpdateStage(lead.id, "no_response", {
                                  searched_internet_email: e.target.checked,
                                })
                              }
                              className="rounded bg-slate-900 border-slate-700 text-emerald-500 focus:ring-0 cursor-pointer"
                            />
                            <span>🌐 Searched New Email</span>
                          </label>

                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={lead.searched_internet_phone}
                              onChange={(e) =>
                                handleUpdateStage(lead.id, "no_response", {
                                  searched_internet_phone: e.target.checked,
                                })
                              }
                              className="rounded bg-slate-900 border-slate-700 text-emerald-500 focus:ring-0 cursor-pointer"
                            />
                            <span>📞 Searched New Phone</span>
                          </label>

                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={lead.linkedin_request_sent}
                              onChange={(e) =>
                                handleUpdateStage(lead.id, "no_response", {
                                  linkedin_request_sent: e.target.checked,
                                })
                              }
                              className="rounded bg-slate-900 border-slate-700 text-indigo-500 focus:ring-0 cursor-pointer"
                            />
                            <span>🔗 LinkedIn Req</span>
                          </label>

                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={lead.linkedin_msg_sent}
                              onChange={(e) =>
                                handleUpdateStage(lead.id, "no_response", {
                                  linkedin_msg_sent: e.target.checked,
                                })
                              }
                              className="rounded bg-slate-900 border-slate-700 text-indigo-500 focus:ring-0 cursor-pointer"
                            />
                            <span>💬 LinkedIn Msg</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Right Section: Action Controls */}
                <div className="flex flex-col sm:flex-row lg:flex-col items-end gap-2 shrink-0">
                  {/* Direct Contact Action Buttons */}
                  <div className="flex items-center gap-1.5">
                    {lead.primary_phone && (
                      <button
                        type="button"
                        onClick={() => onOpenCall?.(lead.primary_phone!, lead.company_name, lead.id)}
                        className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md shadow-emerald-950 transition flex items-center gap-1"
                        title="Direct Dial via Twilio"
                      >
                        📞 Call
                      </button>
                    )}
                    {lead.primary_email && (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenEmailComposer?.(
                            lead.primary_email!,
                            lead.company_name,
                            lead.contact_person || undefined
                          )
                        }
                        className="px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md shadow-sky-950 transition flex items-center gap-1"
                        title="Compose Email"
                      >
                        ✉️ Email
                      </button>
                    )}
                  </div>

                  {/* Promote / Demote Stage Change Dropdown or Modal Trigger */}
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {selectedStage !== "needs_follow_up" && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingLeadId(lead.id);
                          setInlineReason("Need approval from HO");
                          setInlineAction("call");
                        }}
                        className="px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 text-xs font-medium transition"
                      >
                        🕒 Move to Follow Up
                      </button>
                    )}

                    {selectedStage !== "not_interested" && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingLeadId(lead.id);
                          setInlineReason("Price high");
                          setInlineRemarks("");
                        }}
                        className="px-2.5 py-1 rounded-lg bg-purple-500/10 text-purple-200 border border-purple-500/40 hover:bg-purple-500/20 text-xs font-medium transition"
                      >
                        💡 Not Interested
                      </button>
                    )}

                    {selectedStage !== "no_response" && (
                      <button
                        type="button"
                        onClick={() => handleUpdateStage(lead.id, "no_response")}
                        className="px-2.5 py-1 rounded-lg bg-rose-500/10 text-rose-200 border border-rose-500/40 hover:bg-rose-500/20 text-xs font-medium transition"
                      >
                        🔕 No Response
                      </button>
                    )}

                    {selectedStage !== "fresh" && (
                      <button
                        type="button"
                        onClick={() => handleUpdateStage(lead.id, "fresh")}
                        className="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 text-xs font-medium transition"
                      >
                        ↩️ Reset to Fresh
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Inline Action Selector for Move to Follow-up / Not-interested */}
              {editingLeadId === lead.id && (
                <div className="mt-3 p-3 rounded-xl bg-slate-950 border border-slate-700 animate-in fade-in duration-150 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <span className="text-xs font-bold text-white">Select Reason & Strategy for {lead.company_name}</span>
                    <button
                      type="button"
                      onClick={() => setEditingLeadId(null)}
                      className="text-slate-400 hover:text-slate-200 text-xs"
                    >
                      ✕ Cancel
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="block text-slate-400 mb-1">Reason / Category:</label>
                      <select
                        value={inlineReason}
                        onChange={(e) => setInlineReason(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100"
                      >
                        <optgroup label="Needs Follow-up Scenarios">
                          {followUpOptions.map((o) => (
                            <option key={o.id} value={o.label}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Not Interested Scenarios">
                          {notInterestedOptions.map((o) => (
                            <option key={o.id} value={o.label}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-400 mb-1">Action Type:</label>
                      <select
                        value={inlineAction}
                        onChange={(e) => setInlineAction(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-100"
                      >
                        <option value="call">Call Back</option>
                        <option value="email">Send Email / Proposal</option>
                        <option value="quotation">Send CNF/FOB Quotation</option>
                        <option value="whatsapp">WhatsApp Outreach</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 text-xs mb-1">Remarks / TO DO Note:</label>
                    <input
                      type="text"
                      placeholder="e.g. Client requested competitor price comparison / will discuss on Monday..."
                      value={inlineRemarks}
                      onChange={(e) => setInlineRemarks(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500"
                    />
                  </div>

                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const isNotInt = notInterestedOptions.some((o) => o.label === inlineReason);
                        if (isNotInt) {
                          handleUpdateStage(lead.id, "not_interested", {
                            not_interested_reason: inlineReason,
                            not_interested_remarks: inlineRemarks,
                          });
                        } else {
                          handleUpdateStage(lead.id, "needs_follow_up", {
                            follow_up_reason: inlineReason,
                            follow_up_action: inlineAction,
                          });
                        }
                      }}
                      className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition"
                    >
                      ✓ Save & Apply Strategy
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Modals ── */}
      <WhatsAppProofModal
        lead={proofModalLead}
        isOpen={Boolean(proofModalLead)}
        isAdmin={isAdmin}
        onClose={() => setProofModalLead(null)}
        onSave={handleSaveWhatsAppProof}
      />
    </div>
  );
};
