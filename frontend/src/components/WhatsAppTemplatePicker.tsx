import { useEffect, useMemo } from "react";
import type { WhatsAppTemplate } from "../api/client";
import {
  mergeWhatsAppTemplateVariables,
  renderWhatsAppTemplatePreview,
  suggestWhatsAppTemplateVariables,
  type WhatsAppLeadContext,
} from "../utils/whatsappTemplateVariables";
import { IconSearch } from "./icons/AppIcons";

export interface WhatsAppTemplatePickerProps {
  templates: WhatsAppTemplate[];
  loading?: boolean;
  templateId: string;
  onTemplateIdChange: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  variables: string[];
  onVariablesChange: (values: string[]) => void;
  /** Auto-fill {{1}}…{{n}} from contact/company (same as email Dear XYZ). */
  leadContext?: WhatsAppLeadContext | null;
  /** Shorter list height for modals */
  compact?: boolean;
  emptyMessage?: string;
}

export function WhatsAppTemplatePicker({
  templates,
  loading = false,
  templateId,
  onTemplateIdChange,
  search,
  onSearchChange,
  variables,
  onVariablesChange,
  leadContext,
  compact = false,
  emptyMessage,
}: WhatsAppTemplatePickerProps) {
  const selectedTemplate = templates.find((t) => String(t.id) === templateId);

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => {
      const haystack = [t.name, t.category, t.language, t.body_text]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [search, templates]);

  useEffect(() => {
    if (!selectedTemplate || !leadContext) return;
    const count = selectedTemplate.variable_count ?? 0;
    if (count <= 0) return;
    const suggested = suggestWhatsAppTemplateVariables(
      selectedTemplate.body_text,
      count,
      leadContext,
    );
    onVariablesChange(mergeWhatsAppTemplateVariables(variables, suggested));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refill when template/lead changes
  }, [
    selectedTemplate?.id,
    selectedTemplate?.variable_count,
    selectedTemplate?.body_text,
    leadContext?.company_name,
    leadContext?.contact_name,
    leadContext?.country,
  ]);

  const previewText = useMemo(() => {
    if (!selectedTemplate?.body_text) return "";
    return renderWhatsAppTemplatePreview(selectedTemplate.body_text, variables);
  }, [selectedTemplate?.body_text, variables]);

  if (loading) {
    return <p className="text-sm text-slate-400">Loading approved templates…</p>;
  }

  if (templates.length === 0) {
    return (
      <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-3">
        {emptyMessage ||
          "No approved templates synced yet. Open WhatsApp templates in the sidebar and sync from Meta."}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <label className="relative block">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none">
          <IconSearch size="sm" />
        </span>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search approved templates by name, category, body…"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-8 pr-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
        />
      </label>
      <ul
        className={`space-y-1.5 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/50 p-1.5 ${
          compact ? "max-h-40" : "max-h-52"
        }`}
      >
        {filteredTemplates.map((template) => {
          const selected = String(template.id) === templateId;
          return (
            <li key={template.id}>
              <button
                type="button"
                onClick={() => onTemplateIdChange(String(template.id))}
                className={`w-full rounded-md border p-2.5 text-left transition ${
                  selected
                    ? "border-emerald-500/50 bg-emerald-500/10"
                    : "border-transparent bg-transparent hover:border-slate-700 hover:bg-slate-900"
                }`}
              >
                <p className="text-sm font-medium text-slate-100">
                  {template.name}{" "}
                  <span className="text-xs font-normal text-slate-500">
                    ({template.language}
                    {template.category ? ` · ${template.category}` : ""})
                  </span>
                </p>
                {template.body_text ? (
                  <p
                    className={`text-xs text-slate-400 mt-0.5 whitespace-pre-wrap ${
                      selected ? "" : "line-clamp-3"
                    }`}
                  >
                    {template.body_text}
                  </p>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {filteredTemplates.length === 0 ? (
        <p className="text-xs text-slate-500">No templates match “{search.trim()}”.</p>
      ) : null}
      {selectedTemplate ? (
        <div className="rounded-lg border border-slate-700 bg-slate-950/80 p-3 space-y-2">
          <p className="text-xs font-medium text-emerald-300/90">Message preview (what will send)</p>
          <pre className="text-sm text-slate-200 whitespace-pre-wrap font-sans leading-relaxed max-h-56 overflow-y-auto">
            {previewText || selectedTemplate.body_text || selectedTemplate.name}
          </pre>
        </div>
      ) : null}
      {selectedTemplate && selectedTemplate.variable_count > 0 ? (
        <div className="space-y-1.5 pt-1">
          <p className="text-xs text-slate-400">
            Template variables — auto-filled from contact/company; edit if needed
          </p>
          {variables.map((value, index) => (
            <input
              key={index}
              value={value}
              onChange={(e) =>
                onVariablesChange(
                  variables.map((v, i) => (i === index ? e.target.value : v)),
                )
              }
              placeholder={`Variable {{${index + 1}}}`}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
