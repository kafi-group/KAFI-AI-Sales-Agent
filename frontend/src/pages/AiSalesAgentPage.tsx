import { useCallback, useEffect, useState } from "react";
import {
  client,
  setAiSalesAgentAccessCode,
  getAiSalesAgentAccessCode,
  sanitizeUserFacingError,
  isTransientApiError,
  type AiSalesAgentRunner,
  type AiSalesAgentTask,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";

interface AiSalesAgentPageProps {
  onError: (message: string) => void;
}

const PERSONA_LABELS: Record<string, string> = {
  male: "Rayan (male)",
  female: "Sara (female)",
};

export function AiSalesAgentPage({ onError }: AiSalesAgentPageProps) {
  const { isAdmin, user } = useAuth();
  const [unlocked, setUnlocked] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [runners, setRunners] = useState<AiSalesAgentRunner[]>([]);
  const [tasks, setTasks] = useState<AiSalesAgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [assignPersona, setAssignPersona] = useState<"male" | "female">("female");
  const [buyerIdsRaw, setBuyerIdsRaw] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [filterPersona, setFilterPersona] = useState<string>("");
  const [selfTestPhone, setSelfTestPhone] = useState("");
  const [selfTestName, setSelfTestName] = useState("");
  const [selfTestPersona, setSelfTestPersona] = useState<"male" | "female">("female");
  const [selfTesting, setSelfTesting] = useState(false);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);

  useEffect(() => {
    setUnlocked(Boolean(getAiSalesAgentAccessCode()));
  }, []);

  useEffect(() => {
    if (user?.full_name && !selfTestName) {
      setSelfTestName(user.full_name);
    }
  }, [user?.full_name, selfTestName]);

  const load = useCallback(async () => {
    if (!getAiSalesAgentAccessCode()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [runnerRes, taskRes] = await Promise.all([
        client.listAiSalesAgentRunners(),
        client.listAiSalesAgentTasks({
          persona: filterPersona || undefined,
          limit: 200,
        }),
      ]);
      setRunners(runnerRes.runners);
      setTasks(taskRes.tasks);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load AI Sales Agent");
    } finally {
      setLoading(false);
    }
  }, [filterPersona, onError]);

  useEffect(() => {
    if (!unlocked) return;
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load, unlocked]);

  async function tryUnlock() {
    const code = codeInput.trim();
    if (!code) return;
    setUnlocking(true);
    setUnlockError(null);
    const retryDelaysMs = [0, 900, 2_200];
    let lastMessage = "Invalid access code";
    try {
      for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
        if (retryDelaysMs[attempt] > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, retryDelaysMs[attempt]));
        }
        try {
          await client.unlockAiSalesAgent(code);
          setAiSalesAgentAccessCode(code);
          setUnlocked(true);
          setCodeInput("");
          setUnlockError(null);
          return;
        } catch (e) {
          const raw = e instanceof Error ? e.message : "Invalid access code";
          lastMessage = sanitizeUserFacingError(raw);
          const wrongCode = /invalid access code|403/i.test(raw);
          if (wrongCode || !isTransientApiError(raw)) break;
        }
      }
      setUnlockError(lastMessage);
      onError(lastMessage);
    } finally {
      setUnlocking(false);
    }
  }

  async function handleSelfTest() {
    const phone = selfTestPhone.trim();
    if (!phone) {
      onError("Enter your mobile number in international format, e.g. +923001234567");
      return;
    }
    setSelfTesting(true);
    try {
      const result = await client.queueAiSalesAgentSelfTest({
        persona: selfTestPersona,
        phone,
        contact_name: selfTestName.trim() || undefined,
      });
      setFilterPersona(selfTestPersona);
      setQueueNotice(
        `Queued test call to ${phone} as ${selfTestPersona === "female" ? "Sara" : "Rayan"}. ` +
          "Click Start calling below when ready.",
      );
      setTimeout(() => setQueueNotice(null), 10000);
      await load();
      if (result.task?.contact_phone) {
        setSelfTestPhone(result.task.contact_phone);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Self-test queue failed");
    } finally {
      setSelfTesting(false);
    }
  }

  async function handleAssign() {
    const ids = buyerIdsRaw
      .split(/[\s,;]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) {
      onError("Enter one or more buyer IDs from the Master table.");
      return;
    }
    setAssigning(true);
    try {
      await client.assignAiSalesAgentTasks({
        persona: assignPersona,
        buyer_ids: ids,
      });
      setBuyerIdsRaw("");
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Assign failed");
    } finally {
      setAssigning(false);
    }
  }

  async function handleRunnerAction(
    persona: string,
    action: "start" | "pause",
  ) {
    try {
      if (action === "start") {
        await client.startAiSalesAgentRunner(persona);
      } else {
        await client.pauseAiSalesAgentRunner(persona);
      }
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Runner action failed");
    }
  }

  async function handleSkip(taskId: number) {
    try {
      await client.skipAiSalesAgentTask(taskId);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Skip failed");
    }
  }

  async function handleRemove(taskId: number) {
    try {
      await client.deleteAiSalesAgentTask(taskId);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Remove failed");
    }
  }

  if (!unlocked) {
    return (
      <section className="max-w-md space-y-4">
        <div>
          <h2 className="text-lg font-medium text-slate-100">AI Sales Agent</h2>
          <p className="text-sm text-slate-400 mt-1">
            Enter the access code to open Rayan and Sara&apos;s outbound calling queue.
          </p>
        </div>
        {unlockError ? (
          <p className="text-sm text-red-400">{unlockError}</p>
        ) : null}
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={codeInput}
          onChange={(e) => setCodeInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void tryUnlock();
          }}
          placeholder="Access code"
          className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100"
        />
        <button
          type="button"
          disabled={unlocking || !codeInput.trim()}
          onClick={() => void tryUnlock()}
          className="px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40"
        >
          {unlocking ? "Checking… (may retry if API is restarting)" : "Unlock"}
        </button>
      </section>
    );
  }

  if (loading && !runners.length) {
    return <p className="text-sm text-slate-400 p-6">Loading AI Sales Agent…</p>;
  }

  return (
    <section className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-lg font-medium text-slate-100">AI Sales Agent</h2>
        <p className="text-sm text-slate-400 mt-1">
          Rayan and Sara dial the <strong className="text-slate-300">lead&apos;s contact phone</strong>{" "}
          from the Master Table — not your login name. Queue rows with{" "}
          <strong className="text-slate-300">Queue AI calls</strong>, unlock this page, filter by
          agent, then click <strong className="text-slate-300">Start calling</strong>.
        </p>
      </div>

      {queueNotice ? (
        <p className="text-sm text-emerald-300 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          {queueNotice}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {runners.map((runner) => (
          <div
            key={runner.persona}
            className="rounded-xl border border-slate-700/80 bg-slate-900/40 p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-medium text-slate-100">
                  {runner.display_name}{" "}
                  <span className="text-slate-500 text-sm">({runner.gender_label})</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Mailbox / KPI: {runner.app_username} · Voice: {runner.voice}
                </p>
              </div>
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  runner.status === "running"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : runner.status === "paused"
                      ? "bg-amber-500/20 text-amber-300"
                      : "bg-slate-700 text-slate-300"
                }`}
              >
                {runner.status}
              </span>
            </div>
            <p className="text-sm text-slate-400">
              {runner.pending_count} pending
              {runner.current_task?.company_name
                ? ` · Calling ${runner.current_task.company_name}`
                : ""}
            </p>
            {!runner.twilio_ready && (
              <p className="text-xs text-amber-400">
                Twilio webhooks not ready — check Railway TWILIO_* env vars.
              </p>
            )}
            {isAdmin && (
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!runner.twilio_ready || runner.status === "running"}
                  onClick={() => void handleRunnerAction(runner.persona, "start")}
                  className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white"
                >
                  Start calling
                </button>
                <button
                  type="button"
                  disabled={runner.status !== "running"}
                  onClick={() => void handleRunnerAction(runner.persona, "pause")}
                  className="px-3 py-1.5 text-sm rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  Pause
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {isAdmin && (
        <div className="rounded-xl border border-violet-500/40 bg-violet-500/5 p-4 space-y-3">
          <h3 className="font-medium text-slate-100">Test call to your phone</h3>
          <p className="text-xs text-slate-500">
            Fastest way to hear Sara or Rayan: enter your mobile here. Your name is what they
            will ask for on the call. Then click <strong className="text-slate-300">Start calling</strong>{" "}
            on the agent card above.
          </p>
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-sm text-slate-400">
              Agent
              <select
                value={selfTestPersona}
                onChange={(e) =>
                  setSelfTestPersona(e.target.value as "male" | "female")
                }
                className="mt-1 block w-full min-w-[140px] rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
              >
                <option value="female">Sara (female)</option>
                <option value="male">Rayan (male)</option>
              </select>
            </label>
            <label className="text-sm text-slate-400 flex-1 min-w-[160px]">
              Your name on the call
              <input
                value={selfTestName}
                onChange={(e) => setSelfTestName(e.target.value)}
                placeholder={user?.full_name || "Your name"}
                className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
              />
            </label>
            <label className="text-sm text-slate-400 flex-1 min-w-[180px]">
              Your mobile (E.164)
              <input
                value={selfTestPhone}
                onChange={(e) => setSelfTestPhone(e.target.value)}
                placeholder="+923001234567"
                className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
              />
            </label>
            <button
              type="button"
              disabled={selfTesting || !selfTestPhone.trim()}
              onClick={() => void handleSelfTest()}
              className="px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40"
            >
              {selfTesting ? "Queueing…" : "Queue test call"}
            </button>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="rounded-xl border border-slate-700/80 bg-slate-900/40 p-4 space-y-3">
          <h3 className="font-medium text-slate-100">Assign calls (optional)</h3>
          <p className="text-xs text-slate-500">
            Easiest: open <strong className="text-slate-300">Master Table</strong> or{" "}
            <strong className="text-slate-300">Old clients</strong>, select rows, then{" "}
            <strong className="text-slate-300">Queue AI calls → Rayan</strong> or{" "}
            <strong className="text-slate-300">Sara</strong>.{" "}
            <strong className="text-slate-300">Assign to</strong> is for human reps only. The{" "}
            <strong className="text-slate-300">#</strong> column is the lead ID if you paste here
            manually.
          </p>
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-sm text-slate-400">
              Agent
              <select
                value={assignPersona}
                onChange={(e) =>
                  setAssignPersona(e.target.value as "male" | "female")
                }
                className="mt-1 block w-full min-w-[140px] rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
              >
                <option value="male">Rayan (male)</option>
                <option value="female">Sara (female)</option>
              </select>
            </label>
            <label className="text-sm text-slate-400 flex-1 min-w-[200px]">
              Lead IDs from table # column (optional)
              <input
                value={buyerIdsRaw}
                onChange={(e) => setBuyerIdsRaw(e.target.value)}
                placeholder="e.g. 1204 1205 1206"
                className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
              />
            </label>
            <button
              type="button"
              disabled={assigning}
              onClick={() => void handleAssign()}
              className="px-4 py-2 text-sm rounded-lg bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40"
            >
              {assigning ? "Assigning…" : "Assign to queue"}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-medium text-slate-100">Task queue</h3>
          <select
            value={filterPersona}
            onChange={(e) => setFilterPersona(e.target.value)}
            className="text-sm rounded-lg border border-slate-600 bg-slate-950 px-2 py-1 text-slate-200"
          >
            <option value="">All agents</option>
            <option value="male">Rayan</option>
            <option value="female">Sara</option>
          </select>
          <button
            type="button"
            onClick={() => void load()}
            className="text-xs text-sky-400 hover:underline"
          >
            Refresh
          </button>
        </div>

        {!tasks.length ? (
          <p className="text-sm text-slate-500">
            No tasks in the queue yet. Use <strong className="text-slate-400">Test call to your phone</strong>{" "}
            above, or queue leads from Master Table → Queue AI calls.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-700/80">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-900/60 text-slate-400">
                <tr>
                  <th className="px-3 py-2">Agent</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Contact / phone</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Ready</th>
                  <th className="px-3 py-2">Outcome</th>
                  {isAdmin && <th className="px-3 py-2">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {tasks.map((task) => (
                  <tr key={task.id} className="text-slate-200">
                    <td className="px-3 py-2">
                      {PERSONA_LABELS[task.persona] ?? task.persona}
                    </td>
                    <td className="px-3 py-2">
                      {task.company_name ?? `#${task.buyer_id}`}
                      {task.country ? (
                        <span className="text-slate-500 text-xs ml-1">
                          ({task.country})
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {task.contact_name ?? "—"}
                      {task.contact_phone ? (
                        <div className="text-xs text-sky-300/90 font-mono">{task.contact_phone}</div>
                      ) : (
                        <div className="text-xs text-amber-400">No phone on lead</div>
                      )}
                    </td>
                    <td className="px-3 py-2 capitalize">{task.status}</td>
                    <td className="px-3 py-2">
                      {task.ready ? (
                        <span className="text-emerald-400 text-xs">Yes</span>
                      ) : (
                        <span
                          className="text-amber-400 text-xs"
                          title={(task.warnings ?? []).join("; ")}
                        >
                          Needs data
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400">
                      {task.outcome ?? "—"}
                    </td>
                    {isAdmin && (
                      <td className="px-3 py-2 space-x-2 whitespace-nowrap">
                        {task.status === "pending" && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleSkip(task.id)}
                              className="text-xs text-amber-400 hover:underline"
                            >
                              Skip
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleRemove(task.id)}
                              className="text-xs text-red-400 hover:underline"
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
