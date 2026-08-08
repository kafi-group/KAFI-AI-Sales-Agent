import { useState, type FormEvent } from "react";
import { CountrySelect } from "../components/CountrySelect";
import { IndustrySelect } from "../components/IndustrySelect";
import { CompanyNameSuggest } from "../components/CompanyNameSuggest";
import { client, type CompanyNameSuggestion } from "../api/client";
import {
  autocorrectText,
  capitalizeFirstLetter,
  spellingInputProps,
} from "../utils/spelling";
import {
  composeWebsiteUrl,
  type WebsitePrefix,
} from "../utils/websiteUrl";

interface CreateLeadFormProps {
  onSuccess: (leadId: number) => void;
  onCancel: () => void;
  onError: (message: string) => void;
  /** When user picks an existing master-table match — open that profile instead. */
  onOpenExisting?: (leadId: number) => void;
  /** Buyer source so the lead appears in the right table section (e.g. old_clients). */
  source?: string;
  title?: string;
  /** Pre-fill from Brand assistant or other sources. */
  initialValues?: Partial<typeof emptyForm> & { address?: string };
}

const emptyForm = {
  company_name: "",
  website_domain: "",
  website_prefix: "https://" as WebsitePrefix,
  country: "",
  industry: "",
  contact_name: "",
  contact_email: "",
  contact_phone: "",
  contact_designation: "",
};

