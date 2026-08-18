/** Per-recipient merge fields — supports {{company_name}}, [company_name], [Company Name]. */

export type PersonalizeLead = {
  company_name?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  designation?: string | null;
  country?: string | null;
  industry?: string | null;
};

const PLACEHOLDER_CONTACT_NAMES = new Set([
  "",
  "general contact",
  "contact",
  "n/a",
  "na",
  "-",
  "unknown",
  "sir/madam",
  "sir",
  "madam",
]);

const FIELD_ALIASES: Record<string, Array<keyof PersonalizeLead | string>> = {
  company_name: ["company_name", "company name", "company"],
  contact_name: [
    "contact_name",
    "contact name",
    "contact",
    "client name",
    "client_name",
    "client",
    "name",
  ],
  contact_email: ["contact_email", "contact email", "email"],
  designation: ["designation", "title", "job title", "job_title"],
  country: ["country"],
  industry: ["industry"],
};

export function isRealContactName(name: string | null | undefined): boolean {
  const trimmed = (name || "").trim();
  if (!trimmed) return false;
  return !PLACEHOLDER_CONTACT_NAMES.has(trimmed.toLowerCase());
}

/** Salutation: real contact → company name → empty (bare "Dear,"). */
export function resolveContactSalutationName(lead: PersonalizeLead): string {
  const contact = (lead.contact_name || "").trim();
  if (isRealContactName(contact)) return contact;
  const company = (lead.company_name || "").trim();
  return company;
}

function fieldValue(lead: PersonalizeLead, key: string): string {
  const k = key as keyof PersonalizeLead;
  if (k === "contact_name") {
    const contact = (lead.contact_name || "").trim();
    if (isRealContactName(contact)) return contact;
    return (lead.company_name || "").trim();
  }
  if (k === "company_name") {
    return (lead.company_name || "").trim();
  }
  if (k === "contact_email") {
    return (lead.contact_email || "").trim();
  }
  if (k === "designation") {
    return (lead.designation || "").trim();
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

function normalizeDearGreeting(text: string): string {
  return text
    .replace(/^Dear\s+,/im, "Dear,")
    .replace(/^Dear\s+\n/im, "Dear,\n")
    .replace(/^Dear\s+<\/p>/im, "Dear,</p>");
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

  return normalizeDearGreeting(out);
}

function plainBodyStart(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Prepend "Dear {name}," when the body does not already open with a salutation. */
export function ensureDearSalutation(body: string, contactName: string): string {
  const name = (contactName || "").trim();
  const greeting = name ? `Dear ${name},` : "Dear,";
  if (!body?.trim()) {
    return `${greeting}\n\n`;
  }
  if (/^dear\s*,?\s*$/i.test(plainBodyStart(body).split("\n")[0] || "")) return body;
  if (/^dear\s+/i.test(plainBodyStart(body))) return normalizeDearGreeting(body);
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  if (isHtml) {
    return normalizeDearGreeting(`<p>${greeting}</p>${body}`);
  }
  return normalizeDearGreeting(`${greeting}\n\n${body}`);
}
