import { useCallback, useEffect, useState } from "react";
import { client, type AiTrainingData, type AiTrainingSelectedCall } from "../api/client";
import { useAuth } from "../auth/AuthContext";

interface AiTrainPageProps {
  onError: (message: string) => void;
}

/** Standalone training playbook for Sara & Rayan (outside AI Sales Agent dialer). */
export function AiTrainPage({ onError }: AiTrainPageProps) {
  const { isAdmin } = useAuth();
  const [trainingData, setTrainingData] = useState<AiTrainingData | null>(null);
  const [trainingLoading, setTrainingLoading] = useState(false);
  const [rulesDraft, setRulesDraft] = useState("");
  const [savingRules, setSavingRules] = useState(false);
  const [trainingNotice, setTrainingNotice] = useState<string | null>(null);
  const [selectedTrainingCalls, setSelectedTrainingCalls] = useState<AiTrainingSelectedCall[]>([]);
  const [selectedTrainingLoading, setSelectedTrainingLoading] = useState(false);
  const [trainingCallFilter, setTrainingCallFilter] = useState<"all" | "female" | "male">("all");
  const [checkedTrainingIds, setCheckedTrainingIds] = useState<Set<number>>(new Set());

  const loadTraining = useCallback(async () => {
    try {
      const data = await client.getAiTrainingInfo();
      setTrainingData(data);
      setRulesDraft(data.custom_rules || "");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load training data");
    }
  }, [onError]);

  const loadSelectedTrainingCalls = useCallback(async () => {
    setSelectedTrainingLoading(true);
    try {
      const res = await client.listAiTrainingSelectedCalls(80);
      setSelectedTrainingCalls(res.rows || []);
      setCheckedTrainingIds(new Set((res.rows || []).map((r) => r.id)));
    } catch {
      /* ignore */
    } finally {
      setSelectedTrainingLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTraining();
    void loadSelectedTrainingCalls();
  }, [loadTraining, loadSelectedTrainingCalls]);

  async function handleTrainFromHistory(source: "curated" | "history" | "ids") {
    setTrainingLoading(true);
    setTrainingNotice(null);
    try {
      const data = await client.trainAiFromHistory({
        source,
        interaction_ids: source === "ids" ? [...checkedTrainingIds] : [],
      });
      setTrainingData(data);
      setRulesDraft(data.custom_rules || rulesDraft);
      setTrainingNotice(
        source === "curated" || source === "ids"
          ? "Trained Sara & Rayan from ticked calls."
          : "Auto-trained from call history.",
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Training failed");
    } finally {
      setTrainingLoading(false);
    }
  }

  async function handleSaveRules() {
    setSavingRules(true);
    setTrainingNotice(null);
    try {
      const data = await client.updateAiSalesRules(rulesDraft);
      setTrainingData(data);
      setTrainingNotice("Custom sales rules saved.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save rules");
    } finally {
      setSavingRules(false);
    }
  }

  async function handleRemoveTrainingFlag(id: number) {
    try {
      await client.setCallTrainingFlag(id, false);
      await loadSelectedTrainingCalls();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not remove training tick");
    }
  }

  if (!isAdmin) {
    return (
      <p className="text-sm text-slate-400 p-4">
        AI Train is available to admins. Ask an admin to update Sara &amp; Rayan&apos;s playbook.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
          <span>🧠 AI Train</span>
          <span className="text-xs px-2 py-0.5 rounded bg-sky-500/10 border border-sky-500/30 text-sky-300 font-mono">
            Gemini RAG Engine
          </span>
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Train Sara &amp; Rayan outside the dialer. Tick{" "}
          <span className="text-violet-300">Train Sara &amp; Rayan</span> after good calls, then
          train from those ticks or full history. Product confidence also feeds from AI Auto Mode
          when product study is enabled.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleTrainFromHistory("curated")}
          disabled={trainingLoading || selectedTrainingCalls.length === 0}
          className="px-3 py-2 text-xs font-semibold rounded-lg bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
        >
          {trainingLoading ? "Training…" : "Train from ticked calls"}
        </button>
        <button
          type="button"
          onClick={() => void handleTrainFromHistory("history")}
          disabled={trainingLoading}
          className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
        >
          {trainingLoading ? "Gemini Analyzing…" : "⚡ Auto-Train from Call History"}
        </button>
      </div>

      {trainingNotice && (
        <p className="text-xs text-emerald-300 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          {trainingNotice}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Learned Insights
          </h4>
          <div className="text-xs text-slate-300 whitespace-pre-wrap leading-relaxed bg-slate-900/60 p-3 rounded-lg border border-slate-800/80 max-h-56 overflow-y-auto font-mono">
            {trainingData?.learned_insights || "Train from history or ticked calls to extract insights."}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 space-y-2 flex flex-col">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
            Custom Sales Rules
          </h4>
          <textarea
            rows={8}
            value={rulesDraft}
            onChange={(e) => setRulesDraft(e.target.value)}
            className="w-full text-xs rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-slate-200 font-mono min-h-[12rem]"
          />
          <button
            type="button"
            onClick={() => void handleSaveRules()}
            disabled={savingRules}
            className="self-end px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50"
          >
            {savingRules ? "Saving…" : "Save Custom Rules"}
          </button>
        </div>

        <div className="rounded-lg border border-violet-700/40 bg-violet-950/20 p-4 space-y-3 flex flex-col min-h-[16rem]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-violet-300">
              Ticked for Sara &amp; Rayan
            </h4>
            <select
              value={trainingCallFilter}
              onChange={(e) => setTrainingCallFilter(e.target.value as "all" | "female" | "male")}
              className="text-[11px] rounded border border-slate-700 bg-slate-950 px-1.5 py-1 text-slate-300"
            >
              <option value="all">All agents</option>
              <option value="female">Sara</option>
              <option value="male">Rayan</option>
            </select>
          </div>
          <div className="flex-1 max-h-56 overflow-y-auto space-y-1.5 rounded-lg border border-slate-800/80 bg-slate-950/50 p-2">
            {selectedTrainingLoading ? (
              <p className="text-xs text-slate-500">Loading…</p>
            ) : selectedTrainingCalls.filter((c) =>
                trainingCallFilter === "all" ? true : c.persona === trainingCallFilter,
              ).length === 0 ? (
              <p className="text-xs text-slate-500">No ticked calls yet.</p>
            ) : (
              selectedTrainingCalls
                .filter((c) =>
                  trainingCallFilter === "all" ? true : c.persona === trainingCallFilter,
                )
                .map((call) => (
                  <label
                    key={call.id}
                    className="flex items-start gap-2 rounded-md border border-violet-600/40 bg-violet-950/30 px-2 py-1.5 text-xs text-slate-100"
                  >
                    <input
                      type="checkbox"
                      checked={checkedTrainingIds.has(call.id)}
                      onChange={() => {
                        setCheckedTrainingIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(call.id)) next.delete(call.id);
                          else next.add(call.id);
                          return next;
                        });
                      }}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">
                        {call.company_name || call.contact_name || `Call #${call.id}`}
                      </p>
                      <p className="text-[11px] text-slate-500 truncate">
                        {call.contact_name || "—"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRemoveTrainingFlag(call.id)}
                      className="text-[10px] text-rose-400"
                    >
                      Remove
                    </button>
                  </label>
                ))
            )}
          </div>
          <button
            type="button"
            disabled={trainingLoading || checkedTrainingIds.size === 0}
            onClick={() => void handleTrainFromHistory("ids")}
            className="px-3 py-1.5 text-[11px] font-medium rounded-lg bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
          >
            Train from checked ({checkedTrainingIds.size})
          </button>
        </div>
      </div>
    </div>
  );
}
