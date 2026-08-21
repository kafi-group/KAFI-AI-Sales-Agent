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
  multiple?: boolean;
}

export function CountrySelect({
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = "All countries",
  label,
  labelClassName = "text-xs text-slate-400",
  placeholder = "Search countries…",
  multiple = false,
}: CountrySelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedNames = useMemo(() => {
    if (!value) return [];
    return value.split(",").map(c => c.trim()).filter(Boolean);
  }, [value]);

  const selectedSingle = useMemo(() => {
    if (multiple) return null;
    return findCountry(value);
  }, [value, multiple]);

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
    if (!multiple) {
      onChange(country?.name ?? "");
      setOpen(false);
      setQuery("");
      return;
    }

    if (country === null) {
      onChange("");
      setQuery("");
      return;
    }

    const exists = selectedNames.includes(country.name);
    let next: string[];
    if (exists) {
      next = selectedNames.filter((n) => n !== country.name);
    } else {
      next = [...selectedNames, country.name];
    }
    onChange(next.join(", "));
  }

  const buttonLabel = useMemo(() => {
    if (multiple) {
      if (selectedNames.length === 0) {
        return allowEmpty ? emptyLabel : "Select countries";
      }
      if (selectedNames.length === 1) {
        const match = findCountry(selectedNames[0]);
        return match ? `${match.flag} ${match.name}` : selectedNames[0];
      }
      const flags = selectedNames
        .map((name) => findCountry(name)?.flag)
        .filter(Boolean)
        .join("");
      return `${flags} (${selectedNames.length})`;
    } else {
      return selectedSingle
        ? `${selectedSingle.flag} ${selectedSingle.name}`
        : allowEmpty
          ? emptyLabel
          : "Select country";
    }
  }, [multiple, selectedNames, selectedSingle, allowEmpty, emptyLabel]);

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
          <div className="absolute z-30 mt-1 min-w-[240px] w-full rounded-lg border border-slate-700 bg-slate-950 shadow-xl">
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
                    className="w-full px-3 py-2 text-left text-sm text-slate-400 hover:bg-slate-900 flex items-center gap-2"
                  >
                    {multiple && (
                      <input
                        type="checkbox"
                        checked={selectedNames.length === 0}
                        readOnly
                        className="h-4 w-4 shrink-0 rounded border-slate-600 accent-emerald-500"
                      />
                    )}
                    {emptyLabel}
                  </button>
                </li>
              )}
              {filtered.map((country) => {
                const isSelected = multiple
                  ? selectedNames.includes(country.name)
                  : selectedSingle?.code === country.code;
                return (
                  <li key={country.code}>
                    <button
                      type="button"
                      onClick={() => choose(country)}
                      className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-900 flex items-center gap-2 ${
                        isSelected
                          ? "bg-emerald-500/10 text-emerald-300 font-medium"
                          : "text-slate-200"
                      }`}
                    >
                      {multiple && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          readOnly
                          className="h-4 w-4 shrink-0 rounded border-slate-600 accent-emerald-500"
                        />
                      )}
                      <span className="mr-1">{country.flag}</span>
                      {country.name}
                    </button>
                  </li>
                );
              })}
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
