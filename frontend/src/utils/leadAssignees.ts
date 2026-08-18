/** Lead assignee helpers — values are app user IDs, "unassigned", or ai:male / ai:female. */

export const UNASSIGNED = "unassigned";

/** Mirrors backend modules/leads.py — sales reps assignable even if role was mis-set. */
export const ASSIGNABLE_SALES_USERNAMES = new Set([
  "asim",
  "usmankhan",
  "usman",
  "sadia",
  "sadiah",
  "rayan",
  "sara",
]);

export function isAssignableSalesUser(user: {
  role?: string | null;
  username?: string | null;
  is_active?: boolean;
}): boolean {
  if (!user.is_active) return false;
  if (user.role === "user") return true;
  const username = (user.username || "").trim().toLowerCase();
  return ASSIGNABLE_SALES_USERNAMES.has(username);
}

export const AI_SALES_ASSIGN_OPTIONS = [
  { value: "ai:male", label: "Rayan (AI Sales Agent)" },
  { value: "ai:female", label: "Sara (AI Sales Agent)" },
] as const;

export type LeadAssigneeOption = {
  value: string;
  label: string;
  username?: string;
};

export function isAiSalesAssignValue(value: string): boolean {
  return value === "ai:male" || value === "ai:female";
}

export function personaFromAiAssignValue(value: string): "male" | "female" | null {
  if (value === "ai:male") return "male";
  if (value === "ai:female") return "female";
  return null;
}

export function leadAssigneeLabel(
  value: string | number | null | undefined,
  options: LeadAssigneeOption[] = [],
): string {
  if (value == null || value === "" || value === UNASSIGNED) return "Unassigned";
  const key = String(value);
  const ai = AI_SALES_ASSIGN_OPTIONS.find((item) => item.value === key);
  if (ai) return ai.label;
  const match = options.find((item) => item.value === key);
  return match?.label ?? match?.username ?? key;
}

export function normalizeAssigneeValue(
  userId: number | null | undefined,
): string {
  if (userId == null) return UNASSIGNED;
  return String(userId);
}

export function parseAssigneeUserId(value: string): number | null {
  if (!value || value === UNASSIGNED || isAiSalesAssignValue(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function allAssigneeSelectOptions(
  users: LeadAssigneeOption[],
  current?: { userId?: number | null; label?: string | null },
): LeadAssigneeOption[] {
  const mapped = users.map((u) => ({
    value: u.value,
    label: u.username || u.label,
    username: u.username,
  }));
  if (current?.userId != null) {
    const key = String(current.userId);
    if (!mapped.some((u) => u.value === key)) {
      const label =
        (current.label && current.label !== "unassigned" ? current.label : null) || key;
      mapped.unshift({ value: key, label, username: label });
    }
  }
  return [
    { value: UNASSIGNED, label: "Unassigned" },
    ...mapped,
    ...AI_SALES_ASSIGN_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
  ];
}
