import { useEffect, useMemo, useRef, useState } from "react";
import { COUNTRIES, findCountry, type Country } from "../data/countries";

interface CountrySelectProps {
  value: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  label?: string;
  labelClassName?: string;
  placeholder?: string;
}

export function CountrySelect({
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = "All countries",
  label,
  labelClassName = "text-xs text-slate-400",
  placeholder = "Search countries…",
}: CountrySelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => findCountry(value), [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (country) =>
        country.name.toLowerCase().includes(q) ||
        country.code.toLowerCase().includes(q),
    );
  }, [query]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function choose(country: Country | null) {
    onChange(country?.name ?? "");
    setOpen(false);
    setQuery("");
  }

  const buttonLabel = selected
    ? `${selected.flag} ${selected.name}`
    : allowEmpty
      ? emptyLabel
      : "Select country";

  return (
    <label className="block">
      {label && <span className={labelClassName}>{label}</span>}
      <div ref={containerRef} className={`relative ${label ? "mt-1" : ""}`}>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 text-left flex items-center justify-between gap-2"
        >
          <span className="truncate">{buttonLabel}</span>
          <span className="text-slate-500">{open ? "▴" : "▾"}</span>
        </button>

        {open && (
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
                    onClick={() => choose(null)}
                    className="w-full px-3 py-2 text-left text-sm text-slate-400 hover:bg-slate-900"
                  >
                    {emptyLabel}
                  </button>
                </li>
              )}
              {filtered.map((country) => (
                <li key={country.code}>
                  <button
                    type="button"
                    onClick={() => choose(country)}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-900 ${
                      selected?.code === country.code
                        ? "bg-emerald-500/10 text-emerald-300"
                        : "text-slate-200"
                    }`}
                  >
                    <span className="mr-2">{country.flag}</span>
                    {country.name}
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-500">No countries found</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </label>
  );
}
