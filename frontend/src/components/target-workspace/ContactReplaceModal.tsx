import React, { useState } from "react";
import type { WorkspaceLeadItem } from "../../api/client";

interface ContactReplaceModalProps {
  lead: WorkspaceLeadItem | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    buyer_id: number;
    new_contact_name: string;
    new_email: string;
    new_phone?: string;
    new_designation?: string;
    product_type?: string;
    notes?: string;
  }) => Promise<void>;
}

export const ContactReplaceModal: React.FC<ContactReplaceModalProps> = ({
  lead,
  isOpen,
  onClose,
  onSubmit,
}) => {
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newDesignation, setNewDesignation] = useState("");
  const [productType, setProductType] = useState("FMCG / Food & Beverage");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !lead) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newEmail.trim()) {
      setError("Please provide both new contact name and new email address.");
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit({
        buyer_id: lead.id,
        new_contact_name: newName.trim(),
        new_email: newEmail.trim(),
        new_phone: newPhone.trim() || undefined,
        new_designation: newDesignation.trim() || undefined,
        product_type: productType,
        notes: notes.trim() || undefined,
      });
      // Reset form
      setNewName("");
      setNewEmail("");
      setNewPhone("");
      setNewDesignation("");
      setNotes("");
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to replace contact.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div className="relative w-full max-w-xl rounded-2xl bg-slate-900 border border-slate-700/80 shadow-2xl p-6 text-slate-100 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🔄</span>
              <h3 className="text-lg font-bold text-white">Replace Contact & Enroll in Drip Campaign</h3>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Shift stale/dead contact to 15-day automated Drip Campaign while refreshing active master records with the new contact.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
          >
            ✕
          </button>
        </div>

        {/* Current Dead Contact Stale Warning */}
        <div className="my-4 p-3 rounded-xl bg-rose-950/40 border border-rose-800/60 flex flex-col gap-1.5 text-xs">
          <div className="flex items-center gap-2 text-rose-300 font-semibold">
            <span>🔴 Stale Contact Shifting to Drip:</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-slate-300">
            <div><span className="text-slate-400">Company:</span> <strong className="text-white">{lead.company_name}</strong></div>
            <div><span className="text-slate-400">Current Person:</span> {lead.contact_person || "Unknown"}</div>
            <div><span className="text-slate-400">Stale Email:</span> <span className="font-mono text-rose-200">{lead.primary_email || "None"}</span></div>
            <div><span className="text-slate-400">Emails Sent:</span> <span className="text-amber-300 font-bold">{lead.emails_sent_count}</span> | Calls: {lead.calls_made_count}</div>
          </div>
          <p className="text-[11px] text-rose-200/80 mt-1 italic">
            * This old email will receive 1 gentle follow-up email every 15 days in the dedicated Drip Campaign table without disturbing the master contact list.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs">
            {error}
          </div>
        )}

        {/* New Contact Form */}
        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-medium mb-1">
                New Contact Person Name <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. John Doe / Sourcing Manager"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="block text-slate-300 font-medium mb-1">
                New Email Address <span className="text-rose-400">*</span>
              </label>
              <input
                type="email"
                required
                placeholder="e.g. j.doe@company.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-medium mb-1">Designation / Role</label>
              <input
                type="text"
                placeholder="e.g. Procurement Director / Buyer"
                value={newDesignation}
                onChange={(e) => setNewDesignation(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="block text-slate-300 font-medium mb-1">New Phone / WhatsApp</label>
              <input
                type="text"
                placeholder="e.g. +86 138 0000 0000"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">Product Category / Focus</label>
            <select
              value={productType}
              onChange={(e) => setProductType(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            >
              <option value="FMCG / Food & Beverage">FMCG / Food & Beverage</option>
              <option value="Himalayan Rock Salt">Himalayan Rock Salt (Edible & Industrial)</option>
              <option value="Spices & Seasonings">Spices & Seasonings</option>
              <option value="Rice & Pulses">Rice & Pulses</option>
              <option value="Minerals & Ores">Minerals & Ores</option>
              <option value="General Import / Wholesale">General Import / Wholesale</option>
            </select>
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">Research / Replacement Notes</label>
            <textarea
              rows={2}
              placeholder="e.g. Found new buyer on LinkedIn after previous email bounced / 30-day silence."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {/* Action buttons */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold shadow-lg shadow-emerald-900/30 transition flex items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <span className="animate-spin text-sm">⏳</span> Replacing & Enrolling...
                </>
              ) : (
                <>
                  <span>✓</span> Save New Contact & Start Drip
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
