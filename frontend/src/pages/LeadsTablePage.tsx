import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CountrySelect } from "../components/CountrySelect";
import { SearchableSelect, stringOptions } from "../components/SearchableSelect";
import type {
  LeadsTableSection,
} from "../components/AppSidebar";
import {
  assignedUserIdFromSection,
  isAssignedLeadsSection,
  isTargetedPoolSection,
  TARGETED_POOL_EXCLUDE,
} from "../components/AppSidebar";
import { formatCountryLabel } from "../data/countries";
import { ScoreBadge } from "../components/ScoreBadge";
import { MarketRoleBadge } from "../components/MarketRoleBadge";
import { CallRecommendationBadge } from "../components/CallRecommendationBadge";
import { ProducerTierBadge } from "../components/ProducerTierBadge";
import { AssignedToSelect, type AssigneeOption } from "../components/AssignedToSelect";
import { FollowUpScheduleControl } from "../components/FollowUpScheduleControl";
import { CreateLeadForm } from "../components/CreateLeadForm";
import { LeadsTableCsvImport } from "../components/LeadsTableCsvImport";
import { TargetedPoolLeadsTable } from "../components/TargetedPoolLeadsTable";
import { SocialLinksCell } from "../components/SocialLinksCell";
import { BulkEmailModal } from "../components/BulkEmailModal";
import { BulkWhatsAppModal } from "../components/BulkWhatsAppModal";
import {
  LeadWhatsAppComposeModal,
  type WhatsAppComposeTarget,
} from "../components/WhatsAppComposeLink";
import {
  BulkActionProgressPanel,
  type BulkActionProgress,
} from "../components/BulkActionProgressPanel";
import { CallLeadButton } from "../components/CallLeadButton";
import { WhatsAppLeadButton } from "../components/WhatsAppLeadButton";
import { DialpadPhoneText } from "../components/DialpadPhoneText";
import { EmailLeadButton } from "../components/EmailLeadButton";
import { Pagination } from "../components/Pagination";
import { ColumnVisibilityMenu } from "../components/ColumnVisibilityMenu";
import { ActionButton } from "../components/ui/ActionButton";
import { ToolbarDropdown, ToolbarMenuItem, ToolbarMenuLabel } from "../components/ui/ToolbarDropdown";
import {
  IconCheck,
  IconCheckSquare,
  IconCalendar,
  IconDownload,
  IconEdit,
  IconGear,
  IconList,
  IconMail,
  IconFilter,
  IconPlus,
  IconSearch,
  IconArchive,
  IconSend,
  IconTrash,
  IconUpload,
  IconWhatsApp,
  IconX,
  IconXCircle,
} from "../components/icons/AppIcons";
import {
  useColumnVisibility,
  type ColumnDef,
} from "../hooks/useColumnVisibility";
import { exportLeadsTableCsv } from "../utils/exportCsv";
import { UNASSIGNED } from "../utils/leadAssignees";
import { loadResearchPatience, RESEARCH_PATIENCE } from "../lib/researchPatience";

const SORT_FILTER_OPTIONS = [
  { value: "recent", label: "Recently added" },
  { value: "oldest", label: "Oldest first" },
  { value: "company_name", label: "Company name" },
  { value: "country", label: "Country" },
  { value: "latest_score", label: "AI company grading" },
  { value: "market_role", label: "Market role" },
];

const CALL_RECOMMENDED_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "yes", label: "Call now" },
  { value: "no", label: "Not now" },
  { value: "unknown", label: "Unknown" },
];
import {
  autocorrectLeadDraft,
  autocorrectText,
  leadFieldSpellingMode,
  spellingPropsForLeadField,
} from "../utils/spelling";
import { ManageModulesModal } from "../components/ManageModulesModal";
import {
  client,
  type CustomLeadModule,
  type LeadTableFilters,
  type LeadTableRow,
  type LeadTableRowUpdate,
  type LeadTableSectionCountsResponse,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";

const TABLE_PAGE_SIZE = 20;
const TABLE_VIEW_STORAGE_PREFIX = "kafi_leads_table_view";

const MOVE_MODULE_LABELS: Record<string, string> = {
  khalid_focused_sales: "📌 Khalid Focused Sales",
  follow_up_clients: "⏰ Follow up clients",
  interested_clients: "💜 Interested Clients",
  not_interested_clients: "🚫 Not interested",
  not_received_call_clients: "📞 Did not receive call",
  hyperstore_targeted: "🏪 Hyperstore Target",
  targeted_distributor: "🚚 Targeted Distributors",
  targeted_client: "🎯 Targeted Client",
  incomplete_archives: "📂 Incomplete Data from Archives",
  old_clients: "🏛️ Old clients",
  master: "📋 Master Table (FMCG)",
  testing: "🧪 Testing (Staff Numbers)",
};

const STANDARD_MOVE_MODULES = [
  "khalid_focused_sales",
  "follow_up_clients",
  "interested_clients",
  "not_interested_clients",
  "not_received_call_clients",
  "hyperstore_targeted",
  "targeted_distributor",
  "targeted_client",
  "incomplete_archives",
  "old_clients",
  "master",
] as const;

interface LeadsTablePageProps {
  section: LeadsTableSection;
  refreshToken?: number;
  onError: (message: string) => void;
  onSelectLead: (leadId: number) => void;
  onSectionCountsChange?: (counts: LeadTableSectionCountsResponse) => void;
  masterType?: string;
}

type SortField =
  | "created_at"
  | "company_name"
  | "country"
  | "latest_score"
  | "market_role"
  | "id"
  | "business_type"
  | "excel_file_grading"
  | "designation"
  | "contact_person"
  | "primary_mobile"
  | "secondary_mobile"
  | "phone"
  | "secondary_phone"
  | "email"
  | "secondary_email"
  | "product"
  | "website"
  | "city"
  | "ai_grading"
  | "address"
  | "calling_time"
  | "remarks"
  | "assigned_to_user_id";

interface StoredTableView {
  score: string;
  marketRole: string;
  country: string;
  industry: string;
  companyGrading: string;
  productInterest: string;
  city: string;
  callRecommended: string;
  search: string;
  sortBy: SortField;
  sortDir: "asc" | "desc";
}

const DEFAULT_TABLE_VIEW: StoredTableView = {
  score: "",
  marketRole: "",
  country: "",
  industry: "",
  companyGrading: "",
  productInterest: "",
  city: "",
  callRecommended: "",
  search: "",
  sortBy: "created_at",
  sortDir: "desc",
};

const LEADS_WIDE_COLUMNS: ColumnDef[] = [
  { id: "select", label: "Select", locked: true },
  { id: "serial", label: "S. No" },
  { id: "company", label: "Company Name", locked: true },
  { id: "business_type", label: "Business Type" },
  { id: "grading", label: "Companies Grading" },
  { id: "designation", label: "Designation" },
  { id: "contact_person", label: "Contact Person" },
  { id: "primary_mobile", label: "Primary Mobile No." },
  { id: "secondary_mobile", label: "Secondary Mobile No." },
  { id: "primary_phone", label: "Primary Phone No." },
  { id: "secondary_phone", label: "Secondary Phone No." },
  { id: "primary_email", label: "Primary Email" },
  { id: "secondary_email", label: "Secondary Email" },
  { id: "country", label: "Country" },
  { id: "product", label: "Product" },
  { id: "website", label: "Website" },
  { id: "city", label: "City" },
  { id: "ai_grading", label: "AI grading" },
  { id: "address", label: "Address" },
  { id: "added", label: "Added" },
  { id: "calling_time", label: "Calling time" },
  { id: "remarks", label: "Remarks" },
  { id: "assigned_to", label: "Assigned To" },
  { id: "socials", label: "Socials" },
  { id: "call_remarks", label: "Call remarks" },
  { id: "follow_up", label: "Follow-up reminder" },
  { id: "edit", label: "Edit" },
  { id: "actions", label: "Actions", locked: true },
];

/** Hyperstore / Targeted Distributors / Targeted Client — matches Kafi spreadsheet layout. */
const TARGETED_POOL_COLUMNS: ColumnDef[] = [
  { id: "select", label: "Select", locked: true },
  { id: "serial", label: "S. No." },
  { id: "company", label: "Company Name", locked: true },
  { id: "business_type", label: "Business Type" },
  { id: "designation", label: "Designation" },
  { id: "contact_person", label: "Contact Person" },
  { id: "primary_mobile", label: "Primary Mobile No." },
  { id: "secondary_mobile", label: "Secondary Mobile No." },
  { id: "primary_phone", label: "Primary Phone No." },
  { id: "secondary_phone", label: "Secondary Phone No." },
  { id: "primary_email", label: "Primary Email" },
  { id: "secondary_email", label: "Secondary Email" },
  { id: "country", label: "Country" },
  { id: "product", label: "Product" },
  { id: "city", label: "City" },
  { id: "address", label: "Address" },
  { id: "grading", label: "Grading" },
  { id: "remarks", label: "Remarks 02" },
  { id: "remarks_03", label: "Remarks 03" },
  { id: "date", label: "Date" },
  { id: "actions", label: "Actions", locked: true },
];

const LEADS_NARROW_COLUMNS: ColumnDef[] = [
  { id: "select", label: "Select", locked: true },
  { id: "serial", label: "#" },
  { id: "company", label: "Company name", locked: true },
  { id: "website", label: "Website" },
  { id: "email", label: "Email" },
  { id: "phone1", label: "Ph#1" },
  { id: "phone2", label: "Ph#2" },
  { id: "calling_time", label: "Calling time" },
  { id: "role", label: "Role" },
  { id: "ai_grading", label: "AI grading" },
  { id: "socials", label: "Socials" },
  { id: "added", label: "Added" },
  { id: "country", label: "Country" },
  { id: "assigned_to", label: "Assigned To" },
  { id: "edit", label: "Edit" },
  { id: "actions", label: "Actions", locked: true },
];

function formatAddedAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getRowFieldValue(row: LeadTableRow, field: string): string {
  let val: any = null;
  switch (field) {
    case "id":
      val = row.legacy_serial_no != null ? String(row.legacy_serial_no) : row.id;
      break;
    case "company_name":
      val = row.company_name;
      break;
    case "business_type":
      val = row.industry ?? (row as any).business_type;
      break;
    case "excel_file_grading":
      val = row.company_grading ?? (row as any).excel_file_grading;
      break;
    case "designation":
      val = row.contact_designation ?? (row as any).designation;
      break;
    case "contact_person":
      val = row.contact_name ?? (row as any).contact_person;
      break;
    case "primary_mobile":
      val = row.contact_phone ?? (row as any).primary_mobile;
      break;
    case "secondary_mobile":
      val = row.contact_secondary_mobile ?? (row as any).secondary_mobile;
      break;
    case "phone":
      val = row.contact_primary_phone ?? (row as any).phone;
      break;
    case "secondary_phone":
      val = row.contact_secondary_phone ?? (row as any).secondary_phone;
      break;
    case "email":
      val = row.contact_email ?? (row as any).email;
      break;
    case "secondary_email":
      val = row.contact_secondary_email ?? (row as any).secondary_email;
      break;
    case "country":
      val = row.country;
      break;
    case "product":
      val = row.product_interest ?? (row as any).product;
      break;
    case "website":
      val = row.website_url ?? (row as any).website;
      break;
    case "city":
      val = row.city;
      break;
    case "ai_grading":
    case "latest_score":
      val = row.latest_score ?? (row as any).ai_grading;
      break;
    case "address":
      val = row.address;
      break;
    case "created_at":
      if (!row.created_at) return "";
      const d = new Date(row.created_at);
      return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
    case "calling_time":
      val = (row as any).calling_time;
      break;
    case "remarks":
      val = row.remarks;
      break;
    case "assigned_to_user_id": {
      const assignedTo = (row as any).assigned_to;
      if (assignedTo && assignedTo !== "unassigned") return String(assignedTo).trim();
      if (row.assigned_to_user_id) return String(row.assigned_to_user_id).trim();
      return "";
    }
    case "market_role":
      val = row.market_role;
      break;
    default:
      val = (row as any)[field];
  }
  if (val === null || val === undefined) return "";
  const str = String(val).trim();
  if (str === "—" || str === "-") return "";
  return str;
}

function tableViewStorageKey(userId: number | undefined, section: LeadsTableSection): string {
  return `${TABLE_VIEW_STORAGE_PREFIX}:${userId ?? "anonymous"}:${section}`;
}

function readStoredTableView(
  userId: number | undefined,
  section: LeadsTableSection,
): StoredTableView {
  try {
    const raw = sessionStorage.getItem(tableViewStorageKey(userId, section));
    if (!raw) return { ...DEFAULT_TABLE_VIEW };
    const parsed = JSON.parse(raw) as Partial<StoredTableView>;
    const validSortFields: SortField[] = [
      "created_at",
      "company_name",
      "country",
      "latest_score",
      "market_role",
      "id",
      "business_type",
      "excel_file_grading",
      "designation",
      "contact_person",
      "primary_mobile",
      "secondary_mobile",
      "phone",
      "secondary_phone",
      "email",
      "secondary_email",
      "product",
      "website",
      "city",
      "ai_grading",
      "address",
      "calling_time",
      "remarks",
      "assigned_to_user_id",
    ];
    return {
      score: typeof parsed.score === "string" ? parsed.score : "",
      marketRole: typeof parsed.marketRole === "string" ? parsed.marketRole : "",
      country: typeof parsed.country === "string" ? parsed.country : "",
      industry: typeof parsed.industry === "string" ? parsed.industry : "",
      companyGrading:
        typeof parsed.companyGrading === "string" ? parsed.companyGrading : "",
      productInterest:
        typeof parsed.productInterest === "string" ? parsed.productInterest : "",
      city: typeof parsed.city === "string" ? parsed.city : "",
      callRecommended:
        typeof parsed.callRecommended === "string" ? parsed.callRecommended : "",
      search: typeof parsed.search === "string" ? parsed.search : "",
      sortBy:
        parsed.sortBy && validSortFields.includes(parsed.sortBy)
          ? parsed.sortBy
          : DEFAULT_TABLE_VIEW.sortBy,
      sortDir: parsed.sortDir === "asc" || parsed.sortDir === "desc"
        ? parsed.sortDir
        : DEFAULT_TABLE_VIEW.sortDir,
    };
  } catch {
    return { ...DEFAULT_TABLE_VIEW };
  }
}

const EDIT_INPUT =
  "w-full min-w-0 rounded-md bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-slate-200";

const TH = "py-3 px-3 text-left whitespace-nowrap align-middle";
const TD = "py-3 px-3 align-middle";
const TD_MUTED = `${TD} text-slate-400`;
const TD_PRIMARY = `${TD} text-slate-200 font-medium`;

/** Fixed column widths — company / website / email readable; calling time compact. */
const COL_SERIAL = "w-[65px] max-w-[65px] min-w-[65px]";
const COL_COMPANY = "w-[240px] max-w-[240px] min-w-[240px]";
const COL_COMPANY_OLD = "w-[220px] max-w-[220px] min-w-[220px]";
const COL_WEBSITE = "w-[160px] max-w-[160px] min-w-[160px]";
const COL_EMAIL = "w-[180px] max-w-[180px] min-w-[180px]";
const COL_EMAIL2 = "w-[160px] max-w-[160px] min-w-[160px]";
const COL_CALLING = "w-[110px] max-w-[110px] min-w-[110px]";
const COL_ROLE = "w-[133px] max-w-[133px] min-w-[133px]";
const COL_FIXED = "overflow-hidden";

function renderKycDetail(row: LeadTableRow) {
  const contactName = row.contact_name?.trim() || "";
  const designation = (row.contact_designation || (row as unknown as { designation?: string }).designation)?.trim() || "";
  const phone = row.contact_phone?.trim() || "";
  const secondaryPhone = (row.contact_secondary_mobile || row.contact_secondary_phone)?.trim() || "";
  const email = row.contact_email?.trim() || "";
  const secondaryEmail = row.contact_secondary_email?.trim() || "";

  return (
    <div className="space-y-6 text-left">
      {/* Contact Person & Role Card */}
      <div className="rounded-2xl border border-emerald-500/40 bg-slate-950/90 p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">👤</span>
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              Primary Contact Person
            </span>
          </div>
          {designation && (
            <span className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-1 text-xs font-semibold text-emerald-300">
              {designation}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Contact Name
            </label>
            <p className="text-xl font-bold text-slate-100 mt-0.5">
              {contactName || "General Contact / Not specified"}
            </p>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Designation / Role
            </label>
            <p className="text-lg font-semibold text-emerald-300 mt-0.5">
              {designation || "Not specified"}
            </p>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Primary Mobile Number
            </label>
            <p className="text-base font-mono font-bold text-sky-400 mt-0.5">
              {phone || "—"}
            </p>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Secondary Mobile / Phone
            </label>
            <p className="text-base font-mono font-medium text-slate-300 mt-0.5">
              {secondaryPhone || "—"}
            </p>
          </div>

          <div className="sm:col-span-2">
            <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Email Address
            </label>
            <p className="text-sm font-medium text-slate-200 mt-0.5">
              {email || "—"} {secondaryEmail ? `· ${secondaryEmail}` : ""}
            </p>
          </div>
        </div>
      </div>

      {/* Company & Market Information */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 space-y-3">
        <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2">
          <span className="text-xl">🏢</span>
          <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Company & Market Information
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div>
            <span className="text-xs text-slate-400 block">Country / Location</span>
            <span className="font-semibold text-slate-200">{[row.city, row.country].filter(Boolean).join(", ") || "—"}</span>
          </div>
          <div>
            <span className="text-xs text-slate-400 block">Business Type / Industry</span>
            <span className="font-semibold text-slate-200">{row.industry || "—"}</span>
          </div>
          <div>
            <span className="text-xs text-slate-400 block">Company Grading</span>
            <span className="font-semibold text-amber-300">{row.company_grading || "—"}</span>
          </div>
          {row.website_url && (
            <div className="col-span-2 sm:col-span-3">
              <span className="text-xs text-slate-400 block">Website</span>
              <a
                href={row.website_url.startsWith("http") ? row.website_url : `https://${row.website_url}`}
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 hover:underline break-all"
              >
                {row.website_url}
              </a>
            </div>
          )}
        </div>
      </div>

      {/* AI Score Reasoning / Research Notes */}
      {row.score_reasoning && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-5 space-y-2">
          <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2">
            <span className="text-lg">🤖</span>
            <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
              AI Research & Scoring Notes
            </span>
          </div>
          <p className="text-sm sm:text-base leading-relaxed text-slate-200 break-words whitespace-pre-wrap">
            {row.score_reasoning}
          </p>
        </div>
      )}
    </div>
  );
}

function ExpandableCell({
  text,
  className,
  detail,
  empty = "—",
  title = "Know Your Customer",
  openWhenEmpty = false,
}: {
  text: string | null | undefined;
  className?: string;
  detail?: ReactNode;
  empty?: string;
  title?: string;
  openWhenEmpty?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const value = (text ?? "").trim();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!value && !openWhenEmpty) {
    return <span className="text-slate-500">{empty}</span>;
  }

  const modalTitle = title === "Details" || !title || title === "Company name" ? "Know Your Customer" : title;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`block w-full truncate text-left cursor-pointer ${
          className ?? "text-slate-300 hover:text-slate-100"
        }`}
        title="Click to view full"
      >
        {value || empty}
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-md"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            role="presentation"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={modalTitle}
              className="w-full max-w-4xl rounded-3xl border-2 border-emerald-500/40 bg-slate-900 shadow-2xl overflow-hidden p-2"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-4 border-b border-slate-800 px-8 py-5 bg-slate-950/80">
                <h3 className="text-2xl font-extrabold tracking-wide text-emerald-400">{modalTitle}</h3>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-xl px-5 py-2.5 text-base font-bold text-slate-200 hover:bg-slate-800 hover:text-white bg-slate-800/80 border border-slate-700 transition"
                >
                  Close
                </button>
              </div>
              <div className="px-8 py-8 max-h-[80vh] overflow-y-auto space-y-6">
                {value ? (
                  <div>
                    {detail ? (
                      <h4 className="text-base font-semibold text-slate-300">
                        {value}
                      </h4>
                    ) : (
                      <p className="break-all whitespace-pre-wrap text-2xl sm:text-3xl font-bold leading-relaxed text-slate-100 selection:bg-emerald-500 selection:text-white">
                        {value}
                      </p>
                    )}
                  </div>
                ) : null}
                {detail ? (
                  <div className={value ? "border-t border-slate-800 pt-6" : ""}>
                    {detail}
                  </div>
                ) : null}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

const MAX_BULK_ONBOARD = 25;
const BULK_ONBOARD_DELAY_MS = 1000;
const BULK_DELETE_CHUNK = 40;

interface BulkOnboardRowResult {
  id: number;
  company_name: string;
  status: "success" | "failed";
  score?: string;
  reasoning?: string;
  filled_fields?: string[];
  error?: string;
}

function scoreLabel(score: string | null): string {
  return score ?? "Unscored";
}

function sectionTableScope(
  section: LeadsTableSection,
): {
  source?: string;
  exclude_source?: string;
  assigned_to_user_id?: number;
  master?: boolean;
} {
  if (section === "master") return { master: true };
  if (section === "old_clients") return { source: "old_clients" };
  if (section === "my_assigned") return {};
  if (section === "hyperstore_targeted") return { source: "hyperstore_targeted" };
  if (section === "targeted_distributor") return { source: "targeted_distributor" };
  if (section === "targeted_client") return { source: "targeted_client" };
  if (section === "incomplete_archives") return { source: "incomplete_archives" };
  if (section === "testing") return { source: "testing" };
  if (isAssignedLeadsSection(section)) {
    const userId = assignedUserIdFromSection(section);
    return userId != null ? { assigned_to_user_id: userId } : {};
  }
  if (section === "all") return { exclude_source: TARGETED_POOL_EXCLUDE };
  if (
    ![
      "interested_clients",
      "sales_interested_clients",
      "not_interested_clients",
      "not_received_call_clients",
    ].includes(section)
  ) {
    return { source: section };
  }
  return { exclude_source: "old_clients" };
}

function sectionTableParams(
  section: LeadsTableSection,
  intakeMethod: "upload" | "discover" | "all" = "all",
): {
  source?: string;
  exclude_source?: string;
  call_outcome?: string;
  in_interested_clients?: boolean;
  assigned_to_user_id?: number;
  my_assigned?: boolean;
  master?: boolean;
  intake_method?: string;
  new_search_lead_only?: boolean;
} {
  if (section === "master") return { master: true };
  if (section === "old_clients") return { source: "old_clients" };
  if (section === "my_assigned") return { my_assigned: true };
  if (section === "hyperstore_targeted") {
    return {
      source: "hyperstore_targeted",
      ...(intakeMethod !== "all" ? { intake_method: intakeMethod } : {}),
    };
  }
  if (section === "targeted_distributor") {
    return {
      source: "targeted_distributor",
      ...(intakeMethod !== "all" ? { intake_method: intakeMethod } : {}),
    };
  }
  if (section === "targeted_client") {
    return {
      source: "targeted_client",
      ...(intakeMethod !== "all" ? { intake_method: intakeMethod } : {}),
    };
  }
  if (section === "khalid_focused_sales") {
    return {
      source: "khalid_focused_sales",
      ...(intakeMethod !== "all" ? { intake_method: intakeMethod } : {}),
    };
  }
  if (section === "incomplete_archives") return { source: "incomplete_archives" };
  if (section === "testing") return { source: "testing" };
  if (section === "interested_clients") return { call_outcome: "follow_up" };
  if (section === "sales_interested_clients") return { in_interested_clients: true };
  if (section === "not_interested_clients") return { call_outcome: "not_interested" };
  if (section === "not_received_call_clients") return { call_outcome: "not_received_call" };
  if (isAssignedLeadsSection(section)) {
    const userId = assignedUserIdFromSection(section);
    return userId != null ? { assigned_to_user_id: userId } : {};
  }
  if (section === "all") {
    return { exclude_source: TARGETED_POOL_EXCLUDE, new_search_lead_only: true };
  }
  return { source: section };
}

function sectionTitle(
  section: LeadsTableSection,
  assigneeUsername?: string | null,
  isAdmin = true,
  masterType?: string,
  customModules?: CustomLeadModule[],
): string {
  if (section === "master") {
    return masterType === "minerals_ores"
      ? "Master Table (Minerals & Ores)"
      : masterType === "other_items"
      ? "Master Table (Other Items)"
      : "Master Table (FMCG)";
  }
  if (section === "old_clients") return isAdmin ? "Old clients" : "Clients";
  if (section === "khalid_focused_sales") return "Khalid Focused Sales";
  if (section === "my_assigned") return "Assigned";
  if (section === "hyperstore_targeted") return "Hyperstore Target";
  if (section === "targeted_distributor") return "Targeted Distributors";
  if (section === "targeted_client") return "Targeted Client";
  if (section === "incomplete_archives") return "Incomplete Data from Archives";
  if (section === "testing") return "Testing (Staff Numbers)";
  if (section === "interested_clients") return "Follow up clients";
  if (section === "sales_interested_clients") return "Interested Clients";
  if (section === "not_interested_clients") return "Not interested";
  if (section === "not_received_call_clients") return "Did not receive call";
  if (isAssignedLeadsSection(section)) {
    return `Leads Sent To ${assigneeUsername || "user"}`;
  }
  if (customModules) {
    const cm = customModules.find((m) => m.key === section);
    if (cm) return `${cm.icon ? cm.icon + " " : ""}${cm.name}`;
  }
  return "New search lead";
}

function sectionDescription(
  section: LeadsTableSection,
  assigneeUsername?: string | null,
  isAdmin = true,
  customModules?: CustomLeadModule[],
): string {
  if (section === "master") {
    return "Overview of every lead in the system — including leads sent to Asim, Usman, Sadia, or any other user.";
  }
  if (section === "khalid_focused_sales") {
    return "Leads specially selected for Mr. Khalid's focused sales outreach. Select any contact from Old clients, Master table, or New search lead and add them here.";
  }
  if (section === "hyperstore_targeted") {
    return "Hypermarkets and multi-branch retailers (10+ branches) — auto-classified from Old clients by name keywords, or add manually from any table.";
  }
  if (section === "targeted_distributor") {
    return "Distributors and wholesalers — auto-classified from Old clients (distributor, distribution, wholesale, etc.) or add manually from any table.";
  }
  if (section === "targeted_client") {
    return "Hand-picked priority clients — use Add to Targeted Client on any table row selection. No auto keyword matching.";
  }
  if (section === "incomplete_archives") {
    return "Partial rows from archives — name only, phone only, product only (e.g. Salt), or mixed columns. Edit manually or use Research to fill gaps. Promote to Old clients when complete (manual only).";
  }
  if (section === "testing") {
    return "Official Kafi Commodities staff recipients for daily morning bulk email & WhatsApp testing.";
  }
  if (section === "old_clients") {
    return isAdmin
      ? "All past clients from your spreadsheet — assigned and unassigned. Kept separate from Discover Leads — companies here are never mixed into new discoveries."
      : "Your client list from imports and past relationships. Import a spreadsheet to add clients — only you can see rows assigned to you.";
  }
  if (section === "my_assigned") {
    return "Leads assigned to you — from admin assignment or your own imports. Use this list for your daily calling and follow-ups.";
  }
  if (section === "interested_clients") {
    return "Clients moved here after a call is labeled Follow up — schedule the next call. This does not mean the client is interested.";
  }
  if (section === "sales_interested_clients") {
    return "Clients moved here when a call is labeled Client is Interested. You can also move leads here manually. They no longer appear in Scrapped Leads or Old clients.";
  }
  if (section === "not_interested_clients") {
    return "Clients moved here after a call is labeled Not interested. They no longer appear in Scrapped Leads or Old clients.";
  }
  if (section === "not_received_call_clients") {
    return "Clients moved here when a call is labeled Did not receive call. Use the calendar on each row to set when you want a reminder to try again.";
  }
  if (isAssignedLeadsSection(section)) {
    return `Only leads an admin sent to ${assigneeUsername || "this user"}. Their own spreadsheet imports stay on their account and do not appear here.`;
  }
  if (customModules) {
    const cm = customModules.find((m) => m.key === section);
    if (cm && cm.description) return cm.description;
  }
  return "AI-discovered leads from Discover Leads only (web search & scraping). Upload or import spreadsheets in Old clients or Incomplete Data from Archives — not here.";
}

function targetPoolIntakeMethod(section: LeadsTableSection): "upload" | "discover" {
  if (section === "old_clients" || section === "incomplete_archives" || section === "master")
    return "upload";
  if (section === "all") return "discover";
  if (isTargetedPoolSection(section)) return "upload";
  return "discover";
}

function targetPoolLabels(): Record<
  "hyperstore_targeted" | "targeted_distributor" | "targeted_client" | "khalid_focused_sales",
  string
> {
  return {
    hyperstore_targeted: "Hyperstore Target",
    targeted_distributor: "Targeted Distributors",
    targeted_client: "Targeted Client",
    khalid_focused_sales: "Khalid Focused Sales",
  };
}

function sectionEmptyMessage(section: LeadsTableSection): string | null {
  if (section === "master") {
    return "No leads in the system yet.";
  }
  if (section === "interested_clients") {
    return "No follow up clients yet. After a call, label the client as Follow up, then set the next call date with the calendar.";
  }
  if (section === "sales_interested_clients") {
    return "No Interested Clients yet. After a call, label the client as Client is Interested, or select leads and click Move to Interested Clients.";
  }
  if (section === "not_interested_clients") {
    return "No not interested clients yet. After a call, label the client as Not interested in post-call remarks.";
  }
  if (section === "not_received_call_clients") {
    return "No clients listed yet. After a call, label the client as Did not receive call, then set a reminder date with the calendar.";
  }
  if (section === "incomplete_archives") {
    return "No partial archive rows yet. Rows with only a name, phone, or product (e.g. Salt) land here instead of being deleted.";
  }
  if (section === "my_assigned") {
    return "No leads assigned to you yet. An admin can assign clients from Old clients, or import a spreadsheet to add your own.";
  }
  if (section === "all") {
    return "No AI-discovered leads yet. Use Discover Leads to search and import prospects — uploads belong in Old clients or Incomplete Data from Archives.";
  }
  if (isAssignedLeadsSection(section)) {
    return "No leads sent by an admin to this user yet. Assign leads from Scrapped Leads or Old clients to move them here.";
  }
  return null;
}

function rowDraftKey(row: LeadTableRow): string {
  return JSON.stringify({
    company_name: row.company_name,
    country: row.country,
    industry: row.industry,
    website_url: row.website_url,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone,
    linkedin_company_url: row.linkedin_company_url,
    facebook_company_url: row.facebook_company_url,
    instagram_company_url: row.instagram_company_url,
    legacy_serial_no: row.legacy_serial_no,
    company_grading: row.company_grading,
    product_interest: row.product_interest,
    city: row.city,
    address: row.address,
    remarks: row.remarks,
    remarks_03: row.remarks_03,
    remarks_04: row.remarks_04,
    assigned_to: row.assigned_to,
    assigned_to_user_id: row.assigned_to_user_id,
    follow_up_at: row.follow_up_at,
    contact_designation: row.contact_designation,
    contact_secondary_mobile: row.contact_secondary_mobile,
    contact_primary_phone: row.contact_primary_phone,
    contact_secondary_phone: row.contact_secondary_phone,
    contact_secondary_email: row.contact_secondary_email,
  });
}

function normalizeSocialUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function normalizeWebsiteUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
  return `https://${trimmed}`;
}

function buildUpdatePayload(draft: LeadTableRow): LeadTableRowUpdate {
  return {
    company_name: draft.company_name,
    country: draft.country ?? undefined,
    industry: draft.industry ?? undefined,
    website_url: normalizeWebsiteUrl(draft.website_url) ?? undefined,
    linkedin_company_url: normalizeSocialUrl(draft.linkedin_company_url),
    facebook_company_url: normalizeSocialUrl(draft.facebook_company_url),
    instagram_company_url: normalizeSocialUrl(draft.instagram_company_url),
    legacy_serial_no: draft.legacy_serial_no,
    company_grading: draft.company_grading,
    product_interest: draft.product_interest,
    city: draft.city,
    address: draft.address,
    remarks: draft.remarks,
    remarks_03: draft.remarks_03,
    remarks_04: draft.remarks_04,
    assigned_to_user_id: draft.assigned_to_user_id,
    contact_id: draft.contact_id ?? undefined,
    contact_name: draft.contact_name ?? undefined,
    contact_email: draft.contact_email ?? undefined,
    contact_phone: draft.contact_phone ?? undefined,
    contact_designation: draft.contact_designation,
    contact_secondary_mobile: draft.contact_secondary_mobile,
    contact_primary_phone: draft.contact_primary_phone,
    contact_secondary_phone: draft.contact_secondary_phone,
    contact_secondary_email: draft.contact_secondary_email,
  };
}

function FullscreenExpandIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function FullscreenCollapseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3M11 8v6M8 11h6" />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3M8 11h6" />
    </svg>
  );
}

