import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { client, type EmailAttachment, type PersonalizedFollowupDraft } from "../api/client";
import { useCallQueueOptional } from "../hooks/useCallQueue";
import { useTwilioVoice } from "../hooks/useTwilioVoice";
import { type CallOutcome, callOutcomeSectionHint } from "../utils/callOutcomes";
import { deriveWhatsAppFromEmail } from "../utils/channelSync";
import { autocorrectText } from "../utils/spelling";
import { CallRemarksForm } from "./CallRemarksForm";
import { EmailAttachmentsField } from "./EmailAttachmentsField";
import { TryAnotherNumberButtons } from "./TryAnotherNumberButtons";
import { ActionButton } from "./ui/ActionButton";
import { IconWhatsApp, IconX } from "./icons/AppIcons";

interface PostCallRemarksModalProps {
  onError: (message: string) => void;
  onSaved?: (outcome: string | null | undefined) => void;
}

export function PostCallRemarksModal({ onError, onSaved }: PostCallRemarksModalProps) {
  const { pendingFollowUp, clearPendingFollowUp, clearLeadDialSession, bulkModeActive } =
    useTwilioVoice();
  const callQueue = useCallQueueOptional();
  const bulkOwnsFollowUp =
    bulkModeActive &&
    callQueue != null &&
    (callQueue.status === "running" || callQueue.status === "between");
  const [remarks, setRemarks] = useState("");
  const [outcome, setOutcome] = useState<CallOutcome | "">("");
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<PersonalizedFollowupDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [sendingChannel, setSendingChannel] = useState<string | null>(null);
  const [step, setStep] = useState<"remarks" | "confirm">("remarks");
  const [subject, setSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingFollowUp) return;
    setRemarks("");
    setOutcome("");
    setDraft(null);
    setSubject("");
    setEmailBody("");
    setAttachments([]);
    setDraftNotice(null);
    setStep("remarks");
  }, [pendingFollowUp]);

  useEffect(() => {
    if (!draft) return;
    setSubject(draft.subject || "");
    setEmailBody(draft.email_body || draft.whatsapp_body || "");
    setAttachments([]);
  }, [draft?.id]);

  if (!pendingFollowUp || bulkOwnsFollowUp) return null;

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
      clearLeadDialSession();
      void loadDraft(pendingFollowUp.interactionId);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save call remarks");
    } finally {
      setSaving(false);
    }
  }

  async function saveDraftEdits(showNotice = true) {
    if (!draft) return false;
    setSavingDraft(true);
    setDraftNotice(null);
    try {
      const updated = await client.updatePersonalizedFollowup(draft.id, {
        subject,
        email_body: emailBody,
      });
      setDraft(updated);
      setSubject(updated.subject || subject);
      setEmailBody(updated.email_body || emailBody);
      if (showNotice) {
        setDraftNotice("Draft saved. WhatsApp will mirror the email text when sent.");
      }
      return true;
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save draft");
      return false;
    } finally {
      setSavingDraft(false);
    }
  }

  async function sendDraft(channels: "email" | "whatsapp" | "whatsapp_personal" | "all") {
    if (!draft) return;
    setSendingChannel(channels);
    setDraftNotice(null);
    try {
      const saved = await saveDraftEdits(false);
      if (!saved) return;
      const result = await client.sendPersonalizedFollowup(draft.id, {
        channels,
        attachments: channels === "email" || channels === "all" ? attachments : undefined,
      });
      setDraft(result.draft);
      setDraftNotice(result.message);
      if (result.email_sent || result.whatsapp_sent) {
        clearLeadDialSession();
        window.setTimeout(() => clearPendingFollowUp(), 1200);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send confirmation");
    } finally {
      setSendingChannel(null);
    }
  }

  function dismiss() {
    clearLeadDialSession();
    clearPendingFollowUp();
  }

  const whatsappPreview = deriveWhatsAppFromEmail(emailBody);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60">
      <div
        className="w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-5 space-y-4"
        role="dialog"
        aria-labelledby="post-call-title"
      >
        <div>
          <h3 id="post-call-title" className="text-lg font-medium text-slate-100">
            {step === "confirm" ? "Review & send confirmation" : "Call finished"}
          </h3>
          <p className="text-sm text-slate-400 mt-1">
            {step === "confirm" ? (
              <>
                Edit the message, attach files for email, then send to{" "}
                <span className="text-slate-200">{pendingFollowUp.label}</span>.
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
            {pendingFollowUp.buyerId ? (
              <TryAnotherNumberButtons
                buyerId={pendingFollowUp.buyerId}
                triedPhones={pendingFollowUp.triedPhones ?? []}
                onError={onError}
                disabled={saving}
              />
            ) : null}
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
            ) : draft?.status === "ready" || draft?.status === "sent" ? (
              <div className="space-y-4">
                {draft.call_context_label ? (
                  <p className="text-xs text-slate-400">
                    Draft tone:{" "}
                    <span className="text-slate-200">{draft.call_context_label}</span>
                  </p>
                ) : null}
                {draft.call_context &&
                ["voicemail_or_no_answer", "brief_or_unclear"].includes(draft.call_context) &&
                /\b(as per our (call|conversation|discussion)|following our call|thank you for speaking with us today)\b/i.test(
                  emailBody,
                ) ? (
                  <p className="text-xs text-amber-200/95 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                    This draft assumes a live conversation, but the call was voicemail or could
                    not connect. Edit the text before sending.
                  </p>
                ) : null}
                <label className="block">
                  <span className="text-xs text-slate-400">Email subject</span>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-400">Email message</span>
                  <textarea
                    rows={8}
                    value={emailBody}
                    onChange={(e) => setEmailBody(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
                  />
                </label>
                <EmailAttachmentsField
                  attachments={attachments}
                  onChange={setAttachments}
                  disabled={Boolean(sendingChannel) || savingDraft}
                  label="Email attachments"
                  hint="Optional — PDF, images, Excel, etc. Included when you send email."
                />
                <label className="block">
                  <span className="text-xs text-slate-400">WhatsApp preview (auto-synced from email)</span>
                  <textarea
                    readOnly
                    rows={4}
                    value={whatsappPreview}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-400"
                  />
                </label>
                {draftNotice ? (
                  <p className="text-sm text-emerald-300/90">{draftNotice}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={Boolean(sendingChannel) || savingDraft}
                    onClick={() => void saveDraftEdits()}
                    className="rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-3 py-2 text-sm font-medium text-slate-100"
                  >
                    {savingDraft ? "Saving…" : "Save draft"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(sendingChannel) || savingDraft}
                    onClick={() => void sendDraft("email")}
                    className="rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                  >
                    {sendingChannel === "email" ? "Sending…" : "Send email"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(sendingChannel) || savingDraft}
                    onClick={() => void sendDraft("whatsapp")}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                  >
                    <IconWhatsApp size="xs" className="text-white" />
                    {sendingChannel === "whatsapp" ? "Sending…" : "WhatsApp Meta"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(sendingChannel) || savingDraft}
                    onClick={() => void sendDraft("whatsapp_personal")}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                  >
                    <IconWhatsApp size="xs" className="text-white" />
                    {sendingChannel === "whatsapp_personal" ? "Sending…" : "WhatsApp Personal"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(sendingChannel) || savingDraft}
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
                  "Draft is still generating — open Emails → Personalized emails in a moment."}
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
