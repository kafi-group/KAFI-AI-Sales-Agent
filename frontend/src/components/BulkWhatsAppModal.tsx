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

export function BulkWhatsAppModal({
  buyerIds,
  onClose,
  onError,
  onCreated,
}: BulkWhatsAppModalProps) {
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateId, setTemplateId] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");
  const [variables, setVariables] = useState<string[]>([]);
  const [requireOptIn, setRequireOptIn] = useState(buyerIds.length > 1);

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

  async function handleSend() {
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
        aria-labelledby="bulk-compose-whatsapp-title"
      >
        <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3
              id="bulk-compose-whatsapp-title"
              className="text-lg font-medium text-slate-100 flex items-center gap-2"
            >
              <WhatsAppIcon className="text-emerald-400" />
              Send bulk WhatsApp
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              {buyerIds.length} lead{buyerIds.length === 1 ? "" : "s"} selected — each gets an
              approved WhatsApp template message sent immediately.
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

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          <p className="text-xs text-slate-500">
            Only Meta-approved templates can be sent to a full list. Manage and sync templates in{" "}
            <strong className="text-slate-400">WhatsApp templates</strong>.
          </p>

          {loadingTemplates ? (
            <p className="text-sm text-slate-400">Loading templates…</p>
          ) : templates.length === 0 ? (
            <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
              No approved templates yet. Open{" "}
              <strong className="text-slate-300">WhatsApp templates</strong> in the sidebar and
              sync from Meta once your templates are approved.
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
              <p className="text-sm text-slate-400">
                Template variables (same value used for every recipient — for per-lead
                personalization use a template without variables, or send from the buyer
                profile instead)
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
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
                />
              ))}
            </div>
          )}

          {(isMarketing || buyerIds.length === 1) && (
            <label className="flex items-start gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={requireOptIn}
                onChange={(e) => setRequireOptIn(e.target.checked)}
                className="rounded border-slate-600 bg-slate-950 mt-0.5"
              />
              <span>
                Only send to contacts who opted in to WhatsApp marketing
                {buyerIds.length === 1 ? (
                  <span className="block text-xs text-slate-500 mt-0.5">
                    Unchecked for single/test sends — turn on for real marketing campaigns.
                  </span>
                ) : null}
              </span>
            </label>
          )}
        </div>

        <div className="p-5 border-t border-slate-800 flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || !templateId || templates.length === 0}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
          >
            {sending ? "Sending…" : `Send ${buyerIds.length} message(s)`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