const TABLE_ZOOM_MIN = 0.6;
const TABLE_ZOOM_MAX = 1.5;
const TABLE_ZOOM_STEP = 0.1;
const TABLE_ZOOM_DEFAULT = 1;

export function LeadsTablePage({
  section,
  refreshToken = 0,
  onError,
  onSelectLead,
  onSectionCountsChange,
  masterType = "fmcg",
}: LeadsTablePageProps) {
  const { isAdmin, user } = useAuth();
  const initialTableViewRef = useRef(readStoredTableView(user?.id, section));
  const restoringSectionRef = useRef(false);
  const previousSectionRef = useRef(section);
  const [assigneeOptions, setAssigneeOptions] = useState<AssigneeOption[]>([]);
  const [filters, setFilters] = useState<LeadTableFilters | null>(null);
  const [rows, setRows] = useState<LeadTableRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, LeadTableRow>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [originalKeys, setOriginalKeys] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [assigningId, setAssigningId] = useState<number | null>(null);
  const [bulkAssignValue, setBulkAssignValue] = useState("");
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [bulkOnboarding, setBulkOnboarding] = useState(false);
  const [researchPatience] = useState(() => loadResearchPatience());
  const [actionProgress, setActionProgress] = useState<BulkActionProgress | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkOnboardRowResult[] | null>(null);
  const [showBulkEmail, setShowBulkEmail] = useState(false);
  const [openingMailer, setOpeningMailer] = useState(false);
  const [openingScheduleMailer, setOpeningScheduleMailer] = useState(false);
  const [showBulkWhatsApp, setShowBulkWhatsApp] = useState(false);
  const [whatsappTargetIds, setWhatsappTargetIds] = useState<number[] | null>(null);
  const [whatsappComposeTarget, setWhatsappComposeTarget] =
    useState<WhatsAppComposeTarget | null>(null);
  const [bulkWhatsAppNotice, setBulkWhatsAppNotice] = useState<string | null>(null);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [intakeMethodFilter, setIntakeMethodFilter] = useState<"all" | "upload" | "discover">("all");
  const [movingToPool, setMovingToPool] = useState(false);
  const [moveConfirmTarget, setMoveConfirmTarget] = useState<{
    moduleKey: string;
    moduleLabel: string;
    count: number;
  } | null>(null);
  const [populatingPool, setPopulatingPool] = useState(false);
  const [removingFromPool, setRemovingFromPool] = useState(false);
  const [promotingIncomplete, setPromotingIncomplete] = useState(false);
  const [showCreateLead, setShowCreateLead] = useState(false);
  const [bulkEmailNotice, setBulkEmailNotice] = useState<string | null>(null);
  const [deduping, setDeduping] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [tableZoom, setTableZoom] = useState(TABLE_ZOOM_DEFAULT);
  const [topScrollWidth, setTopScrollWidth] = useState(0);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const tableZoomContentRef = useRef<HTMLDivElement>(null);
  const scrollSyncLockRef = useRef(false);

  const syncTopScrollWidth = useCallback(() => {
    const body = bodyScrollRef.current;
    if (!body) return;
    setTopScrollWidth(body.scrollWidth);
  }, []);

  const onTopHorizontalScroll = useCallback(() => {
    if (scrollSyncLockRef.current) return;
    const top = topScrollRef.current;
    const body = bodyScrollRef.current;
    if (!top || !body) return;
    scrollSyncLockRef.current = true;
    body.scrollLeft = top.scrollLeft;
    requestAnimationFrame(() => {
      scrollSyncLockRef.current = false;
    });
  }, []);

  const onBodyHorizontalScroll = useCallback(() => {
    if (scrollSyncLockRef.current) return;
    const top = topScrollRef.current;
    const body = bodyScrollRef.current;
    if (!top || !body) return;
    scrollSyncLockRef.current = true;
    top.scrollLeft = body.scrollLeft;
    requestAnimationFrame(() => {
      scrollSyncLockRef.current = false;
    });
  }, []);

  const zoomIn = useCallback(() => {
    setTableZoom((prev) =>
      Math.min(TABLE_ZOOM_MAX, Math.round((prev + TABLE_ZOOM_STEP) * 10) / 10),
    );
  }, []);

  const zoomOut = useCallback(() => {
    setTableZoom((prev) =>
      Math.max(TABLE_ZOOM_MIN, Math.round((prev - TABLE_ZOOM_STEP) * 10) / 10),
    );
  }, []);

  const resetZoom = useCallback(() => {
    setTableZoom(TABLE_ZOOM_DEFAULT);
  }, []);

  const showEmailNotice = useCallback((message: string) => {
    setBulkEmailNotice(message);
    window.setTimeout(() => setBulkEmailNotice(null), 8000);
  }, []);

  const openBulkMailer = useCallback(async () => {
    const ids = [...selected];
    if (!ids.length) return;
    // Localhost talks to 127.0.0.1 — Vercel mailer reports activity to Railway, so
    // local Email Activity stays empty. Use in-app send so activity hits this backend.
    if (import.meta.env.DEV) {
      setShowBulkEmail(true);
      showEmailNotice(
        "Localhost: using in-app email send so Email Activity logs here. Live uses Vercel mailer.",
      );
      return;
    }
    setOpeningMailer(true);
    try {
      // Production: Railway handoff → Vercel mailer URL (SMTP cannot run on Hobby).
      // Do not fall back to in-app BulkEmailModal unless mailer env is missing.
      const handoff = await client.createMailerHandoff(ids);
      const opened = window.open(handoff.url, "_blank", "noopener,noreferrer");
      if (!opened) {
        onError(
          "Pop-up blocked. Allow pop-ups for this site, then click Send emails again.",
        );
        return;
      }
      showEmailNotice(
        `Opened Vercel mailer with ${handoff.recipient_count} recipient${
          handoff.recipient_count === 1 ? "" : "s"
        }` +
          (handoff.skipped_no_email
            ? ` (${handoff.skipped_no_email} skipped — no email).`
            : "."),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to open mailer";
      const mailerMissing =
        /not configured|MAILER_HANDOFF_SECRET|MAILER_PUBLIC_URL/i.test(msg);
      if (mailerMissing) {
        // Local / misconfigured: old modal (still fails on Railway Hobby SMTP).
        showEmailNotice(
          "Vercel mailer not configured on Railway — using in-app compose (SMTP may fail on Hobby).",
        );
        setShowBulkEmail(true);
        return;
      }
      onError(msg);
    } finally {
      setOpeningMailer(false);
    }
  }, [selected, onError, showEmailNotice]);

  const openScheduleBulkMailer = useCallback(async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setOpeningScheduleMailer(true);
    try {
      const handoff = await client.createMailerHandoff(ids);
      const url = `${handoff.url}&schedule=1`;
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) {
        onError(
          "Pop-up blocked. Allow pop-ups for this site, then click Schedule bulk email again.",
        );
        return;
      }
      showEmailNotice(
        `Opened mailer to schedule ${handoff.recipient_count} recipient${
          handoff.recipient_count === 1 ? "" : "s"
        }. Pick date/time and click Schedule.`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to open schedule mailer");
    } finally {
      setOpeningScheduleMailer(false);
    }
  }, [selected, onError, showEmailNotice]);

  useEffect(() => {
    if (!isAdmin) {
      setAssigneeOptions([]);
      return;
    }
    client
      .listAssignees()
      .then((users) =>
        setAssigneeOptions(
          users.map((u) => ({
            value: String(u.id),
            label: u.full_name || u.username,
            username: u.username,
          })),
        ),
      )
      .catch(() => setAssigneeOptions([]));
  }, [isAdmin]);

  useEffect(() => {
    if (!isFullscreen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsFullscreen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isFullscreen]);

  const [score, setScore] = useState(initialTableViewRef.current.score);
  const [marketRole, setMarketRole] = useState(initialTableViewRef.current.marketRole);
  const [country, setCountry] = useState(initialTableViewRef.current.country);
  const [industry, setIndustry] = useState(initialTableViewRef.current.industry);
  const [companyGrading, setCompanyGrading] = useState(
    initialTableViewRef.current.companyGrading,
  );
  const [productInterest, setProductInterest] = useState(
    initialTableViewRef.current.productInterest,
  );
  const [city, setCity] = useState(initialTableViewRef.current.city);
  const [callRecommended, setCallRecommended] = useState(
    initialTableViewRef.current.callRecommended,
  );
  const [search, setSearch] = useState(initialTableViewRef.current.search);
  const [debouncedSearch, setDebouncedSearch] = useState(
    initialTableViewRef.current.search,
  );
  const [sortBy, setSortBy] = useState<SortField>(initialTableViewRef.current.sortBy);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialTableViewRef.current.sortDir);

  const [colFilterModal, setColFilterModal] = useState<{ field: SortField; label: string } | null>(null);
  const [colModalSearch, setColModalSearch] = useState("");
  const [selectedColValues, setSelectedColValues] = useState<Record<string, string[]>>({});
  const [pendingColSelections, setPendingColSelections] = useState<string[]>([]);
  const [colModalColumnData, setColModalColumnData] = useState<{
    field: string;
    total_matching: number;
    blank_count: number;
    unique_values: Array<{ value: string; count: number }>;
  } | null>(null);
  const [colModalLoading, setColModalLoading] = useState(false);

  function openColFilter(field: SortField, label: string) {
    setColFilterModal({ field, label });
    setColModalSearch("");
    setColModalColumnData(null);
    setPendingColSelections(selectedColValues[field] || []);
  }

  function renderColHeaderBtn(field: SortField, label: string) {
    const activeCount = selectedColValues[field]?.length || 0;
    return (
      <button
        type="button"
        onClick={() => openColFilter(field, label)}
        className="hover:text-emerald-300 flex items-center gap-1.5 font-bold transition-colors"
        title={`Click to filter & sort ${label}`}
      >
        <span>{label}</span>
        {sortIndicator(field)}
        {activeCount > 0 ? (
          <span className="bg-emerald-500 text-slate-950 text-[10px] font-extrabold px-1.5 py-0.5 rounded-full shadow-sm">
            {activeCount}
          </span>
        ) : (
          <span className="text-slate-500 text-xs">▼</span>
        )}
      </button>
    );
  }

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const isAssignedSection = isAssignedLeadsSection(section);
  const assignedSectionUserId = assignedUserIdFromSection(section);
  const assigneeUsername = isAssignedSection
    ? assigneeOptions.find((o) => o.value === String(assignedSectionUserId))?.username ||
      (user?.id === assignedSectionUserId ? user.username : null) ||
      null
    : null;

  /** Old-clients column set + filters on every leads table section. */
  const [showManageModules, setShowManageModules] = useState(false);
  const [customModules, setCustomModules] = useState<CustomLeadModule[]>([]);

  const loadCustomModules = useCallback(async () => {
    try {
      const list = await client.listCustomModules(false);
      setCustomModules(list);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadCustomModules();
  }, [loadCustomModules]);

  const useClientsFilters = true;
  const isOldClients = section === "old_clients";
  const isMyAssigned = section === "my_assigned";
  const isIncompleteArchives = section === "incomplete_archives";
  const isMaster = section === "master";
  const isTargetedPool = isTargetedPoolSection(section);
  const isTestingModule = section === "testing";
  const isCustomModule =
    !isOldClients &&
    !isMyAssigned &&
    !isIncompleteArchives &&
    !isMaster &&
    !isTargetedPool &&
    !isAssignedLeadsSection(section) &&
    section !== "all" &&
    section !== "interested_clients" &&
    section !== "sales_interested_clients" &&
    section !== "not_interested_clients" &&
    section !== "not_received_call_clients";

  const canImportSpreadsheet =
    section === "old_clients" ||
    isIncompleteArchives ||
    isTargetedPool ||
    isCustomModule ||
    isTestingModule;
  /** Every user can manually add leads on Clients / Master / targeted pools / custom modules — not New search lead. */
  const canAddLead =
    section === "old_clients" ||
    section === "incomplete_archives" ||
    section === "master" ||
    isTargetedPool ||
    isCustomModule ||
    isTestingModule;
  const createLeadSource =
    isIncompleteArchives
      ? "incomplete_archives"
      : isTargetedPool || isCustomModule || isTestingModule
        ? section
        : "old_clients";
  const canBulkAssign = isAdmin && (section === "all" || section === "old_clients" || isMaster || isCustomModule || isTestingModule);
  const importSource = isOldClients
    ? "old_clients"
    : isIncompleteArchives
      ? "incomplete_archives"
    : isTargetedPool || isCustomModule || isTestingModule
      ? section
      : "csv";
  const isCallOutcomeSection =
    section === "interested_clients" ||
    section === "sales_interested_clients" ||
    section === "not_interested_clients" ||
    section === "not_received_call_clients";
  const canScheduleFollowUp =
    section === "interested_clients" ||
    section === "sales_interested_clients" ||
    section === "not_received_call_clients";
  const callOutcomeEmptyMessage = sectionEmptyMessage(section);

  const isWideLayout =
    isOldClients ||
    isMyAssigned ||
    isIncompleteArchives ||
    isCallOutcomeSection ||
    isTargetedPool ||
    isCustomModule ||
    isTestingModule;
  /** Same spreadsheet-style table as Old clients (not Discover narrow layout). */
  const usesOldClientsTable =
    isOldClients ||
    isMyAssigned ||
    isIncompleteArchives ||
    isCallOutcomeSection ||
    isCustomModule ||
    isTestingModule;
  const columnDefs = useMemo(() => {
    const base = isTargetedPool
      ? TARGETED_POOL_COLUMNS
      : isWideLayout
        ? LEADS_WIDE_COLUMNS
        : LEADS_NARROW_COLUMNS;
    return base.filter((col) => {
      if (col.id === "call_remarks" && !isCallOutcomeSection) return false;
      if (col.id === "follow_up" && !canScheduleFollowUp) return false;
      if (col.id === "edit" && !editMode) return false;
      return true;
    });
  }, [isWideLayout, isTargetedPool, isCallOutcomeSection, canScheduleFollowUp, editMode]);
  const columnsUi = useColumnVisibility(
    isTargetedPool ? "leads.targeted" : isWideLayout ? "leads.wide" : "leads.narrow",
    columnDefs,
    user?.id,
  );

  useEffect(() => {
    syncTopScrollWidth();
    const content = tableZoomContentRef.current;
    const body = bodyScrollRef.current;
    if (!content && !body) return;

    const observer = new ResizeObserver(() => {
      syncTopScrollWidth();
    });
    if (content) observer.observe(content);
    if (body) observer.observe(body);
    window.addEventListener("resize", syncTopScrollWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncTopScrollWidth);
    };
  }, [
    syncTopScrollWidth,
    rows,
    tableZoom,
    isOldClients,
    isCallOutcomeSection,
    isFullscreen,
    canScheduleFollowUp,
  ]);

  useEffect(() => {
    setIntakeMethodFilter("all");
    setPage(1);
  }, [section]);

  const tableQueryParams = useMemo(
    () => {
      const colFiltersParams: Record<string, string> = {};
      Object.entries(selectedColValues).forEach(([f, vals]) => {
        if (vals && vals.length > 0) {
          colFiltersParams[f] = vals.join(",");
        }
      });

      return {
        score: useClientsFilters ? undefined : score || undefined,
        market_role: useClientsFilters ? undefined : marketRole || undefined,
        country: country || undefined,
        industry: useClientsFilters ? industry || undefined : undefined,
        company_grading: useClientsFilters ? companyGrading || undefined : undefined,
        product_interest: useClientsFilters ? productInterest || undefined : undefined,
        city: useClientsFilters ? city || undefined : undefined,
        call_recommended: useClientsFilters ? callRecommended || undefined : undefined,
        q: debouncedSearch.trim() || undefined,
        sort_by: sortBy,
        sort_dir: sortDir,
        master_type: masterType,
        ...sectionTableParams(section, intakeMethodFilter),
        ...colFiltersParams,
      };
    },
    [
      callRecommended,
      city,
      companyGrading,
      country,
      industry,
      useClientsFilters,
      marketRole,
      productInterest,
      score,
      debouncedSearch,
      section,
      sortBy,
      sortDir,
      intakeMethodFilter,
      masterType,
      selectedColValues,
    ],
  );

  const companyGradingOptions = useMemo(() => {
    const raw = filters?.company_gradings ?? [];
    const standard = ["AAAA", "AAA", "AA", "A"];
    const standardSet = new Set(standard.map((s) => s.toLowerCase()));
    const other = raw.filter((g) => g && !standardSet.has(g.trim().toLowerCase()));
    return stringOptions([...standard, ...other]);
  }, [filters?.company_gradings]);

  const aiScoreOptions = useMemo(() => {
    const raw = filters?.scores ?? ["AAAA", "AAA", "AA", "A", "Unscored"];
    const standard = ["AAAA", "AAA", "AA", "A", "Unscored"];
    const standardSet = new Set(standard.map((s) => s.toLowerCase()));
    const other = raw.filter((s) => s && !standardSet.has(s.trim().toLowerCase()));
    return stringOptions([...standard, ...other]);
  }, [filters?.scores]);

  useEffect(() => {
    if (!colFilterModal) {
      setColModalColumnData(null);
      setColModalLoading(false);
      return;
    }
    let active = true;
    setColModalLoading(true);

    const paramsExceptField: Record<string, any> = { ...tableQueryParams };
    delete paramsExceptField[colFilterModal.field];

    client
      .getLeadTableColumnValues(colFilterModal.field, paramsExceptField)
      .then((res) => {
        if (active) setColModalColumnData(res);
      })
      .catch((err) => {
        console.warn("Failed to load overall column values", err);
      })
      .finally(() => {
        if (active) setColModalLoading(false);
      });

    return () => {
      active = false;
    };
  }, [colFilterModal?.field, JSON.stringify(tableQueryParams)]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAllMatchingSelected(false);
  }, []);

  const [sectionCounts, setSectionCounts] = useState<Record<string, number>>({});

  const loadSectionCounts = useCallback(async () => {
    try {
      const counts = await client.getLeadsTableSectionCounts(masterType);
      setSectionCounts(counts as any);
      if (onSectionCountsChange) {
        onSectionCountsChange({
          ...counts,
          by_assignee: counts.by_assignee ?? {},
        });
      }
    } catch {
      /* optional */
    }
  }, [onSectionCountsChange, masterType]);

  const loadTable = useCallback(async () => {
    setLoading(true);
    try {
      const result = await client.listLeadsTable({
        ...tableQueryParams,
        page,
        page_size: TABLE_PAGE_SIZE,
      });
      setRows(result.rows);
      setTotal(result.total);
      setFilteredCount(result.filtered_count);
      setTotalPages(result.total_pages);
      setPage(result.page);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load leads table");
    } finally {
      setLoading(false);
    }
  }, [onError, page, tableQueryParams]);

  useEffect(() => {
    setPage(1);
    clearSelection();
  }, [
    clearSelection,
    section,
    score,
    marketRole,
    country,
    industry,
    companyGrading,
    productInterest,
    city,
    callRecommended,
    debouncedSearch,
    sortBy,
    sortDir,
  ]);

  useEffect(() => {
    if (previousSectionRef.current === section) return;

    previousSectionRef.current = section;
    restoringSectionRef.current = true;
    const stored = readStoredTableView(user?.id, section);
    setScore(stored.score);
    setMarketRole(stored.marketRole);
    setCountry(stored.country);
    setIndustry(stored.industry);
    setCompanyGrading(stored.companyGrading);
    setProductInterest(stored.productInterest);
    setCity(stored.city);
    setCallRecommended(stored.callRecommended);
    setSearch(stored.search);
    setDebouncedSearch(stored.search);
    setSortBy(stored.sortBy);
    setSortDir(stored.sortDir);
  }, [section, user?.id]);

  useEffect(() => {
    if (restoringSectionRef.current) {
      restoringSectionRef.current = false;
      return;
    }
    try {
      const view: StoredTableView = {
        score,
        marketRole,
        country,
        industry,
        companyGrading,
        productInterest,
        city,
        callRecommended,
        search,
        sortBy,
        sortDir,
      };
      sessionStorage.setItem(tableViewStorageKey(user?.id, section), JSON.stringify(view));
    } catch {
      /* Storage may be unavailable; the table still works with in-memory state. */
    }
  }, [
    callRecommended,
    city,
    companyGrading,
    country,
    industry,
    marketRole,
    productInterest,
    score,
    search,
    section,
    sortBy,
    sortDir,
    user?.id,
  ]);

  useEffect(() => {
    client
      .listLeadTableFilters(isOldClients || isMyAssigned ? { source: "old_clients" } : {})
      .then(setFilters)
      .catch(() => {});
    void loadSectionCounts();
  }, [isOldClients, isMyAssigned, isMaster, loadSectionCounts]);

  useEffect(() => {
    void loadTable();
  }, [loadTable]);

  useEffect(() => {
    if (refreshToken > 0) {
      void loadTable();
      void loadSectionCounts();
    }
  }, [loadSectionCounts, loadTable, refreshToken]);

  useEffect(() => {
    setEditMode(false);
    setDrafts({});
    setOriginalKeys({});
    setBulkResults(null);
    setSaveNotice(null);
    setShowCsvImport(false);
    setShowCreateLead(false);
    setBulkAssignValue("");
    clearSelection();
  }, [clearSelection, section]);

  function enterEditMode() {
    setDrafts(Object.fromEntries(rows.map((row) => [row.id, { ...row }])));
    setOriginalKeys(Object.fromEntries(rows.map((row) => [row.id, rowDraftKey(row)])));
    setEditMode(true);
    setSaveNotice(null);
  }

  function updateDraft(rowId: number, field: keyof LeadTableRow, value: string) {
    setDrafts((prev) => {
      const current = prev[rowId];
      if (!current) return prev;
      let nextValue: string | number | null = value || null;
      if (field === "legacy_serial_no") {
        const trimmed = value.trim();
        if (!trimmed) nextValue = null;
        else {
          const parsed = Number(trimmed);
          nextValue = Number.isFinite(parsed) ? Math.trunc(parsed) : current.legacy_serial_no;
        }
      }
      return {
        ...prev,
        [rowId]: {
          ...current,
          [field]: nextValue,
        },
      };
    });
  }

  function commitDraftField(rowId: number, field: keyof LeadTableRow, value: string) {
    const mode = leadFieldSpellingMode(String(field));
    if (mode === "off") {
      updateDraft(rowId, field, value);
      return;
    }
    updateDraft(rowId, field, autocorrectText(value, mode));
  }

  function isRowDirty(rowId: number): boolean {
    const draft = drafts[rowId];
    if (!draft) return false;
    return rowDraftKey(draft) !== originalKeys[rowId];
  }

  const dirtyCount = useMemo(
    () => Object.keys(drafts).filter((id) => isRowDirty(Number(id))).length,
    [drafts, originalKeys],
  );

  function applyAssigneeMove(
    rowId: number,
    updated: LeadTableRow,
    previousAssigneeId: number | null | undefined,
  ) {
    const assignedToUserId = updated.assigned_to_user_id;
    const assigneeChanged = previousAssigneeId !== assignedToUserId;
    const leavesPoolSection =
      assigneeChanged &&
      (section === "all" || section === "old_clients") &&
      assignedToUserId != null;
    const leavesAssignedSection =
      assigneeChanged &&
      isAssignedSection &&
      (assignedToUserId == null || assignedToUserId !== assignedSectionUserId);
    const leavesMyAssignedSection =
      assigneeChanged &&
      isMyAssigned &&
      (assignedToUserId == null || assignedToUserId !== user?.id);

    if (leavesPoolSection || leavesAssignedSection || leavesMyAssignedSection) {
      setRows((prev) => prev.filter((row) => row.id !== rowId));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
      setOriginalKeys((prev) => {
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
      setTotal((prev) => Math.max(0, prev - 1));
      setFilteredCount((prev) => Math.max(0, prev - 1));
      return true;
    }

    setRows((prev) => prev.map((row) => (row.id === rowId ? updated : row)));
    setDrafts((prev) => ({ ...prev, [rowId]: updated }));
    setOriginalKeys((prev) => ({ ...prev, [rowId]: rowDraftKey(updated) }));
    return false;
  }

  async function saveRow(rowId: number) {
    const raw = draftsRef.current[rowId];
    if (!raw) return;
    const draft = autocorrectLeadDraft(raw);
    if (draft !== raw) {
      setDrafts((prev) => ({ ...prev, [rowId]: draft }));
    }
    const previousAssigneeId = rows.find((r) => r.id === rowId)?.assigned_to_user_id ?? null;

    setSavingId(rowId);
    setSaveNotice(null);
    try {
      const payload = buildUpdatePayload(draft);
      if (!isAdmin) {
        delete payload.assigned_to_user_id;
      }
      const updated = await client.updateLeadTableRow(rowId, payload);
      applyAssigneeMove(rowId, updated, previousAssigneeId);
      await loadSectionCounts();
      setSaveNotice("Row saved.");
      setTimeout(() => setSaveNotice(null), 3000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save row");
    } finally {
      setSavingId(null);
    }
  }

  async function saveAssignedTo(rowId: number, assignedToUserId: number | null) {
    if (!isAdmin) {
      onError("Only an admin can assign leads to users.");
      return;
    }
    setAssigningId(rowId);
    try {
      const previousAssigneeId = rows.find((r) => r.id === rowId)?.assigned_to_user_id ?? null;
      const updated = await client.updateLeadTableRow(rowId, {
        assigned_to_user_id: assignedToUserId,
      });
      applyAssigneeMove(rowId, updated, previousAssigneeId);
      await loadSectionCounts();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update assignee");
    } finally {
      setAssigningId(null);
    }
  }

  async function bulkAssignSelected(rawValue: string) {
    if (!canBulkAssign || !rawValue || bulkAssigning) {
      setBulkAssignValue("");
      return;
    }

    const assignedToUserId = rawValue === UNASSIGNED ? null : Number(rawValue);
    if (rawValue !== UNASSIGNED && !Number.isFinite(assignedToUserId)) {
      setBulkAssignValue("");
      return;
    }

    let ids = [...selected];
    if (ids.length === 0) {
      if (filteredCount === 0) {
        setBulkAssignValue("");
        return;
      }
      setBulkAssigning(true);
      try {
        const result = await client.listLeadsTableIds(tableQueryParams);
        ids = result.ids;
      } catch (e) {
        onError(e instanceof Error ? e.message : "Failed to load matching leads");
        setBulkAssignValue("");
        setBulkAssigning(false);
        return;
      }
    }

    const label =
      assignedToUserId == null
        ? "Unassigned"
        : assigneeOptions.find((o) => o.value === String(assignedToUserId))?.label ||
          assigneeOptions.find((o) => o.value === String(assignedToUserId))?.username ||
          "selected user";

    const count = ids.length;
    const usingFilter = selected.size === 0;
    const confirmed = window.confirm(
      assignedToUserId == null
        ? `Unassign ${count} lead${count === 1 ? "" : "s"}${usingFilter ? " matching current filters" : ""}?`
        : `Assign ${count} lead${count === 1 ? "" : "s"}${usingFilter ? " matching current filters" : ""} to ${label}?`,
    );
    if (!confirmed) {
      setBulkAssignValue("");
      if (usingFilter) setBulkAssigning(false);
      return;
    }

    setBulkAssigning(true);
    setSaveNotice(null);
    try {
      const result = await client.bulkAssignLeadTableRows(ids, assignedToUserId);
      const movedIds = new Set(result.assigned_ids);
      if (movedIds.size > 0) {
        setRows((prev) => prev.filter((row) => !movedIds.has(row.id)));
        setDrafts((prev) => {
          const next = { ...prev };
          for (const id of movedIds) delete next[id];
          return next;
        });
        setOriginalKeys((prev) => {
          const next = { ...prev };
          for (const id of movedIds) delete next[id];
          return next;
        });
        setTotal((prev) => Math.max(0, prev - movedIds.size));
        setFilteredCount((prev) => Math.max(0, prev - movedIds.size));
      }
      clearSelection();
      await loadSectionCounts();
      setSaveNotice(
        assignedToUserId == null
          ? `Unassigned ${result.assigned_count} lead${result.assigned_count === 1 ? "" : "s"}.`
          : result.transfer_message ||
              `Assigned ${result.assigned_count} lead${result.assigned_count === 1 ? "" : "s"} to ${result.assigned_to}.`,
      );
      setTimeout(() => setSaveNotice(null), 4000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to bulk assign leads");
    } finally {
      setBulkAssignValue("");
      setBulkAssigning(false);
    }
  }

  async function moveSelectedToTargetPool(
    pool: "hyperstore_targeted" | "targeted_distributor" | "targeted_client" | "khalid_focused_sales",
  ) {
    if (!isAdmin || selected.size === 0 || movingToPool) return;
    const labels = targetPoolLabels();
    const count = selected.size;
    const intake = targetPoolIntakeMethod(section);
    const confirmed = window.confirm(
      `Move ${count} selected lead${count === 1 ? "" : "s"} to ${labels[pool]}?`,
    );
    if (!confirmed) return;

    setMovingToPool(true);
    setSaveNotice(null);
    try {
      const result = await client.setTargetPool([...selected], pool, intake);
      const movedIds = new Set(result.updated_ids);
      if (movedIds.size > 0) {
        setRows((prev) => prev.filter((row) => !movedIds.has(row.id)));
        setTotal((prev) => Math.max(0, prev - movedIds.size));
        setFilteredCount((prev) => Math.max(0, prev - movedIds.size));
        clearSelection();
      }
      await loadSectionCounts();
      setSaveNotice(
        `Moved ${result.updated_count} lead${result.updated_count === 1 ? "" : "s"} to ${labels[pool]}.`,
      );
      window.setTimeout(() => setSaveNotice(null), 5000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to move leads to targeted pool");
    } finally {
      setMovingToPool(false);
    }
  }

  async function populateTargetPoolFrom(
    fromSource: "old_clients" | "discover" | "discover_leads",
  ) {
    if (!isAdmin || !isTargetedPool || populatingPool) return;
    if (section === "targeted_client") return;
    const label =
      fromSource === "old_clients"
        ? "Old clients"
        : fromSource === "discover_leads"
          ? "Discover Leads"
          : "New search leads";
    const confirmed = window.confirm(
      fromSource === "discover_leads"
        ? `Fetch up to 50 matching leads from Discover Leads into ${sectionTitle(section, assigneeUsername, isAdmin)}? Existing rows stay — only new matches are added as AI / search leads.`
        : `Intelligently add up to 50 matching leads from ${label} into this targeted pool? Existing rows stay — only new matches are added.`,
    );
    if (!confirmed) return;

    setPopulatingPool(true);
    setSaveNotice(null);
    try {
      const result = await client.populateTargetPool(section, fromSource, 50);
      await loadTable();
      await loadSectionCounts();
      setSaveNotice(
        result.updated_count > 0
          ? fromSource === "discover_leads"
            ? `Fetched ${result.updated_count} lead${result.updated_count === 1 ? "" : "s"} from Discover Leads (scanned ${result.scanned}).`
            : `Added ${result.updated_count} lead${result.updated_count === 1 ? "" : "s"} from ${label} (scanned ${result.scanned}).`
          : fromSource === "discover_leads"
            ? `No new matches in Discover Leads for this pool (scanned ${result.scanned}).`
            : `No new matches found in ${label} for this pool (scanned ${result.scanned}).`,
      );
      window.setTimeout(() => setSaveNotice(null), 6000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to populate targeted pool");
    } finally {
      setPopulatingPool(false);
    }
  }

  async function fetchDiscoverLeadsIntoPool() {
    if (intakeMethodFilter !== "discover") {
      setIntakeMethodFilter("discover");
      setPage(1);
    }
    await populateTargetPoolFrom("discover_leads");
  }

  async function promoteSelectedFromIncompleteArchives() {
    if (!isAdmin || !isIncompleteArchives || selected.size === 0 || promotingIncomplete) return;
    const count = selected.size;
    const confirmed = window.confirm(
      `Promote ${count} selected row${count === 1 ? "" : "s"} to Old clients? (Manual promotion only.)`,
    );
    if (!confirmed) return;
    setPromotingIncomplete(true);
    try {
      const result = await client.promoteIncompleteArchives([...selected]);
      const moved = new Set(result.promoted_ids);
      if (moved.size > 0) {
        setRows((prev) => prev.filter((row) => !moved.has(row.id)));
        setTotal((prev) => Math.max(0, prev - moved.size));
        setFilteredCount((prev) => Math.max(0, prev - moved.size));
        clearSelection();
      }
      await loadSectionCounts();
      setSaveNotice(
        `Promoted ${result.promoted_count} row${result.promoted_count === 1 ? "" : "s"} to Old clients.`,
      );
      window.setTimeout(() => setSaveNotice(null), 5000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to promote rows");
    } finally {
      setPromotingIncomplete(false);
    }
  }

  async function removeSelectedFromTargetPool() {
    if (!isAdmin || !isTargetedPool || selected.size === 0 || removingFromPool) return;
    const count = selected.size;
    const confirmed = window.confirm(
      `Remove ${count} lead${count === 1 ? "" : "s"} from this targeted pool? They will return to Old clients or New search lead — not deleted.`,
    );
    if (!confirmed) return;

    setRemovingFromPool(true);
    setSaveNotice(null);
    try {
      const result = await client.removeFromTargetPool([...selected]);
      const removed = new Set(result.updated_ids);
      if (removed.size > 0) {
        setRows((prev) => prev.filter((row) => !removed.has(row.id)));
        setTotal((prev) => Math.max(0, prev - removed.size));
        setFilteredCount((prev) => Math.max(0, prev - removed.size));
        clearSelection();
      }
      await loadSectionCounts();
      setSaveNotice(
        `Removed ${result.updated_count} lead${result.updated_count === 1 ? "" : "s"} from this pool.`,
      );
      window.setTimeout(() => setSaveNotice(null), 5000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to remove leads from pool");
    } finally {
      setRemovingFromPool(false);
    }
  }

  function confirmMoveToModule(moduleKey: string) {
    if (selected.size === 0 || movingToModule) return;
    const custom = customModules.find((module) => module.key === moduleKey);
    const label = custom
      ? `${custom.icon ? `${custom.icon} ` : ""}${custom.name}`
      : MOVE_MODULE_LABELS[moduleKey] || moduleKey.replaceAll("_", " ");
    setMoveConfirmTarget({
      moduleKey,
      moduleLabel: label,
      count: selected.size,
    });
  }

  async function moveSelectedToInterestedClients(inList: boolean) {
    if (selected.size === 0) return;
    const count = selected.size;
    const confirmed = window.confirm(
      inList
        ? `Move ${count} selected lead${count === 1 ? "" : "s"} to Interested Clients?`
        : `Remove ${count} selected lead${count === 1 ? "" : "s"} from Interested Clients?`,
    );
    if (!confirmed) return;

    setSaveNotice(null);
    try {
      const result = await client.setInterestedClientsMembership([...selected], inList);
      const movedIds = new Set(result.updated_ids);
      if (movedIds.size > 0) {
        setRows((prev) => prev.filter((row) => !movedIds.has(row.id)));
        setDrafts((prev) => {
          const next = { ...prev };
          for (const id of movedIds) delete next[id];
          return next;
        });
        setOriginalKeys((prev) => {
          const next = { ...prev };
          for (const id of movedIds) delete next[id];
          return next;
        });
        setTotal((prev) => Math.max(0, prev - movedIds.size));
        setFilteredCount((prev) => Math.max(0, prev - movedIds.size));
      }
      clearSelection();
      await loadSectionCounts();
      setSaveNotice(
        inList
          ? `Moved ${result.updated_count} lead${result.updated_count === 1 ? "" : "s"} to Interested Clients.`
          : `Removed ${result.updated_count} lead${result.updated_count === 1 ? "" : "s"} from Interested Clients.`,
      );
      setTimeout(() => setSaveNotice(null), 4000);
    } catch (e) {
      onError(
        e instanceof Error ? e.message : "Failed to update Interested Clients membership",
      );
    }
  }

  function openWhatsAppCompose(row: LeadTableRow, phone: string) {
    setWhatsappComposeTarget({ row, phone: phone.trim() });
  }

  async function saveFollowUpAt(rowId: number, followUpAt: string | null) {
    try {
      const result = await client.scheduleInterestedFollowUp(rowId, followUpAt);
      setRows((prev) =>
        prev.map((row) =>
          row.id === rowId ? { ...row, follow_up_at: result.follow_up_at } : row,
        ),
      );
      setDrafts((prev) => {
        const current = prev[rowId];
        if (!current) return prev;
        return {
          ...prev,
          [rowId]: { ...current, follow_up_at: result.follow_up_at },
        };
      });
      setSaveNotice(
        followUpAt
          ? "Follow-up reminder scheduled."
          : "Follow-up reminder cleared.",
      );
      setTimeout(() => setSaveNotice(null), 3000);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to schedule follow-up");
    }
  }

  function renderAssignedToCell(row: LeadTableRow, draft: LeadTableRow) {
    if (!isAdmin) {
      return (
        <span className="text-sm text-slate-300">
          {!row.assigned_to || row.assigned_to === "unassigned"
            ? "Unassigned"
            : row.assigned_to}
        </span>
      );
    }
    return (
      <AssignedToSelect
        value={editMode ? draft.assigned_to_user_id : row.assigned_to_user_id}
        options={assigneeOptions}
        onChange={(userId) => {
          if (editMode) {
            const label =
              userId == null
                ? "unassigned"
                : assigneeOptions.find((o) => o.value === String(userId))?.label ||
                  "unassigned";
            setDrafts((prev) => ({
              ...prev,
              [row.id]: {
                ...(prev[row.id] ?? row),
                assigned_to_user_id: userId,
                assigned_to: label,
              },
            }));
            return;
          }
          void saveAssignedTo(row.id, userId);
        }}
        disabled={assigningId === row.id || savingId === row.id}
      />
    );
  }

  function toggleSelected(rowId: number) {
    setAllMatchingSelected(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function toggleSelectAllOnPage() {
    const pageIds = displayedRows.map((row) => row.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
    setAllMatchingSelected(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        pageIds.forEach((id) => next.delete(id));
      } else {
        pageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  async function selectAllMatching() {
    if (filteredCount === 0 || selectingAll) return;
    setSelectingAll(true);
    try {
      const result = await client.listLeadsTableIds(tableQueryParams);
      setSelected(new Set(result.ids));
      setAllMatchingSelected(true);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to select all matching leads");
    } finally {
      setSelectingAll(false);
    }
  }

  async function bulkResearchAndScore() {
    const ids = [...selected];
    if (ids.length === 0) return;

    if (ids.length > MAX_BULK_ONBOARD) {
      onError(`Select at most ${MAX_BULK_ONBOARD} leads per batch`);
      return;
    }

    const patience = RESEARCH_PATIENCE[researchPatience];
    const withoutWebsite = rows.filter((row) => ids.includes(row.id) && !row.website_url?.trim());
    const estimateSec = Math.round(
      ids.length * (patience.expectedSec + BULK_ONBOARD_DELAY_MS / 1000),
    );
    const estimateLabel =
      estimateSec < 60
        ? `~${estimateSec}s`
        : `~${Math.floor(estimateSec / 60)}m ${estimateSec % 60}s`;
    const confirmed = window.confirm(
      `Research & score ${ids.length} lead${ids.length === 1 ? "" : "s"}?\n\n` +
        `• Looks up company details and fills empty table fields (not just the score).\n` +
        (isOldClients
          ? `• Clients table priority: city & address first, then phone/email/designation.\n`
          : `• Scrapped Leads priority: website, email, phone, socials, country.\n`) +
        `• Patience: ${patience.label} (${patience.timeoutMs / 1000}s max per lead).\n` +
        `• Runs one at a time (${estimateLabel} estimated for this batch).\n` +
        (withoutWebsite.length > 0
          ? `• ${withoutWebsite.length} selected lead${withoutWebsite.length === 1 ? " has" : "s have"} no website — fit signals will be weaker.\n`
          : "") +
        `\nContinue?`,
    );
    if (!confirmed) return;

    setBulkOnboarding(true);
    setBulkResults(null);
    setSaveNotice(null);
    const startedAt = Date.now();
    const patienceLabel = `${patience.label} · ${patience.timeoutMs / 1000}s/lead`;

    const results: BulkOnboardRowResult[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const row = rows.find((r) => r.id === id);
      const companyName = row?.company_name ?? `Lead #${id}`;
      const itemStartedAt = Date.now();
      setActionProgress({
        title: "Researching & scoring leads",
        mode: "determinate",
        current: i,
        total: ids.length,
        detail: companyName,
        startedAt,
        accent: "emerald",
        itemStartedAt,
        itemTimeoutMs: patience.timeoutMs,
        expectedSecPerItem: patience.expectedSec + BULK_ONBOARD_DELAY_MS / 1000,
        patienceLabel,
      });

      try {
        const result = await client.onboardLead(id, { timeoutMs: patience.timeoutMs });
        results.push({
          id,
          company_name: companyName,
          status: "success",
          score: result.score,
          reasoning: result.reasoning,
          filled_fields: result.enrichment?.filled_fields ?? [],
        });
      } catch (e) {
        results.push({
          id,
          company_name: companyName,
          status: "failed",
          error: e instanceof Error ? e.message : "Research & score failed",
        });
      }

      setActionProgress({
        title: "Researching & scoring leads",
        mode: "determinate",
        current: i + 1,
        total: ids.length,
        detail: companyName,
        startedAt,
        accent: "emerald",
        patienceLabel,
        expectedSecPerItem: patience.expectedSec + BULK_ONBOARD_DELAY_MS / 1000,
      });

      if (i < ids.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, BULK_ONBOARD_DELAY_MS));
      }
    }

    setActionProgress(null);
    setBulkOnboarding(false);
    setBulkResults(results);
    clearSelection();
    await loadTable();
  }

  async function runPostImportClean(opts?: { afterImport?: boolean }) {
    if (!isOldClients) return;
    if (!opts?.afterImport) {
      const confirmed = window.confirm(
        "Run full post-import clean on Old clients?\n\n" +
          "• Fix email apostrophes\n" +
          "• Clean company / address / email fields\n" +
          "• Fix location-as-company names\n" +
          "• Remove Unnamed junk and empty rows\n" +
          "• Deduplicate within Old clients only\n\n" +
          "Existing rows in other Master Table sections are not touched.\n\n" +
          "Continue?",
      );
      if (!confirmed) return;
    }

    setDeduping(true);
    setSaveNotice(null);
    setActionProgress({
      title: opts?.afterImport ? "Cleaning imported Old clients" : "Post-import clean",
      mode: "indeterminate",
      detail: "Fixing emails, names, junk rows, and duplicates…",
      startedAt: Date.now(),
      accent: "sky",
    });
    try {
      const result = await client.postImportClean(sectionTableScope(section));
      await loadTable();
      await loadSectionCounts();
      const s = result.summary;
      setSaveNotice(
        `Post-import clean — emails ${s.emails_fixed}, company fields ${s.company_fields_fixed}, ` +
          `names ${s.names_fixed}, junk removed ${s.junk_rows_removed}, empty removed ${s.empty_rows_removed}, ` +
          `duplicates removed ${s.duplicates_removed}`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Post-import clean failed");
    } finally {
      setActionProgress(null);
      setDeduping(false);
    }
  }

  async function removeOldClientOverlaps() {
    if (!isAdmin || isOldClients) return;
    const confirmed = window.confirm(
      "Remove Discover / Scrapped Leads rows that match Old clients?\n\n" +
        "• Matches by company name or website domain.\n" +
        "• Old clients are never deleted — only overlapping new-discovery leads are removed.\n" +
        "• Use this if Old clients were accidentally mixed into Scrapped Leads.\n\n" +
        "Continue?",
    );
    if (!confirmed) return;

    setDeduping(true);
    setSaveNotice(null);
    setActionProgress({
      title: "Removing leads that match Old clients",
      mode: "indeterminate",
      detail: "Comparing Scrapped Leads against Old clients…",
      startedAt: Date.now(),
      accent: "violet",
    });
    try {
      const result = await client.removeOldClientOverlaps();
      await loadTable();
      await loadSectionCounts();
      setSaveNotice(
        result.removed_count > 0
          ? `Removed ${result.removed_count} lead${result.removed_count === 1 ? "" : "s"} that matched Old clients (${result.kept_count} discovery lead${result.kept_count === 1 ? "" : "s"} kept)`
          : "No Discover / Scrapped Leads rows matched Old clients",
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to remove old-client overlaps");
    } finally {
      setActionProgress(null);
      setDeduping(false);
    }
  }

  async function deleteRows(rowIds: number[]) {
    if (rowIds.length === 0) return;

    const names = rows
      .filter((row) => rowIds.includes(row.id))
      .map((row) => row.company_name);
    const preview =
      names.length === 1
        ? names[0]
        : `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
    const confirmed = window.confirm(
      rowIds.length === 1
        ? `Delete "${preview}"? This cannot be undone.`
        : `Delete ${rowIds.length} leads (${preview})? This cannot be undone.`,
    );
    if (!confirmed) return;

    if (rowIds.length === 1) {
      setDeletingId(rowIds[0]);
    } else {
      setDeletingSelected(true);
    }
    setSaveNotice(null);
    const startedAt = Date.now();
    if (rowIds.length > 1) {
      setActionProgress({
        title: "Deleting selected leads",
        mode: "determinate",
        current: 0,
        total: rowIds.length,
        detail: preview,
        startedAt,
        accent: "red",
      });
    }

    try {
      const deletedIds: number[] = [];
      if (rowIds.length === 1) {
        await client.deleteLeadTableRow(rowIds[0]);
        deletedIds.push(rowIds[0]);
      } else {
        for (let i = 0; i < rowIds.length; i += BULK_DELETE_CHUNK) {
          const chunk = rowIds.slice(i, i + BULK_DELETE_CHUNK);
          const firstName =
            rows.find((row) => row.id === chunk[0])?.company_name ?? `Lead #${chunk[0]}`;
          setActionProgress({
            title: "Deleting selected leads",
            mode: "determinate",
            current: i,
            total: rowIds.length,
            detail: firstName,
            startedAt,
            accent: "red",
          });
          const result = await client.bulkDeleteLeadTableRows(chunk);
          deletedIds.push(...(result.deleted_ids ?? chunk));
          setActionProgress({
            title: "Deleting selected leads",
            mode: "determinate",
            current: Math.min(i + chunk.length, rowIds.length),
            total: rowIds.length,
            detail: firstName,
            startedAt,
            accent: "red",
          });
        }
      }
      const removed = new Set(deletedIds.length > 0 ? deletedIds : rowIds);
      setRows((prev) => prev.filter((row) => !removed.has(row.id)));
      setTotal((prev) => Math.max(0, prev - removed.size));
      setFilteredCount((prev) => Math.max(0, prev - removed.size));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const rowId of removed) next.delete(rowId);
        return next;
      });
      setDrafts((prev) => {
        const next = { ...prev };
        for (const rowId of removed) delete next[rowId];
        return next;
      });
      setOriginalKeys((prev) => {
        const next = { ...prev };
        for (const rowId of removed) delete next[rowId];
        return next;
      });
      setSaveNotice(`Deleted ${removed.size} lead${removed.size === 1 ? "" : "s"}`);
      const updatedFilters = await client.listLeadTableFilters();
      setFilters(updatedFilters);
      await loadSectionCounts();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete lead(s)");
    } finally {
      setActionProgress(null);
      setDeletingId(null);
      setDeletingSelected(false);
    }
  }

  async function finishEditing() {
    const dirtyIds = Object.keys(draftsRef.current)
      .map(Number)
      .filter((id) => {
        const draft = draftsRef.current[id];
        if (!draft) return false;
        return rowDraftKey(draft) !== originalKeys[id];
      });

    if (dirtyIds.length === 0) {
      setEditMode(false);
      setDrafts({});
      setOriginalKeys({});
      setSaveNotice(null);
      return;
    }

    setSavingAll(true);
    setSaveNotice(null);
    try {
      const results = await Promise.all(
        dirtyIds.map(async (rowId) => {
          const raw = draftsRef.current[rowId];
          if (!raw) return null;
          const draft = autocorrectLeadDraft(raw);
          const payload = buildUpdatePayload(draft);
          if (!isAdmin) {
            delete payload.assigned_to_user_id;
          }
          const updated = await client.updateLeadTableRow(rowId, payload);
          return [rowId, updated] as const;
        }),
      );
      const updatedById = new Map<number, LeadTableRow>();
      for (const entry of results) {
        if (entry) updatedById.set(entry[0], entry[1]);
      }
      setRows((prev) => prev.map((row) => updatedById.get(row.id) ?? row));
      setEditMode(false);
      setDrafts({});
      setOriginalKeys({});
      setSaveNotice(
        `Saved ${updatedById.size} row${updatedById.size === 1 ? "" : "s"}`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save changes");
    } finally {
      setSavingAll(false);
    }
  }

  function toggleSort(field: SortField) {
    if (sortBy === field) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(field);
    setSortDir(field === "company_name" || field === "country" ? "asc" : "desc");
  }

  function sortSelectValue(): string {
    if (sortBy === "created_at") {
      return sortDir === "asc" ? "oldest" : "recent";
    }
    return sortBy;
  }

  function applySortSelect(value: string) {
    if (value === "recent") {
      setSortBy("created_at");
      setSortDir("desc");
      return;
    }
    if (value === "oldest") {
      setSortBy("created_at");
      setSortDir("asc");
      return;
    }
    const field = value as SortField;
    setSortBy(field);
    setSortDir(field === "company_name" || field === "country" ? "asc" : "desc");
  }

  const [exporting, setExporting] = useState(false);

  async function handleExportData() {
    if (exporting) return;
    setExporting(true);
    try {
      if (allMatchingSelected || (selected.size > 0 && selected.size > rows.length)) {
        setSaveNotice(`Preparing full export for all matching leads…`);
        const result = await client.listLeadsTable({
          ...tableQueryParams,
          page: 1,
          page_size: 10000,
        });
        const exportRows = allMatchingSelected
          ? result.rows
          : result.rows.filter((r) => selected.has(r.id));
        exportLeadsTableCsv(exportRows, `${section}-full-backup.xls`);
        setSaveNotice(`Exported ${exportRows.length} lead(s) to Excel.`);
      } else if (selected.size > 0) {
        const selectedRows = rows.filter((r) => selected.has(r.id));
        if (selectedRows.length === selected.size) {
          exportLeadsTableCsv(selectedRows, `${section}-selected.xls`);
          setSaveNotice(`Exported ${selectedRows.length} selected lead(s) to Excel.`);
        } else {
          setSaveNotice(`Preparing export for ${selected.size} selected lead(s)…`);
          const result = await client.listLeadsTable({
            ...tableQueryParams,
            page: 1,
            page_size: 10000,
          });
          const filtered = result.rows.filter((r) => selected.has(r.id));
          exportLeadsTableCsv(filtered, `${section}-selected.xls`);
          setSaveNotice(`Exported ${filtered.length} selected lead(s) to Excel.`);
        }
      } else {
        const exportAll = window.confirm(
          `Export all ${filteredCount} matching lead(s) in section to Excel?\n\n` +
            `• Click OK to download a full backup of all ${filteredCount} lead(s).\n` +
            `• Click Cancel to download only the currently visible page (${rows.length} rows).`,
        );
        if (exportAll) {
          setSaveNotice(`Preparing full export of ${filteredCount} lead(s)…`);
          const result = await client.listLeadsTable({
            ...tableQueryParams,
            page: 1,
            page_size: 10000,
          });
          exportLeadsTableCsv(result.rows, `${section}-full-${filteredCount}-leads.xls`);
          setSaveNotice(`Exported all ${result.rows.length} lead(s) to Excel.`);
        } else {
          exportLeadsTableCsv(rows, `${section}-visible-page.xls`);
        }
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to export data");
    } finally {
      setExporting(false);
    }
  }

  const [movingToModule, setMovingToModule] = useState(false);

  async function handleMoveToModule(targetModule: string) {
    if (!targetModule || movingToModule) return;
    const ids = [...selected];
    if (ids.length === 0) return;

    setMovingToModule(true);
    try {
      setSaveNotice(`Moving ${ids.length} lead(s) to target module…`);
      const res = await client.moveLeadsToModule(ids, targetModule);
      const isTargeted = isTargetedPoolSection(section);
      setSaveNotice(
        `Successfully moved ${res.updated_count} lead(s) to ${res.target_label}.` +
          (isTargeted ? ` (They remain visible in ${sectionTitle(section, assigneeUsername, isAdmin, masterType)} as well.)` : ""),
      );
      clearSelection();
      await loadTable();
      await loadSectionCounts();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to move leads to target module");
    } finally {
      setMovingToModule(false);
    }
  }

  function clearFilters() {
    setScore("");
    setMarketRole("");
    setCountry("");
    setIndustry("");
    setCompanyGrading("");
    setProductInterest("");
    setCity("");
    setCallRecommended("");
    setSearch("");
    setDebouncedSearch("");
    setSortBy("created_at");
    setSortDir("desc");
    setSelectedColValues({});
  }

  function sortIndicator(field: SortField): string {
    if (sortBy !== field) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  const getFilteredRowsExcept = useCallback(
    (currentField: string) => {
      const activeFields = Object.keys(selectedColValues).filter(
        (field) => field !== currentField && selectedColValues[field] && selectedColValues[field].length > 0,
      );

      if (activeFields.length === 0) return rows;

      return rows.filter((row) => {
        return activeFields.every((field) => {
          const allowedVals = selectedColValues[field];
          const rawVal = getRowFieldValue(row, field);
          const valLabel = rawVal ? rawVal : "(Blanks)";
          return allowedVals.includes(valLabel) || (rawVal !== "" && allowedVals.includes(rawVal));
        });
      });
    },
    [rows, selectedColValues],
  );

  const displayedRows = useMemo(() => {
    const activeFields = Object.keys(selectedColValues).filter(
      (field) => selectedColValues[field] && selectedColValues[field].length > 0,
    );

    if (activeFields.length === 0) return rows;

    return rows.filter((row) => {
      return activeFields.every((field) => {
        const allowedVals = selectedColValues[field];
        const rawVal = getRowFieldValue(row, field);
        const valLabel = rawVal ? rawVal : "(Blanks)";
        return allowedVals.includes(valLabel) || (rawVal !== "" && allowedVals.includes(rawVal));
      });
    });
  }, [rows, selectedColValues]);

  const hasActiveFilters = useClientsFilters
    ? Boolean(
        country ||
          industry ||
          companyGrading ||
          productInterest ||
          city ||
          callRecommended ||
          search.trim() ||
          Object.values(selectedColValues).some((v) => v && v.length > 0),
      )
    : Boolean(
        score ||
          marketRole ||
          country ||
          search.trim() ||
          Object.values(selectedColValues).some((v) => v && v.length > 0),
      );

  const activeFiltersCount = useMemo(() => {
    let count = 0;
    if (country) count++;
    if (industry) count++;
    if (companyGrading) count++;
    if (productInterest) count++;
    if (city) count++;
    if (callRecommended) count++;
    if (search.trim()) count++;
    if (score) count++;
    if (marketRole) count++;
    if (Object.values(selectedColValues).some((v) => v && v.length > 0)) count++;
    return count;
  }, [
    country,
    industry,
    companyGrading,
    productInterest,
    city,
    callRecommended,
    search,
    score,
    marketRole,
    selectedColValues,
  ]);
  const allOnPageSelected =
    displayedRows.length > 0 && displayedRows.every((row) => selected.has(row.id));
  const someOnPageSelected = displayedRows.some((row) => selected.has(row.id));
  const allMatchingAreSelected =
    allMatchingSelected || (selected.size > 0 && selected.size >= filteredCount);
  const showSelectAllBanner =
    filteredCount > displayedRows.length &&
    allOnPageSelected &&
    !allMatchingAreSelected &&
    !selectingAll;
  const tableOuterClass = isFullscreen
    ? "flex flex-col flex-1 min-h-0 rounded-xl border border-slate-800 overflow-hidden"
    : "rounded-xl border border-slate-800 overflow-hidden";
  const tableBodyScrollClass = isFullscreen ? "flex-1 min-h-0 overflow-auto" : "overflow-x-auto";
  const theadStickyClass = isFullscreen ? "sticky top-0 z-[2]" : "";

  return (
    <section
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-slate-950 p-3 sm:p-4 gap-3 overflow-hidden"
          : "space-y-4 w-full min-w-0"
      }
    >
      <div className="flex items-start justify-between gap-4 flex-wrap shrink-0">
        <div>
          <ActionButton
            icon={IconFilter}
            variant={filtersExpanded || activeFiltersCount > 0 ? "emerald" : "secondary"}
            onClick={() => setFiltersExpanded((prev) => !prev)}
            title={filtersExpanded ? "Hide search and column filters" : "Show search and column filters"}
          >
            Filter
            {activeFiltersCount > 0 ? ` (${activeFiltersCount})` : ""}
          </ActionButton>
          <p className="text-sm text-slate-500 mt-2">
            {sectionDescription(section, assigneeUsername, isAdmin, customModules)}
          </p>
          {isTestingModule && (
            <div className="mt-3 p-3.5 rounded-2xl bg-gradient-to-r from-emerald-950/80 via-slate-900 to-slate-900 border border-emerald-500/40 shadow-lg flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-lg">
                  🧪
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white flex items-center gap-2">
                    Daily Morning Testing Hub
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold">
                      Staff QA Recipients
                    </span>
                  </h4>
                  <p className="text-[11px] text-slate-300">
                    Use this list to verify bulk email & WhatsApp dispatches every morning with your own staff before customer campaigns.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelected(new Set(rows.map((r) => r.id)));
                    setShowBulkEmail(true);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 shadow"
                >
                  <span>✉️</span> Test Bulk Email
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(new Set(rows.map((r) => r.id)));
                    setWhatsappTargetIds(rows.map((r) => r.id));
                    setShowBulkWhatsApp(true);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-xs font-bold flex items-center gap-1.5 shadow"
                >
                  <span>💬</span> Test Bulk WhatsApp
                </button>
                <button
                  type="button"
                  onClick={() => setShowManageModules(true)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 border border-slate-700"
                >
                  <span>⚙️</span> Manage Staff
                </button>
              </div>
            </div>
          )}
          {isTargetedPool ? (
            <div className="mt-3 space-y-2">
              <div className="inline-flex rounded-lg border border-slate-700 bg-slate-900/80 p-0.5 text-xs">
                {(
                  [
                    ["all", "All leads"],
                    ["upload", "Uploaded data"],
                    ["discover", "AI / search leads"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setIntakeMethodFilter(value);
                      setPage(1);
                    }}
                    className={`px-3 py-1.5 rounded-md transition ${
                      intakeMethodFilter === value
                        ? "bg-emerald-600 text-white"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {isAdmin ? (
                <div className="flex flex-wrap gap-2">
                  {section !== "targeted_client" ? (
                    <button
                      type="button"
                      disabled={populatingPool || bulkOnboarding || editMode}
                      onClick={() => void populateTargetPoolFrom("old_clients")}
                      className="text-xs px-3 py-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 disabled:opacity-50"
                    >
                      {populatingPool ? "Populating…" : "Populate from Old clients"}
                    </button>
                  ) : null}
                  {selected.size > 0 ? (
                    <button
                      type="button"
                      disabled={removingFromPool || bulkOnboarding || editMode}
                      onClick={() => void removeSelectedFromTargetPool()}
                      className="text-xs px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                    >
                      {removingFromPool ? "Removing…" : `Remove from pool (${selected.size})`}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <p className="text-sm text-slate-500 mt-1">
            {filteredCount} matching · {total} in section · {TABLE_PAGE_SIZE} per page
            {selected.size > 0 ? (
              <span className="text-sky-400">
                {" "}
                · {selected.size} selected
                {allMatchingAreSelected ? " (all matching)" : ""}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            icon={IconCheckSquare}
            onClick={() => void selectAllMatching()}
            disabled={
              filteredCount === 0 ||
              selectingAll ||
              allMatchingAreSelected ||
              bulkOnboarding ||
              deletingSelected ||
              deletingId !== null ||
              editMode
            }
            title="Select all matching"
          >
            {selectingAll
              ? "Selecting all…"
              : allMatchingAreSelected
                ? `All ${filteredCount} selected`
                : `Select all (${filteredCount})`}
          </ActionButton>
          {selected.size > 0 && (
            <ActionButton
              icon={IconX}
              onClick={clearSelection}
              disabled={bulkOnboarding || deletingSelected || deletingId !== null || editMode}
              title="Clear selection"
            >
              Clear
            </ActionButton>
          )}

          <ToolbarDropdown label="Action" icon={IconSend} variant="sky">
            <ToolbarMenuItem
              icon={IconWhatsApp}
              tone="emerald"
              disabled={
                selected.size === 0 ||
                bulkOnboarding ||
                deletingSelected ||
                deletingId !== null ||
                editMode
              }
              title="Send WhatsApp"
              onClick={() => {
                setWhatsappTargetIds([...selected]);
                setShowBulkWhatsApp(true);
              }}
            >
              WhatsApp ({selected.size})
            </ToolbarMenuItem>
            <ToolbarMenuItem
              icon={IconCalendar}
              tone="violet"
              disabled={
                selected.size === 0 ||
                bulkOnboarding ||
                deletingSelected ||
                deletingId !== null ||
                editMode ||
                openingScheduleMailer
              }
              title="Schedule bulk email for a later date/time"
              onClick={() => void openScheduleBulkMailer()}
            >
              {openingScheduleMailer
                ? "Opening…"
                : `Schedule emails (${selected.size})`}
            </ToolbarMenuItem>
            <ToolbarMenuItem
              icon={IconMail}
              tone="sky"
              disabled={
                selected.size === 0 ||
                bulkOnboarding ||
                deletingSelected ||
                deletingId !== null ||
                editMode ||
                openingMailer
              }
              title="Send emails"
              onClick={() => void openBulkMailer()}
            >
              {openingMailer ? "Opening mailer…" : `Send emails (${selected.size})`}
            </ToolbarMenuItem>
          </ToolbarDropdown>

          <ToolbarDropdown label="Modify" icon={IconEdit} variant="emerald">
            {canAddLead && !showCreateLead ? (
              <ToolbarMenuItem
                icon={IconPlus}
                tone="emerald"
                disabled={bulkOnboarding || deletingSelected || deletingId !== null || editMode}
                title="Add a new lead to this table"
                onClick={() => {
                  setShowCreateLead(true);
                  setShowCsvImport(false);
                }}
              >
                Add lead
              </ToolbarMenuItem>
            ) : null}
            {canImportSpreadsheet ? (
              <ToolbarMenuItem
                icon={IconUpload}
                tone="violet"
                disabled={bulkOnboarding || deletingSelected || deletingId !== null || editMode}
                title="Import spreadsheet"
                onClick={() => setShowCsvImport(true)}
              >
                Import spreadsheet
              </ToolbarMenuItem>
            ) : null}
            <ToolbarMenuItem
              icon={IconTrash}
              tone="danger"
              disabled={
                selected.size === 0 ||
                deletingSelected ||
                deletingId !== null ||
                bulkOnboarding ||
                deduping
              }
              title="Delete selected"
              onClick={() => void deleteRows([...selected])}
            >
              {deletingSelected
                ? actionProgress?.mode === "determinate" && actionProgress.total
                  ? `Deleting ${actionProgress.current ?? 0}/${actionProgress.total}…`
                  : "Deleting…"
                : `Delete (${selected.size})`}
            </ToolbarMenuItem>
            <ToolbarMenuItem
              icon={IconSearch}
              tone="emerald"
              disabled={
                selected.size === 0 ||
                bulkOnboarding ||
                deletingSelected ||
                deletingId !== null ||
                deduping ||
                editMode
              }
              title="Research and score"
              onClick={() => void bulkResearchAndScore()}
            >
              {bulkOnboarding
                ? actionProgress?.mode === "determinate" && actionProgress.total
                  ? `Researching ${actionProgress.current ?? 0}/${actionProgress.total}…`
                  : "Starting…"
                : `Research (${selected.size})`}
            </ToolbarMenuItem>
            <ToolbarMenuItem
              icon={editMode ? IconCheck : IconEdit}
              disabled={savingAll}
              title={editMode ? "Done editing" : "Edit table"}
              onClick={() => {
                if (editMode) {
                  void finishEditing();
                } else {
                  enterEditMode();
                }
              }}
            >
              {savingAll ? "Saving…" : editMode ? "Done" : "Edit"}
            </ToolbarMenuItem>
          </ToolbarDropdown>

          <ToolbarDropdown
            label="Lists and Modules"
            icon={IconList}
            variant="violet"
            menuClassName="min-w-[260px]"
          >
            <ToolbarMenuItem
              icon={IconGear}
              tone="emerald"
              title="Add or remove modules / lists, or configure morning testing staff"
              onClick={() => setShowManageModules(true)}
            >
              Add / Manage Lists
            </ToolbarMenuItem>
            <ToolbarMenuLabel>
              {selected.size === 0
                ? "Move to module — select leads first"
                : movingToModule
                  ? "Moving…"
                  : `Move ${selected.size} selected lead${selected.size === 1 ? "" : "s"} to`}
            </ToolbarMenuLabel>
            {customModules.length > 0 ? (
              <>
                <ToolbarMenuLabel>Custom & Testing Lists</ToolbarMenuLabel>
                {customModules.map((module) => (
                  <ToolbarMenuItem
                    key={module.key}
                    disabled={selected.size === 0 || movingToModule}
                    title={`Move selected leads to ${module.name}`}
                    onClick={() => confirmMoveToModule(module.key)}
                  >
                    {module.icon || "📋"} {module.name}
                    {sectionCounts[module.key] != null ? ` (${sectionCounts[module.key]})` : ""}
                  </ToolbarMenuItem>
                ))}
              </>
            ) : null}
            <ToolbarMenuLabel>Standard CRM Pools</ToolbarMenuLabel>
            {STANDARD_MOVE_MODULES.map((moduleKey) => {
              const count = sectionCounts[moduleKey];
              return (
                <ToolbarMenuItem
                  key={moduleKey}
                  disabled={selected.size === 0 || movingToModule}
                  title={`Move selected leads to ${MOVE_MODULE_LABELS[moduleKey]}`}
                  onClick={() => confirmMoveToModule(moduleKey)}
                >
                  {MOVE_MODULE_LABELS[moduleKey]}
                  {count != null ? ` (${count})` : ""}
                </ToolbarMenuItem>
              );
            })}
          </ToolbarDropdown>

          {isIncompleteArchives && isAdmin && selected.size > 0 ? (
            <ActionButton
              icon={IconArchive}
              variant="emerald"
              onClick={() => void promoteSelectedFromIncompleteArchives()}
              disabled={promotingIncomplete || bulkOnboarding || editMode}
              title="Manual promotion to Old clients when data is complete enough"
            >
              {promotingIncomplete ? "Promoting…" : `Promote to Old clients (${selected.size})`}
            </ActionButton>
          ) : null}
          {isAdmin && selected.size > 0 ? (
            <>
              {section !== "khalid_focused_sales" ? (
                <ActionButton
                  icon={IconSearch}
                  variant="emerald"
                  onClick={() => void moveSelectedToTargetPool("khalid_focused_sales")}
                  disabled={movingToPool || bulkOnboarding || editMode}
                  title="Add selected leads to Khalid Focused Sales"
                >
                  {movingToPool ? "Moving…" : "→ Khalid Focused"}
                </ActionButton>
              ) : null}
              {section !== "hyperstore_targeted" ? (
                <ActionButton
                  icon={IconSearch}
                  onClick={() => void moveSelectedToTargetPool("hyperstore_targeted")}
                  disabled={movingToPool || bulkOnboarding || editMode}
                  title="Add to Hyperstore Target"
                >
                  {movingToPool ? "Moving…" : "→ Hyperstore"}
                </ActionButton>
              ) : null}
              {section !== "targeted_distributor" ? (
                <ActionButton
                  icon={IconSearch}
                  onClick={() => void moveSelectedToTargetPool("targeted_distributor")}
                  disabled={movingToPool || bulkOnboarding || editMode}
                  title="Add to Targeted Distributors"
                >
                  → Distributors
                </ActionButton>
              ) : null}
              {section !== "targeted_client" ? (
                <ActionButton
                  icon={IconSearch}
                  onClick={() => void moveSelectedToTargetPool("targeted_client")}
                  disabled={movingToPool || bulkOnboarding || editMode}
                  title="Add to Targeted Client"
                >
                  → Targeted Client
                </ActionButton>
              ) : null}
            </>
          ) : null}

          {section === "sales_interested_clients" && (
            <ActionButton
              icon={IconXCircle}
              onClick={() => void moveSelectedToInterestedClients(false)}
              disabled={
                selected.size === 0 ||
                bulkOnboarding ||
                deletingSelected ||
                deletingId !== null ||
                editMode
              }
              title="Remove from Interested Clients"
            >
              Remove Interested ({selected.size})
            </ActionButton>
          )}
          {isAdmin && section === "all" && (
            <ActionButton
              icon={IconXCircle}
              variant="violet"
              onClick={() => void removeOldClientOverlaps()}
              disabled={
                deduping ||
                loading ||
                bulkOnboarding ||
                deletingSelected
              }
              title="Delete Scrapped Leads rows that match Old clients by name or website"
            >
              {deduping && actionProgress?.title.includes("Old clients")
                ? "Cleaning overlaps…"
                : "Remove overlaps"}
            </ActionButton>
          )}
          <ActionButton
            icon={IconDownload}
            onClick={() => void handleExportData()}
            disabled={rows.length === 0 || exporting}
            title="Export Excel (supports full dataset backup)"
          >
            {exporting ? "Exporting…" : "Export"}
          </ActionButton>
        </div>
      </div>

      <div
        className={
          isFullscreen ? "flex flex-col flex-1 min-h-0 gap-3 overflow-hidden" : "space-y-4"
        }
      >
      {editMode && (
        <p className="text-xs text-amber-300/90 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 shrink-0">
          Edit mode is on. Update fields after visiting a company website, then click Done editing to save all changes (or Save on a single row).
          Social URLs can be edited in the Socials column.
          {dirtyCount > 0 ? ` ${dirtyCount} unsaved row${dirtyCount === 1 ? "" : "s"}.` : ""}
        </p>
      )}

      {showCreateLead && canAddLead && (
        <CreateLeadForm
          source={createLeadSource}
          title={isOldClients && !isAdmin ? "Add new client" : "Add new lead"}
          onCancel={() => setShowCreateLead(false)}
          onError={onError}
          onOpenExisting={(leadId) => {
            setShowCreateLead(false);
            onSelectLead(leadId);
          }}
          onSuccess={async (leadId) => {
            setShowCreateLead(false);
            setSaveNotice("Lead added to your table.");
            clearFilters();
            setPage(1);
            await loadTable();
            await loadSectionCounts();
            onSelectLead(leadId);
          }}
        />
      )}

      {saveNotice && (
        <p className="text-xs text-emerald-300 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 shrink-0">
          {saveNotice}
        </p>
      )}

      {bulkEmailNotice && (
        <p className="text-xs text-emerald-300 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 shrink-0">
          {bulkEmailNotice}
        </p>
      )}

      {bulkWhatsAppNotice && (
        <p className="text-xs text-emerald-300 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 shrink-0">
          {bulkWhatsAppNotice}
        </p>
      )}

      {selectingAll && (
        <p className="text-xs text-slate-300 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 shrink-0">
          Selecting all {filteredCount} matching leads…
        </p>
      )}

      {showSelectAllBanner && (
        <p className="text-xs text-sky-200 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 shrink-0">
          All {rows.length} leads on this page are selected.{" "}
          <button
            type="button"
            onClick={() => void selectAllMatching()}
            className="font-medium text-sky-300 hover:text-sky-200 underline underline-offset-2"
          >
            Select all {filteredCount} matching leads
          </button>
        </p>
      )}

      {allMatchingAreSelected && filteredCount > rows.length && (
        <p className="text-xs text-sky-200 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 shrink-0">
          All {filteredCount} matching leads are selected across every page.{" "}
          <button
            type="button"
            onClick={clearSelection}
            className="font-medium text-sky-300 hover:text-sky-200 underline underline-offset-2"
          >
            Clear selection
          </button>
        </p>
      )}

      {actionProgress && <BulkActionProgressPanel progress={actionProgress} />}

      {bulkResults && bulkResults.length > 0 && (
        <div className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 space-y-2 shrink-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-sm text-slate-200">
              Bulk research complete —{" "}
              {bulkResults.filter((r) => r.status === "success").length} succeeded,{" "}
              {bulkResults.filter((r) => r.status === "failed").length} failed
              {(() => {
                const aaa = bulkResults.filter((r) => r.score === "AAA" || r.score === "HOT").length;
                const aa = bulkResults.filter((r) => r.score === "AA" || r.score === "WARM").length;
                const a = bulkResults.filter((r) => r.score === "A" || r.score === "COLD").length;
                if (aaa + aa + a === 0) return null;
                return (
                  <span className="text-slate-400">
                    {" "}
                    · {aaa} AAA, {aa} AA, {a} A
                  </span>
                );
              })()}
            </p>
            <button
              type="button"
              onClick={() => setBulkResults(null)}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Dismiss
            </button>
          </div>
          <ul className="max-h-40 overflow-y-auto space-y-1 text-xs">
            {bulkResults.map((result) => (
              <li key={result.id} className="flex items-center gap-2 text-slate-400">
                {result.status === "success" && result.score ? (
                  <ScoreBadge score={result.score} />
                ) : (
                  <span className="px-2 py-0.5 rounded text-xs border border-red-500/30 text-red-300">
                    Failed
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onSelectLead(result.id)}
                  className="text-slate-300 hover:text-emerald-300 truncate text-left"
                >
                  {result.company_name}
                </button>
                {result.error && <span className="text-red-400 truncate">{result.error}</span>}
                {result.status === "success" &&
                  result.filled_fields &&
                  result.filled_fields.length > 0 && (
                    <span className="text-emerald-400/80 truncate">
                      filled {result.filled_fields.slice(0, 4).join(", ")}
                      {result.filled_fields.length > 4
                        ? ` +${result.filled_fields.length - 4}`
                        : ""}
                    </span>
                  )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {filtersExpanded ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 space-y-3 shadow-sm shrink-0">
            <div
              className={`grid gap-3 sm:grid-cols-2 ${
                useClientsFilters ? "lg:grid-cols-4 xl:grid-cols-4" : "lg:grid-cols-4"
              }`}
            >
          {useClientsFilters ? (
            <>
              <SearchableSelect
                label="Sort by"
                value={sortSelectValue()}
                onChange={applySortSelect}
                options={SORT_FILTER_OPTIONS.filter((o) => o.value !== "market_role")}
                placeholder="Search sort options…"
              />

              <SearchableSelect
                label="Business type"
                value={industry}
                onChange={setIndustry}
                options={stringOptions(filters?.industries ?? [])}
                allowEmpty
                emptyLabel="All types"
                placeholder="Search business types…"
              />

              <SearchableSelect
                label="Excel / file grading"
                value={companyGrading}
                onChange={setCompanyGrading}
                options={companyGradingOptions}
                allowEmpty
                emptyLabel="All gradings"
                placeholder="Search gradings…"
              />

              <CountrySelect
                label="Country"
                value={country}
                onChange={setCountry}
                allowEmpty
                emptyLabel="All countries"
              />

              <SearchableSelect
                label="Call?"
                value={callRecommended}
                onChange={setCallRecommended}
                options={CALL_RECOMMENDED_OPTIONS}
                placeholder="Search…"
              />

              <SearchableSelect
                label="Product"
                value={productInterest}
                onChange={setProductInterest}
                options={stringOptions(filters?.products ?? [])}
                allowEmpty
                emptyLabel="All products"
                placeholder="Search products…"
              />

              <SearchableSelect
                label="City"
                value={city}
                onChange={setCity}
                options={stringOptions(filters?.cities ?? [])}
                allowEmpty
                emptyLabel="All cities"
                placeholder="Search cities…"
              />

              {isTargetedPool && intakeMethodFilter === "discover" && isAdmin ? (
                <div className="flex flex-col justify-end">
                  <span className="block text-xs text-slate-400 mb-1">Searched by AI</span>
                  <button
                    type="button"
                    disabled={populatingPool || bulkOnboarding || editMode}
                    onClick={() => void fetchDiscoverLeadsIntoPool()}
                    className="w-full rounded-lg border border-violet-500/50 bg-violet-500/15 px-3 py-2 text-sm font-medium text-violet-100 hover:bg-violet-500/25 disabled:opacity-50 inline-flex items-center justify-center gap-2 min-h-[42px]"
                    title="Fetch matching leads from Searched by AI into this list (AI / search rows)"
                  >
                    <IconSearch size="sm" />
                    Fetch AI search leads
                  </button>
                </div>
              ) : null}

              <label className="block text-xs text-slate-400 sm:col-span-2">
                Search
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Company, contact, phone, designation, address…"
                  className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
                />
              </label>

              {isAdmin && (
                <SearchableSelect
                  label="Assign to"
                  multiSelect={false}
                  value={bulkAssignValue}
                  onChange={(next) => {
                    setBulkAssignValue(next);
                    void bulkAssignSelected(next);
                  }}
                  disabled={
                    (selected.size === 0 && filteredCount === 0) ||
                    bulkAssigning ||
                    deletingSelected ||
                    editMode ||
                    assigneeOptions.length === 0
                  }
                  options={[
                    {
                      value: UNASSIGNED,
                      label: "Unassigned (remove assignee)",
                    },
                    ...assigneeOptions.map((option) => ({
                      value: option.value,
                      label: option.username || option.label,
                    })),
                  ]}
                  allowEmpty
                  emptyLabel={
                    bulkAssigning
                      ? "Assigning…"
                      : selected.size > 0
                        ? `Assign ${selected.size} selected…`
                        : filteredCount > 0
                          ? `Assign all ${filteredCount} matching (filtered)…`
                          : "Filter or select leads first…"
                  }
                  placeholder="Search team members…"
                />
              )}
            </>
          ) : (
            <>
              <SearchableSelect
                label="Sort by"
                multiSelect={false}
                value={sortSelectValue()}
                onChange={applySortSelect}
                options={SORT_FILTER_OPTIONS}
                placeholder="Search sort options…"
              />

              <SearchableSelect
                label="AI company grading"
                value={score}
                onChange={setScore}
                options={aiScoreOptions}
                allowEmpty
                emptyLabel="All grades"
                placeholder="Search grades…"
              />

              <SearchableSelect
                label="Market role"
                value={marketRole}
                onChange={setMarketRole}
                options={[
                  { value: "consumer", label: "Importer" },
                  { value: "producer", label: "Exporter" },
                  { value: "hybrid", label: "Hybrid" },
                  { value: "unknown", label: "Unclassified" },
                ]}
                allowEmpty
                emptyLabel="All roles"
                placeholder="Search roles…"
              />

              <CountrySelect
                label="Country"
                value={country}
                onChange={setCountry}
                allowEmpty
                emptyLabel="All countries"
              />

              <label className="block text-xs text-slate-400">
                Search
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Company, email, contact…"
                  className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200"
                />
              </label>

              {canBulkAssign && (
                <SearchableSelect
                  label="Assign to"
                  value={bulkAssignValue}
                  onChange={(next) => {
                    setBulkAssignValue(next);
                    void bulkAssignSelected(next);
                  }}
                  disabled={
                    (selected.size === 0 && filteredCount === 0) ||
                    bulkAssigning ||
                    deletingSelected ||
                    editMode ||
                    assigneeOptions.length === 0
                  }
                  options={[
                    {
                      value: UNASSIGNED,
                      label: "Unassigned (remove assignee)",
                    },
                    ...assigneeOptions.map((option) => ({
                      value: option.value,
                      label: option.username || option.label,
                    })),
                  ]}
                  allowEmpty
                  emptyLabel={
                    bulkAssigning
                      ? "Assigning…"
                      : selected.size > 0
                        ? `Assign ${selected.size} selected…`
                        : filteredCount > 0
                          ? `Assign all ${filteredCount} matching (filtered)…`
                          : "Filter or select leads first…"
                  }
                  placeholder="Search team members…"
                />
              )}
            </>
          )}
        </div>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            Clear filters
          </button>
        )}
      </div>
      ) : null}

      {loading ? (
        <p className="text-slate-400 text-sm">Loading leads table…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/50 p-8 text-center space-y-3">
          <p className="text-slate-400 text-sm">
            {hasActiveFilters
              ? "No leads match these filters."
              : !isAdmin
                ? isOldClients || isMyAssigned
                  ? "No clients yet. Add a lead manually or import a CSV/Excel file."
                  : callOutcomeEmptyMessage ??
                    "No clients in this section yet. After a call, clients move here from Clients."
                : isOldClients || isMyAssigned
                  ? isMyAssigned
                    ? "No leads assigned to you yet. An admin can assign clients from Old clients, or import a spreadsheet to add your own."
                    : "No old clients yet. Add a lead manually or import a CSV/Excel file."
                  : callOutcomeEmptyMessage ??
                    "No leads in this section yet. Add a lead manually or import a CSV/Excel file."}
          </p>
          {!hasActiveFilters && (canAddLead || canImportSpreadsheet) && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {canAddLead && (
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateLead(true);
                    setShowCsvImport(false);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium"
                >
                  Add lead
                </button>
              )}
              {canImportSpreadsheet && (
                <button
                  type="button"
                  onClick={() => setShowCsvImport(true)}
                  className="px-3 py-1.5 rounded-lg bg-violet-700 hover:bg-violet-600 border border-violet-600/50 text-sm font-medium"
                >
                  Import spreadsheet
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className={tableOuterClass}>
          <div className="flex items-center justify-end gap-2 px-2 py-1 border-b border-slate-800/80 bg-slate-950 shrink-0">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={zoomOut}
                disabled={tableZoom <= TABLE_ZOOM_MIN}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                title="Zoom out"
                aria-label="Zoom out table"
              >
                <ZoomOutIcon />
              </button>
              <button
                type="button"
                onClick={resetZoom}
                className="min-w-[2.75rem] h-7 px-1.5 rounded-md text-[11px] tabular-nums text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                title="Reset zoom to 100%"
                aria-label={`Table zoom ${Math.round(tableZoom * 100)} percent. Click to reset`}
              >
                {Math.round(tableZoom * 100)}%
              </button>
              <button
                type="button"
                onClick={zoomIn}
                disabled={tableZoom >= TABLE_ZOOM_MAX}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                title="Zoom in"
                aria-label="Zoom in table"
              >
                <ZoomInIcon />
              </button>
              <span className="mx-1 h-4 w-px bg-slate-800" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setIsFullscreen((prev) => !prev)}
                className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  isFullscreen
                    ? "text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
                    : "text-slate-500 hover:text-slate-200 hover:bg-slate-800"
                }`}
                title={isFullscreen ? "Exit full screen (Esc)" : "Expand table"}
                aria-label={isFullscreen ? "Exit full screen" : "Expand table to full screen"}
              >
                {isFullscreen ? <FullscreenCollapseIcon /> : <FullscreenExpandIcon />}
              </button>
            </div>
            <ColumnVisibilityMenu
              columns={columnsUi.columns}
              isVisible={columnsUi.isVisible}
              toggle={columnsUi.toggle}
              showAll={columnsUi.showAll}
              resetDefaults={columnsUi.resetDefaults}
              hiddenCount={columnsUi.hiddenCount}
            />
          </div>
          <div
            ref={topScrollRef}
            className="overflow-x-auto overflow-y-hidden shrink-0 border-b border-slate-800/80 bg-slate-950"
            onScroll={onTopHorizontalScroll}
            aria-label="Scroll table left and right"
          >
            <div
              style={{ width: Math.max(topScrollWidth, 1), height: 1 }}
              aria-hidden="true"
            />
          </div>
          <div
            ref={bodyScrollRef}
            className={tableBodyScrollClass}
            onScroll={onBodyHorizontalScroll}
          >
          <div
            ref={tableZoomContentRef}
            style={{ zoom: tableZoom }}
            className="origin-top-left"
          >
          {columnsUi.css ? <style>{columnsUi.css}</style> : null}
          {isTargetedPool ? (
            <TargetedPoolLeadsTable
              rows={displayedRows}
              drafts={drafts}
              selected={selected}
              editMode={editMode}
              theadStickyClass={theadStickyClass}
              isFullscreen={isFullscreen}
              allOnPageSelected={allOnPageSelected}
              someOnPageSelected={someOnPageSelected}
              toggleSelectAllOnPage={toggleSelectAllOnPage}
              toggleSelected={toggleSelected}
              sortIndicator={sortIndicator}
              toggleSort={toggleSort}
              onSelectLead={onSelectLead}
              onError={onError}
              deletingId={deletingId}
              deletingSelected={deletingSelected}
              deleteRows={deleteRows}
              updateDraft={updateDraft}
              commitDraftField={commitDraftField}
              openWhatsAppCompose={openWhatsAppCompose}
            />
          ) : usesOldClientsTable ? (
            <table
              className={`w-full text-sm border-collapse ${
                canScheduleFollowUp ? "min-w-[2800px]" : "min-w-[2600px]"
              }`}
            >
              <thead>
                <tr className={`text-slate-500 border-b border-slate-800 bg-slate-950 ${theadStickyClass}`}>
                  <th
                    data-col="select"
                    className={`${TH} w-12 sticky left-0 bg-slate-950 z-[1] ${
                      isFullscreen ? "top-0 z-[3]" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={allOnPageSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected;
                      }}
                      onChange={toggleSelectAllOnPage}
                      aria-label="Select all leads on this page"
                      className="rounded border-slate-600 bg-slate-950"
                    />
                  </th>
                  <th data-col="serial" className={`${TH} ${COL_SERIAL}`}>{renderColHeaderBtn("id", "S. No")}</th>
                  <th data-col="company" className={`${TH} ${COL_COMPANY_OLD}`}>{renderColHeaderBtn("company_name", "Company Name")}</th>
                  <th data-col="business_type" className={`${TH} min-w-[140px]`}>{renderColHeaderBtn("business_type", "Business Type")}</th>
                  <th data-col="grading" className={`${TH} min-w-[140px]`}>{renderColHeaderBtn("excel_file_grading", "Companies Grading")}</th>
                  <th data-col="designation" className={`${TH} min-w-[130px]`}>{renderColHeaderBtn("designation", "Designation")}</th>
                  <th data-col="contact_person" className={`${TH} min-w-[150px]`}>{renderColHeaderBtn("contact_person", "Contact Person")}</th>
                  <th data-col="primary_mobile" className={`${TH} min-w-[160px]`}>{renderColHeaderBtn("primary_mobile", "Primary Mobile No.")}</th>
                  <th data-col="secondary_mobile" className={`${TH} min-w-[160px]`}>{renderColHeaderBtn("secondary_mobile", "Secondary Mobile No.")}</th>
                  <th data-col="primary_phone" className={`${TH} min-w-[160px]`}>{renderColHeaderBtn("phone", "Primary Phone No.")}</th>
                  <th data-col="secondary_phone" className={`${TH} min-w-[160px]`}>{renderColHeaderBtn("secondary_phone", "Secondary Phone No.")}</th>
                  <th data-col="primary_email" className={`${TH} ${COL_EMAIL}`}>{renderColHeaderBtn("email", "Primary Email")}</th>
                  <th data-col="secondary_email" className={`${TH} ${COL_EMAIL2}`}>{renderColHeaderBtn("secondary_email", "Secondary Email")}</th>
                  <th data-col="country" className={`${TH} min-w-[130px]`}>{renderColHeaderBtn("country", "Country")}</th>
                  <th data-col="product" className={`${TH} min-w-[140px]`}>{renderColHeaderBtn("product", "Product")}</th>
                  <th data-col="website" className={`${TH} ${COL_WEBSITE}`}>{renderColHeaderBtn("website", "Website")}</th>
                  <th data-col="city" className={`${TH} min-w-[120px]`}>{renderColHeaderBtn("city", "City")}</th>
                  <th data-col="ai_grading" className={`${TH} min-w-[120px]`}>{renderColHeaderBtn("ai_grading", "AI grading")}</th>
                  <th data-col="address" className={`${TH} min-w-[200px]`}>{renderColHeaderBtn("address", "Address")}</th>
                  <th data-col="added" className={`${TH} min-w-[120px]`}>{renderColHeaderBtn("created_at", "Added")}</th>
                  <th data-col="calling_time" className={`${TH} ${COL_CALLING}`}>{renderColHeaderBtn("calling_time", "Calling time")}</th>
                  <th data-col="remarks" className={`${TH} min-w-[180px]`}>{renderColHeaderBtn("remarks", "Remarks")}</th>
                  <th data-col="assigned_to" className={`${TH} min-w-[150px]`}>{renderColHeaderBtn("assigned_to_user_id", "Assigned To")}</th>
                  <th data-col="socials" className={`${TH} min-w-[120px]`}>Socials</th>
                  {isCallOutcomeSection && (
                    <th data-col="call_remarks" className={`${TH} min-w-[220px]`}>Call remarks</th>
                  )}
                  {canScheduleFollowUp && (
                    <th data-col="follow_up" className={`${TH} min-w-[190px]`}>Follow-up reminder</th>
                  )}
                  {editMode && <th data-col="edit" className={`${TH} min-w-[120px]`}>Edit</th>}
                  <th data-col="actions" className={`${TH} min-w-[100px]`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayedRows.map((row) => {
                  const draft = drafts[row.id] ?? row;
                  const dirty = editMode && isRowDirty(row.id);
                  const cell = (
                    field: keyof LeadTableRow,
                    display: string,
                    opts?: { type?: string; className?: string },
                  ) =>
                    editMode ? (
                      <input
                        type={opts?.type ?? "text"}
                        value={
                          field === "legacy_serial_no"
                            ? draft.legacy_serial_no != null
                              ? String(draft.legacy_serial_no)
                              : ""
                            : String((draft[field] as string | null | undefined) ?? "")
                        }
                        onChange={(e) => updateDraft(row.id, field, e.target.value)}
                        onBlur={(e) => commitDraftField(row.id, field, e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className={`${EDIT_INPUT} ${opts?.className ?? ""}`}
                        {...spellingPropsForLeadField(String(field))}
                      />
                    ) : (
                      <span className={`block truncate ${opts?.className ?? ""}`}>{display || "—"}</span>
                    );

                  return (
                    <tr
                      key={row.id}
                      onClick={() => {
                        if (!editMode) onSelectLead(row.id);
                      }}
                      className={`border-b border-slate-800/60 ${
                        editMode ? "" : "cursor-pointer hover:bg-slate-900/80"
                      } ${dirty ? "bg-amber-500/5" : ""} ${selected.has(row.id) ? "bg-slate-900/40" : ""}`}
                    >
                      <td
                        data-col="select"
                        className={`${TD} sticky left-0 bg-slate-900 z-[1]`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          onChange={() => toggleSelected(row.id)}
                          aria-label={`Select ${row.company_name}`}
                          className="rounded border-slate-600 bg-slate-950"
                        />
                      </td>
                      <td data-col="serial" className={`${TD_MUTED} ${COL_SERIAL} ${COL_FIXED}`}>
                        {editMode ? (
                          cell("legacy_serial_no", row.legacy_serial_no != null ? String(row.legacy_serial_no) : "")
                        ) : (
                          <ExpandableCell
                            text={
                              row.legacy_serial_no != null ? String(row.legacy_serial_no) : ""
                            }
                            title="Serial number"
                          />
                        )}
                      </td>
                      <td data-col="company" className={`${TD_PRIMARY} ${COL_COMPANY_OLD} ${COL_FIXED}`}>
                        {editMode ? (
                          cell("company_name", row.company_name)
                        ) : (
                          <ExpandableCell
                            text={row.company_name}
                            title="Know Your Customer"
                            className="text-slate-200 font-medium hover:text-white"
                            detail={renderKycDetail(row)}
                          />
                        )}
                      </td>
                      <td data-col="business_type" className={TD_MUTED}>{cell("industry", row.industry ?? "")}</td>
                      <td data-col="grading" className={TD_MUTED}>
                        {cell("company_grading", row.company_grading ?? "")}
                      </td>
                      <td data-col="designation" className={TD_MUTED}>
                        {cell("contact_designation", row.contact_designation ?? "")}
                      </td>
                      <td data-col="contact_person" className={TD_MUTED}>
                        {cell("contact_name", row.contact_name ?? "")}
                      </td>
                      <td data-col="primary_mobile" className={TD_MUTED}>
                        {editMode ? (
                          cell("contact_phone", row.contact_phone ?? "")
                        ) : row.contact_phone ? (
                          <span className="flex items-center gap-2 min-w-0">
                            <DialpadPhoneText
                              phone={row.contact_phone}
                              contactName={row.contact_name}
                              countryHint={row.country}
                            />
                            <CallLeadButton
                              leadId={row.id}
                              phone={row.contact_phone}
                              onError={onError}
                              assignedToUserId={row.assigned_to_user_id}
                              assignedTo={row.assigned_to}
                              compact
                            />
                            <WhatsAppLeadButton
                              phone={row.contact_phone}
                              compact
                              onClick={() => openWhatsAppCompose(row, row.contact_phone!)}
                            />
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-col="secondary_mobile" className={TD_MUTED}>
                        {editMode ? (
                          cell("contact_secondary_mobile", row.contact_secondary_mobile ?? "")
                        ) : row.contact_secondary_mobile ? (
                          <span className="flex items-center gap-2 min-w-0">
                            <DialpadPhoneText
                              phone={row.contact_secondary_mobile}
                              contactName={row.contact_name}
                              countryHint={row.country}
                            />
                            <CallLeadButton
                              leadId={row.id}
                              phone={row.contact_secondary_mobile}
                              onError={onError}
                              assignedToUserId={row.assigned_to_user_id}
                              assignedTo={row.assigned_to}
                              compact
                            />
                            <WhatsAppLeadButton
                              phone={row.contact_secondary_mobile}
                              compact
                              onClick={() =>
                                openWhatsAppCompose(row, row.contact_secondary_mobile!)
                              }
                            />
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-col="primary_phone" className={TD_MUTED}>
                        {editMode ? (
                          cell("contact_primary_phone", row.contact_primary_phone ?? "")
                        ) : row.contact_primary_phone ? (
                          <span className="flex items-center gap-2 min-w-0">
                            <DialpadPhoneText
                              phone={row.contact_primary_phone}
                              contactName={row.contact_name}
                              countryHint={row.country}
                            />
                            <CallLeadButton
                              leadId={row.id}
                              phone={row.contact_primary_phone}
                              onError={onError}
                              assignedToUserId={row.assigned_to_user_id}
                              assignedTo={row.assigned_to}
                              compact
                            />
                            <WhatsAppLeadButton
                              phone={row.contact_primary_phone}
                              compact
                              onClick={() =>
                                openWhatsAppCompose(row, row.contact_primary_phone!)
                              }
                            />
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-col="secondary_phone" className={TD_MUTED}>
                        {editMode ? (
                          cell("contact_secondary_phone", row.contact_secondary_phone ?? "")
                        ) : row.contact_secondary_phone ? (
                          <span className="flex items-center gap-2 min-w-0">
                            <DialpadPhoneText
                              phone={row.contact_secondary_phone}
                              contactName={row.contact_name}
                              countryHint={row.country}
                            />
                            <CallLeadButton
                              leadId={row.id}
                              phone={row.contact_secondary_phone}
                              onError={onError}
                              assignedToUserId={row.assigned_to_user_id}
                              assignedTo={row.assigned_to}
                              compact
                            />
                            <WhatsAppLeadButton
                              phone={row.contact_secondary_phone}
                              compact
                              onClick={() =>
                                openWhatsAppCompose(row, row.contact_secondary_phone!)
                              }
                            />
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td
                        data-col="primary_email"
                        className={`${TD_MUTED} ${COL_EMAIL} ${COL_FIXED}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {editMode ? (
                          cell("contact_email", row.contact_email ?? "", { type: "email" })
                        ) : row.contact_email ? (
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="truncate block" title={row.contact_email}>
                              {row.contact_email}
                            </span>
                            <EmailLeadButton
                              email={row.contact_email}
                              row={row}
                              onError={onError}
                              compact
                            />
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-col="secondary_email" className={`${TD_MUTED} ${COL_EMAIL2} ${COL_FIXED}`}>
                        {editMode ? (
                          cell("contact_secondary_email", row.contact_secondary_email ?? "", {
                            type: "email",
                          })
                        ) : row.contact_secondary_email?.includes("@") ? (
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="truncate block" title={row.contact_secondary_email}>
                              {row.contact_secondary_email}
                            </span>
                            <EmailLeadButton
                              email={row.contact_secondary_email}
                              row={row}
                              onError={onError}
                              compact
                            />
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-col="country" className={TD_MUTED}>
                        {editMode ? (
                          <div onClick={(e) => e.stopPropagation()}>
                            <CountrySelect
                              multiSelect={false}
                              value={draft.country ?? ""}
                              onChange={(value) => updateDraft(row.id, "country", value)}
                            />
                          </div>
                        ) : (
                          <span className="truncate block">{formatCountryLabel(row.country)}</span>
                        )}
                      </td>
                      <td data-col="product" className={TD_MUTED}>
                        {cell("product_interest", row.product_interest ?? "")}
                      </td>
                      <td data-col="website" className={`${TD_MUTED} ${COL_WEBSITE} ${COL_FIXED}`}>
                        {editMode ? (
                          cell("website_url", row.website_url ?? "")
                        ) : row.website_url ? (
                          <ExpandableCell
                            text={row.website_url.replace(/^https?:\/\//i, "")}
                            title="Website"
                            className="text-emerald-400 hover:text-emerald-300"
                            detail={
                              <a
                                href={row.website_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block text-xs text-emerald-400 hover:text-emerald-300"
                              >
                                Open website
                              </a>
                            }
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-col="city" className={TD_MUTED}>{cell("city", row.city ?? "")}</td>
                      <td data-col="ai_grading" className={TD}>
                        {row.latest_score ? (
                          <ScoreBadge score={scoreLabel(row.latest_score)} />
                        ) : (
                          <span className="text-slate-500 text-sm">Not scored</span>
                        )}
                      </td>
                      <td data-col="address" className={TD_MUTED}>{cell("address", row.address ?? "")}</td>
                      <td data-col="added" className={TD_MUTED} title={row.created_at || undefined}>
                        {formatAddedAt(row.created_at)}
                      </td>
                      <td data-col="calling_time" className={`${TD} ${COL_CALLING}`}>
                        <CallRecommendationBadge
                          recommended={row.call_recommended}
                          localTime={row.call_local_time}
                          reason={row.call_reason}
                          wrap
                        />
                      </td>
                      <td data-col="remarks" className={TD_MUTED}>
                        {editMode ? (
                          cell("remarks", row.remarks ?? "")
                        ) : (
                          <ExpandableCell
                            text={row.remarks}
                            title="Client remarks"
                            openWhenEmpty={(row.remarks_history?.length ?? 0) > 0}
                            detail={
                              (row.remarks_history?.length ?? 0) > 0 ? (
                                <div className="space-y-2 border-t border-slate-700 pt-3">
                                  <p className="text-xs uppercase tracking-wide text-slate-500">
                                    History (newest first)
                                  </p>
                                  {[...(row.remarks_history || [])]
                                    .filter((entry) => (entry.text || "").trim())
                                    .reverse()
                                    .map((entry, idx) => (
                                      <div
                                        key={`${entry.at}-${idx}`}
                                        className="rounded-md border border-slate-800 bg-slate-950/80 px-2.5 py-2"
                                      >
                                        <p className="text-[11px] text-slate-500 mb-1">
                                          <span className="font-medium text-slate-300">
                                            {entry.at
                                              ? new Date(entry.at).toLocaleString()
                                              : "—"}
                                          </span>
                                          {entry.by ? ` · ${entry.by}` : ""}
                                          {entry.source === "call" ? " · From call" : ""}
                                        </p>
                                        <p className="text-sm text-slate-300 whitespace-pre-wrap break-words">
                                          {entry.text}
                                        </p>
                                      </div>
                                    ))}
                                </div>
                              ) : (
                                <p className="mt-2 text-xs text-slate-500">
                                  No history yet. Edits from this table are saved with timestamps.
                                </p>
                              )
                            }
                          />
                        )}
                      </td>
                      <td data-col="assigned_to" className={TD_MUTED} onClick={(e) => e.stopPropagation()}>
                        {renderAssignedToCell(row, draft)}
                      </td>
                      <td data-col="socials" className={TD} onClick={(e) => e.stopPropagation()}>
                        {editMode ? (
                          <div className="space-y-1">
                            <input
                              value={draft.linkedin_company_url ?? ""}
                              onChange={(e) => updateDraft(row.id, "linkedin_company_url", e.target.value)}
                              placeholder="LinkedIn URL"
                              className={EDIT_INPUT}
                              {...spellingPropsForLeadField("linkedin_company_url")}
                            />
                            <input
                              value={draft.facebook_company_url ?? ""}
                              onChange={(e) => updateDraft(row.id, "facebook_company_url", e.target.value)}
                              placeholder="Facebook URL"
                              className={EDIT_INPUT}
                              {...spellingPropsForLeadField("facebook_company_url")}
                            />
                            <input
                              value={draft.instagram_company_url ?? ""}
                              onChange={(e) => updateDraft(row.id, "instagram_company_url", e.target.value)}
                              placeholder="Instagram URL"
                              className={EDIT_INPUT}
                              {...spellingPropsForLeadField("instagram_company_url")}
                            />
                          </div>
                        ) : (
                          <SocialLinksCell
                            companyName={row.company_name}
                            linkedinUrl={row.linkedin_company_url}
                            facebookUrl={row.facebook_company_url}
                            instagramUrl={row.instagram_company_url}
                          />
                        )}
                      </td>
                      {isCallOutcomeSection && (
                        <td data-col="call_remarks" className={TD_MUTED}>
                          {row.call_remarks ? (
                            <span
                              className="block whitespace-pre-wrap text-slate-300 text-xs leading-relaxed max-w-[280px]"
                              title={row.call_remarks}
                            >
                              {row.call_remarks}
                            </span>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                      )}
                      {canScheduleFollowUp && (
                        <td data-col="follow_up" className={TD_MUTED} onClick={(e) => e.stopPropagation()}>
                          <FollowUpScheduleControl
                            value={row.follow_up_at}
                            onChange={(next) => saveFollowUpAt(row.id, next)}
                          />
                        </td>
                      )}
                      {editMode && (
                        <td data-col="edit" className={`${TD} whitespace-nowrap`}>
                          <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => void saveRow(row.id)}
                              disabled={!dirty || savingId === row.id}
                              className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-medium disabled:opacity-50"
                            >
                              {savingId === row.id ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={() => onSelectLead(row.id)}
                              className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs"
                            >
                              Open
                            </button>
                          </div>
                        </td>
                      )}
                      <td data-col="actions" className={`${TD} whitespace-nowrap`}>
                        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => void deleteRows([row.id])}
                            disabled={deletingId === row.id || deletingSelected}
                            className="px-2 py-1 rounded bg-red-900/50 hover:bg-red-800 border border-red-800/50 text-xs text-red-200 disabled:opacity-50"
                          >
                            {deletingId === row.id ? "Deleting…" : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
          <table className="w-full text-sm border-collapse min-w-[1400px]">
            <thead>
              <tr className={`text-slate-500 border-b border-slate-800 bg-slate-950 ${theadStickyClass}`}>
                <th data-col="select" className={`${TH} w-12 sticky left-0 bg-slate-950 z-[1]`}>
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected;
                    }}
                    onChange={toggleSelectAllOnPage}
                    aria-label="Select all leads on this page"
                    className="rounded border-slate-600 bg-slate-950"
                  />
                </th>
                <th data-col="serial" className={`${TH} ${COL_SERIAL}`}>{renderColHeaderBtn("id", "S. No")}</th>
                <th data-col="company" className={`${TH} ${COL_COMPANY}`}>{renderColHeaderBtn("company_name", "Company name")}</th>
                <th data-col="website" className={`${TH} ${COL_WEBSITE}`}>{renderColHeaderBtn("website", "Website")}</th>
                <th data-col="email" className={`${TH} ${COL_EMAIL}`}>{renderColHeaderBtn("email", "Email")}</th>
                <th data-col="phone1" className={`${TH} min-w-[160px]`}>{renderColHeaderBtn("phone", "Primary Phone")}</th>
                <th data-col="phone2" className={`${TH} min-w-[160px]`}>{renderColHeaderBtn("secondary_phone", "Secondary Phone")}</th>
                <th data-col="calling_time" className={`${TH} ${COL_CALLING}`}>{renderColHeaderBtn("calling_time", "Calling time")}</th>
                <th data-col="role" className={`${TH} ${COL_ROLE}`}>{renderColHeaderBtn("market_role", "Role")}</th>
                <th data-col="ai_grading" className={`${TH} min-w-[110px]`}>{renderColHeaderBtn("ai_grading", "AI grading")}</th>
                <th data-col="socials" className={`${TH} min-w-[120px]`}>Socials</th>
                <th data-col="added" className={`${TH} min-w-[120px]`}>{renderColHeaderBtn("created_at", "Added")}</th>
                <th data-col="country" className={`${TH} min-w-[130px]`}>{renderColHeaderBtn("country", "Country")}</th>
                <th data-col="assigned_to" className={`${TH} min-w-[150px]`}>{renderColHeaderBtn("assigned_to_user_id", "Assigned To")}</th>
                {editMode && <th data-col="edit" className={`${TH} min-w-[120px]`}>Edit</th>}
                <th data-col="actions" className={`${TH} min-w-[100px]`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((row) => {
                const draft = drafts[row.id] ?? row;
                const dirty = editMode && isRowDirty(row.id);

                return (
                  <tr
                    key={row.id}
                    onClick={() => {
                      if (!editMode) onSelectLead(row.id);
                    }}
                    className={`border-b border-slate-800/60 ${
                      editMode ? "" : "cursor-pointer hover:bg-slate-900/80"
                    } ${dirty ? "bg-amber-500/5" : ""} ${selected.has(row.id) ? "bg-slate-900/40" : ""}`}
                  >
                    <td data-col="select" className={`${TD} sticky left-0 bg-slate-900 z-[1]`} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggleSelected(row.id)}
                        aria-label={`Select ${row.company_name}`}
                        className="rounded border-slate-600 bg-slate-950"
                      />
                    </td>
                    <td data-col="serial" className={`${TD_MUTED} ${COL_SERIAL} ${COL_FIXED}`}>
                      {editMode ? (
                        <input
                          value={
                            draft.legacy_serial_no != null ? String(draft.legacy_serial_no) : ""
                          }
                          onChange={(e) => updateDraft(row.id, "legacy_serial_no", e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className={EDIT_INPUT}
                          {...spellingPropsForLeadField("legacy_serial_no")}
                        />
                      ) : (
                        <ExpandableCell
                          text={
                            row.legacy_serial_no != null ? String(row.legacy_serial_no) : ""
                          }
                          title="Serial number"
                        />
                      )}
                    </td>
                    <td data-col="company" className={`${TD_PRIMARY} ${COL_COMPANY} ${COL_FIXED}`}>
                      {editMode ? (
                        <input
                          value={draft.company_name}
                          onChange={(e) => updateDraft(row.id, "company_name", e.target.value)}
                          onBlur={(e) =>
                            commitDraftField(row.id, "company_name", e.target.value)
                          }
                          onClick={(e) => e.stopPropagation()}
                          className={EDIT_INPUT}
                          {...spellingPropsForLeadField("company_name")}
                        />
                      ) : (
                        <ExpandableCell
                          text={row.company_name}
                          title="Know Your Customer"
                          className="text-slate-200 font-medium hover:text-white"
                          detail={renderKycDetail(row)}
                        />
                      )}
                    </td>
                    <td data-col="website" className={`${TD_MUTED} ${COL_WEBSITE} ${COL_FIXED}`}>
                      {editMode ? (
                        <input
                          value={draft.website_url ?? ""}
                          onChange={(e) => updateDraft(row.id, "website_url", e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="example.com"
                          className={EDIT_INPUT}
                          {...spellingPropsForLeadField("website_url")}
                        />
                      ) : row.website_url ? (
                        <ExpandableCell
                          text={row.website_url.replace(/^https?:\/\//, "")}
                          title="Website"
                          className="text-emerald-400 hover:text-emerald-300"
                          detail={
                            <a
                              href={row.website_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-block text-xs text-emerald-400 hover:text-emerald-300"
                            >
                              Open website
                            </a>
                          }
                        />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td
                      data-col="email"
                      className={`${TD_MUTED} ${COL_EMAIL} ${COL_FIXED}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {editMode ? (
                        <input
                          type="email"
                          value={draft.contact_email ?? ""}
                          onChange={(e) => updateDraft(row.id, "contact_email", e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className={EDIT_INPUT}
                          {...spellingPropsForLeadField("contact_email")}
                        />
                      ) : row.contact_email ? (
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="truncate block" title={row.contact_email}>
                            {row.contact_email}
                          </span>
                          <EmailLeadButton
                            email={row.contact_email}
                            row={row}
                            onError={onError}
                            compact
                          />
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td data-col="phone1" className={TD_MUTED}>
                      {editMode ? (
                        <input
                          value={draft.contact_phone ?? ""}
                          onChange={(e) => updateDraft(row.id, "contact_phone", e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className={EDIT_INPUT}
                          {...spellingPropsForLeadField("contact_phone")}
                        />
                      ) : row.contact_phone ? (
                        <span className="flex items-center gap-2 min-w-0">
                          <DialpadPhoneText
                            phone={row.contact_phone}
                            contactName={row.contact_name}
                            countryHint={row.country}
                          />
                          <CallLeadButton
                            leadId={row.id}
                            phone={row.contact_phone}
                            onError={onError}
                            compact
                          />
                          <WhatsAppLeadButton
                            phone={row.contact_phone}
                            compact
                            onClick={() => openWhatsAppCompose(row, row.contact_phone!)}
                          />
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td data-col="phone2" className={TD_MUTED}>
                      {editMode ? (
                        <input
                          value={draft.contact_secondary_mobile ?? draft.contact_secondary_phone ?? ""}
                          onChange={(e) =>
                            updateDraft(row.id, "contact_secondary_mobile", e.target.value)
                          }
                          onClick={(e) => e.stopPropagation()}
                          className={EDIT_INPUT}
                          {...spellingPropsForLeadField("contact_secondary_mobile")}
                        />
                      ) : (row.contact_secondary_mobile || row.contact_secondary_phone) ? (
                        <span className="flex items-center gap-2 min-w-0">
                          <DialpadPhoneText
                            phone={
                              (row.contact_secondary_mobile ||
                                row.contact_secondary_phone) as string
                            }
                            contactName={row.contact_name}
                            countryHint={row.country}
                          />
                          <CallLeadButton
                            leadId={row.id}
                            phone={
                              (row.contact_secondary_mobile ||
                                row.contact_secondary_phone) as string
                            }
                            onError={onError}
                            assignedToUserId={row.assigned_to_user_id}
                            assignedTo={row.assigned_to}
                            compact
                          />
                          <WhatsAppLeadButton
                            phone={
                              (row.contact_secondary_mobile ||
                                row.contact_secondary_phone) as string
                            }
                            compact
                            onClick={() =>
                              openWhatsAppCompose(
                                row,
                                (row.contact_secondary_mobile ||
                                  row.contact_secondary_phone) as string,
                              )
                            }
                          />
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td data-col="calling_time" className={`${TD} ${COL_CALLING}`}>
                      <CallRecommendationBadge
                        recommended={row.call_recommended}
                        localTime={row.call_local_time}
                        reason={row.call_reason}
                        wrap
                      />
                    </td>
                    <td data-col="role" className={`${TD} ${COL_ROLE} ${COL_FIXED}`}>
                      <div className="flex flex-col gap-1 min-w-0">
                        <MarketRoleBadge role={row.market_role ?? "unknown"} />
                        {(row.market_role === "producer" || row.market_role === "hybrid") && (
                          <ProducerTierBadge
                            tier={row.producer_tier}
                            conversionPct={row.producer_conversion_pct}
                            compact
                          />
                        )}
                      </div>
                      {(row.producer_tier_reasoning || row.market_role_reasoning) && !editMode && (
                        <p className="text-xs text-slate-500 mt-1 line-clamp-2 break-words">
                          {row.producer_tier_reasoning ?? row.market_role_reasoning}
                        </p>
                      )}
                    </td>
                    <td data-col="ai_grading" className={TD}>
                      {row.latest_score ? (
                        <ScoreBadge score={scoreLabel(row.latest_score)} />
                      ) : (
                        <span className="text-slate-500 text-sm">Not scored</span>
                      )}
                    </td>
                    <td data-col="socials" className={TD}>
                      <SocialLinksCell
                        companyName={draft.company_name}
                        facebookUrl={draft.facebook_company_url}
                        instagramUrl={draft.instagram_company_url}
                        linkedinUrl={draft.linkedin_company_url}
                        editMode={editMode}
                        onFieldChange={(field, value) => updateDraft(row.id, field, value)}
                      />
                    </td>
                    <td data-col="added" className={TD_MUTED} title={row.created_at || undefined}>
                      {formatAddedAt(row.created_at)}
                    </td>
                    <td data-col="country" className={TD_MUTED}>
                      {editMode ? (
                        <div onClick={(e) => e.stopPropagation()}>
                          <CountrySelect
                            multiSelect={false}
                            value={draft.country ?? ""}
                            onChange={(value) => updateDraft(row.id, "country", value)}
                          />
                        </div>
                      ) : (
                        <span className="truncate block">{formatCountryLabel(row.country)}</span>
                      )}
                    </td>
                    <td data-col="assigned_to" className={TD_MUTED} onClick={(e) => e.stopPropagation()}>
                      {renderAssignedToCell(row, draft)}
                    </td>
                    {editMode && (
                      <td data-col="edit" className={`${TD} whitespace-nowrap`}>
                        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => void saveRow(row.id)}
                            disabled={!dirty || savingId === row.id}
                            className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-medium disabled:opacity-50"
                          >
                            {savingId === row.id ? "Saving…" : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={() => onSelectLead(row.id)}
                            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs"
                          >
                            Open
                          </button>
                        </div>
                      </td>
                    )}
                    <td data-col="actions" className={`${TD} whitespace-nowrap`}>
                      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => void deleteRows([row.id])}
                          disabled={deletingId === row.id || deletingSelected}
                          className="px-2 py-1 rounded bg-red-900/50 hover:bg-red-800 border border-red-800/50 text-xs text-red-200 disabled:opacity-50"
                        >
                          {deletingId === row.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
          </div>
          </div>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={filteredCount}
          pageSize={TABLE_PAGE_SIZE}
          onPageChange={setPage}
          disabled={loading || bulkOnboarding || deletingSelected || editMode}
        />
      )}
      </div>

      {showCsvImport && canImportSpreadsheet && (
        <LeadsTableCsvImport
          onClose={() => setShowCsvImport(false)}
          onImported={() => {
            clearFilters();
            setPage(1);
            setSortBy("created_at");
            setSortDir("desc");
            if (isOldClients) {
              void runPostImportClean({ afterImport: true });
              return;
            }
            void loadTable();
            void loadSectionCounts();
            setSaveNotice("Import finished — table refreshed to show the newest rows.");
            window.setTimeout(() => setSaveNotice(null), 6000);
          }}
          onError={onError}
          importSource={importSource}
          tableLabel={
            isOldClients
              ? isAdmin
                ? "Old clients"
                : "Clients"
              : isTargetedPool
                ? sectionTitle(section, assigneeUsername, isAdmin)
                : undefined
          }
          title={
            isOldClients
              ? isAdmin
                ? "Import old clients"
                : "Import clients"
              : isTargetedPool
                ? `Import ${sectionTitle(section, assigneeUsername, isAdmin)}`
                : "Import leads"
          }
          description={
            isOldClients
              ? isAdmin
                ? "Upload CSV or Excel (.xlsx). Columns are mapped to the Old clients table. Import only saves rows as-is — research and score later from the table."
                : "Upload CSV or Excel (.xlsx). Columns are mapped to your Clients table. Import only saves rows as-is — research and score later from the table."
              : isTargetedPool
                ? "Upload CSV or Excel (.xlsx). Rows are saved as uploaded data in this targeted list — use the toggle to view them separately from AI / search leads."
                : "Upload CSV or Excel (.xlsx). Rows are saved into your leads table as-is — research and score them from the table when ready."
          }
        />
      )}

      {showBulkEmail && (
        <BulkEmailModal
          buyerIds={[...selected]}
          sampleBuyerId={[...selected][0] ?? null}
          sampleCompanyName={rows.find((r) => selected.has(r.id))?.company_name}
          onClose={() => setShowBulkEmail(false)}
          onError={onError}
          onCreated={(result) => {
            setBulkEmailNotice(
              `Sent ${result.sent_count ?? 0} email(s). ` +
                ((result.failed_count ?? 0) > 0
                  ? `${result.failed_count} failed. `
                  : "") +
                (result.skipped_count > 0
                  ? `${result.skipped_count} skipped (no email on file). `
                  : "") +
                "Open Email Activity for live notifications.",
            );
            clearSelection();
          }}
        />
      )}

      {whatsappComposeTarget && (
        <LeadWhatsAppComposeModal
          target={whatsappComposeTarget}
          onClose={() => setWhatsappComposeTarget(null)}
          onError={onError}
          onSent={(message) => {
            setBulkWhatsAppNotice(message);
            setWhatsappComposeTarget(null);
          }}
        />
      )}

      {showBulkWhatsApp && whatsappTargetIds && whatsappTargetIds.length > 0 && (
        <BulkWhatsAppModal
          buyerIds={whatsappTargetIds}
          onClose={() => {
            setShowBulkWhatsApp(false);
            setWhatsappTargetIds(null);
          }}
          onError={onError}
          onCreated={(result) => {
            const skipReasons = (result.skipped || [])
              .map((s) => s.reason)
              .filter(Boolean)
              .slice(0, 2);
            const skipHint =
              skipReasons.length > 0
                ? ` Reason: ${skipReasons.join("; ")}.`
                : result.skipped_count > 0
                  ? " Usually missing phone, or marketing opt-in was required."
                  : "";
            setBulkWhatsAppNotice(
              `Sent ${result.sent_count ?? 0} WhatsApp message(s). ` +
                ((result.failed_count ?? 0) > 0 ? `${result.failed_count} failed. ` : "") +
                (result.skipped_count > 0
                  ? `${result.skipped_count} skipped.${skipHint} `
                  : "") +
                "Open WhatsApp inbox to see the thread.",
            );
            clearSelection();
            setShowBulkWhatsApp(false);
            setWhatsappTargetIds(null);
          }}
        />
      )}
      {colFilterModal && (
        <div className="fixed inset-0 z-[999] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 sm:p-6">
          <div className="bg-slate-900 border-2 border-slate-700 rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in zoom-in duration-150">
            {/* Modal Header */}
            <div className="bg-slate-950 border-b border-slate-800 p-6 flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-2xl font-extrabold text-slate-100 flex items-center gap-3">
                  <span className="text-emerald-400">🔍 Filter &amp; Sort:</span>
                  <span>{colFilterModal.label}</span>
                </h2>
                <p className="text-sm text-slate-400 mt-1">
                  Multi-select values or search across all rows to filter this column view.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setColFilterModal(null)}
                className="w-10 h-10 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center justify-center text-lg font-bold transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-6 flex-1 overflow-y-auto">
              {/* Sort Action Bar */}
              <div className="flex items-center gap-3 bg-slate-950/60 border border-slate-800 p-3.5 rounded-2xl">
                <span className="text-sm font-semibold text-slate-300 shrink-0">Sort Order:</span>
                <button
                  type="button"
                  onClick={() => {
                    setSortBy(colFilterModal.field);
                    setSortDir("asc");
                  }}
                  className={`px-4 py-2 rounded-xl text-sm font-bold border transition-colors flex items-center gap-1.5 ${
                    sortBy === colFilterModal.field && sortDir === "asc"
                      ? "bg-emerald-500/20 border-emerald-500 text-emerald-300"
                      : "border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  <span>Sort A → Z</span>
                  <span>↑</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSortBy(colFilterModal.field);
                    setSortDir("desc");
                  }}
                  className={`px-4 py-2 rounded-xl text-sm font-bold border transition-colors flex items-center gap-1.5 ${
                    sortBy === colFilterModal.field && sortDir === "desc"
                      ? "bg-emerald-500/20 border-emerald-500 text-emerald-300"
                      : "border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  <span>Sort Z → A</span>
                  <span>↓</span>
                </button>
              </div>

              {/* Search Bar inside Modal */}
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-200 block">
                  Search values in {colFilterModal.label}:
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={colModalSearch}
                    onChange={(e) => setColModalSearch(e.target.value)}
                    placeholder={`Type to search ${colFilterModal.label}...`}
                    className="w-full text-base bg-slate-950 border-2 border-slate-700 focus:border-emerald-500 rounded-2xl px-4 py-3 text-slate-100 placeholder:text-slate-500 focus:outline-none font-medium shadow-inner"
                  />
                  {colModalSearch && (
                    <button
                      type="button"
                      onClick={() => setColModalSearch("")}
                      className="absolute right-4 top-3.5 text-slate-400 hover:text-white text-xs font-semibold"
                    >
                      Clear Search
                    </button>
                  )}
                </div>
              </div>

              {/* Multi-Select Value Options List */}
              <div className="space-y-3">
                {(() => {
                  let allUniqueVals: [string, number][] = [];
                  let blankCount = 0;
                  let totalMatching = filteredCount;

                  if (colModalColumnData) {
                    blankCount = colModalColumnData.blank_count;
                    totalMatching = colModalColumnData.total_matching;
                    allUniqueVals = [
                      ...(blankCount > 0 ? [["(Blanks)", blankCount] as [string, number]] : []),
                      ...colModalColumnData.unique_values.map((v) => [v.value, v.count] as [string, number]),
                    ];
                  } else {
                    const modalRows = getFilteredRowsExcept(colFilterModal.field);
                    const uniqueValuesMap = new Map<string, number>();
                    modalRows.forEach((r) => {
                      const val = getRowFieldValue(r, colFilterModal.field);
                      if (!val) {
                        blankCount++;
                      } else {
                        uniqueValuesMap.set(val, (uniqueValuesMap.get(val) || 0) + 1);
                      }
                    });
                    const sortedUniqueVals = Array.from(uniqueValuesMap.entries())
                      .sort((a, b) => b[1] - a[1]);
                    allUniqueVals = [
                      ...(blankCount > 0 ? [["(Blanks)", blankCount] as [string, number]] : []),
                      ...sortedUniqueVals,
                    ];
                  }

                  const filteredUniqueVals = allUniqueVals.filter(([val]) =>
                    val.toLowerCase().includes(colModalSearch.trim().toLowerCase()),
                  );

                  return (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-slate-300">
                          Select options ({pendingColSelections.length} selected)
                          {colModalColumnData ? ` out of ${totalMatching} total rows` : ""}:
                        </span>
                        <div className="flex items-center gap-3 text-sm">
                          {colModalLoading && (
                            <span className="text-xs text-amber-400 animate-pulse font-mono">
                              Calculating overall counts…
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              const allVals = allUniqueVals.map(([v]) => v);
                              setPendingColSelections(allVals);
                            }}
                            className="text-emerald-400 hover:underline font-semibold"
                          >
                            Select All
                          </button>
                          <span className="text-slate-600">|</span>
                          <button
                            type="button"
                            onClick={() => setPendingColSelections([])}
                            className="text-slate-400 hover:text-white font-semibold"
                          >
                            Clear All
                          </button>
                        </div>
                      </div>

                      {/* Scrollable Container with large text and vertical/horizontal scrolling */}
                      <div className="max-h-[380px] overflow-y-auto overflow-x-auto border-2 border-slate-800 bg-slate-950/80 rounded-2xl p-3 space-y-1.5 divide-y divide-slate-800/40">
                        {filteredUniqueVals.length === 0 ? (
                          <div className="py-8 text-center text-slate-500 text-sm font-medium">
                            {colModalLoading
                              ? "Calculating options across section..."
                              : `No matching values found for "${colModalSearch}"`}
                          </div>
                        ) : (
                          filteredUniqueVals.map(([val, count]) => {
                            const checked = pendingColSelections.includes(val);
                            const isBlank = val === "(Blanks)";
                            return (
                              <label
                                key={val}
                                className={`flex items-center justify-between gap-4 p-3 rounded-xl hover:bg-slate-900/90 cursor-pointer transition-colors group pt-2.5 ${
                                  isBlank ? "bg-amber-500/10 border border-amber-500/30" : ""
                                }`}
                              >
                                <div className="flex items-center gap-3.5 min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setPendingColSelections((prev) => [...prev, val]);
                                      } else {
                                        setPendingColSelections((prev) =>
                                          prev.filter((v) => v !== val),
                                        );
                                      }
                                    }}
                                    className="w-5 h-5 rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-500 shrink-0"
                                  />
                                  <span
                                    className={`text-base font-semibold group-hover:text-white truncate ${
                                      isBlank ? "text-amber-300 font-bold" : "text-slate-200"
                                    }`}
                                  >
                                    {isBlank ? "📂 (Blanks / Empty Data)" : val}
                                  </span>
                                </div>
                                <span
                                  className={`text-xs font-mono font-bold px-2.5 py-1 rounded-full shrink-0 ${
                                    isBlank
                                      ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                      : "bg-slate-800/80 text-emerald-400"
                                  }`}
                                >
                                  {count} rows
                                </span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="bg-slate-950 border-t border-slate-800 p-6 flex items-center justify-between shrink-0 gap-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedColValues((prev) => ({
                      ...prev,
                      [colFilterModal.field]: [],
                    }));
                    setColFilterModal(null);
                  }}
                  className="px-5 py-3 rounded-2xl border border-slate-700 text-slate-300 hover:bg-slate-900 hover:text-white font-bold text-sm transition-colors"
                >
                  Reset Column Filter
                </button>
                {(() => {
                  const blankCount = colModalColumnData
                    ? colModalColumnData.blank_count
                    : getFilteredRowsExcept(colFilterModal.field).filter(
                        (r) => !getRowFieldValue(r, colFilterModal.field),
                      ).length;
                  if (blankCount === 0) return null;
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        setPendingColSelections(["(Blanks)"]);
                      }}
                      className="px-5 py-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 font-extrabold text-sm transition-colors flex items-center gap-2"
                      title="Select only rows with blank/empty data for this column"
                    >
                      <span>Show Blanks Only</span>
                      <span className="bg-amber-500/20 px-2 py-0.5 rounded-full text-xs font-mono">
                        {blankCount}
                      </span>
                    </button>
                  );
                })()}
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setColFilterModal(null)}
                  className="px-5 py-3 rounded-2xl border border-slate-800 text-slate-400 hover:text-white font-semibold text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedColValues((prev) => ({
                      ...prev,
                      [colFilterModal.field]: pendingColSelections,
                    }));
                    setColFilterModal(null);
                  }}
                  className="px-7 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-base shadow-xl transition-colors"
                >
                  Apply Filter
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {moveConfirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-indigo-500/40 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-400 text-xl font-bold">
                📦
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">
                  Confirm Move to Module
                </h3>
                <p className="text-xs text-slate-400">
                  Are you sure you want to transfer selected leads?
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-300 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Leads to move:</span>
                <span className="font-extrabold text-indigo-300 bg-indigo-500/10 px-2.5 py-1 rounded-lg border border-indigo-500/20">
                  {moveConfirmTarget.count} lead(s)
                </span>
              </div>
              <div className="flex justify-between items-center pt-1">
                <span className="text-slate-400">Destination module:</span>
                <span className="font-extrabold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20">
                  {moveConfirmTarget.moduleLabel}
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={movingToModule}
                onClick={() => setMoveConfirmTarget(null)}
                className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-bold text-slate-300 hover:bg-slate-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={movingToModule}
                onClick={async () => {
                  const target = moveConfirmTarget;
                  setMoveConfirmTarget(null);
                  await handleMoveToModule(target.moduleKey);
                }}
                className="rounded-xl bg-indigo-600 hover:bg-indigo-500 px-5 py-2 text-xs font-extrabold text-white shadow-lg transition-all disabled:opacity-50"
              >
                {movingToModule ? "Moving…" : "Confirm Move"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dynamic Module & List Manager Modal */}
      <ManageModulesModal
        isOpen={showManageModules}
        onClose={() => setShowManageModules(false)}
        onModulesChanged={() => {
          void loadCustomModules();
          void loadSectionCounts();
          void loadTable();
        }}
      />
    </section>
  );
}
