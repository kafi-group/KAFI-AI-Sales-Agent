import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  client,
  type WhatsAppCampaignDraftResponse,
  type WhatsAppTemplate,
} from "../api/client";

interface BulkWhatsAppModalProps {
  buyerIds: number[];
  onClose: () => void;
  onError: (message: string) => void;
  onCreated: (result: WhatsAppCampaignDraftResponse) => void;
}

function WhatsAppIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-5 w-5 shrink-0 ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.94.56 3.75 1.53 5.28L2 22l4.94-1.62a9.83 9.83 0 0 0 5.1 1.4h.01c5.46 0 9.9-4.45 9.9-9.91C21.95 6.45 17.5 2 12.04 2Zm5.79 14.06c-.24.68-1.4 1.3-1.93 1.38-.5.08-1.1.11-1.77-.11a15.4 15.4 0 0 1-1.6-.6c-2.82-1.22-4.66-4.07-4.8-4.26-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07.99-2.35.26-.28.57-.35.76-.35.19 0 .38 0 .55.01.18.01.42-.07.65.5.24.58.81 2 .88 2.14.07.14.12.31.02.5-.1.19-.15.31-.29.48-.14.17-.3.37-.43.5-.14.14-.29.29-.13.57.17.28.75 1.24 1.62 2.01 1.11 1 2.05 1.31 2.34 1.46.29.14.46.12.63-.07.17-.19.72-.83.91-1.12.19-.28.38-.24.65-.14.26.1 1.68.79 1.97.93.29.14.48.21.55.33.07.12.07.71-.17 1.39Z" />
    </svg>
  );
}

type BulkWhatsAppTab = "personal" | "template";

