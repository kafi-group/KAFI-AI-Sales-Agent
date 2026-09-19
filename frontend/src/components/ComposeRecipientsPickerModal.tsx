import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { client, type LeadTableRow } from "../api/client";
import { IconMail, IconX } from "./icons/AppIcons";

export interface ComposeRecipientChoice {
  email: string;
  label: string;
  company_name?: string;
  contact_name?: string;
  buyer_id?: number;
}

interface ComposeRecipientsPickerModalProps {
  onClose: () => void;
  onError: (message: string) => void;
  onContinue: (result: { to: string[]; cc: string[] }) => void;
}

function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email.includes("@") || email.length < 5) return null;
  return email;
}

function emailsFromRow(row: LeadTableRow): ComposeRecipientChoice[] {
  const out: ComposeRecipientChoice[] = [];
  const seen = new Set<string>();
  const add = (email: string | null | undefined, kind: string) => {
    const n = normalizeEmail(email || "");
    if (!n || seen.has(n)) return;
    seen.add(n);
    const contact = row.contact_name || "Contact";
    const company = row.company_name || "Company";
    out.push({
      email: n,
      label: `${contact} · ${company} (${kind})`,
      company_name: row.company_name || undefined,
      contact_name: row.contact_name || undefined,
      buyer_id: row.id,
    });
  };
  add(row.contact_email, "primary");
  add(row.contact_secondary_email, "secondary");
  return out;
}

