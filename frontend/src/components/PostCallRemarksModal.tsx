import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type EmailAttachment,
  type PersonalizedFollowupDraft,
  type WhatsAppTemplate,
} from "../api/client";
import { useCallQueueOptional } from "../hooks/useCallQueue";
import { useTwilioVoice } from "../hooks/useTwilioVoice";
import { type CallOutcome, callOutcomeSectionHint } from "../utils/callOutcomes";
import { deriveWhatsAppFromEmail } from "../utils/channelSync";
import { autocorrectText } from "../utils/spelling";
import { CallRemarksForm } from "./CallRemarksForm";
import { EmailAttachmentsField } from "./EmailAttachmentsField";
import { TryAnotherNumberButtons } from "./TryAnotherNumberButtons";
import { WhatsAppTemplatePicker } from "./WhatsAppTemplatePicker";
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
  const [waTemplates, setWaTemplates] = useState<WhatsAppTemplate[]>([]);
  const [waTemplatesLoading, setWaTemplatesLoading] = useState(false);
  const [waTemplateId, setWaTemplateId] = useState("");
  const [waTemplateSearch, setWaTemplateSearch] = useState("");
  const [waTemplateVariables, setWaTemplateVariables] = useState<string[]>([]);
  const [needsWaTemplate, setNeedsWaTemplate] = useState(false);
  const [selectedPhone, setSelectedPhone] = useState("");
  const [customPhone, setCustomPhone] = useState("");
  const [whatsappBody, setWhatsappBody] = useState("");
  const [waBodyCustomized, setWaBodyCustomized] = useState(false);

  useEffect(() => {
    if (!pendingFollowUp) return;
    setRemarks("");
    setOutcome("");
    setDraft(null);
    setSubject("");
    setEmailBody("");
    setWhatsappBody("");
    setWaBodyCustomized(false);
    setAttachments([]);
    setSelectedPhone("");
    setCustomPhone("");
    setDraftNotice(null);
    setStep("remarks");
    setWaTemplateId("");
    setWaTemplateSearch("");
    setWaTemplateVariables([]);
    setNeedsWaTemplate(false);
  }, [pendingFollowUp]);

  useEffect(() => {
    if (step !== "confirm") return;
    let cancelled = false;
    setWaTemplatesLoading(true);
    client
      .listWhatsAppTemplates(true)
      .then((rows) => {
        if (cancelled) return;
        setWaTemplates(rows);
        setWaTemplateId((current) => {
          if (current && rows.some((t) => String(t.id) === current)) return current;
          return rows.length > 0 ? String(rows[0].id) : "";
        });
      })
      .catch(() => {
        if (!cancelled) setWaTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setWaTemplatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const selectedWaTemplate = waTemplates.find((t) => String(t.id) === waTemplateId);

  useEffect(() => {
    const count = selectedWaTemplate?.variable_count ?? 0;
    setWaTemplateVariables((prev) => {
      if (prev.length === count) return prev;
      const next = Array(count).fill("");
      for (let i = 0; i < Math.min(prev.length, count); i += 1) {
        next[i] = prev[i];
      }
      return next;
    });
  }, [selectedWaTemplate?.id, selectedWaTemplate?.variable_count]);

  useEffect(() => {
    if (!draft) return;
    setSubject(draft.subject || "");
    const email = draft.email_body || "";
    setEmailBody(email);
    const wa = draft.whatsapp_body || deriveWhatsAppFromEmail(email);
    setWhatsappBody(wa);
    setWaBodyCustomized(Boolean(draft.whatsapp_body && draft.whatsapp_body !== deriveWhatsAppFromEmail(email)));
    setAttachments([]);
    if (draft.selected_phone) {
      setSelectedPhone(draft.selected_phone);
    } else if (draft.available_phones && draft.available_phones.length > 0) {
      setSelectedPhone(draft.available_phones[0].phone);
    } else if (draft.contact_phone) {
      setSelectedPhone(draft.contact_phone);
    }
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
        whatsapp_body: whatsappBody,
      });
      setDraft(updated);
      setSubject(updated.subject || subject);
      setEmailBody(updated.email_body || emailBody);
      setWhatsappBody(updated.whatsapp_body || whatsappBody);
      if (showNotice) {
        setDraftNotice("Draft saved successfully.");
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
    const wantsWaMeta = channels === "whatsapp" || channels === "all";
    if (wantsWaMeta && needsWaTemplate && !selectedWaTemplate) {
      onError("Select an approved Meta template for WhatsApp Business send.");
      return;
    }
    const useWaTemplate = wantsWaMeta && Boolean(selectedWaTemplate);
    setSendingChannel(channels);
    setDraftNotice(null);
    try {
      const saved = await saveDraftEdits(false);
      if (!saved) return;
      const result = await client.sendPersonalizedFollowup(draft.id, {
        channels,
        target_phone: selectedPhone.trim() || undefined,
        subject,
        email_body: emailBody,
        whatsapp_body: whatsappBody,
        attachments: channels === "email" || channels === "all" ? attachments : undefined,
        ...(useWaTemplate
          ? {
              template_name: selectedWaTemplate!.name,
              template_language: selectedWaTemplate!.language,
              template_variables: waTemplateVariables,
            }
          : {}),
      });
      setDraft(result.draft);
      const waFailedNeedsTemplate =
        result.needs_whatsapp_template ||
        (!result.whatsapp_sent &&
          channels !== "email" &&
          /template/i.test(result.message || result.draft.whatsapp_send_message || ""));
      if (waFailedNeedsTemplate) {
        setNeedsWaTemplate(true);
        setDraftNotice(
          result.email_sent
            ? "Email sent. Outside the 24h WhatsApp window — confirm the approved template below and send again."
            : "Outside the 24h WhatsApp window — select an approved template and send WhatsApp Meta again.",
        );
      } else {
        setNeedsWaTemplate(false);
        setDraftNotice(result.message);
        if (result.email_sent || result.whatsapp_sent) {
          clearLeadDialSession();
          window.setTimeout(() => clearPendingFollowUp(), 1200);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to send confirmation";
      if ((channels === "whatsapp" || channels === "all") && /template/i.test(message)) {
        setNeedsWaTemplate(true);
        setDraftNotice("Outside the 24h WhatsApp window — select an approved template and retry.");
      } else {
        onError(message);
      }
    } finally {
      setSendingChannel(null);
    }
  }

  function dismiss() {
    clearLeadDialSession();
    clearPendingFollowUp();
  }

  const availablePhones = draft?.available_phones || [];
  const selectedPhoneObj = availablePhones.find((p) => p.phone === selectedPhone);

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="post-call-title"
    >
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl space-y-4">
        <h3 id="post-call-title" className="text-lg font-medium text-slate-100">
          {step === "remarks"
            ? "Call remarks & outcome"
            : `Follow-up draft — ${draft?.company_name || "Lead"}`}
        </h3>

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
              saveLabel="Save & generate draft"
              compact
            />
            {outcome ? (
              <p className="text-xs text-slate-400">
                Next list:{" "}
                <span className="text-slate-200">{callOutcomeSectionHint(outcome)}</span>
              </p>
            ) : null}
            <ActionButton
              icon={IconX}
              variant="ghost"
              size="sm"
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
                    onChange={(e) => {
                      const val = e.target.value;
                      setEmailBody(val);
                      if (!waBodyCustomized) {
                        setWhatsappBody(deriveWhatsAppFromEmail(val));
                      }
                    }}
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

                {/* Target WhatsApp Recipient & Number Selector */}
                <div className="rounded-xl border border-slate-700/80 bg-slate-950/60 p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                      <IconWhatsApp size="sm" className="text-emerald-400" />
                      Target WhatsApp Recipient
                    </span>
                    {selectedPhoneObj && (
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                          selectedPhoneObj.is_landline
                            ? "bg-amber-950/70 text-amber-300 border border-amber-800/60"
                            : "bg-emerald-950/70 text-emerald-300 border border-emerald-800/60"
                        }`}
                      >
                        {selectedPhoneObj.is_landline ? "⚠️ Landline (No WhatsApp)" : "🟢 WhatsApp Mobile"}
                      </span>
                    )}
                  </div>

                  {availablePhones.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {availablePhones.map((p) => {
                        const isSelected = selectedPhone === p.phone;
                        return (
                          <label
                            key={p.phone}
                            onClick={() => {
                              setSelectedPhone(p.phone);
                              setCustomPhone("");
                            }}
                            className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-xs cursor-pointer transition ${
                              isSelected
                                ? "border-emerald-500 bg-emerald-950/30 text-slate-100 shadow-sm"
                                : "border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700"
                            }`}
                          >
                            <input
                              type="radio"
                              name="target_phone"
                              checked={isSelected}
                              onChange={() => {
                                setSelectedPhone(p.phone);
                                setCustomPhone("");
                              }}
                              className="mt-0.5 text-emerald-500 focus:ring-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 font-medium">
                                <span className="truncate">{p.label}</span>
                                {p.is_dialed && (
                                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-sky-900/60 text-sky-300 border border-sky-700/50">
                                    Dialed
                                  </span>
                                )}
                              </div>
                              <p className="text-slate-400 font-mono text-[11px] mt-0.5 truncate">{p.phone}</p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}

                  {selectedPhoneObj?.is_landline && (
                    <p className="text-xs text-amber-300/90 rounded-lg bg-amber-950/40 border border-amber-800/50 px-2.5 py-1.5">
                      ⚠️ <strong>Landline selected:</strong> WhatsApp cannot deliver messages to landlines. Please select a mobile number above or enter one below.
                    </p>
                  )}

                  <div className="flex items-center gap-2 pt-1 border-t border-slate-800/80">
                    <span className="text-[11px] text-slate-400 shrink-0">Other number:</span>
                    <input
                      type="text"
                      placeholder="e.g. +971501234567"
                      value={customPhone}
                      onChange={(e) => {
                        setCustomPhone(e.target.value);
                        if (e.target.value.trim()) {
                          setSelectedPhone(e.target.value.trim());
                        }
                      }}
                      className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                </div>

                <label className="block">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">
                      WhatsApp message {waBodyCustomized ? "(customized)" : "(auto-synced from email)"}
                    </span>
                    {waBodyCustomized && (
                      <button
                        type="button"
                        onClick={() => {
                          setWhatsappBody(deriveWhatsAppFromEmail(emailBody));
                          setWaBodyCustomized(false);
                        }}
                        className="text-[11px] text-sky-400 hover:text-sky-300 font-medium transition"
                      >
                        ↺ Reset to email sync
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={5}
                    value={whatsappBody}
                    onChange={(e) => {
                      setWhatsappBody(e.target.value);
                      setWaBodyCustomized(true);
                    }}
                    placeholder="Type or customize your WhatsApp message…"
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500"
                  />
                </label>
                <div
                  className={`rounded-lg border p-3 space-y-2 ${
                    needsWaTemplate
                      ? "border-amber-500/40 bg-amber-500/10"
                      : "border-emerald-500/25 bg-emerald-500/5"
                  }`}
                >
                  <p className="text-xs text-slate-300">
                    <strong className="text-emerald-300">WhatsApp Meta</strong> — searchable
                    approved templates. Use a template for cold outreach; inside the 24h reply
                    window free text may work without one.
                  </p>
                  <WhatsAppTemplatePicker
                    templates={waTemplates}
                    loading={waTemplatesLoading}
                    templateId={waTemplateId}
                    onTemplateIdChange={setWaTemplateId}
                    search={waTemplateSearch}
                    onSearchChange={setWaTemplateSearch}
                    variables={waTemplateVariables}
                    onVariablesChange={setWaTemplateVariables}
                    leadContext={
                      draft
                        ? {
                            company_name: draft.company_name,
                            contact_name: draft.contact_name,
                            country: draft.country,
                          }
                        : null
                    }
                    compact
                  />
                </div>
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
                    <IconWhatsApp size="md" className="text-white !h-7 !w-7" />
                    {sendingChannel === "whatsapp" ? "Sending…" : "WhatsApp Meta"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(sendingChannel) || savingDraft}
                    onClick={() => void sendDraft("whatsapp_personal")}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-3 py-2 text-sm font-medium"
                    title="Send post-call follow-up via your mobile WhatsApp number"
                  >
                    <IconWhatsApp size="md" className="text-white !h-7 !w-7" />
                    {sendingChannel === "whatsapp_personal" ? "Sending…" : "WhatsApp Mobile"}
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
