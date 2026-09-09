import { useEffect, useMemo, useRef, useState } from "react";
import {
  client,
  type CallFilterSectionOption,
  type DialableContactSuggestion,
} from "../api/client";
import { findCountry } from "../data/countries";

function contactKey(item: DialableContactSuggestion): string {
  return `${item.buyer_id}:${item.contact_id ?? "x"}:${item.phone}`;
}

interface AiSalesAgentQueuePickerProps {
  persona: "male" | "female";
  onPersonaChange: (persona: "male" | "female") => void;
  assigning: boolean;
  onAssign: (contacts: DialableContactSuggestion[]) => void;
}

export function AiSalesAgentQueuePicker({
  persona,
  onPersonaChange,
  assigning,
  onAssign,
}: AiSalesAgentQueuePickerProps) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<DialableContactSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<DialableContactSuggestion[]>([]);

  const [sectionFilter, setSectionFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState("");
  const [gradeFilter, setGradeFilter] = useState("");
  const [designationFilter, setDesignationFilter] = useState("");

  const [availableSections, setAvailableSections] = useState<CallFilterSectionOption[]>([]);
  const [availableCountries, setAvailableCountries] = useState<string[]>([]);
  const [availableGrades, setAvailableGrades] = useState<string[]>([]);
  const [availableDesignations, setAvailableDesignations] = useState<string[]>([]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedKeys = useMemo(() => new Set(selected.map(contactKey)), [selected]);

  useEffect(() => {
    let active = true;
    client
      .getCallFilterOptions()
      .then((res) => {
        if (!active) return;
        if (res.sections?.length) setAvailableSections(res.sections);
        if (res.countries?.length) setAvailableCountries(res.countries);
        if (res.grades?.length) setAvailableGrades(res.grades);
        if (res.designations?.length) setAvailableDesignations(res.designations);
      })
      .catch(() => {
        if (!active) return;
        setAvailableSections([
          { id: "", label: "All Sections / Master", icon: "🌐" },
          { id: "old_clients", label: "Old clients", icon: "👥" },
        ]);
        setAvailableCountries([
          "Kuwait",
          "Pakistan",
          "United Arab Emirates",
          "Saudi Arabia",
          "United States",
        ]);
        setAvailableGrades(["AAAA", "AAA", "AA", "A", "B", "Ungraded"]);
        setAvailableDesignations(["Managing Director", "Director", "CEO", "Owner", "Manager"]);
      });
    return () => {
      active = false;
    };
  }, []);

  const hasActiveFilters = Boolean(
    sectionFilter || countryFilter || gradeFilter || designationFilter || query.trim(),
  );

  useEffect(() => {
    const q = query.trim();
    if (!q && !sectionFilter && !countryFilter && !gradeFilter && !designationFilter) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await client.suggestDialableContacts({
          q: q || undefined,
          section: sectionFilter || undefined,
          country: countryFilter || undefined,
          grade: gradeFilter || undefined,
          designation: designationFilter || undefined,
          limit: 80,
        });
        const rows = res.rows || [];
        setSuggestions(rows);
        setOpen(true);
      } catch {
        setSuggestions([]);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    }, 150);

    return () => window.clearTimeout(timer);
  }, [query, sectionFilter, countryFilter, gradeFilter, designationFilter]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function toggleContact(item: DialableContactSuggestion) {
    const key = contactKey(item);
    setSelected((prev) => {
      if (prev.some((row) => contactKey(row) === key)) {
        return prev.filter((row) => contactKey(row) !== key);
      }
      return [...prev, item];
    });
  }

  function tickVisible() {
    setSelected((prev) => {
      const map = new Map(prev.map((row) => [contactKey(row), row]));
      for (const item of suggestions) {
        map.set(contactKey(item), item);
      }
      return Array.from(map.values());
    });
  }

  function handleClearFilters() {
    setSectionFilter("");
    setCountryFilter("");
    setGradeFilter("");
    setDesignationFilter("");
    setQuery("");
    setSuggestions([]);
    setOpen(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 items-end">
        <label className="text-sm text-slate-400">
          Agent
          <select
            value={persona}
            onChange={(e) => onPersonaChange(e.target.value as "male" | "female")}
            className="mt-1 block w-full min-w-[140px] rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
          >
            <option value="female">Sara (female)</option>
            <option value="male">Rayan (male)</option>
          </select>
        </label>
        <p className="text-xs text-slate-500 flex-1 min-w-[220px] pb-1">
          Filter Master Table contacts, tick names, then add them to {persona === "female" ? "Sara" : "Rayan"}
          &apos;s queue. After the queue is ready, call one number or start the full sequence.
        </p>
      </div>

      <div ref={containerRef} className="relative w-full space-y-2">
        <div>
          <label className="block text-[11px] font-medium text-cyan-400 mb-1">
            Filter by Lead List / Pool
          </label>
          <select
            value={sectionFilter}
            onChange={(e) => setSectionFilter(e.target.value)}
            className="w-full rounded-md bg-slate-900 border border-cyan-800/60 px-2.5 py-1.5 text-xs text-cyan-200 font-medium focus:outline-none focus:border-cyan-400"
          >
            <option value="">🌐 All Sections / Master Table</option>
            {availableSections.map((sec) => (
              <option key={sec.id || "all"} value={sec.id}>
                {sec.icon ? `${sec.icon} ` : ""}
                {sec.label}
                {sec.count != null ? ` (${sec.count.toLocaleString()})` : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">Filter Country</label>
            <select
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              className="w-full rounded-md bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-200"
            >
              <option value="">🌍 All Countries</option>
              {availableCountries.map((c) => {
                const info = findCountry(c);
                return (
                  <option key={c} value={c}>
                    {info ? `${info.flag} ${c}` : c}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">Filter Grade</label>
            <select
              value={gradeFilter}
              onChange={(e) => setGradeFilter(e.target.value)}
              className="w-full rounded-md bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-200"
            >
              <option value="">⭐ All Grades</option>
              {availableGrades.map((g) => (
                <option key={g} value={g}>
                  Grade {g}
                </option>
              ))}
              {!availableGrades.includes("Ungraded") && <option value="Ungraded">Ungraded</option>}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-slate-400 mb-1">Filter Designation</label>
          <select
            value={designationFilter}
            onChange={(e) => setDesignationFilter(e.target.value)}
            className="w-full rounded-md bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="">👔 All Designations</option>
            {availableDesignations.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>

        <div className="relative">
          <div className="flex items-center justify-between mb-1">
            <label className="block text-[11px] font-medium text-slate-400">
              Search Contact / Company / Phone
            </label>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="text-[10px] text-rose-400 hover:text-rose-300 underline"
              >
                Reset Filters
              </button>
            )}
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => {
              if (suggestions.length > 0) setOpen(true);
            }}
            placeholder="Type name, company, or phone — then tick contacts…"
            className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
          />
          {loading && (
            <div className="absolute right-3 top-9 text-xs text-slate-500 animate-pulse">Searching…</div>
          )}

          {open && (
            <div className="absolute z-50 left-0 right-0 mt-1 max-h-80 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 shadow-2xl">
              <div className="px-3 py-1.5 bg-slate-900/90 text-[10px] text-slate-400 font-medium flex items-center justify-between sticky top-0 backdrop-blur z-10">
                <span>
                  Matching contacts ({suggestions.length})
                  {countryFilter ? ` · ${countryFilter}` : ""}
                  {gradeFilter ? ` · ${gradeFilter}` : ""}
                  {designationFilter ? ` · ${designationFilter}` : ""}
                </span>
                {suggestions.length > 0 && (
                  <button
                    type="button"
                    onClick={tickVisible}
                    className="text-emerald-300 hover:text-emerald-200"
                  >
                    Tick all visible
                  </button>
                )}
              </div>
              {suggestions.length === 0 ? (
                <p className="px-3 py-3 text-xs text-slate-500">No matching Master Table contacts.</p>
              ) : (
                suggestions.map((item, idx) => {
                  const key = contactKey(item);
                  const checked = selectedKeys.has(key);
                  const countryInfo = item.country ? findCountry(item.country) : null;
                  return (
                    <label
                      key={`${key}-${idx}`}
                      className="flex items-start gap-2 px-3 py-2 text-xs text-slate-200 hover:bg-emerald-950/70 cursor-pointer border-t border-slate-800/80"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleContact(item)}
                        className="mt-0.5 accent-emerald-500"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center justify-between gap-2 font-medium">
                          <span className="truncate">{item.company_name || "(Company N/A)"}</span>
                          <span className="flex items-center gap-1.5 shrink-0">
                            {item.grading && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                {item.grading}
                              </span>
                            )}
                            {item.country && (
                              <span className="text-[10px] text-slate-400">
                                {countryInfo?.flag ? `${countryInfo.flag} ` : ""}
                                {item.country}
                              </span>
                            )}
                          </span>
                        </span>
                        <span className="flex items-center justify-between gap-2 text-slate-400 mt-0.5">
                          <span className="truncate">
                            {item.contact_name}
                            {item.designation ? ` · ${item.designation}` : ""}
                          </span>
                          <span className="font-mono text-emerald-400 text-[11px] shrink-0">{item.phone}</span>
                        </span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {selected.length > 0 && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-emerald-200 font-medium">{selected.length} ticked for the queue</p>
            <button
              type="button"
              onClick={() => setSelected([])}
              className="text-[10px] text-slate-400 hover:text-slate-200 underline"
            >
              Clear ticks
            </button>
          </div>
          <ul className="max-h-28 overflow-y-auto space-y-1 text-xs text-slate-300">
            {selected.map((item) => (
              <li key={contactKey(item)} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {item.contact_name || item.company_name} · {item.phone}
                </span>
                <button
                  type="button"
                  onClick={() => toggleContact(item)}
                  className="text-rose-400 hover:text-rose-300 shrink-0"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={assigning || selected.length === 0}
          onClick={() => {
            onAssign(selected);
            setSelected([]);
            setOpen(false);
          }}
          className="px-4 py-2 text-sm rounded-lg bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40"
        >
          {assigning
            ? "Adding…"
            : `Add ${selected.length || ""} ticked contact${selected.length === 1 ? "" : "s"} to ${
                persona === "female" ? "Sara" : "Rayan"
              }`}
        </button>
      </div>
    </div>
  );
}
