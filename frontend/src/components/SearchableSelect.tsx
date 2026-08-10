import { useEffect, useMemo, useRef, useState } from "react";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  allowEmpty?: boolean;
  emptyLabel?: string;
  label?: string;
  labelClassName?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  allowEmpty = false,
  emptyLabel = "All",
  label,
  labelClassName = "text-xs text-slate-400",
  placeholder = "Search…",
  disabled = false,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(q) ||
        option.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function choose(next: string) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  const buttonLabel = selected?.label ?? (allowEmpty ? emptyLabel : "Select…");

  return (
    <label className="block">
      {label && <span className={labelClassName}>{label}</span>}
      <div ref={containerRef} className={`relative ${label ? "mt-1" : ""}`}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((prev) => !prev)}
          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 text-left flex items-center justify-between gap-2 disabled:opacity-50"
        >
          <span className="truncate">{buttonLabel}</span>
          <span className="text-slate-500">{open ? "▴" : "▾"}</span>
        </button>

        {open && !disabled && (
          <div className="absolute z-30 mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 shadow-xl">
            <div className="p-2 border-b border-slate-800">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder}
                autoFocus
                className="w-full rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              />
            </div>
            <ul className="max-h-56 overflow-y-auto py-1">
              {allowEmpty && (
                <li>
                  <button
                    type="button"
                    onClick={() => choose("")}
                    className="w-full px-3 py-2 text-left text-sm text-slate-400 hover:bg-slate-900"
                  >
                    {emptyLabel}
                  </button>
                </li>
              )}
              {filtered.map((option) => (
                <li key={option.value}>
                  <button
                    type="button"
                    onClick={() => choose(option.value)}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-900 ${
                      value === option.value
                        ? "bg-emerald-500/10 text-emerald-300"
                        : "text-slate-200"
                    }`}
                  >
                    {option.label}
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-500">No matches</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </label>
  );
}

export function stringOptions(values: string[]): SearchableSelectOption[] {
  return values.map((value) => ({ value, label: value }));
}