export function ComposeRecipientsPickerModal({
  onClose,
  onError,
  onContinue,
}: ComposeRecipientsPickerModalProps) {
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [hits, setHits] = useState<ComposeRecipientChoice[]>([]);
  const [toList, setToList] = useState<ComposeRecipientChoice[]>([]);
  const [ccList, setCcList] = useState<ComposeRecipientChoice[]>([]);
  const [manualEmail, setManualEmail] = useState("");
  const [manualTarget, setManualTarget] = useState<"to" | "cc">("to");

  const toEmails = useMemo(() => new Set(toList.map((r) => r.email)), [toList]);
  const ccEmails = useMemo(() => new Set(ccList.map((r) => r.email)), [ccList]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      client
        .listLeadsTable({
          q,
          page: 1,
          page_size: 25,
          master: true,
        })
        .then((res) => {
          if (cancelled) return;
          const rows = res.rows || [];
          const found: ComposeRecipientChoice[] = [];
          const seen = new Set<string>();
          for (const row of rows) {
            for (const item of emailsFromRow(row)) {
              if (seen.has(item.email)) continue;
              seen.add(item.email);
              found.push(item);
            }
          }
          setHits(found);
        })
        .catch((e) => {
          if (!cancelled) {
            onError(e instanceof Error ? e.message : "Contact search failed");
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, onError]);

  function addTo(bucket: "to" | "cc", item: ComposeRecipientChoice) {
    const email = normalizeEmail(item.email);
    if (!email) return;
    const next = { ...item, email };
    if (bucket === "to") {
      setCcList((prev) => prev.filter((r) => r.email !== email));
      setToList((prev) => (prev.some((r) => r.email === email) ? prev : [...prev, next]));
    } else {
      setToList((prev) => prev.filter((r) => r.email !== email));
      setCcList((prev) => (prev.some((r) => r.email === email) ? prev : [...prev, next]));
    }
  }

  function removeFrom(bucket: "to" | "cc", email: string) {
    if (bucket === "to") setToList((prev) => prev.filter((r) => r.email !== email));
    else setCcList((prev) => prev.filter((r) => r.email !== email));
  }

  function addManual() {
    const email = normalizeEmail(manualEmail);
    if (!email) {
      onError("Enter a valid email address.");
      return;
    }
    addTo(manualTarget, { email, label: email });
    setManualEmail("");
  }

  function handleContinue() {
    if (toList.length === 0 && ccList.length === 0) {
      onError("Add at least one email to To or Cc.");
      return;
    }
    if (toList.length === 0) {
      onError("Add at least one recipient in To.");
      return;
    }
    onContinue({
      to: toList.map((r) => r.email),
      cc: ccList.map((r) => r.email),
    });
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-black/65"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-4 shrink-0">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-100 inline-flex items-center gap-2">
              <IconMail size="sm" className="text-emerald-400" />
              Choose recipients
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Pick contacts for <strong className="text-slate-300">To</strong> and{" "}
              <strong className="text-slate-300">Cc</strong>, then open the mailer.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close"
          >
            <IconX size="sm" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
              Search contacts
            </label>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Company, contact name, or email…"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
              autoFocus
            />
            {loading ? (
              <p className="text-xs text-slate-500 mt-2">Searching…</p>
            ) : query.trim().length >= 2 && hits.length === 0 ? (
              <p className="text-xs text-slate-500 mt-2">No contacts with email matched.</p>
            ) : null}
            {hits.length > 0 ? (
              <ul className="mt-2 max-h-44 overflow-y-auto space-y-1.5 rounded-xl border border-slate-800 bg-slate-950/60 p-2">
                {hits.map((hit) => {
                  const inTo = toEmails.has(hit.email);
                  const inCc = ccEmails.has(hit.email);
                  return (
                    <li
                      key={hit.email}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/80 px-2.5 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-slate-100 truncate">{hit.label}</p>
                        <p className="text-xs font-mono text-sky-300/90 truncate">{hit.email}</p>
                      </div>
                      <button
                        type="button"
                        disabled={inTo}
                        onClick={() => addTo("to", hit)}
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-600/90 hover:bg-emerald-500 text-white disabled:opacity-40"
                      >
                        {inTo ? "In To" : "Add To"}
                      </button>
                      <button
                        type="button"
                        disabled={inCc}
                        onClick={() => addTo("cc", hit)}
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-sky-700 hover:bg-sky-600 text-white disabled:opacity-40"
                      >
                        {inCc ? "In Cc" : "Add Cc"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                Or type an email
              </label>
              <input
                type="email"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addManual();
                  }
                }}
                placeholder="name@company.com"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <select
              value={manualTarget}
              onChange={(e) => setManualTarget(e.target.value as "to" | "cc")}
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-200"
            >
              <option value="to">To</option>
              <option value="cc">Cc</option>
            </select>
            <button
              type="button"
              onClick={addManual}
              className="px-3.5 py-2.5 rounded-xl text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-100"
            >
              Add
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3 space-y-2 min-h-[7rem]">
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
                To ({toList.length})
              </p>
              {toList.length === 0 ? (
                <p className="text-xs text-slate-500">No To recipients yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {toList.map((r) => (
                    <li
                      key={r.email}
                      className="flex items-center justify-between gap-2 rounded-lg bg-slate-950/50 px-2 py-1.5"
                    >
                      <span className="text-xs text-slate-200 truncate" title={r.label}>
                        {r.email}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFrom("to", r.email)}
                        className="text-[11px] text-rose-400 hover:text-rose-300 shrink-0"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-xl border border-sky-500/30 bg-sky-950/20 p-3 space-y-2 min-h-[7rem]">
              <p className="text-xs font-semibold uppercase tracking-wider text-sky-300">
                Cc ({ccList.length})
              </p>
              {ccList.length === 0 ? (
                <p className="text-xs text-slate-500">No Cc recipients yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {ccList.map((r) => (
                    <li
                      key={r.email}
                      className="flex items-center justify-between gap-2 rounded-lg bg-slate-950/50 px-2 py-1.5"
                    >
                      <span className="text-xs text-slate-200 truncate" title={r.label}>
                        {r.email}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFrom("cc", r.email)}
                        className="text-[11px] text-rose-400 hover:text-rose-300 shrink-0"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-4 shrink-0 bg-slate-950/50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleContinue}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500"
          >
            Open mailer
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
