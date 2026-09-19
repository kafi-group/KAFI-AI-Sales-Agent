import { useCallback, useEffect, useState } from "react";
import {
  client,
  setAiSalesAgentAccessCode,
  getAiSalesAgentAccessCode,
  sanitizeUserFacingError,
  isTransientApiError,
  type AiSalesAgentRunner,
  type AiSalesAgentTask,
  type DialableContactSuggestion,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { AiSalesAgentQueuePicker } from "../components/AiSalesAgentQueuePicker";
import {
  LeadWhatsAppComposeModal,
  type WhatsAppComposeTarget,
} from "../components/WhatsAppComposeLink";
import {
  LeadTelegramComposeModal,
  type TelegramComposeTarget,
} from "../components/TelegramComposeLink";
import { ComposeMailModal } from "../components/ComposeMailModal";
import { AiAutoModePanel } from "../components/AiAutoModePanel";
import { AiSalesProcessesPanel } from "../components/AiSalesProcessesPanel";

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
  const [callingTaskId, setCallingTaskId] = useState<number | null>(null);
  const [startingAutoPersona, setStartingAutoPersona] = useState<"female" | "male" | null>(null);
  const [whatsAppModalTarget, setWhatsAppModalTarget] = useState<WhatsAppComposeTarget | null>(null);
  const [telegramModalTarget, setTelegramModalTarget] = useState<TelegramComposeTarget | null>(null);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailModalInitial, setEmailModalInitial] = useState<{ to: string; subject: string } | null>(null);
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

  function followupNotice(prefix: string, followup?: AiSalesAgentTask["followup"] | null) {
    if (!followup) return prefix;
    const waBit =
      followup.whatsapp_status === "sent"
        ? " WhatsApp sent."
        : followup.whatsapp_message
          ? ` WhatsApp: ${followup.whatsapp_message}`
          : "";
    const emailBit =
      followup.email_status === "sent"
        ? ` Email sent${followup.email_to ? ` to ${followup.email_to}` : ""}.`
        : followup.email_message
          ? ` Email: ${followup.email_message}`
          : "";
    return `${prefix}${waBit}${emailBit}`;
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
        dial_now: false,
      });
      setFilterPersona(selfTestPersona);
      setQueueNotice(
        `Queued test call to ${phone} as ${selfTestPersona === "female" ? "Sara" : "Rayan"}. ` +
          "Use Call this number in the queue, or Start calling (all in sequence).",
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
      await client.queueAiSalesAgentSelfTest({
        persona: selfTestPersona,
        phone,
        contact_name: selfTestName.trim() || undefined,
        language: selfTestLanguage,
        dial_now: true,
      });
      const agentName = selfTestPersona === "female" ? "Sara" : "Rayan";
      setQueueNotice(
        `📞 ${agentName} is calling ${phone} now. When the call ends, WhatsApp and email are sent automatically — including a missed-call email if no one picks up.`,
      );
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
      const result = await client.assignAiSalesAgentTasks({
        persona: assignPersona,
        buyer_ids: ids,
      });
      setBuyerIdsRaw("");
      setQueueNotice(`Added ${result.tasks.length} contact(s) to the queue.`);
      setTimeout(() => setQueueNotice(null), 8000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Assign failed");
    } finally {
      setAssigning(false);
    }
  }

  async function handleAssignContacts(contacts: DialableContactSuggestion[]) {
    if (!contacts.length) {
      onError("Tick at least one contact from the Master Table list.");
      return;
    }
    setAssigning(true);
    try {
      const result = await client.assignAiSalesAgentTasks({
        persona: assignPersona,
        buyer_ids: contacts.map((row) => row.buyer_id),
        contact_ids: contacts.map((row) => row.contact_id),
      });
      setFilterPersona(assignPersona);
      setQueueNotice(
        `Added ${result.tasks.length} Master Table contact(s) to ${
          assignPersona === "female" ? "Sara" : "Rayan"
        }'s queue.`,
      );
      setTimeout(() => setQueueNotice(null), 8000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not add contacts to the queue");
    } finally {
      setAssigning(false);
    }
  }

  async function handleAutoModeStart(persona: "female" | "male") {
    setStartingAutoPersona(persona);
    try {
      await client.startAiSalesAgentRunner(persona, { sequence: true });
      const name = persona === "female" ? "Sara" : "Rayan";
      setQueueNotice(
        `${name} started with AI Auto Mode actions on the queue. Check the Sara / Rayan pipeline below.`,
      );
      setTimeout(() => setQueueNotice(null), 10000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not start agent");
    } finally {
      setStartingAutoPersona(null);
    }
  }

  async function handleCallOne(task: AiSalesAgentTask) {
    setCallingTaskId(task.id);
    try {
      await client.startAiSalesAgentRunner(task.persona, {
        task_id: task.id,
        sequence: false,
      });
      const agentName = task.persona === "female" ? "Sara" : "Rayan";
      setQueueNotice(
        `${agentName} is calling ${task.contact_name || task.company_name || "this number"} now. Follow-up WhatsApp and email send automatically when the call ends.`,
      );
      setTimeout(() => setQueueNotice(null), 12000);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not start this call");
    } finally {
      setCallingTaskId(null);
    }
  }

  async function handleRunnerAction(
    persona: string,
    action: "start" | "pause",
  ) {
    try {
      if (action === "start") {
        await client.startAiSalesAgentRunner(persona, { sequence: true });
        const agentName = persona === "female" ? "Sara" : "Rayan";
        setQueueNotice(
          `${agentName} is calling the queue in sequence. After each call, WhatsApp and email are sent automatically (missed-call email if no pickup), then the next number is dialed.`,
        );
        setTimeout(() => setQueueNotice(null), 14000);
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
      setQueueNotice(followupNotice("Call ended.", res.followup || res.task?.followup));
      setTimeout(() => setQueueNotice(null), 12000);
      await load();
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

  function openTelegramForTask(task: AiSalesAgentTask) {
    if (!task.contact_phone) {
      onError("No phone number available for this contact.");
      return;
    }
    setTelegramModalTarget({
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

  if (!unlocked) {
    return (
      <section className="max-w-3xl space-y-5">
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
          className="w-full max-w-md rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100"
        />
        <button
          type="button"
          disabled={unlocking || !codeInput.trim()}
          onClick={() => void tryUnlock()}
          className="px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40"
        >
          {unlocking ? "Checking… (may retry if API is restarting)" : "Unlock"}
        </button>

        {isAdmin ? (
          <div className="pt-2 space-y-2">
            <p className="text-xs text-slate-500">
              Configure Auto Mode below (saved even before unlock). Training lives under{" "}
              <strong className="text-slate-300">Call Center → AI Train</strong>.
            </p>
            <AiAutoModePanel onError={onError} compact />
          </div>
        ) : null}
      </section>
    );
  }

  if (loading && !runners.length) {
    return <p className="text-sm text-slate-400 p-6">Loading AI Sales Agent…</p>;
  }

  return (
    <section className="space-y-6 w-full min-w-0">
      <div>
        <h2 className="text-lg font-medium text-slate-100">AI Sales Agent</h2>
        <p className="text-sm text-slate-400 mt-1">
          Rayan and Sara dial leads from the <strong className="text-slate-300">Master Table</strong>.
          Filter by country, grade, and designation, tick contacts into the queue, then call one
          number or the full sequence. Use <strong className="text-slate-300">AI Auto Mode</strong>{" "}
          below to choose call / email / WhatsApp behaviour. Training is under{" "}
          <strong className="text-slate-300">Call Center → AI Train</strong>.
        </p>
      </div>

      <AiAutoModePanel
        onError={onError}
        onStartAgent={(persona) => void handleAutoModeStart(persona)}
        startingPersona={startingAutoPersona}
      />

      <AiSalesProcessesPanel onError={onError} />

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
              {runner.sequence_mode && runner.status === "running" ? " · sequence" : ""}
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
                  disabled={
                    !runner.twilio_ready ||
                    runner.status === "running" ||
                    runner.pending_count === 0
                  }
                  onClick={() => void handleRunnerAction(runner.persona, "start")}
                  className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium"
                >
                  Start calling (all in sequence)
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
            Fastest way to hear Sara or Rayan: enter your mobile here. When the call ends they
            send WhatsApp and email automatically (a missed-call note if you do not pick up).
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
                <option value="ja">🇯🇵 Japanese (日本語)</option>
                <option value="fil">🇵🇭 Filipino / Tagalog</option>
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

      {isAdmin && (
        <div className="rounded-xl border border-cyan-500/30 bg-slate-900/40 p-4 space-y-3">
          <h3 className="font-medium text-slate-100">Add contacts to queue</h3>
          <p className="text-xs text-slate-500">
            Contacts come from the <strong className="text-slate-300">Master Table</strong>. Choose
            country, grade, and designation first so the searchable list shrinks, then tick names
            and add them. Sara or Rayan can then call one number or the whole queue in sequence.
            After each call they send WhatsApp and email themselves — they do not ask you to draft.
          </p>
          <AiSalesAgentQueuePicker
            persona={assignPersona}
            onPersonaChange={setAssignPersona}
            assigning={assigning}
            onAssign={(contacts) => void handleAssignContacts(contacts)}
          />
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
              Or paste Master Table lead IDs
            </summary>
            <div className="flex flex-wrap gap-3 items-end mt-3">
              <label className="text-sm text-slate-400 flex-1 min-w-[200px]">
                Lead IDs from table # column
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
                className="px-4 py-2 text-sm rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              >
                {assigning ? "Assigning…" : "Assign IDs to queue"}
              </button>
            </div>
          </details>
        </div>
      )}

      <div className="rounded-xl border border-slate-700/80 bg-slate-900/40 p-4 text-sm text-slate-400">
        Sara &amp; Rayan training (playbook, ticked calls, Gemini) moved to{" "}
        <strong className="text-slate-200">Call Center → AI Train</strong>.
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-medium text-slate-100">Sara / Rayan pipeline</h3>
          <p className="w-full text-xs text-slate-500">
            Contacts assigned from any Master list (or below) appear here — call, email, and WhatsApp
            status per row.
          </p>
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
            No tasks in the queue yet. Filter Master Table contacts above, tick names, and add them
            to Sara or Rayan.
          </p>
        ) : (
          <div className="rounded-xl border border-slate-700/80 overflow-hidden">
            <table className="w-full table-fixed text-sm text-left">
              <colgroup>
                <col className="w-[9%]" />
                <col className="w-[16%]" />
                <col className="w-[14%]" />
                <col className="w-[7%]" />
                <col className="w-[7%]" />
                <col className="w-[8%]" />
                <col className="w-[9%]" />
                <col className="w-[7%]" />
                <col className="w-[8%]" />
                <col className="w-[15%]" />
              </colgroup>
              <thead className="bg-slate-900/60 text-slate-400">
                <tr>
                  <th className="px-3 py-2.5 font-medium">Agent</th>
                  <th className="px-3 py-2.5 font-medium">Company</th>
                  <th className="px-3 py-2.5 font-medium">Contact / phone</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Call</th>
                  <th className="px-3 py-2.5 font-medium">Email sent</th>
                  <th className="px-3 py-2.5 font-medium">WhatsApp sent</th>
                  <th className="px-3 py-2.5 font-medium">Email reply</th>
                  <th className="px-3 py-2.5 font-medium">Outcome</th>
                  <th className="px-3 py-2.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {tasks.map((task) => (
                  <tr key={task.id} className="text-slate-200 align-top">
                    <td className="px-3 py-2.5">
                      {PERSONA_LABELS[task.persona] ?? task.persona}
                    </td>
                    <td className="px-3 py-2.5 break-words">
                      {task.company_name ?? `#${task.buyer_id}`}
                      {task.country ? (
                        <span className="text-slate-500 text-xs ml-1">
                          ({task.country})
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 break-words">
                      {task.contact_name ?? "—"}
                      {task.contact_phone ? (
                        <div className="text-xs text-sky-300/90 font-mono break-all">{task.contact_phone}</div>
                      ) : (
                        <div className="text-xs text-amber-400">No phone on lead</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 capitalize">{task.status}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {task.status === "completed" || task.status === "in_progress" || task.call_sid ? (
                        <span className="text-emerald-400">
                          {task.status === "in_progress" ? "In progress" : "Made"}
                        </span>
                      ) : task.ready === false ? (
                        <span className="text-amber-400" title={(task.warnings ?? []).join("; ")}>
                          Needs data
                        </span>
                      ) : (
                        <span className="text-slate-500">Queued</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {task.followup?.email_status === "sent" ||
                      task.followup?.email_status === "ok" ||
                      task.followup?.email_status === "success" ? (
                        <span className="text-emerald-400" title={task.followup?.email_to || ""}>
                          Sent
                        </span>
                      ) : task.followup?.email_status === "skipped" ? (
                        <span className="text-slate-500">Skipped</span>
                      ) : task.followup?.email_status ? (
                        <span className="text-amber-400">{task.followup.email_status}</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {task.followup?.whatsapp_status === "sent" ? (
                        <span className="text-emerald-400">Sent</span>
                      ) : task.followup?.whatsapp_status === "skipped" ? (
                        <span className="text-slate-500">Skipped</span>
                      ) : task.followup?.whatsapp_status === "not_connected" ? (
                        <span className="text-amber-400">WA offline</span>
                      ) : task.followup?.whatsapp_status ? (
                        <span className="text-amber-400">{task.followup.whatsapp_status}</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-500" title="Tracked when inbound email matching is wired">
                      —
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-400 break-words">
                      {task.outcome ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
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
                        {task.contact_phone && (
                          <button
                            type="button"
                            onClick={() => openTelegramForTask(task)}
                            className="px-2 py-1 rounded bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 text-xs font-semibold flex items-center gap-1 transition"
                            title={`Send Telegram message to ${task.contact_phone}`}
                          >
                            <span>✈️</span>
                            <span>Telegram</span>
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
                        {isAdmin && (task.status === "queued" || task.status === "pending") && (
                          <>
                            <button
                              type="button"
                              disabled={callingTaskId === task.id || !task.contact_phone}
                              onClick={() => void handleCallOne(task)}
                              className="px-2 py-1 rounded bg-violet-600/20 hover:bg-violet-600/30 text-violet-200 border border-violet-500/30 text-xs font-semibold disabled:opacity-40"
                              title="Call only this number"
                            >
                              {callingTaskId === task.id ? "Calling…" : "Call this"}
                            </button>
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

      {telegramModalTarget && (
        <LeadTelegramComposeModal
          target={telegramModalTarget}
          onClose={() => setTelegramModalTarget(null)}
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
