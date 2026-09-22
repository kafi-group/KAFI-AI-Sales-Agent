import {
  clearAiResearchLog,
  formatAiResearchLogTime,
  type AiResearchLogEntry,
} from "../utils/aiResearchLog";

interface AiResearchLogModalProps {
  entries: AiResearchLogEntry[];
  onClose: () => void;
  onEntriesChange: (entries: AiResearchLogEntry[]) => void;
  /** Jump back to the contact list with these IDs still selected. */
  onOpenContacts: (leadIds: number[], section?: string | null) => void;
}

export function AiResearchLogModal({
  entries,
  onClose,
  onEntriesChange,
  onOpenContacts,
}: AiResearchLogModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
      <div className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-xl flex flex-col">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">AI Research log</h2>
            <p className="text-sm text-slate-400 mt-0.5">
              Date, time, and contacts from Modify → AI Research on this browser. Open an entry to
              return to that list with the same contacts selected.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {entries.length === 0 ? (
            <p className="text-sm text-slate-500">No research sessions logged yet.</p>
          ) : (
            entries.map((entry) => {
              const ids = entry.contacts.map((c) => c.id).filter((id) => id > 0);
              return (
                <div
                  key={entry.id}
                  className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 space-y-2"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-amber-200">
                      {formatAiResearchLogTime(entry.at)}
                    </span>
                    <span className="px-1.5 py-0.5 rounded border border-slate-600 text-slate-300 uppercase tracking-wide">
                      {entry.action}
                    </span>
                    {entry.section ? (
                      <span className="text-slate-500">list: {entry.section}</span>
                    ) : null}
                  </div>
                  {entry.note ? <p className="text-xs text-slate-400">{entry.note}</p> : null}
                  <ul className="space-y-1.5">
                    {entry.contacts.map((c) => (
                      <li key={`${entry.id}-${c.id}`} className="text-sm text-slate-200">
                        <span className="font-medium">{c.label}</span>
                        <span className="text-slate-500 text-xs"> · #{c.id}</span>
                        {c.contact_name ? (
                          <span className="text-slate-400 text-xs"> · {c.contact_name}</span>
                        ) : null}
                        {c.phone ? (
                          <span className="text-slate-400 text-xs"> · {c.phone}</span>
                        ) : null}
                        {c.email ? (
                          <span className="text-slate-400 text-xs"> · {c.email}</span>
                        ) : null}
                        {c.filled_fields?.length ? (
                          <div className="text-[11px] text-emerald-300/90 mt-0.5">
                            Filled: {c.filled_fields.join(", ")}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {ids.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => onOpenContacts(ids, entry.section)}
                      className="mt-1 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
                    >
                      Open list with these contacts selected
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        <div className="px-5 py-3 border-t border-slate-800 flex justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              if (!window.confirm("Clear all AI Research log entries on this browser?")) return;
              clearAiResearchLog();
              onEntriesChange([]);
            }}
            className="px-3 py-1.5 rounded-lg text-xs text-rose-300 border border-rose-500/30 hover:bg-rose-500/10"
          >
            Clear log
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-slate-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
