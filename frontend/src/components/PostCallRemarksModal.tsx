import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { client, type PersonalizedFollowupDraft } from "../api/client";
import { useTwilioVoice } from "../hooks/useTwilioVoice";
import { type CallOutcome, callOutcomeSectionHint } from "../utils/callOutcomes";
import { autocorrectText } from "../utils/spelling";
import { CallRemarksForm } from "./CallRemarksForm";
import { ActionButton } from "./ui/ActionButton";
import { IconX } from "./icons/AppIcons";

interface PostCallRemarksModalProps {
  onError: (message: string) => void;
  onSaved?: (outcome: string | null | undefined) => void;
}

export function PostCallRemarksModal({ onError, onSaved }: PostCallRemarksModalProps) {
  const { pendingFollowUp, clearPendingFollowUp, bulkModeActive } = useTwilioVoice();
  const [remarks, setRemarks] = useState("");
  const [outcome, setOutcome] = useState<CallOutcome | "">("");
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<PersonalizedFollowupDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [sendingChannel, setSendingChannel] = useState<string | null>(null);
  const [step, setStep] = useState<"remarks" | "confirm">("remarks");

  useEffect(() => {
    if (!pendingFollowUp) return;
    setRemarks("");
    setOutcome("");
    setDraft(null);
    setStep("remarks");
  }, [pendingFollowUp]);

  if (!pendingFollowUp || bulkModeActive) return null;

  async function loadDraft(interactionId: number, attempt = 0) {
    setDraftLoading(true);
    try {
      const row = await client.getPersonalizedFollowupByInteraction(interactionId);
      setDraft(row);
      setStep("confirm");
      return;
    } catch {
      if (attempt < 4) {
        window.setTimeout(() => void loadDraft(interactionId, attempt + 1), 800);
        return;
      }
      setStep("confirm");
    } finally {
      setDraftLoading(false);
    }
  }

  async function saveRemarks() {
    if (!pendingFollowUp) return;
    setSaving(true);
    try {
      await client.updateCallFollowUp(pendingFollowUp.interactionId, {
        notes: autocorrectText(remarks, "prose"),
        call_outcome: outcome || null,
      });
      onSaved?.(outcome || null);
      void loadDraft(pendingFollowUp.interactionId);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save call remarks");
    } finally {
      setSaving(false);
    }
  }

  async function sendDraft(channels: "email" | "whatsapp" | "whatsapp_personal" | "all") {
    if (!draft) return;
    setSendingChannel(channels);
    try {
      await client.sendPersonalizedFollowup(draft.id, { channels });
      clearPendingFollowUp();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send confirmation");
    } finally {
      setSendingChannel(null);
    }
  }

  function dismiss() {
    clearPendingFollowUp();
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60">
      <div
        className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4"
        role="dialog"
        aria-labelledby="post-call-title"
      >
        <div>
          <h3 id="post-call-title" className="text-lg font-medium text-slate-100">
            {step === "confirm" ? "Call confirmation ready" : "Call finished"}
          </h3>
          <p className="text-sm text-slate-400 mt-1">
            {step === "confirm" ? (
              <>
                Email and WhatsApp drafts for{" "}
                <span className="text-slate-200">{pendingFollowUp.label}</span> — review and send
                with one click.
              </>
            ) : (
              <>
                Add remarks and label the outcome for{" "}
                <span className="text-slate-200">{pendingFollowUp.label}</span>.
                {callOutcomeSectionHint(outcome) ? (
                  <span className="block mt-1 text-emerald-300/90">
                    {callOutcomeSectionHint(outcome)}
                  </span>
                ) : null}
              </>
            )}
          </p>
        </div>

        {step === "remarks" ? (
          <>
            <CallRemarksForm
              remarks={remarks}
              outcome={outcome}
              onRemarksChange={setRemarks}
              onOutcomeChange={setOutcome}
              onSave={() => void saveRemarks()}
              saving={saving}
              saveLabel="Save & prepare confirmation"
              compact
            />
            <ActionButton
              icon={IconX}
              variant="ghost"
              onClick={dismiss}
              title="Skip for now"
              className="text-slate-400"
            >
              Skip for now
            </ActionButton>
          </>
        ) : (
          <>
            {draftLoading ? (
              <p className="text-sm text-slate-400 animate-pulse">Preparing email & WhatsApp drafts…</p>
            ) : draft?.status === "ready" ? (
              <div className="space-y-4">
                <label className="block">
                  <span className="text-xs text-slate-400">Email subject</span>
                  <input
                    readOnly
                    value={draft.subject || ""}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-400">Message (email & WhatsApp)</span>
                  <textarea
                    readOnly
                    rows={8}
                    value={draft.email_body || draft.whatsapp_body || ""}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={Boolean(sendingChannel)}
                    onClick={() => void sendDraft("email")}
                    className="rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                  >
                    {sendingChannel === "email" ? "Sending…" : "Send email"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(sendingChannel)}
                    onClick={() => void sendDraft("whatsapp")}
                    className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                  >
                    {sendingChannel === "whatsapp" ? "Sending…" : "WhatsApp Meta"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(sendingChannel)}
                    onClick={() => void sendDraft("whatsapp_personal")}
                    className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                  >
                    {sendingChannel === "whatsapp_personal" ? "Sending…" : "WhatsApp Personal"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(sendingChannel)}
                    onClick={() => void sendDraft("all")}
                    className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                  >
                    {sendingChannel === "all" ? "Sending…" : "Send all 3"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-amber-200/90">
                {draft?.generation_error ||
                  "Draft is still generating — open AI Mode → Personalized emails in a moment."}
              </p>
            )}
            <ActionButton
              icon={IconX}
              variant="ghost"
              onClick={dismiss}
              title="Close"
              className="text-slate-400"
            >
              Close
            </ActionButton>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
