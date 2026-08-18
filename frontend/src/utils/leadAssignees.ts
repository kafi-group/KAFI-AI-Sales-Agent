/** Lead assignee helpers — values are app user IDs, "unassigned", or ai:male / ai:female. */

export const UNASSIGNED = "unassigned";

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
): LeadAssigneeOption[] {
  return [
    { value: UNASSIGNED, label: "Unassigned" },
    ...users.map((u) => ({
      value: u.value,
      label: u.username || u.label,
      username: u.username,
    })),
    ...AI_SALES_ASSIGN_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
  ];
}
