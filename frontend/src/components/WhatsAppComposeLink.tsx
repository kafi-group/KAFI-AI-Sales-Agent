import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type LeadTableRow,
  type WhatsAppCampaignDraftResponse,
  type WhatsAppTemplate,
} from "../api/client";
import { ActionButton } from "./ui/ActionButton";
import {
  IconExternal,
  IconSend,
  IconTemplate,
  IconWhatsApp,
  IconX,
} from "./icons/AppIcons";
import { ProseTextarea } from "./ProseTextField";

type ComposeTab = "personal" | "template";

export interface WhatsAppComposeTarget {
  row: LeadTableRow;
  phone: string;
}

interface LeadWhatsAppComposeModalProps {
  target: WhatsAppComposeTarget;
  onClose: () => void;
  onError: (message: string) => void;
  onSent: (message: string) => void;
}

function WhatsAppIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.94.56 3.75 1.53 5.28L2 22l4.94-1.62a9.83 9.83 0 0 0 5.1 1.4h.01c5.46 0 9.9-4.45 9.9-9.91C21.95 6.45 17.5 2 12.04 2Zm5.79 14.06c-.24.68-1.4 1.3-1.93 1.38-.5.08-1.1.11-1.77-.11a15.4 15.4 0 0 1-1.6-.6c-2.82-1.22-4.66-4.07-4.8-4.26-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07.99-2.35.26-.28.57-.35.76-.35.19 0 .38 0 .55.01.18.01.42-.07.65.5.24.58.81 2 .88 2.14.07.14.12.31.02.5-.1.19-.15.31-.29.48-.14.17-.3.37-.43.5-.14.14-.29.29-.13.57.17.28.75 1.24 1.62 2.01 1.11 1 2.05 1.31 2.34 1.46.29.14.46.12.63-.07.17-.19.72-.83.91-1.12.19-.28.38-.24.65-.14.26.1 1.68.79 1.97.93.29.14.48.21.55.33.07.12.07.71-.17 1.39Z" />
    </svg>
  );
}

function phoneKey(value: string | null | undefined): string {
  return (value || "").replace(/\D/g, "");
}

function contactMatchesPhone(
  contact: { phone?: string | null; wa_id?: string | null },
  targetPhone: string,
): boolean {
  const key = phoneKey(targetPhone);
  if (!key) return false;
  return phoneKey(contact.phone) === key || phoneKey(contact.wa_id) === key;
}

/** wa.me digits for deep links (handles common PK local numbers like 03…). */
function whatsAppWaMeDigits(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length >= 10 && digits.length <= 11) {
    digits = `92${digits.slice(1)}`;
  }
  return digits;
}

function whatsAppDeepLink(phone: string, text: string): string {
  const digits = whatsAppWaMeDigits(phone);
  if (!digits) return "https://wa.me/";
  const query = text.trim() ? `?text=${encodeURIComponent(text.trim())}` : "";
  return `https://wa.me/${digits}${query}`;
}