export function BulkWhatsAppModal({
  buyerIds,
  onClose,
  onError,
  onCreated,
}: BulkWhatsAppModalProps) {
  const [tab, setTab] = useState<BulkWhatsAppTab>("personal");
  const [sending, setSending] = useState(false);

  // Personal message state
  const [personalMessage, setPersonalMessage] = useState(
    "Dear {{name}},\n\n" +
      "I hope this message finds you well. We at Kafi Commodities would like to connect with {{company}} regarding our ESSENCE product range.\n\n" +
      "Please let us know if you would like specifications or current pricing.\n\n" +
      "Best regards,\nKafi Commodities Export Team",
  );

  // Template state
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");
  const [variables, setVariables] = useState<string[]>([]);
  const [requireOptIn, setRequireOptIn] = useState(false); // Default false so test sends and bulk sends are not blocked

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
    if (tab === "template") {
      void refreshTemplates();
    }
  }, [tab, refreshTemplates]);

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

  useEffect(() => {
    setVariables(Array(selectedTemplate?.variable_count ?? 0).fill(""));
  }, [selectedTemplate]);

  async function handleSendPersonal() {
    if (!personalMessage.trim()) {
      onError("Please write a message to send.");
      return;
    }
    setSending(true);
    try {
      const result = await client.sendWhatsAppPersonalBulk({
        buyer_ids: buyerIds,
        message: personalMessage.trim(),
      });
      onCreated({
        created_count: result.sent_count,
        sent_count: result.sent_count,
        failed_count: result.failed_count,
        skipped_count: result.skipped_count || 0,
        created: [],
        skipped: [],
      });
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Personal bulk WhatsApp send failed");
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
      const result = await client.createWhatsAppCampaignDrafts({
        template_id: Number(templateId),
        buyer_ids: buyerIds,
        template_variables: variables,
        require_opt_in: requireOptIn,
      });
      onCreated(result);
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Bulk WhatsApp send failed");
    } finally {
      setSending(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4 backdrop-blur-sm"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div
        className="w-full sm:max-w-2xl max-h-[92vh] overflow-hidden flex flex-col rounded-t-2xl sm:rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-compose-whatsapp-title"
      >
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-3 shrink-0 bg-slate-950/60">
          <div className="min-w-0">
            <h3
              id="bulk-compose-whatsapp-title"
              className="text-lg font-bold text-slate-100 flex items-center gap-2"
            >
              <WhatsAppIcon className="text-emerald-400" />
              <span>Bulk WhatsApp Message</span>
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-extrabold">
                {buyerIds.length} lead{buyerIds.length === 1 ? "" : "s"} selected
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Dispatch to your staff testing list or targeted buyer contacts.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 text-xl leading-none transition"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Tab switcher: Personal QR vs Meta Verified */}
        <div className="flex border-b border-slate-800 bg-slate-950/80 px-5 pt-3 gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setTab("personal")}
            className={`pb-2.5 px-3 text-xs sm:text-sm font-bold border-b-2 transition-all flex items-center gap-2 cursor-pointer ${
              tab === "personal"
                ? "border-emerald-500 text-emerald-300 shadow-sm"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>📱 Personal WhatsApp (QR Scanned)</span>
          </button>
          <button
            type="button"
            onClick={() => setTab("template")}
            className={`pb-2.5 px-3 text-xs sm:text-sm font-bold border-b-2 transition-all flex items-center gap-2 cursor-pointer ${
              tab === "template"
                ? "border-emerald-500 text-emerald-300 shadow-sm"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>🏢 Meta Verified (Templates)</span>
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {tab === "personal" ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3 text-xs text-emerald-200/90 leading-relaxed flex items-start gap-2.5">
                <span className="text-base shrink-0">⚡</span>
                <div>
                  <strong className="text-emerald-300 font-semibold block">
                    Sent via your scanned WhatsApp Web (Baileys)
                  </strong>
                  Each contact receives a direct personal message from your active session. Tags like{" "}
                  <code className="bg-emerald-900/60 px-1 py-0.5 rounded text-emerald-200 font-mono">
                    {"{{name}}"}
                  </code>{" "}
                  and{" "}
                  <code className="bg-emerald-900/60 px-1 py-0.5 rounded text-emerald-200 font-mono">
                    {"{{company}}"}
                  </code>{" "}
                  are automatically personalized for every recipient.
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                  Message Content:
                </label>
                <textarea
                  rows={8}
                  value={personalMessage}
                  onChange={(e) => setPersonalMessage(e.target.value)}
                  placeholder="Type your WhatsApp message..."
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 p-3.5 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 leading-relaxed font-sans"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                <span className="text-slate-400 font-medium">Insert tags:</span>
                <button
                  type="button"
                  onClick={() => setPersonalMessage((prev) => prev + " {{name}}")}
                  className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono border border-slate-700 transition"
                >
                  + {"{{name}}"}
                </button>
                <button
                  type="button"
                  onClick={() => setPersonalMessage((prev) => prev + " {{company}}")}
                  className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono border border-slate-700 transition"
                >
                  + {"{{company}}"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-slate-400">
                Only Meta-approved templates can be sent via Meta Cloud API. Manage templates in{" "}
                <strong className="text-slate-300">WhatsApp templates</strong>.
              </p>

              {loadingTemplates ? (
                <p className="text-sm text-slate-400 py-4 text-center">Loading templates…</p>
              ) : templates.length === 0 ? (
                <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
                  No approved templates yet. Open{" "}
                  <strong className="text-slate-300">WhatsApp templates</strong> in the sidebar and
                  sync from Meta.
                </p>
              ) : (
                <>
                  <input
                    type="search"
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    placeholder="Search templates by name, category, body…"
                    className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder-slate-500"
                  />
                  <ul className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {filteredTemplates.map((template) => {
                      const selected = String(template.id) === templateId;
                      return (
                        <li key={template.id}>
                          <button
                            type="button"
                            onClick={() => setTemplateId(String(template.id))}
                            className={`w-full rounded-lg border p-3 text-left transition ${
                              selected
                                ? "border-emerald-500/60 bg-emerald-500/10 text-white"
                                : "border-slate-800 bg-slate-950 hover:border-slate-700 text-slate-300"
                            }`}
                          >
                            <p className="font-semibold text-sm">
                              {template.name}{" "}
                              <span className="text-xs font-normal text-slate-400 font-mono">
                                ({template.category})
                              </span>
                            </p>
                            {template.body_text && (
                              <p className="text-xs text-slate-400 truncate mt-0.5">
                                {template.body_text}
                              </p>
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
                <div className="space-y-2 pt-2 border-t border-slate-800">
                  <p className="text-xs text-slate-400">
                    Template variables (values used for every recipient):
                  </p>
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
                      className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100"
                    />
                  ))}
                </div>
              )}

              <label className="flex items-start gap-2.5 text-xs text-slate-400 pt-2 border-t border-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={requireOptIn}
                  onChange={(e) => setRequireOptIn(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-950 mt-0.5"
                />
                <span>
                  Only send to contacts with recorded WhatsApp marketing opt-in (leave unchecked for
                  testing and regular outreach)
                </span>
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 sm:p-5 border-t border-slate-800 flex justify-end gap-3 shrink-0 bg-slate-950/60">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs sm:text-sm font-semibold text-slate-300 transition"
          >
            Cancel
          </button>
          {tab === "personal" ? (
            <button
              type="button"
              onClick={() => void handleSendPersonal()}
              disabled={sending || !personalMessage.trim()}
              className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs sm:text-sm font-bold text-white shadow-lg shadow-emerald-600/30 disabled:opacity-50 transition cursor-pointer"
            >
              {sending ? "Sending…" : `Send to ${buyerIds.length} contact(s)`}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSendTemplate()}
              disabled={sending || !templateId || templates.length === 0}
              className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs sm:text-sm font-bold text-white shadow-lg shadow-emerald-600/30 disabled:opacity-50 transition cursor-pointer"
            >
              {sending ? "Sending…" : `Send ${buyerIds.length} message(s)`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
