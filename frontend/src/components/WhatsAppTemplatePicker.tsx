import { useMemo } from "react";
import type { WhatsAppTemplate } from "../api/client";
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
                  <p className="text-xs text-slate-400 mt-0.5 line-clamp-2 whitespace-pre-wrap">
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
      {selectedTemplate && selectedTemplate.variable_count > 0 ? (
        <div className="space-y-1.5 pt-1">
          <p className="text-xs text-slate-400">Template variables</p>
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