export function LeadWhatsAppComposeModal({
  target,
  onClose,
  onError,
  onSent,
}: LeadWhatsAppComposeModalProps) {
  const { row, phone } = target;
  const [tab, setTab] = useState<ComposeTab>("template");
  const [contactId, setContactId] = useState<number | null>(row.contact_id);
  const [withinSessionWindow, setWithinSessionWindow] = useState(false);
  const [resolvingContact, setResolvingContact] = useState(true);
  const [sending, setSending] = useState(false);

  const [message, setMessage] = useState(
    `Dear ${row.contact_name || "Sir/Madam"},\n\n` +
      `I hope this message finds you well. We at Kafi Commodities would like to connect with ${row.company_name} regarding our ESSENCE product range.\n\n` +
      `Please let us know if you would like specifications or pricing.\n\n` +
      `Best regards,\nKafi Commodities Export Team`,
  );

  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateId, setTemplateId] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");
  const [variables, setVariables] = useState<string[]>([]);
  const [requireOptIn, setRequireOptIn] = useState(false);

  const refreshTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    try {
      const rows = await client.listWhatsAppTemplates(true);
      setTemplates(rows);
      setTemplateId((current) => {
        if (current && rows.some((t) => String(t.id) === current)) return current;
        return rows.length > 0 ? String(rows[0].id) : "";
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load WhatsApp templates");
    } finally {
      setLoadingTemplates(false);
    }
  }, [onError]);

  useEffect(() => {
    void refreshTemplates();
  }, [refreshTemplates]);

  useEffect(() => {
    let cancelled = false;
    setResolvingContact(true);
    client
      .listLeadContacts(row.id)
      .then((contacts) => {
        if (cancelled) return;
        const matched =
          (row.contact_id
            ? contacts.find((c) => c.id === row.contact_id)
            : undefined) ||
          contacts.find((c) => contactMatchesPhone(c, phone)) ||
          contacts.find((c) => (c.phone || c.wa_id || "").trim());
        setContactId(matched?.id ?? null);
        const within = Boolean(matched?.within_session_window);
        setWithinSessionWindow(within);
        setTab(within ? "personal" : "template");
      })
      .catch(() => {
        if (!cancelled) {
          setContactId(row.contact_id ?? null);
          setWithinSessionWindow(false);
          setTab("template");
        }
      })
      .finally(() => {
        if (!cancelled) setResolvingContact(false);
      });

    return () => {
      cancelled = true;
    };
  }, [row.contact_id, row.id, phone]);

  const selectedTemplate = templates.find((t) => String(t.id) === templateId);
  const filteredTemplates = useMemo(() => {
    const q = templateSearch.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => {
      const haystack = [t.name, t.category, t.language, t.body_text]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [templateSearch, templates]);
  const isMarketing = (selectedTemplate?.category || "").toUpperCase() === "MARKETING";

  useEffect(() => {
    setVariables(Array(selectedTemplate?.variable_count ?? 0).fill(""));
  }, [selectedTemplate]);

  async function handleSendPersonal() {
    if (!contactId) {
      onError("No contact with this phone number found for this lead.");
      return;
    }
    if (!withinSessionWindow) {
      onError(
        "Meta only allows free-text WhatsApp after the customer has messaged you in the last 24 hours. " +
          "Use Open in WhatsApp for a manual send, or the WhatsApp template tab for cold outreach via the API.",
      );
      return;
    }
    if (!message.trim()) {
      onError("Message is required");
      return;
    }
    setSending(true);
    try {
      const result = await client.replyToWhatsAppConversation(contactId, {
        content: message.trim(),
        send: true,
      });
      if (result.sent) {
        onSent(`WhatsApp sent to ${row.company_name}. Open WhatsApp inbox to see the thread.`);
      } else {
        onError(
          result.send_message ||
            "Send did not complete. If the 24-hour window has closed, use the WhatsApp template tab.",
        );
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send WhatsApp message");
    } finally {
      setSending(false);
    }
  }

  async function handleSendTemplate() {
    if (!templateId) {
      onError("Select an approved template first");
      return;
    }
    setSending(true);
    try {
      const result: WhatsAppCampaignDraftResponse = await client.createWhatsAppCampaignDrafts({
        template_id: Number(templateId),
        buyer_ids: [row.id],
        template_variables: variables,
        require_opt_in: requireOptIn,
      });
      if ((result.sent_count ?? 0) > 0) {
        onSent(`WhatsApp template sent to ${row.company_name}. Open WhatsApp inbox to see the thread.`);
        return;
      }
      const reason =
        result.skipped[0]?.reason ||
        result.created[0]?.send_message ||
        "Could not send WhatsApp template";
      onError(reason);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to send WhatsApp template");
    } finally {
      setSending(false);
    }
  }

  const waDeepLink = whatsAppDeepLink(phone, message);
  const canSendPersonalViaApi = Boolean(contactId && withinSessionWindow && message.trim());

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div
        className="w-full sm:max-w-2xl max-h-[92vh] overflow-hidden flex flex-col rounded-t-2xl sm:rounded-xl border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-whatsapp-title"
      >
        <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3
              id="compose-whatsapp-title"
              className="text-lg font-medium text-slate-100 flex items-center gap-2"
            >
              <WhatsAppIcon className="text-emerald-400" />
              WhatsApp message
            </h3>
            <p className="text-sm text-slate-500 mt-1 truncate">
              To: <span className="text-slate-300">{phone}</span>
              {" · "}
              {row.company_name}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-5 pt-4 shrink-0">
          <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-1">
            <button
              type="button"
              onClick={() => setTab("personal")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${
                tab === "personal"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Personal message
            </button>
            <button
              type="button"
              onClick={() => setTab("template")}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${
                tab === "template"
                  ? "bg-emerald-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              WhatsApp template
            </button>
          </div>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {tab === "personal" ? (
            <>
              {resolvingContact ? (
                <p className="text-sm text-slate-400">Looking up contact…</p>
              ) : !contactId ? (
                <p className="text-sm text-amber-200 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                  No contact record matches this phone number. Add or update the contact on this
                  lead, or use the <strong>WhatsApp template</strong> tab for cold outreach.
                </p>
              ) : !withinSessionWindow ? (
                <p className="text-sm text-amber-200 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                  This contact has not messaged you on WhatsApp in the last 24 hours. Meta&apos;s
                  Cloud API cannot send this free-text message automatically. Use{" "}
                  <strong>Open in WhatsApp</strong> below to send from your phone or WhatsApp Web,
                  or switch to <strong>WhatsApp template</strong> for an API send with an approved
                  Meta template.
                </p>
              ) : (
                <p className="text-sm text-emerald-200 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                  24-hour reply window is open — your message will send directly via WhatsApp Cloud
                  API.
                </p>
              )}
              <label className="block">
                <span className="text-sm text-slate-400">Message</span>
                <ProseTextarea
                  rows={10}
                  value={message}
                  onChange={setMessage}
                  className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
                />
              </label>
              <p className="text-xs text-slate-500">
                {withinSessionWindow
                  ? "Free-text sends through your connected WhatsApp Business number."
                  : "For cold outreach, Meta requires an approved template. Open in WhatsApp sends the text below manually from your device."}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                Select an approved Meta template to send to this lead. Sync templates in{" "}
                <strong className="text-slate-400">WhatsApp templates</strong> in the sidebar.
              </p>

              {loadingTemplates ? (
                <p className="text-sm text-slate-400">Loading templates…</p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
                  No approved templates yet. Open{" "}
                  <strong className="text-slate-300">WhatsApp templates</strong> and sync from Meta.
                </p>
              ) : (
                <>
                  <input
                    type="search"
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    placeholder="Search templates by name, category, body…"
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
                  />
                  <ul className="space-y-2">
                    {filteredTemplates.map((template) => {
                    const selected = String(template.id) === templateId;
                    return (
                      <li key={template.id}>
                        <button
                          type="button"
                          onClick={() => setTemplateId(String(template.id))}
                          className={`w-full rounded-lg border p-3 text-left transition ${
                            selected
                              ? "border-emerald-500/50 bg-emerald-500/10"
                              : "border-slate-800 bg-slate-950 hover:border-slate-700"
                          }`}
                        >
                          <p className="font-medium text-slate-100">
                            {template.name}{" "}
                            <span className="text-xs text-slate-500">({template.category})</span>
                          </p>
                          {template.body_text && (
                            <p className="text-sm text-slate-400 truncate">{template.body_text}</p>
                          )}
                        </button>
                      </li>
                    );
                  })}
                  </ul>
                  {filteredTemplates.length === 0 && (
                    <p className="text-sm text-slate-500">No templates match your search.</p>
                  )}
                </>
              )}

              {selectedTemplate && variables.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-slate-400">Template variables</p>
                  {variables.map((value, index) => (
                    <input
                      key={index}
                      value={value}
                      onChange={(e) =>
                        setVariables((prev) =>
                          prev.map((v, i) => (i === index ? e.target.value : v)),
                        )
                      }
                      placeholder={`Variable {{${index + 1}}}`}
                      className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
                    />
                  ))}
                </div>
              )}

              {isMarketing && (
                <label className="flex items-start gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={requireOptIn}
                    onChange={(e) => setRequireOptIn(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-950 mt-0.5"
                  />
                  <span>Only send if contact opted in to WhatsApp marketing</span>
                </label>
              )}
            </>
          )}
        </div>

        <div className="p-5 border-t border-slate-800 flex flex-wrap justify-end gap-2 shrink-0">
          <ActionButton icon={IconX} size="md" onClick={onClose} title="Cancel">
            Cancel
          </ActionButton>
          {tab === "personal" ? (
            <>
              {!withinSessionWindow && (
                <ActionButton
                  icon={IconTemplate}
                  size="md"
                  onClick={() => setTab("template")}
                  title="Use approved template"
                >
                  Use template
                </ActionButton>
              )}
              {!withinSessionWindow ? (
                <a
                  href={waDeepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white border border-emerald-500/40"
                  title="Open in WhatsApp"
                >
                  <IconWhatsApp size="sm" />
                  Open in WhatsApp
                  <IconExternal size="xs" className="opacity-80" />
                </a>
              ) : (
                <ActionButton
                  icon={IconSend}
                  variant="primary"
                  size="md"
                  onClick={() => void handleSendPersonal()}
                  disabled={sending || resolvingContact || !canSendPersonalViaApi}
                  title="Send message"
                >
                  {sending ? "Sending…" : "Send message"}
                </ActionButton>
              )}
            </>
          ) : (
            <ActionButton
              icon={IconSend}
              variant="primary"
              size="md"
              onClick={() => void handleSendTemplate()}
              disabled={sending || !templateId || templates.length === 0}
              title="Send from template"
            >
              {sending ? "Sending…" : "Send template"}
            </ActionButton>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
