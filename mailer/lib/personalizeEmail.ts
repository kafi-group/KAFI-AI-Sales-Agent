/** Per-recipient merge fields — supports {{company_name}}, [company_name], [Company Name]. */

export type PersonalizeLead = {
  company_name?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  country?: string | null;
  industry?: string | null;
};

const FIELD_ALIASES: Record<string, Array<keyof PersonalizeLead | string>> = {
  company_name: ["company_name", "company name", "company"],
  contact_name: ["contact_name", "contact name", "contact", "name"],
  contact_email: ["contact_email", "contact email", "email"],
  country: ["country"],
  industry: ["industry"],
};

function fieldValue(lead: PersonalizeLead, key: string): string {
  const k = key as keyof PersonalizeLead;
  if (k === "contact_name") {
    return (lead.contact_name || lead.company_name || "Sir/Madam").trim();
  }
  if (k === "company_name") {
    return (lead.company_name || "").trim();
  }
  if (k === "contact_email") {
    return (lead.contact_email || "").trim();
  }
  return String(lead[k] ?? "").trim();
}

function aliasToCanonical(alias: string): string | null {
  const norm = alias.trim().toLowerCase().replace(/\s+/g, " ");
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase().replace(/\s+/g, " ") === norm)) {
      return canonical;
    }
  }
  return null;
}

export function personalizeEmailText(template: string, lead: PersonalizeLead): string {
  if (!template) return template;
  let out = template;

  // {{company_name}} and {{Company Name}}
  out = out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey: string) => {
    const canonical = aliasToCanonical(rawKey);
    return canonical ? fieldValue(lead, canonical) : _match;
  });

  // [company_name] and [Company Name]
  out = out.replace(/\[([^\]]+)\]/g, (match, rawKey: string) => {
    const canonical = aliasToCanonical(rawKey);
    return canonical ? fieldValue(lead, canonical) : match;
  });

  return out;
}