export function CreateLeadForm({
  onSuccess,
  onCancel,
  onError,
  onOpenExisting,
  source = "manual",
  title = "Add new lead",
  initialValues,
}: CreateLeadFormProps) {
  const [form, setForm] = useState({
    ...emptyForm,
    ...initialValues,
    website_prefix: initialValues?.website_prefix ?? ("https://" as WebsitePrefix),
  });
  const [submitting, setSubmitting] = useState(false);
  const [existingMatch, setExistingMatch] = useState<CompanyNameSuggestion | null>(
    null,
  );

  function updateField(field: keyof typeof emptyForm, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field === "company_name") {
      setExistingMatch((prev) => {
        if (!prev) return null;
        return prev.company_name.trim().toLowerCase() === value.trim().toLowerCase()
          ? prev
          : null;
      });
    }
  }

  function handleSelectExisting(suggestion: CompanyNameSuggestion) {
    setForm((prev) => ({
      ...prev,
      company_name: suggestion.company_name,
      country: suggestion.country || prev.country,
      industry: suggestion.industry || prev.industry,
    }));
    setExistingMatch(suggestion);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form.company_name.trim()) {
      onError("Company or buyer name is required");
      return;
    }

    if (
      existingMatch &&
      existingMatch.company_name.trim().toLowerCase() ===
        form.company_name.trim().toLowerCase()
    ) {
      onError(
        `"${existingMatch.company_name}" already exists in the master table. Open the existing lead instead of creating a duplicate.`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const companyName = autocorrectText(form.company_name, "name");
      const industry = autocorrectText(form.industry, "prose");
      const contactName = autocorrectText(form.contact_name, "name");
      const designation = autocorrectText(form.contact_designation, "prose");

      const lead = await client.createLead({
        company_name: companyName,
        website_url: composeWebsiteUrl(form.website_prefix, form.website_domain),
        country: form.country.trim() || undefined,
        industry: industry || undefined,
        source,
      });

      if (initialValues?.address?.trim()) {
        await client.updateLeadTableRow(lead.id, { address: initialValues.address.trim() });
      }

      if (contactName) {
        await client.createContact({
          buyer_id: lead.id,
          full_name: contactName,
          email: form.contact_email.trim() || undefined,
          phone: form.contact_phone.trim() || undefined,
          designation: designation || undefined,
        });
      }

      setForm(emptyForm);
      setExistingMatch(null);
      onSuccess(lead.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create lead");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-emerald-500/30 bg-slate-900 p-5 space-y-5"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-slate-200">{title}</h3>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-slate-400 hover:text-slate-200"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-sm text-slate-400">Company / buyer name *</span>
          <CompanyNameSuggest
            value={form.company_name}
            onChange={(value) => updateField("company_name", value)}
            onSelectExisting={handleSelectExisting}
            disabled={submitting}
          />
          <p className="text-xs text-slate-500 mt-1">
            Suggestions come from the master table as you type — pick a match to avoid
            duplicates.
          </p>
        </label>

        {existingMatch ? (
          <div className="sm:col-span-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-amber-100/95">
              <span className="font-medium">{existingMatch.company_name}</span> is already
              in the master table
              {existingMatch.country ? ` (${existingMatch.country})` : ""}. Creating again
              would duplicate this lead.
            </p>
            {onOpenExisting ? (
              <button
                type="button"
                onClick={() => onOpenExisting(existingMatch.id)}
                className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-100 hover:bg-amber-500/25"
              >
                Open existing
              </button>
            ) : null}
          </div>
        ) : null}

        <CountrySelect
          label="Country"
          labelClassName="text-sm text-slate-400"
          value={form.country}
          onChange={(value) => updateField("country", value)}
        />

        <IndustrySelect
          label="Industry"
          labelClassName="text-sm text-slate-400"
          value={form.industry}
          onChange={(value) => updateField("industry", value)}
        />

        <div className="block sm:col-span-2">
          <span className="text-sm text-slate-400">Website (optional)</span>
          <div className="mt-1 flex rounded-lg border border-slate-700 bg-slate-950 overflow-hidden focus-within:border-emerald-500/50">
            <label className="sr-only" htmlFor="lead-website-prefix">
              URL prefix
            </label>
            <select
              id="lead-website-prefix"
              value={form.website_prefix}
              onChange={(e) =>
                updateField("website_prefix", e.target.value as WebsitePrefix)
              }
              disabled={submitting}
              className="shrink-0 border-r border-slate-700 bg-slate-900 px-2.5 py-2 text-sm text-slate-300 outline-none"
            >
              <option value="https://">https://</option>
              <option value="http://">http://</option>
              <option value="www.">www.</option>
            </select>
            <input
              type="text"
              inputMode="url"
              value={form.website_domain}
              onChange={(e) => updateField("website_domain", e.target.value)}
              placeholder="example.com"
              disabled={submitting}
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 outline-none"
              {...spellingInputProps("off")}
            />
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Optional — enter the domain only (e.g. alnoorfoods.com). Leave blank if unknown.
          </p>
        </div>
      </div>

      <fieldset className="border-t border-slate-800 pt-4">
        <legend className="text-sm font-medium text-slate-300 px-1">
          Primary contact (optional)
        </legend>
        <div className="grid gap-4 sm:grid-cols-2 mt-3">
          <label className="block sm:col-span-2">
            <span className="text-sm text-slate-400">Full name</span>
            <input
              type="text"
              value={form.contact_name}
              onChange={(e) =>
                updateField("contact_name", capitalizeFirstLetter(e.target.value))
              }
              onBlur={(e) =>
                updateField("contact_name", autocorrectText(e.target.value, "name"))
              }
              placeholder="e.g. Ahmed Al-Rashid"
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              {...spellingInputProps("name")}
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-400">Email</span>
            <input
              type="email"
              value={form.contact_email}
              onChange={(e) => updateField("contact_email", e.target.value)}
              placeholder="name@company.com"
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              {...spellingInputProps("off")}
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-400">Phone</span>
            <input
              type="tel"
              value={form.contact_phone}
              onChange={(e) => updateField("contact_phone", e.target.value)}
              placeholder="+971..."
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              {...spellingInputProps("off")}
            />
          </label>

          <label className="block sm:col-span-2">
            <span className="text-sm text-slate-400">Designation</span>
            <input
              type="text"
              value={form.contact_designation}
              onChange={(e) =>
                updateField(
                  "contact_designation",
                  capitalizeFirstLetter(e.target.value),
                )
              }
              onBlur={(e) =>
                updateField(
                  "contact_designation",
                  autocorrectText(e.target.value, "prose"),
                )
              }
              placeholder="e.g. Procurement Manager"
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
              {...spellingInputProps("prose")}
            />
          </label>
        </div>
      </fieldset>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || Boolean(existingMatch)}
          className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
          title={
            existingMatch
              ? "This company already exists — open the existing lead instead"
              : undefined
          }
        >
          {submitting ? "Creating…" : "Create lead"}
        </button>
      </div>
    </form>
  );
}
