import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedByPersona, setSelectedByPersona] = useState<
    Record<"female" | "male", Set<number>>
  >({ female: new Set(), male: new Set() });

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

  const queues = useMemo(() => {
    const out: Record<
      "female" | "male",
      { outreach: AiSalesAgentTask[]; data_update: AiSalesAgentTask[] }
    > = {
      female: { outreach: [], data_update: [] },
      male: { outreach: [], data_update: [] },
    };
    for (const t of tasks) {
      const persona = t.persona === "male" ? "male" : "female";
      const lane = (t.queue_lane || "outreach") === "data_update" ? "data_update" : "outreach";
      out[persona][lane].push(t);
    }
    return out;
  }, [tasks]);

  async function saveSchedule(
    persona: "female" | "male",
    patch: {
      enabled?: boolean;
      time?: string;
      end_time?: string;
      stop_mode?: "until_done" | "until_end_time";
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

  function toggleSelect(persona: "female" | "male", taskId: number) {
    setSelectedByPersona((prev) => {
      const next = new Set(prev[persona]);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return { ...prev, [persona]: next };
    });
  }

  function selectAllInLane(
    persona: "female" | "male",
    lane: "outreach" | "data_update",
    on: boolean,
  ) {
    const ids = queues[persona][lane].map((t) => t.id);
    setSelectedByPersona((prev) => {
      const next = new Set(prev[persona]);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return { ...prev, [persona]: next };
    });
  }

  async function moveSelected(
    persona: "female" | "male",
    lane: "outreach" | "data_update",
  ) {
    const ids = [...selectedByPersona[persona]].filter((id) =>
      queues[persona].outreach.concat(queues[persona].data_update).some((t) => t.id === id),
    );
    if (!ids.length) {
      onError("Select one or more contacts first.");
      return;
    }
    setMoving(true);
    try {
      await client.setAiSalesTaskLane({ task_ids: ids, queue_lane: lane });
      setSelectedByPersona((prev) => ({ ...prev, [persona]: new Set() }));
      onTasksChanged();
      await load();
      setNotice(
        `Moved ${ids.length} contact(s) to ${lane === "data_update" ? "Data Update" : "Outreach"} — still on ${persona === "female" ? "Sara" : "Rayan"}.`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to move contacts");
    } finally {
      setMoving(false);
    }
  }

  async function setLane(taskId: number, lane: "outreach" | "data_update") {
    setMoving(true);
    try {
      await client.setAiSalesTaskLane({ task_ids: [taskId], queue_lane: lane });
      onTasksChanged();
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to move contact");
    } finally {
      setMoving(false);
    }
  }

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
            Sara and Rayan each keep their own contacts. Within an agent, a contact is either
            Outreach or Data Update — moving lanes never switches agents.
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
              const outreach = queues[p.id].outreach;
              const dataUpdate = queues[p.id].data_update;
              const selected = selectedByPersona[p.id];
              const stopMode = (sch?.stop_mode || "until_done") as "until_done" | "until_end_time";
              return (
                <div
                  key={p.id}
                  className="rounded-lg border border-slate-700 bg-slate-950/50 p-3 space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-semibold text-slate-100">{p.label}</h4>
                      <p className="text-[10px] text-slate-500 mt-0.5">
                        Toggle = schedule armed (waits for start time). Does not start instantly.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void saveSchedule(p.id, { enabled: !sch?.enabled })}
                      title={
                        sch?.enabled
                          ? "Schedule ON — autopilot starts at the daily time on selected days"
                          : "Schedule OFF — will not auto-start (use Run now to start manually)"
                      }
                      className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${
                        sch?.enabled ? "bg-emerald-500" : "bg-slate-700"
                      }`}
                      aria-pressed={Boolean(sch?.enabled)}
                      aria-label={`${p.label} schedule enabled`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                          sch?.enabled ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs text-slate-400">
                      Start (Asia/Karachi)
                      <input
                        type="time"
                        value={sch?.time || "10:00"}
                        disabled={saving}
                        onChange={(e) => void saveSchedule(p.id, { time: e.target.value })}
                        className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                      />
                    </label>
                    <label className="block text-xs text-slate-400">
                      End (optional)
                      <input
                        type="time"
                        value={sch?.end_time || ""}
                        disabled={saving || stopMode === "until_done"}
                        onChange={(e) => void saveSchedule(p.id, { end_time: e.target.value })}
                        className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-40"
                      />
                    </label>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-[11px] text-slate-400 font-medium">Stop when</p>
                    <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="radio"
                        className="mt-0.5 accent-cyan-500"
                        checked={stopMode === "until_done"}
                        disabled={saving}
                        onChange={() => void saveSchedule(p.id, { stop_mode: "until_done" })}
                      />
                      <span>Until this agent&apos;s Data Update queue is empty</span>
                    </label>
                    <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="radio"
                        className="mt-0.5 accent-cyan-500"
                        checked={stopMode === "until_end_time"}
                        disabled={saving}
                        onChange={() => void saveSchedule(p.id, { stop_mode: "until_end_time" })}
                      />
                      <span>At end time (even if contacts remain)</span>
                    </label>
                  </div>

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
                      title="Start this agent's Data Update queue immediately (does not wait for schedule)"
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
                    <p className="text-[11px] text-cyan-200/90">Now: {run.current_label}</p>
                  ) : null}

                  {run?.last_report ? (
                    <details className="text-[11px] text-slate-400">
                      <summary className="cursor-pointer text-slate-300">Last report</summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-slate-900/80 p-2 overflow-auto max-h-40">
                        {JSON.stringify(run.last_report, null, 2)}
                      </pre>
                    </details>
                  ) : null}

                  {/* Per-agent queues */}
                  <div className="grid gap-2 pt-1">
                    <QueueLaneBlock
                      title={`Outreach (${outreach.length})`}
                      hint="Calling / Auto Mode uses this list only."
                      tasks={outreach}
                      selected={selected}
                      moving={moving}
                      onToggle={(id) => toggleSelect(p.id, id)}
                      onSelectAll={(on) => selectAllInLane(p.id, "outreach", on)}
                      onMoveOne={(id) => void setLane(id, "data_update")}
                      moveLabel="→ Data Update"
                      onBulkMove={() => void moveSelected(p.id, "data_update")}
                      bulkLabel="Move selected → Data Update"
                    />
                    <QueueLaneBlock
                      title={`Data Update (${dataUpdate.length})`}
                      hint="Autopilot research — empty fields only. Same agent."
                      tasks={dataUpdate}
                      selected={selected}
                      moving={moving}
                      accent
                      onToggle={(id) => toggleSelect(p.id, id)}
                      onSelectAll={(on) => selectAllInLane(p.id, "data_update", on)}
                      onMoveOne={(id) => void setLane(id, "outreach")}
                      moveLabel="→ Outreach"
                      onBulkMove={() => void moveSelected(p.id, "outreach")}
                      bulkLabel="Move selected → Outreach"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QueueLaneBlock({
  title,
  hint,
  tasks,
  selected,
  moving,
  accent,
  onToggle,
  onSelectAll,
  onMoveOne,
  moveLabel,
  onBulkMove,
  bulkLabel,
}: {
  title: string;
  hint: string;
  tasks: AiSalesAgentTask[];
  selected: Set<number>;
  moving: boolean;
  accent?: boolean;
  onToggle: (id: number) => void;
  onSelectAll: (on: boolean) => void;
  onMoveOne: (id: number) => void;
  moveLabel: string;
  onBulkMove: () => void;
  bulkLabel: string;
}) {
  const allSelected = tasks.length > 0 && tasks.every((t) => selected.has(t.id));
  const someSelected = tasks.some((t) => selected.has(t.id));
  return (
    <div
      className={`rounded-md border p-2 ${
        accent ? "border-cyan-700/40 bg-cyan-950/20" : "border-slate-800 bg-slate-950/40"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <div>
          <h5 className="text-xs font-semibold text-slate-100">{title}</h5>
          <p className="text-[10px] text-slate-500">{hint}</p>
        </div>
        {tasks.length > 0 ? (
          <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              className="accent-cyan-500"
              checked={allSelected}
              onChange={(e) => onSelectAll(e.target.checked)}
            />
            Select all
          </label>
        ) : null}
      </div>
      <ul className="space-y-1 max-h-40 overflow-y-auto text-xs">
        {tasks.length === 0 ? (
          <li className="text-slate-600 px-1 py-1">Empty</li>
        ) : (
          tasks.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-2 rounded border border-slate-800/80 px-2 py-1.5"
            >
              <input
                type="checkbox"
                className="accent-cyan-500 shrink-0"
                checked={selected.has(t.id)}
                onChange={() => onToggle(t.id)}
              />
              <span className="text-slate-200 truncate flex-1 min-w-0">
                {t.company_name || t.contact_name || `#${t.buyer_id}`}
              </span>
              <button
                type="button"
                disabled={moving}
                onClick={() => onMoveOne(t.id)}
                className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-40"
              >
                {moveLabel}
              </button>
            </li>
          ))
        )}
      </ul>
      {someSelected ? (
        <button
          type="button"
          disabled={moving}
          onClick={onBulkMove}
          className="mt-2 w-full text-[11px] px-2 py-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-40"
        >
          {bulkLabel} ({[...selected].filter((id) => tasks.some((t) => t.id === id)).length})
        </button>
      ) : null}
    </div>
  );
}
