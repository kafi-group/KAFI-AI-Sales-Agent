import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  client,
  type WhatsAppConfig,
  type WhatsAppTemplate,
  type WhatsAppTemplateCreatePayload,
  type WhatsAppTemplateNotification,
} from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { IconSearch } from "../components/icons/AppIcons";
import { capitalizeFirstLetter } from "../utils/spelling";

interface WhatsAppTemplatesPageProps {
  onError: (message: string) => void;
  onCountChange?: (count: number) => void;
}

const STATUS_STYLES: Record<string, string> = {
  approved: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
  pending: "bg-amber-500/10 border-amber-500/30 text-amber-300",
  rejected: "bg-red-500/10 border-red-500/30 text-red-300",
  paused: "bg-slate-700/50 border-slate-600 text-slate-400",
  disabled: "bg-slate-700/50 border-slate-600 text-slate-400",
};

type WhatsAppTemplateCategory = WhatsAppTemplateCreatePayload["category"];

interface WhatsAppTemplateCreateForm {
  name: string;
  category: WhatsAppTemplateCategory;
  language: string;
  body: string;
  footer: string;
}

const DEFAULT_CREATE_FORM: WhatsAppTemplateCreateForm = {
  name: "kafi_product_intro",
  category: "UTILITY",
  language: "en_US",
  body:
    "Dear {{1}},\n\n" +
    "Thank you for your interest in Kafi Commodities ESSENCE products. " +
    "We would be pleased to share specifications and pricing for {{2}}.\n\n" +
    "Best regards,\nKafi Commodities Export Team",
  footer: "Kafi Commodities (Pvt) Ltd",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs border ${STATUS_STYLES[status] ?? STATUS_STYLES.pending}`}
    >
      {status}
    </span>
  );
}

function notificationStyle(eventType: string): string {
  if (eventType === "approved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-100";
  if (eventType === "rejected") return "border-red-500/30 bg-red-500/10 text-red-100";
  if (eventType === "submitted") return "border-amber-500/30 bg-amber-500/10 text-amber-100";
  return "border-slate-700 bg-slate-900/80 text-slate-200";
}

export function WhatsAppTemplatesPage({ onError, onCountChange }: WhatsAppTemplatesPageProps) {
  const { isAdmin } = useAuth();
  const [config, setConfig] = useState<WhatsAppConfig | null>(null);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [notifications, setNotifications] = useState<WhatsAppTemplateNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [showCreator, setShowCreator] = useState(false);
  const [createForm, setCreateForm] =
    useState<WhatsAppTemplateCreateForm>(DEFAULT_CREATE_FORM);
  const [submitting, setSubmitting] = useState(false);

  const [testPhone, setTestPhone] = useState("");
  const [testTemplateId, setTestTemplateId] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [templateSearch, setTemplateSearch] = useState("");

  const refreshNotifications = useCallback(async () => {
    try {
      const data = await client.listWhatsAppTemplateNotifications({ unreadOnly: true, limit: 20 });
      setNotifications(data.rows || []);
      setUnreadCount(data.unread_count || 0);
    } catch {
      // Non-blocking — templates list still works without notifications.
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, rows] = await Promise.all([
        client.getWhatsAppConfig(),
        client.listWhatsAppTemplates(),
      ]);
      setConfig(cfg);
      setTemplates(rows);
      onCountChange?.(rows.filter((t) => t.status === "approved").length);
      const approved = rows.filter((t) => t.status === "approved");
      setTestTemplateId((current) => {
        if (current && approved.some((t) => String(t.id) === current)) return current;
        const hello = approved.find((t) => t.name === "hello_world");
        return String((hello ?? approved[0])?.id ?? "");
      });
      await refreshNotifications();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load WhatsApp templates");
    } finally {
      setLoading(false);
    }
  }, [onCountChange, onError, refreshNotifications]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshNotifications();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [refreshNotifications]);

  async function handleSync() {
    setSyncing(true);
    setNotice(null);
    try {
      const result = await client.syncWhatsAppTemplates();
      setNotice(result.message);
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Template sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setNotice(null);
    setSubmitError(null);
    try {
      const result = await client.createWhatsAppTemplate({
        name: createForm.name.trim(),
        category: createForm.category,
        language: createForm.language.trim() || "en_US",
        body: createForm.body.trim(),
        footer: createForm.footer.trim() || null,
      });
      setNotice(result.message);
      setShowCreator(false);
      setCreateForm(DEFAULT_CREATE_FORM);
      await refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to submit template to Meta";
      setSubmitError(message);
      onError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function dismissNotifications(ids?: number[]) {
    try {
      await client.markWhatsAppTemplateNotificationsRead(ids);
      await refreshNotifications();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to mark notifications read");
    }
  }

  async function handleTestSend() {
    if (!isAdmin) {
      onError("Only an admin can send a WhatsApp test message.");
      return;
    }
    const phone = testPhone.trim();
    if (!phone) {
      onError("Enter a recipient phone number (e.g. 03XXXXXXXXX or +92…).");
      return;
    }
    const template = templates.find((t) => String(t.id) === testTemplateId);
    if (!template || template.status !== "approved") {
      onError("Select an approved template first.");
      return;
    }
    setTestSending(true);
    setNotice(null);
    try {
      const result = await client.testWhatsAppSend({
        phone,
        template_name: template.name,
        template_language: template.language || "en_US",
      });
      if (result.status === "sent") {
        setNotice(
          `Test sent to ${result.to || phone}` +
            (result.provider_message_id ? ` · id ${result.provider_message_id}` : ""),
        );
      } else {
        onError(result.message || `Send failed (${result.status})`);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "WhatsApp test send failed");
    } finally {
      setTestSending(false);
    }
  }

  const approvedTemplates = templates.filter((t) => t.status === "approved");

  const filteredTemplates = useMemo(() => {
    const q = templateSearch.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) => {
      const haystack = [t.name, t.status, t.category, t.language, t.body_text, t.rejection_reason]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [templateSearch, templates]);

  return (
    <section className="space-y-6 w-full min-w-0">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-medium text-slate-100">WhatsApp templates</h2>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Create templates here and submit them to Meta for review. When Meta approves or
            rejects a template, you&apos;ll see a notification on this page. Approved templates
            are available immediately in bulk send and lead WhatsApp compose.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setShowCreator((open) => !open);
              setNotice(null);
            }}
            disabled={!config?.configured}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm font-medium disabled:opacity-50"
          >
            {showCreator ? "Close creator" : "Create template"}
          </button>
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={syncing || !config?.configured}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync from Meta"}
          </button>
        </div>
      </div>

      {unreadCount > 0 && notifications.length > 0 && (
        <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4 space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="text-sm font-medium text-slate-200">
              Template review updates ({unreadCount} unread)
            </h3>
            <button
              type="button"
              onClick={() => void dismissNotifications()}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Mark all read
            </button>
          </div>
          <ul className="space-y-2">
            {notifications.map((item) => (
              <li
                key={item.id}
                className={`rounded-lg border px-3 py-2 text-sm flex items-start justify-between gap-3 ${notificationStyle(item.event_type)}`}
              >
                <div>
                  <p>{item.message}</p>
                  <p className="text-xs opacity-70 mt-1">
                    {item.created_at ? new Date(item.created_at).toLocaleString() : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void dismissNotifications([item.id])}
                  className="text-xs opacity-80 hover:opacity-100 shrink-0"
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {config?.configured && config.meta_api_ok === false && config.meta_api_message && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <p className="font-medium">Meta WhatsApp API connection failed</p>
          <p className="mt-1">{config.meta_api_message}</p>
        </div>
      )}

      {config?.configured && config.meta_api_ok === true && config.meta_api_message && (
        <p className="text-xs text-emerald-400/90">{config.meta_api_message}</p>
      )}

      {config && !config.configured && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <p className="font-medium">WhatsApp Cloud API is not configured yet.</p>
          <p className="mt-1 text-amber-200/80">
            Set {config.missing_env.join(", ")} in <code>backend/.env</code>, then restart the
            backend.
          </p>
        </div>
      )}

      {config?.webhook_callback_url ? (
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3 text-xs text-slate-400 space-y-1">
          <p>
            Meta webhook Callback URL:{" "}
            <code className="text-slate-200 break-all">{config.webhook_callback_url}</code>
          </p>
          <p>
            Subscribe fields: <code className="text-slate-300">messages</code> and{" "}
            <code className="text-slate-300">message_template_status_update</code>. Verify token must
            match <code className="text-slate-300">WHATSAPP_WEBHOOK_VERIFY_TOKEN</code> on the server.
          </p>
        </div>
      ) : null}

      {config?.configured && (
        <p className="text-xs text-slate-500">
          Webhook must subscribe to <code className="text-slate-400">message_template_status_update</code>{" "}
          for instant approval/rejection alerts.
          {config.display_number ? ` Sending as ${config.display_number}.` : ""}
        </p>
      )}

      {notice && (
        <p className="text-sm text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          {notice}
        </p>
      )}

      {showCreator && config?.configured && (
        <form
          onSubmit={(e) => void handleCreateSubmit(e)}
          className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-4"
        >
          <div>
            <h3 className="text-sm font-medium text-slate-200">Submit template to Meta</h3>
            <p className="text-xs text-slate-500 mt-1">
              Meta reviews every template (usually minutes to 48 hours). Use{" "}
              <code className="text-slate-400">{`{{1}}`}</code>,{" "}
              <code className="text-slate-400">{`{{2}}`}</code> for variables. Name must be
              lowercase with underscores.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="block sm:col-span-1">
              <span className="text-xs text-slate-400">Template name</span>
              <input
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="kafi_product_intro"
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                required
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-400">Category</span>
              <select
                value={createForm.category}
                onChange={(e) =>
                  setCreateForm((f) => ({
                    ...f,
                    category: e.target.value as WhatsAppTemplateCategory,
                  }))
                }
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              >
                <option value="UTILITY">Utility</option>
                <option value="MARKETING">Marketing</option>
                <option value="AUTHENTICATION">Authentication</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-slate-400">Language</span>
              <input
                value={createForm.language}
                onChange={(e) => setCreateForm((f) => ({ ...f, language: e.target.value }))}
                placeholder="en_US"
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                required
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-slate-400">Body</span>
            <textarea
              rows={8}
              value={createForm.body}
              onChange={(e) =>
                setCreateForm((f) => ({
                  ...f,
                  body: capitalizeFirstLetter(e.target.value),
                }))
              }
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono"
              required
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Footer (optional, max 60 chars)</span>
            <input
              value={createForm.footer}
              onChange={(e) => setCreateForm((f) => ({ ...f, footer: e.target.value }))}
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              maxLength={60}
            />
          </label>
          {submitError && (
            <p className="text-sm text-red-300 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
              {submitError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreator(false)}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >
              {submitting ? "Submitting to Meta…" : "Submit for Meta review"}
            </button>
          </div>
        </form>
      )}

      {isAdmin && config?.configured && (
        <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-4 space-y-3">
          <div>
            <h3 className="text-sm font-medium text-slate-200">Send test WhatsApp</h3>
            <p className="text-xs text-slate-500 mt-1">
              Sends from your connected business number to any phone using an approved template.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="Recipient phone e.g. 03001234567"
              className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
            />
            <select
              value={testTemplateId}
              onChange={(e) => setTestTemplateId(e.target.value)}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 min-w-[12rem]"
            >
              {approvedTemplates.length === 0 ? (
                <option value="">No approved templates</option>
              ) : (
                approvedTemplates.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.name} ({t.language})
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              onClick={() => void handleTestSend()}
              disabled={testSending || approvedTemplates.length === 0 || !testPhone.trim()}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50 shrink-0"
            >
              {testSending ? "Sending…" : "Send test"}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-slate-300">Templates</h3>
            <span className="text-xs text-slate-500">
              {templateSearch.trim()
                ? `${filteredTemplates.length} / ${templates.length}`
                : `${templates.length} total`}
            </span>
          </div>
          <label className="relative block max-w-md">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none">
              <IconSearch size="sm" />
            </span>
            <input
              type="search"
              value={templateSearch}
              onChange={(e) => setTemplateSearch(e.target.value)}
              placeholder="Search templates by name, status, body…"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 pl-8 pr-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600"
            />
          </label>
        </div>
        <div className="p-4 space-y-2 max-h-[70vh] overflow-y-auto">
          {loading ? (
            <p className="text-sm text-slate-400">Loading templates…</p>
          ) : templates.length === 0 ? (
            <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
              No templates yet. Click <strong className="text-slate-300">Create template</strong>{" "}
              to submit one to Meta, or sync existing templates from Business Manager.
            </p>
          ) : filteredTemplates.length === 0 ? (
            <p className="text-sm text-slate-500 rounded-lg border border-dashed border-slate-700 p-4">
              No templates match “{templateSearch.trim()}”.
            </p>
          ) : (
            filteredTemplates.map((template) => (
              <div
                key={template.id}
                className="rounded-lg border border-slate-800 bg-slate-950 p-3 flex items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-slate-100">{template.name}</p>
                    <StatusBadge status={template.status} />
                    {template.category && (
                      <span className="px-2 py-0.5 rounded text-xs border border-slate-700 bg-slate-800 text-slate-400">
                        {template.category}
                      </span>
                    )}
                    <span className="text-xs text-slate-500">{template.language}</span>
                  </div>
                  {template.body_text && (
                    <p className="text-xs text-slate-500 mt-1.5 whitespace-pre-wrap line-clamp-3">
                      {template.body_text}
                    </p>
                  )}
                  {template.rejection_reason && (
                    <p className="text-xs text-red-300/90 mt-2">
                      Rejection reason: {template.rejection_reason}
                    </p>
                  )}
                  {template.variable_count > 0 && (
                    <p className="text-xs text-slate-600 mt-1">
                      {template.variable_count} variable{template.variable_count === 1 ? "" : "s"}
                    </p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
