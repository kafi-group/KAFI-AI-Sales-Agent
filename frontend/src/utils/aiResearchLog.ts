/** Local activity log for AI Research & Update sessions. */

export type AiResearchLogContact = {
  id: number;
  label: string;
  company_name?: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  filled_fields?: string[];
};

export type AiResearchLogEntry = {
  id: string;
  at: string;
  action: "opened" | "saved" | "returned";
  section?: string | null;
  contacts: AiResearchLogContact[];
  note?: string;
};

const STORAGE_KEY = "kafi-ai-research-log-v1";
const MAX_ENTRIES = 80;

function readRaw(): AiResearchLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AiResearchLogEntry[]) : [];
  } catch {
    return [];
  }
}

function writeRaw(entries: AiResearchLogEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* ignore quota */
  }
}

export function listAiResearchLog(): AiResearchLogEntry[] {
  return readRaw();
}

export function appendAiResearchLog(
  entry: Omit<AiResearchLogEntry, "id" | "at"> & { at?: string },
): AiResearchLogEntry {
  const full: AiResearchLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: entry.at || new Date().toISOString(),
    action: entry.action,
    section: entry.section ?? null,
    contacts: entry.contacts || [],
    note: entry.note,
  };
  const next = [full, ...readRaw()].slice(0, MAX_ENTRIES);
  writeRaw(next);
  return full;
}

export function clearAiResearchLog() {
  writeRaw([]);
}

export function formatAiResearchLogTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
