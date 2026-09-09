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
import {
  LeadWhatsAppComposeModal,
  type WhatsAppComposeTarget,
} from "../components/WhatsAppComposeLink";
import { ComposeMailModal } from "../components/ComposeMailModal";

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
  const [selfTestLanguage, setSelfTestLanguage] = useState<string>("en");
  const [selfTesting, setSelfTesting] = useState(false);
  const [endingCall, setEndingCall] = useState(false);
  const [postCallPrompt, setPostCallPrompt] = useState<AiSalesAgentTask | null>(null);
  const [whatsAppModalTarget, setWhatsAppModalTarget] = useState<WhatsAppComposeTarget | null>(null);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailModalInitial, setEmailModalInitial] = useState<{ to: string; subject: string } | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);

  // AI Agent Training & Knowledge Base State
  const [trainingData, setTrainingData] = useState<import("../api/client").AiTrainingData | null>(null);
  const [trainingLoading, setTrainingLoading] = useState(false);
  const [rulesDraft, setRulesDraft] = useState("");
  const [savingRules, setSavingRules] = useState(false);
  const [trainingNotice, setTrainingNotice] = useState<string | null>(null);

  const loadTraining = useCallback(async () => {
    try {
      const data = await client.getAiTrainingInfo();
      setTrainingData(data);
      setRulesDraft(data.custom_rules || "");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    setUnlocked(Boolean(getAiSalesAgentAccessCode()));
  }, []);

  useEffect(() => {
    if (unlocked) {
      void loadTraining();
    }
  }, [unlocked, loadTraining]);

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
        language: selfTestLanguage,
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

  async function handleDirectCall() {
    const phone = selfTestPhone.trim();
    if (!phone) {
      onError("Enter phone number in international format, e.g. +923001234567");
      return;
    }
    setSelfTesting(true);
    try {
      const result = await client.queueAiSalesAgentSelfTest({
        persona: selfTestPersona,
        phone,
        contact_name: selfTestName.trim() || undefined,
        language: selfTestLanguage,
      });
      await client.startAiSalesAgentRunner(selfTestPersona);
      const agentName = selfTestPersona === "female" ? "Sara" : "Rayan";
      const followup = result.followup;
      const waBit =
        followup?.whatsapp_status === "sent"
          ? " Personal WhatsApp sent."
          : followup?.whatsapp_message
            ? ` WhatsApp: ${followup.whatsapp_message}`
            : "";
      const emailBit =
        followup?.email_status === "sent"
          ? ` Email sent${followup.email_to ? ` to ${followup.email_to}` : ""}.`
          : followup?.email_message
            ? ` Email: ${followup.email_message}`
            : "";
      setQueueNotice(`📞 ${agentName} is calling ${phone} now.${waBit}${emailBit}`);
      setTimeout(() => setQueueNotice(null), 14000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Direct call failed");
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
        const runner = await client.startAiSalesAgentRunner(persona);
        const followup = runner.current_task?.followup;
        const agentName = persona === "female" ? "Sara" : "Rayan";
        if (followup) {
          const waBit =
            followup.whatsapp_status === "sent"
              ? " Personal WhatsApp sent."
              : followup.whatsapp_message
                ? ` WhatsApp: ${followup.whatsapp_message}`
                : "";
          const emailBit =
            followup.email_status === "sent"
              ? ` Email sent${followup.email_to ? ` to ${followup.email_to}` : ""}.`
              : followup.email_message
                ? ` Email: ${followup.email_message}`
                : "";
          setQueueNotice(`${agentName} started calling.${waBit}${emailBit}`);
          setTimeout(() => setQueueNotice(null), 14000);
        }
      } else {
        await client.pauseAiSalesAgentRunner(persona);
      }
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Runner action failed");
    }
  }

  async function handleEndCall(persona?: string) {
    setEndingCall(true);
    try {
      const res = await client.endAiSalesAgentCall({ persona });
      setQueueNotice("Call ended.");
      setTimeout(() => setQueueNotice(null), 5000);
      await load();
      if (res.task && res.task.contact_phone) {
        setPostCallPrompt(res.task);
      } else if (tasks.length > 0 && tasks[0].contact_phone) {
        setPostCallPrompt(tasks[0]);
      } else if (selfTestPhone.trim()) {
        setPostCallPrompt({
          id: 0,
          persona: (persona as any) || selfTestPersona,
          buyer_id: 0,
          contact_id: null,
          company_name: selfTestName.trim() || "Test Call",
          contact_name: selfTestName.trim() || "Test Lead",
          contact_phone: selfTestPhone.trim(),
          status: "completed",
          ready: true,
          outcome: "Ended",
        } as unknown as AiSalesAgentTask);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to end call");
    } finally {
      setEndingCall(false);
    }
  }

  function openWhatsAppForTask(task: AiSalesAgentTask) {
    if (!task.contact_phone) {
      onError("No phone number available for this contact.");
      return;
    }
    setWhatsAppModalTarget({
      phone: task.contact_phone,
      row: {
        id: task.buyer_id || 0,
        company_name: task.company_name || "Lead",
        country: task.country || null,
      } as unknown as any,
    });
  }

  function openEmailForTask(task: AiSalesAgentTask) {
    setEmailModalInitial({
      to: (task as any).contact_email || "",
      subject: `Follow-up from Kafi Commodities · ${task.company_name || ""}`,
    });
    setEmailModalOpen(true);
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

  async function handleTrainFromHistory() {
    setTrainingLoading(true);
    setTrainingNotice(null);
    try {
      const res = await client.trainAiFromHistory();
      setTrainingData(res);
      setTrainingNotice(`Successfully analyzed ${res.total_calls_analyzed} past calls! Training playbook updated for Sara & Rayan.`);
      setTimeout(() => setTrainingNotice(null), 5000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to train AI from history");
    } finally {
      setTrainingLoading(false);
    }
  }

  async function handleSaveRules() {
    setSavingRules(true);
    try {
      const res = await client.updateAiSalesRules(rulesDraft);
      setTrainingData(res);
      setTrainingNotice("Custom sales rules saved and applied to Sara & Rayan calls!");
      setTimeout(() => setTrainingNotice(null), 4000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save rules");
    } finally {
      setSavingRules(false);
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
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!runner.twilio_ready || runner.status === "running"}
                  onClick={() => void handleRunnerAction(runner.persona, "start")}
                  className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium"
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
                <button
                  type="button"
                  disabled={endingCall || (runner.status !== "running" && !runner.current_task)}
                  onClick={() => void handleEndCall(runner.persona)}
                  className="px-3 py-1.5 text-sm rounded-lg bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-40 font-medium flex items-center gap-1"
                  title="End current call immediately"
                >
                  <span>🔴 End call</span>
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
            will ask for on the call. Then click <strong className="text-slate-300">Call Now</strong>.
            When the call starts, Sara/Rayan also send a personal WhatsApp from your scanned
            session and an email if an address is on file.
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
            <label className="text-sm text-slate-400">
              Speaking Language
              <select
                value={selfTestLanguage}
                onChange={(e) => setSelfTestLanguage(e.target.value)}
                className="mt-1 block w-full min-w-[160px] rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100 font-medium"
              >
                <option value="en">🇺🇸 English (Default)</option>
                <option value="ur">🇵🇰 Urdu (اردو)</option>
                <option value="fr">🇫🇷 French (Français)</option>
                <option value="ar">🇸🇦 Arabic (العربية)</option>
                <option value="de">🇩🇪 German (Deutsch)</option>
                <option value="ru">🇷🇺 Russian (Русский)</option>
                <option value="zh">🇨🇳 Chinese (中文)</option>
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
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={selfTesting || !selfTestPhone.trim()}
                onClick={() => void handleDirectCall()}
                className="px-4 py-2 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-500 font-bold text-white shadow-md disabled:opacity-40 flex items-center gap-1.5"
                title="Initiate direct call to this phone number immediately"
              >
                <span>📞 Call Now</span>
              </button>
              <button
                type="button"
                disabled={endingCall}
                onClick={() => void handleEndCall(selfTestPersona)}
                className="px-3.5 py-2 text-sm rounded-lg bg-rose-600 hover:bg-rose-500 font-semibold text-white disabled:opacity-40 flex items-center gap-1.5"
                title="End active call immediately"
              >
                <span>🔴 End Call</span>
              </button>
              <button
                type="button"
                disabled={selfTesting || !selfTestPhone.trim()}
                onClick={() => void handleSelfTest()}
                className="px-3.5 py-2 text-sm rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              >
                {selfTesting ? "Queueing…" : "Queue test call"}
              </button>
            </div>
          </div>
        </div>
      )}

      {postCallPrompt && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/40 p-4 flex flex-wrap items-center justify-between gap-3 shadow-lg">
          <div>
            <p className="font-semibold text-emerald-200 flex items-center gap-2 text-sm">
              <span>📞</span>
              <span>
                Call with {postCallPrompt.contact_name || postCallPrompt.company_name} ({postCallPrompt.contact_phone}) ended.
              </span>
            </p>
            <p className="text-xs text-slate-300 mt-0.5">
              Send follow-up communication to this contact right now:
            </p>
          </div>
          <div className="flex items-center gap-2">
            {postCallPrompt.contact_phone && (
              <button
                type="button"
                onClick={() => openWhatsAppForTask(postCallPrompt)}
                className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 shadow"
              >
                <span>💬 Send WhatsApp</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => openEmailForTask(postCallPrompt)}
              className="px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold flex items-center gap-1.5 shadow"
            >
              <span>✉️ Send Email</span>
            </button>
            <button
              type="button"
              onClick={() => setPostCallPrompt(null)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-white text-xs"
            >
              Dismiss
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

      {/* 🧠 AI Agent Training & Sales Playbook Section */}
      <div className="rounded-xl border border-slate-700/80 bg-slate-900/40 p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-medium text-slate-100 flex items-center gap-2">
              <span>🧠 AI Agent Training & Sales Playbook</span>
              <span className="text-xs px-2 py-0.5 rounded bg-sky-500/10 border border-sky-500/30 text-sky-300 font-mono">
                Gemini RAG Engine
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Sara & Rayan analyze past sales call logs, transcripts, and objections to continuously improve their sales techniques.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleTrainFromHistory()}
            disabled={trainingLoading}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition-all flex items-center gap-2 shadow-lg shadow-emerald-950/40"
          >
            {trainingLoading ? (
              <>
                <span className="animate-spin">⚡</span>
                <span>Gemini Analyzing History…</span>
              </>
            ) : (
              <>
                <span>⚡ Auto-Train from Call History</span>
              </>
            )}
          </button>
        </div>

        {trainingNotice && (
          <p className="text-xs text-emerald-300 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
            {trainingNotice}
          </p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {/* Learned Insights Card */}
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Learned Insights (From Call History)
              </h4>
              {trainingData?.last_trained_at && (
                <span className="text-xs text-slate-500 font-mono">
                  {trainingData.total_calls_analyzed} calls analyzed
                </span>
              )}
            </div>
            <div className="text-xs text-slate-300 whitespace-pre-wrap leading-relaxed bg-slate-900/60 p-3 rounded-lg border border-slate-800/80 max-h-48 overflow-y-auto font-mono">
              {trainingData?.learned_insights || "Click 'Auto-Train' above to extract insights from past sales calls."}
            </div>
          </div>

          {/* Custom Sales Rules Editor */}
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 space-y-2 flex flex-col justify-between">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                Custom Sales Rules & Guidelines
              </h4>
              <textarea
                rows={4}
                value={rulesDraft}
                onChange={(e) => setRulesDraft(e.target.value)}
                placeholder="Type custom sales instructions for Sara & Rayan (e.g. Always pitch CNF price first, offer 1% discount on 100+ MT orders)..."
                className="w-full text-xs rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-slate-200 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none resize-none font-mono"
              />
            </div>
            <div className="flex items-center justify-between pt-1 border-t border-slate-800/60">
              <span className="text-xs text-slate-500">Injected into voice call prompts</span>
              <button
                type="button"
                onClick={() => void handleSaveRules()}
                disabled={savingRules}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50 transition-colors"
              >
                {savingRules ? "Saving…" : "Save Custom Rules"}
              </button>
            </div>
          </div>
        </div>
      </div>

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
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        {task.contact_phone && (
                          <button
                            type="button"
                            onClick={() => openWhatsAppForTask(task)}
                            className="px-2 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1 transition"
                            title={`Send WhatsApp message to ${task.contact_phone}`}
                          >
                            <span>💬</span>
                            <span>WhatsApp</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openEmailForTask(task)}
                          className="px-2 py-1 rounded bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 text-xs font-semibold flex items-center gap-1 transition"
                          title={`Send Email to ${task.company_name || "Lead"}`}
                        >
                          <span>✉️</span>
                          <span>Email</span>
                        </button>
                        {isAdmin && task.status === "pending" && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleSkip(task.id)}
                              className="text-xs text-amber-400 hover:underline px-1"
                            >
                              Skip
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleRemove(task.id)}
                              className="text-xs text-red-400 hover:underline px-1"
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {whatsAppModalTarget && (
        <LeadWhatsAppComposeModal
          target={whatsAppModalTarget}
          onClose={() => setWhatsAppModalTarget(null)}
          onError={onError}
          onSent={(msg) => {
            setQueueNotice(msg);
            setTimeout(() => setQueueNotice(null), 8000);
          }}
        />
      )}

      {emailModalOpen && (
        <ComposeMailModal
          fromEmail={(user as any)?.mailbox_email || "export@kafi-group.com"}
          initialDraft={
            emailModalInitial
              ? {
                  to_addrs: emailModalInitial.to,
                  subject: emailModalInitial.subject,
                }
              : null
          }
          onClose={() => {
            setEmailModalOpen(false);
            setEmailModalInitial(null);
          }}
          onError={onError}
          onSent={(msg) => {
            setQueueNotice(msg);
            setTimeout(() => setQueueNotice(null), 8000);
          }}
        />
      )}
    </section>
  );
}
