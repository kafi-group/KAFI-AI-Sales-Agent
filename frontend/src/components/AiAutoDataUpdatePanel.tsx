import { useCallback, useEffect, useState } from "react";
import {
  client,
  type AiSalesAgentTask,
  type AiSalesDataUpdateStatus,
} from "../api/client";

interface Props {
  onError: (message: string) => void;
  tasks: AiSalesAgentTask[];
  onTasksChanged: () => void;
}

const WEEKDAYS = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
] as const;

const PERSONAS = [
  { id: "female" as const, label: "Sara" },
  { id: "male" as const, label: "Rayan" },
];

export function AiAutoDataUpdatePanel({ onError, tasks, onTasksChanged }: Props) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<AiSalesDataUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningPersona, setRunningPersona] = useState<"female" | "male" | null>(null);
  const [movingId, setMovingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await client.getAiSalesDataUpdate();
      setStatus(data);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load Data Update schedule");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 12000);
    return () => window.clearInterval(t);
  }, [load]);

  async function saveSchedule(
    persona: "female" | "male",
    patch: {
      enabled?: boolean;
      time?: string;
      weekdays?: string[];
      cooldown_sec?: number;
    },
  ) {
    setSaving(true);
    setNotice(null);
    try {
      const next = await client.updateAiSalesDataUpdateSchedule({ persona, ...patch });
      setStatus(next);
      setNotice(`Saved ${persona === "female" ? "Sara" : "Rayan"} Data Update schedule.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save schedule");
    } finally {
      setSaving(false);
    }
  }

  async function runNow(persona: "female" | "male") {
    setRunningPersona(persona);
    setNotice(null);
    try {
      const res = await client.runAiSalesDataUpdateNow(persona);
      setStatus(res.status as AiSalesDataUpdateStatus);
      setNotice(
        `Started Data Update for ${persona === "female" ? "Sara" : "Rayan"} — ${res.total} contact(s). Autopilot runs 1-at-a-time with cooldown.`,
      );
      onTasksChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to start Data Update");
    } finally {
      setRunningPersona(null);
    }
  }

  async function setLane(taskId: number, lane: "outreach" | "data_update") {
    setMovingId(taskId);
    try {
      await client.setAiSalesTaskLane({ task_ids: [taskId], queue_lane: lane });
      onTasksChanged();
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to move contact");
    } finally {
      setMovingId(null);
    }
  }

  const outreach = tasks.filter((t) => (t.queue_lane || "outreach") === "outreach");
  const dataUpdate = tasks.filter((t) => t.queue_lane === "data_update");

  if (loading && !status) {
    return (
      <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/20 p-4 text-sm text-slate-400">
        Loading AI Auto Data Update Schedule…
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-cyan-500/40 bg-gradient-to-br from-cyan-950/30 to-slate-900/60 shadow-lg shadow-cyan-950/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div>
          <h3 className="text-base font-semibold text-slate-100">AI Auto Data Update Schedule</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Move contacts into Data Update (not Outreach). One recurring job per Sara / Rayan —
            autopilot fills missing fields 1-at-a-time with cooldown.
          </p>
        </div>
        <span className="text-slate-400 text-sm shrink-0">{open ? "▾" : "▸"}</span>
      </button>

      {open ? (
        <div className="px-4 pb-4 space-y-4 border-t border-cyan-500/20 pt-3">
          {notice ? <p className="text-xs text-emerald-300">{notice}</p> : null}

          <div className="grid gap-3 md:grid-cols-2">
            {PERSONAS.map((p) => {
              const sch = status?.schedules?.[p.id];
              const run = status?.run_state?.[p.id];
              const prog = run?.progress;
              return (
                <div
                  key={p.id}
                  className="rounded-lg border border-slate-700 bg-slate-950/50 p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-slate-100">{p.label}</h4>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void saveSchedule(p.id, { enabled: !sch?.enabled })}
                      className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${
                        sch?.enabled ? "bg-emerald-500" : "bg-slate-700"
                      }`}
                      aria-pressed={Boolean(sch?.enabled)}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                          sch?.enabled ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>

                  <label className="block text-xs text-slate-400">
                    Daily time (Asia/Karachi)
                    <input
                      type="time"
                      value={sch?.time || "10:00"}
                      disabled={saving}
                      onChange={(e) => void saveSchedule(p.id, { time: e.target.value })}
                      className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                    />
                  </label>

                  <div className="flex flex-wrap gap-1">
                    {WEEKDAYS.map((d) => {
                      const on = (sch?.weekdays || []).includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          disabled={saving}
                          onClick={() => {
                            const cur = new Set(sch?.weekdays || []);
                            if (on) cur.delete(d.id);
                            else cur.add(d.id);
                            void saveSchedule(p.id, { weekdays: [...cur] });
                          }}
                          className={`px-2 py-0.5 rounded text-[11px] border ${
                            on
                              ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-100"
                              : "border-slate-700 text-slate-500"
                          }`}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>

                  <label className="block text-xs text-slate-400">
                    Cooldown between contacts (sec)
                    <input
                      type="number"
                      min={15}
                      max={600}
                      value={sch?.cooldown_sec ?? 45}
                      disabled={saving}
                      onChange={(e) =>
                        void saveSchedule(p.id, { cooldown_sec: Number(e.target.value) || 45 })
                      }
                      className="mt-1 block w-28 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                    />
                  </label>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={runningPersona === p.id}
                      onClick={() => void runNow(p.id)}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white disabled:opacity-40"
                    >
                      {runningPersona === p.id ? "Starting…" : `Run ${p.label} now`}
                    </button>
                    <span className="text-[11px] text-slate-500">
                      Status: {run?.status || "idle"}
                      {prog
                        ? ` · ${prog.done}/${prog.total} (ok ${prog.succeeded}, skip ${prog.skipped}, fail ${prog.failed})`
                        : ""}
                    </span>
                  </div>

                  {run?.current_label ? (
                    <p className="text-[11px] text-cyan-200/90">
                      Now: {run.current_label}
                    </p>
                  ) : null}

                  {run?.last_report ? (
                    <details className="text-[11px] text-slate-400">
                      <summary className="cursor-pointer text-slate-300">Last report</summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-900/80 p-2 overflow-auto max-h-40">
                        {JSON.stringify(run.last_report, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
              <h4 className="text-sm font-semibold text-slate-100 mb-1">
                Outreach queue ({outreach.length})
              </h4>
              <p className="text-[11px] text-slate-500 mb-2">
                Call / email / WhatsApp. Move a contact to Data Update to exclude it from dialling.
              </p>
              <ul className="space-y-1 max-h-48 overflow-y-auto text-xs">
                {outreach.length === 0 ? (
                  <li className="text-slate-600">Empty</li>
                ) : (
                  outreach.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1.5"
                    >
                      <span className="text-slate-200 truncate">
                        {t.company_name || t.contact_name || `#${t.buyer_id}`}
                        <span className="text-slate-500"> · {t.persona === "female" ? "Sara" : "Rayan"}</span>
                      </span>
                      <button
                        type="button"
                        disabled={movingId === t.id}
                        onClick={() => void setLane(t.id, "data_update")}
                        className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-40"
                      >
                        → Data Update
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div className="rounded-lg border border-cyan-700/40 bg-cyan-950/20 p-3">
              <h4 className="text-sm font-semibold text-slate-100 mb-1">
                Data Update queue ({dataUpdate.length})
              </h4>
              <p className="text-[11px] text-slate-500 mb-2">
                Autopilot research fills empty fields only. Cannot also be in Outreach.
              </p>
              <ul className="space-y-1 max-h-48 overflow-y-auto text-xs">
                {dataUpdate.length === 0 ? (
                  <li className="text-slate-600">Empty — move contacts from Outreach</li>
                ) : (
                  dataUpdate.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center justify-between gap-2 rounded border border-cyan-800/40 px-2 py-1.5"
                    >
                      <span className="text-slate-200 truncate">
                        {t.company_name || t.contact_name || `#${t.buyer_id}`}
                        <span className="text-slate-500"> · {t.persona === "female" ? "Sara" : "Rayan"}</span>
                      </span>
                      <button
                        type="button"
                        disabled={movingId === t.id}
                        onClick={() => void setLane(t.id, "outreach")}
                        className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                      >
                        → Outreach
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
