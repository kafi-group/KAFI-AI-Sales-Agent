import {
  AI_SALES_ASSIGN_OPTIONS,
  allAssigneeSelectOptions,
  leadAssigneeLabel,
  normalizeAssigneeValue,
  UNASSIGNED,
  type LeadAssigneeOption,
} from "../utils/leadAssignees";

export type AssigneeOption = LeadAssigneeOption;

interface AssignedToSelectProps {
  value: number | null | undefined;
  onChange: (userId: number | null, rawValue: string) => void;
  options: AssigneeOption[];
  disabled?: boolean;
  className?: string;
}

export function AssignedToSelect({
  value,
  onChange,
  options,
  disabled = false,
  className = "",
}: AssignedToSelectProps) {
  const selectValue = normalizeAssigneeValue(value);
  const items = allAssigneeSelectOptions(options);

  if (disabled) {
    return (
      <span className={`text-sm text-slate-300 ${className}`}>
        {leadAssigneeLabel(selectValue, items)}
      </span>
    );
  }

  return (
    <select
      value={selectValue}
      onChange={(e) => {
        const next = e.target.value;
        if (next === UNASSIGNED) {
          onChange(null, next);
          return;
        }
        if (next === "ai:male" || next === "ai:female") {
          onChange(null, next);
          return;
        }
        onChange(Number(next), next);
      }}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      className={`w-full rounded-md bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-200 ${className}`}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
}

export { AI_SALES_ASSIGN_OPTIONS };
