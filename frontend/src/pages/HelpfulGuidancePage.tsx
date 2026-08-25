import { useCallback, useEffect, useState } from "react";
import { client, type AppUser } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { SearchableSelect } from "../components/SearchableSelect";

interface HelpfulGuidanceResponse {
  generated_at: string;
  months: number;
  user_id: number | null;
  is_team_view: boolean;
  kpi_by_month: Array<{ period_label: string; counts: Record<string, number> }>;
  kpi_totals: Record<string, number>;
  remark_patterns: {
    scanned_remarks: number;
    pattern_counts: Record<string, number>;
    samples: Record<string, string[]>;
  };
  strengths: string[];
  gaps: string[];
  recommendations: Array<{ title: string; body: string }>;
  approach_buyers: string[];
  save_phone_bill: string[];
}

interface HelpfulGuidancePageProps {
  onError: (message: string) => void;
}

export function HelpfulGuidancePage({ onError }: HelpfulGuidancePageProps) {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<HelpfulGuidanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [assignees, setAssignees] = useState<AppUser[]>([]);
  const [userFilter, setUserFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await client.getHelpfulGuidance({
        months: 3,
        user_id: userFilter || undefined,
      });
      setData(result as unknown as HelpfulGuidanceResponse);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load guidance");
    } finally {
      setLoading(false);
    }
  }, [onError, userFilter]);

  useEffect(() => {
    if (isAdmin) {
      void client.listAssignees().then(setAssignees).catch(() => setAssignees([]));
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return <p className="text-sm text-slate-400 p-6">Loading helpful guidance…</p>;
  }

  if (!data) return null;

  const totals = data.kpi_totals;

  return (
    <section className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg font-medium text-slate-100">SALES HELP MANAGER</h2>
        <p className="text-sm text-slate-400 mt-1">
          Coaching from client history, call outcomes, and the last {data.months} months of KPI
          {data.is_team_view ? " (team view)" : ""}.
        </p>
      </div>

      {isAdmin && (
        <SearchableSelect
          label="User"
          value={userFilter}
          onChange={setUserFilter}
          options={[
            { value: "", label: "Team rollup" },
            { value: "agent_all", label: "🤖 All AI Sales Agents" },
            { value: "agent_sara", label: "🤖 Sara (AI Sales Agent)" },
            { value: "agent_rayan", label: "🤖 Rayan (AI Sales Agent)" },
            ...assignees.map((u) => ({ value: String(u.id), label: u.username })),
          ]}
          allowEmpty
          emptyLabel="Team rollup"
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Calls logged", totals.calls_logged ?? 0],
          ["Interested", totals.outcomes_interested ?? 0],
          ["Follow up", totals.outcomes_follow_up ?? 0],
          ["No answer", totals.outcomes_not_received_call ?? 0],
        ].map(([label, val]) => (
          <div
            key={String(label)}
            className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3"
          >
            <p className="text-xs text-slate-500">{label}</p>
            <p className="text-2xl font-semibold text-slate-100 tabular-nums">{val}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-4">
        <h3 className="text-sm font-medium text-emerald-200">Strengths</h3>
        <ul className="mt-2 space-y-1 text-sm text-emerald-100/90 list-disc list-inside">
          {data.strengths.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 p-4">
        <h3 className="text-sm font-medium text-amber-200">Where we are lacking</h3>
        <ul className="mt-2 space-y-1 text-sm text-amber-100/90 list-disc list-inside">
          {data.gaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-slate-200">Recommendations</h3>
        {data.recommendations.map((rec) => (
          <div key={rec.title} className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
            <p className="text-sm font-medium text-sky-200">{rec.title}</p>
            <p className="text-sm text-slate-300 mt-1">{rec.body}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-800 p-4">
          <h3 className="text-sm font-medium text-slate-200">How to approach buyers</h3>
          <ul className="mt-2 space-y-1 text-sm text-slate-400 list-disc list-inside">
            {data.approach_buyers.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-slate-800 p-4">
          <h3 className="text-sm font-medium text-slate-200">Save telephone / voicemail cost</h3>
          <ul className="mt-2 space-y-1 text-sm text-slate-400 list-disc list-inside">
            {data.save_phone_bill.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
