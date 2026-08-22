import { useEffect, useRef, useState } from "react";
import { client, type DialableContactSuggestion } from "../api/client";
import { parsePhoneForDialpad } from "../data/countryDialCodes";
import { findCountry } from "../data/countries";

interface DialerContactInputProps {
  value: string;
  onChange: (value: string) => void;
  onSelectContact: (info: { name: string; countryCode: string; digits: string }) => void;
  placeholder?: string;
  className?: string;
}

export function DialerContactInput({
  value,
  onChange,
  onSelectContact,
  placeholder = "Search contact or company name…",
  className = "",
}: DialerContactInputProps) {
  const [suggestions, setSuggestions] = useState<DialableContactSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const query = value.trim();
    if (query.length < 1) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await client.suggestDialableContacts(query);
        const rows = res.rows || [];
        setSuggestions(rows);
        setOpen(rows.length > 0);
      } catch {
        setSuggestions([]);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleSelect(item: DialableContactSuggestion) {
    const contactName = item.company_name || item.contact_name || item.label;
    onChange(contactName);
    setOpen(false);

    if (item.phone) {
      const parsed = parsePhoneForDialpad(
        item.phone,
        item.country ? findCountry(item.country)?.code ?? item.country : undefined,
      );
      if (parsed) {
        onSelectContact({
          name: contactName,
          countryCode: parsed.countryCode,
          digits: parsed.digits,
        });
      }
    }
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        placeholder={placeholder}
        className={`w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 transition ${className}`}
      />
      {loading && (
        <div className="absolute right-3 top-2.5 text-xs text-slate-500 animate-pulse">
          Searching…
        </div>
      )}
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 shadow-2xl divide-y divide-slate-800/80">
          {suggestions.map((item, idx) => (
            <button
              key={`${item.buyer_id}-${item.contact_id}-${idx}`}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => handleSelect(item)}
              className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-emerald-950/70 hover:text-emerald-300 transition flex flex-col gap-0.5 group"
            >
              <div className="flex items-center justify-between font-medium text-slate-100 group-hover:text-emerald-200">
                <span className="truncate">{item.company_name}</span>
                {item.country && (
                  <span className="text-[10px] text-slate-400 shrink-0 ml-2">{item.country}</span>
                )}
              </div>
              <div className="flex items-center justify-between text-slate-400 group-hover:text-slate-300">
                <span className="truncate">{item.contact_name}</span>
                <span className="font-mono text-emerald-400 text-[11px] shrink-0 ml-2">
                  {item.phone}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
