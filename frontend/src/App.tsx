import { useCallback, useEffect, useRef, useState } from "react";
import type { IndexAction } from "./data/indexSections";
import { sumWhatsAppInboxUnread } from "./utils/whatsappRead";
import {
  client,
  QUOTATION_AGENT_URL,
  sanitizeUserFacingError,
  type AppUser,
  type LeadTableSectionCountsResponse,
} from "./api/client";
import { useAuth } from "./auth/AuthContext";
import {
  AppSidebar,
  assignedUserIdFromSection,
  isAssignedLeadsSection,
  mailLabelIdFromSection,
  type LeadsTableSection,
  type MailSection,
  type NavItem,
  type Tab,
  type WhatsAppSection,
} from "./components/AppSidebar";
import { mailLabelSectionId } from "./lib/mailLabelRules";
import { displayDashboardUserLabel } from "./utils/displayUserName";
import { InboxAlertToasts } from "./components/InboxAlertToasts";
import { WhatsAppAlertToasts } from "./components/WhatsAppAlertToasts";
import { InterestedFollowUpAlertToasts } from "./components/InterestedFollowUpAlertToasts";
import { QuotationMeetingAlertToasts } from "./components/QuotationMeetingAlertToasts";
import { InterestedClientsActivityToasts } from "./components/InterestedClientsActivityToasts";
import { AppTopActions } from "./components/AppTopActions";
import { APP_BRAND_NAME } from "./brand";
import { EmailActivityPage } from "./pages/EmailActivityPage";
import { EmailTemplatesPage } from "./pages/EmailTemplatesPage";
import { WhatsAppTemplatesPage } from "./pages/WhatsAppTemplatesPage";
import { WhatsAppInboxPage } from "./pages/WhatsAppInboxPage";
import { WhatsAppQrPage } from "./pages/WhatsAppQrPage";
import { BuyerProfile } from "./pages/BuyerProfile";
import { CallsPage } from "./pages/CallsPage";
import { InboxPage } from "./pages/InboxPage";
import { AiModePage } from "./pages/AiModePage";
import { IndexesPage } from "./pages/IndexesPage";
import { UserManualPage } from "./pages/UserManualPage";
import { LeadsPage } from "./pages/LeadsPage";
import { DataSynthesisPage } from "./pages/DataSynthesisPage";
import { LeadsTablePage } from "./pages/LeadsTablePage";
import { ClientHistoryPage } from "./pages/ClientHistoryPage";
import { HelpfulGuidancePage } from "./pages/HelpfulGuidancePage";
import { ChatbotPage } from "./pages/ChatbotPage";
import { KpiPage } from "./pages/KpiPage";
import { LoginPage } from "./pages/LoginPage";
import { UsersPage } from "./pages/UsersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TwilioVoiceProvider, useTwilioVoiceOptional } from "./hooks/useTwilioVoice";
import { CallQueueProvider } from "./hooks/useCallQueue";
import { PostCallRemarksModal } from "./components/PostCallRemarksModal";
import { CallingCardOverlay } from "./components/CallingCardOverlay";
import { BulkCallQueueHost } from "./components/BulkCallQueueHost";
import { FloatingDialpad } from "./components/FloatingDialpad";
import { FloatingSalesAssistant, OPEN_SALES_ASSISTANT_EVENT } from "./components/FloatingSalesAssistant";
import {
  alertInterestedFollowUp,
  alertInterestedClientsActivity,
  alertNewInboxMessage,
  alertNewWhatsAppMessage,
  alertQuotationMeeting,
  requestNotificationPermission,
  unlockNotificationAudio,
} from "./utils/notify";


const INBOX_POLL_INTERVAL_MS = 20_000;
const WHATSAPP_POLL_INTERVAL_MS = 15_000;
const FOLLOW_UP_POLL_INTERVAL_MS = 60_000;
const MEETING_POLL_INTERVAL_MS = 60_000;
const INTERESTED_ACTIVITY_POLL_INTERVAL_MS = 30_000;
const SIDEBAR_OPEN_KEY = "kafi_sidebar_open";

function readSidebarOpenPreference(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function CallInitBanner() {
  const voice = useTwilioVoiceOptional();
  if (!voice) return null;

  if (voice.callError) {
    return (
      <div className="mb-7 p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-100 text-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-medium">Call did not connect</p>
            <p className="mt-1 text-rose-200/85">{voice.callError}</p>
            <p className="mt-2 text-xs text-rose-200/60">
              Twilio Console → Monitor → Logs (error on Voice URL), Voice → Settings → Geo
              Permissions (enable the lead’s country), and confirm TwiML App Voice URL is your
              Railway API{" "}
              <code className="text-rose-100/80">/api/webhooks/twilio/voice/client-dial</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={() => voice.clearCallError()}
            className="shrink-0 rounded-md border border-rose-500/40 px-2 py-1 text-xs text-rose-100 hover:bg-rose-500/20"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (!voice.initError) return null;
  const micFail = /31402|AcquisitionFailed|getting the media failed/i.test(voice.initError);
  return (
    <div className="mb-7 p-4 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-100 text-sm">
      <p className="font-medium">Browser calling is not ready</p>
      <p className="mt-1 text-amber-200/80">{voice.initError}</p>
      <p className="mt-2 text-xs text-amber-200/60">
        {micFail
          ? "Microphone access failed after permission was granted. Close other apps using the mic (Zoom/Teams/WhatsApp), use Chrome/Edge on HTTPS, unplug/replug the headset, then refresh and try again."
          : "Refresh the page, or open Calls and try again in a moment. Railway may still be warming up."}
      </p>
    </div>
  );
}

function DashboardApp() {
  const { user, isAdmin, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("inbox");
  const [tableSection, setTableSection] = useState<LeadsTableSection>("master");
  const [mailSection, setMailSection] = useState<MailSection>("inbox");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpenPreference);
  const [mailDraftCount, setMailDraftCount] = useState(0);
  const [mailLabels, setMailLabels] = useState<
    Array<{ id: number; name: string; color: string; count: number }>
  >([]);
  const [tableCounts, setTableCounts] = useState<LeadTableSectionCountsResponse>({
    all: 0,
    old_clients: 0,
    interested_clients: 0,
    sales_interested_clients: 0,
    not_interested_clients: 0,
    not_received_call_clients: 0,
    master: 0,
    hyperstore_targeted: 0,
    targeted_distributor: 0,
    targeted_client: 0,
    incomplete_archives: 0,
    my_assigned: 0,
    by_assignee: {},
  });
  const [assigneeNavUsers, setAssigneeNavUsers] = useState<AppUser[]>([]);
  const [mailCounts, setMailCounts] = useState({
    inbox: 0,
    sent: 0,
    trash: 0,
    archive: 0,
  });
  const [leadsTableRefreshToken, setLeadsTableRefreshToken] = useState(0);
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  const [pendingWhatsAppContactId, setPendingWhatsAppContactId] = useState<number | null>(
    null,
  );
  const [error, setErrorState] = useState<string | null>(null);
  const setError = useCallback((message: string | null) => {
    setErrorState(message == null ? null : sanitizeUserFacingError(message));
  }, []);
  const [emailActivityUnread, setEmailActivityUnread] = useState(0);
  const [whatsappActivityUnread, setWhatsappActivityUnread] = useState(0);
  const [whatsappInboxUnread, setWhatsappInboxUnread] = useState(0);
  const [emailTemplateCount, setEmailTemplateCount] = useState(0);
  const [personalizedEmailCount, setPersonalizedEmailCount] = useState(0);
  const [whatsappTemplateCount, setWhatsappTemplateCount] = useState(0);
  const [discoverLeadsCount, setDiscoverLeadsCount] = useState(0);

  const [inboxUnread, setInboxUnread] = useState(0);
  const seenMessageUidsRef = useRef<Set<string> | null>(null);
  const lastInboxUnreadRef = useRef(0);
  const seenWhatsAppKeysRef = useRef<Set<string> | null>(null);
  const seenFollowUpIdsRef = useRef<Set<string>>(new Set());
  const seenMeetingAlertIdsRef = useRef<Set<string>>(new Set());
  const seenInterestedActivityIdRef = useRef<number | null>(null);

  useEffect(() => {
    const onExpired = () => {
      void logout();
    };
    window.addEventListener("kafi:auth-expired", onExpired);
    return () => window.removeEventListener("kafi:auth-expired", onExpired);
  }, [logout]);

  useEffect(() => {
    if (!isAdmin && tab === "users") {
      setTab("inbox");
    }
    if (!isAdmin && tab === "settings") {
      setTab("inbox");
    }
  }, [isAdmin, tab]);

  useEffect(() => {
    if (tab !== "master-table") return;
    setTab("table");
    setTableSection("master");
    setSelectedLeadId(null);
  }, [tab]);

  const loadDiscoverLeadsCount = useCallback(async () => {
    try {
      const result = await client.listLeads({ page: 1, page_size: 1 });
      setDiscoverLeadsCount(result.total);
    } catch {
      setDiscoverLeadsCount(0);
    }
  }, []);

  const loadEmailTemplateCount = useCallback(async () => {
    try {
      const rows = await client.listEmailTemplates();
      setEmailTemplateCount(rows.length);
    } catch {
      setEmailTemplateCount(0);
    }
  }, []);

  const loadWhatsappTemplateCount = useCallback(async () => {
    try {
      const rows = await client.listWhatsAppTemplates();
      setWhatsappTemplateCount(rows.filter((t) => t.status === "approved").length);
    } catch {
      setWhatsappTemplateCount(0);
    }
  }, []);

  const loadTableCounts = useCallback(async () => {
    try {
      const counts = await client.getLeadsTableSectionCounts();
      setTableCounts({
        ...counts,
        by_assignee: counts.by_assignee ?? {},
      });
    } catch {
      /* optional badges */
    }
  }, []);

  const loadAssigneeNavUsers = useCallback(async () => {
    try {
      const users = await client.listAssignees();
      setAssigneeNavUsers(users);
    } catch {
      setAssigneeNavUsers([]);
    }
  }, []);

  const loadMailCounts = useCallback(async () => {
    try {
      const result = await client.listInboxFolders();
      const next = { inbox: 0, sent: 0, trash: 0, archive: 0 };
      for (const folder of result.folders) {
        if (folder.key === "inbox" || folder.key === "sent" || folder.key === "trash" || folder.key === "archive") {
          next[folder.key] = folder.count;
        }
      }
      setMailCounts(next);
    } catch {
      /* optional badges */
    }
  }, []);

  const loadMailExtras = useCallback(async () => {
    try {
      const [drafts, labels, personalized] = await Promise.all([
        client.getMailDraftCount(),
        client.listMailLabels(),
        client.listPersonalizedFollowups({ limit: 1 }).catch(() => null),
      ]);
      setMailDraftCount(drafts.count);
      setMailLabels(labels);
      if (personalized) setPersonalizedEmailCount(personalized.pending_count);
    } catch {
      /* optional badges */
    }
  }, []);

  const handleDeleteMailLabel = useCallback(
    async (labelId: number) => {
      const label = mailLabels.find((row) => row.id === labelId);
      const name = label?.name || "this label";
      if (
        !window.confirm(
          `Delete label “${name}”? No emails will be removed from the mailbox — only the label and its grouping.`,
        )
      ) {
        return;
      }
      try {
        await client.deleteMailLabel(labelId);
        if (mailLabelIdFromSection(mailSection) === labelId) {
          setMailSection("inbox");
        }
        await loadMailExtras();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to delete label");
      }
    },
    [loadMailExtras, mailLabels, mailSection, setError],
  );

  const pollInbox = useCallback(() => {
    client
      .getInboxStatus()
      .then((status) => {
        if (!status.configured) {
          seenMessageUidsRef.current = null;
          lastInboxUnreadRef.current = 0;
          setInboxUnread(0);
          return;
        }
        const previousUnread = lastInboxUnreadRef.current;
        lastInboxUnreadRef.current = status.unread_count;
        setInboxUnread(status.unread_count);

        // Only pull a message list when unread goes up — avoid downloading mail
        // on every badge poll just to detect new arrivals.
        if (status.unread_count <= previousUnread && seenMessageUidsRef.current !== null) {
          return;
        }

        return client.listInboxMessages({ limit: 15 }).then((result) => {
          const messages = result.items;
          const currentUids = new Set(messages.map((m) => m.uid));
          const seen = seenMessageUidsRef.current;

          if (seen === null) {
            seenMessageUidsRef.current = currentUids;
            return;
          }

          const newMessages = messages.filter((m) => !seen.has(m.uid));
          if (newMessages.length > 0) {
            const first = newMessages[0];
            alertNewInboxMessage({
              from: first.from_name || first.from_email,
              subject: first.subject,
              count: newMessages.length,
            });
          }

          seenMessageUidsRef.current = currentUids;
        });
      })
      .catch(() => {
        /* mailbox may be unconfigured — ignore */
      });
  }, []);

  const pollWhatsAppInbox = useCallback(() => {
    client
      .listWhatsAppConversations({ page: 1, page_size: 50 })
      .then((result) => {
        const rows = result.rows || [];
        const inboxUnreadTotal = sumWhatsAppInboxUnread(rows);
        setWhatsappInboxUnread(inboxUnreadTotal);

        const inbound = rows.filter(
          (row) => row.last_direction === "inbound" && row.last_message_at,
        );
        const currentKeys = new Set(
          inbound.map((row) => `${row.contact_id}:${row.last_message_at}`),
        );
        const seen = seenWhatsAppKeysRef.current;

        if (seen === null) {
          seenWhatsAppKeysRef.current = currentKeys;
          return;
        }

        const fresh = inbound.filter(
          (row) => !seen.has(`${row.contact_id}:${row.last_message_at}`),
        );
        if (fresh.length > 0) {
          const first = fresh[0];
          const label =
            first.contact_name?.trim() ||
            first.company_name?.trim() ||
            first.contact_phone ||
            "WhatsApp contact";
          alertNewWhatsAppMessage({
            from: label,
            preview: first.last_message,
            count: fresh.length,
            contactId: first.contact_id,
          });
        }

        seenWhatsAppKeysRef.current = currentKeys;
      })
      .catch(() => {
        /* WhatsApp may be unconfigured — ignore */
      });
  }, []);

  const pollInterestedFollowUps = useCallback(() => {
    client
      .listInterestedFollowUps()
      .then((reminders) => {
        const seen = seenFollowUpIdsRef.current;
        for (const reminder of reminders) {
          if (seen.has(reminder.id)) continue;
          seen.add(reminder.id);
          alertInterestedFollowUp({
            id: reminder.id,
            buyerId: reminder.buyer_id,
            companyName: reminder.company_name,
            contactName: reminder.contact_name,
            dueAt: reminder.due_at,
            daysSincePlacement: reminder.days_since_placement ?? 0,
            tableSection:
              reminder.table_section === "not_received_call_clients"
                ? "not_received_call_clients"
                : reminder.table_section === "sales_interested_clients"
                  ? "sales_interested_clients"
                  : "interested_clients",
          });
        }
      })
      .catch(() => {
        /* optional */
      });
  }, []);

  const pollQuotationMeetings = useCallback(() => {
    client
      .listQuotationMeetingAlerts()
      .then((result) => {
        const seen = seenMeetingAlertIdsRef.current;
        for (const alert of result.alerts || []) {
          if (seen.has(alert.id)) continue;
          seen.add(alert.id);
          alertQuotationMeeting({
            id: alert.id,
            buyerId: alert.buyer_id,
            companyName: alert.company_name,
            contactName: alert.contact_name,
            meetingAt: alert.meeting_at,
            minutesUntil: alert.minutes_until,
          });
        }
      })
      .catch(() => {
        /* optional */
      });
  }, []);

  const pollInterestedClientsActivity = useCallback(() => {
    const afterId = seenInterestedActivityIdRef.current;
    client
      .listAiModeInterestedActivities({
        after_id: afterId ?? undefined,
        limit: 50,
      })
      .then((data) => {
        if (afterId === null) {
          seenInterestedActivityIdRef.current = data.latest_id ?? 0;
          return;
        }

        const newRows = data.rows || [];
        seenInterestedActivityIdRef.current = data.latest_id ?? afterId;

        if (newRows.length === 0) return;

        if (isAdmin) {
          const grouped = new Map<
            number,
            { label: string; count: number; companies: string[] }
          >();
          for (const row of newRows) {
            const current = grouped.get(row.user_id) || {
              label: row.user_label,
              count: 0,
              companies: [],
            };
            current.count += 1;
            if (row.company_name) current.companies.push(row.company_name);
            grouped.set(row.user_id, current);
          }
          for (const [userId, group] of grouped) {
            const message =
              group.count === 1
                ? `${group.label} added ${group.companies[0] || "a client"} to Interested Clients`
                : `${group.label} added ${group.count} clients to Interested Clients`;
            alertInterestedClientsActivity({
              id: `interested-admin-${userId}-${data.latest_id}-${group.count}`,
              message,
              count: group.count,
              isSelf: false,
              userLabel: group.label,
            });
          }
          return;
        }

        const message =
          newRows.length === 1
            ? `You added ${newRows[0].company_name || "a client"} to Interested Clients`
            : `You added ${newRows.length} clients to Interested Clients`;
        alertInterestedClientsActivity({
          id: `interested-self-${data.latest_id}-${newRows.length}`,
          message,
          count: newRows.length,
          isSelf: true,
        });
      })
      .catch(() => {
        /* optional */
      });
  }, [isAdmin]);

  const refreshAll = useCallback(() => {
    setError(null);
    void loadDiscoverLeadsCount();
    void loadTableCounts();
    void loadAssigneeNavUsers();
    void loadMailCounts();
    void loadMailExtras();
    void loadEmailTemplateCount();
    void loadWhatsappTemplateCount();
    client
      .getEmailActivityUnreadCount("email")
      .then((r) => setEmailActivityUnread(r.unread_count))
      .catch(() => setEmailActivityUnread(0));
    client
      .getEmailActivityUnreadCount("whatsapp")
      .then((r) => setWhatsappActivityUnread(r.unread_count))
      .catch(() => setWhatsappActivityUnread(0));
    pollInbox();
    pollWhatsAppInbox();
    pollInterestedFollowUps();
    pollQuotationMeetings();
    pollInterestedClientsActivity();
  }, [
    loadDiscoverLeadsCount,
    loadEmailTemplateCount,
    loadWhatsappTemplateCount,
    loadMailCounts,
    loadMailExtras,
    loadTableCounts,
    loadAssigneeNavUsers,
    pollInbox,
    pollWhatsAppInbox,
    pollInterestedFollowUps,
    pollQuotationMeetings,
    pollInterestedClientsActivity,
  ]);

  useEffect(() => {
    void Promise.all([
      loadTableCounts(),
      loadAssigneeNavUsers(),
      loadMailCounts(),
      loadMailExtras(),
      loadDiscoverLeadsCount(),
      loadEmailTemplateCount(),
      loadWhatsappTemplateCount(),
    ]);
    requestNotificationPermission();

    const unlock = () => unlockNotificationAudio();
    window.addEventListener("click", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    pollInbox();
    pollWhatsAppInbox();
    pollInterestedFollowUps();
    pollQuotationMeetings();
    pollInterestedClientsActivity();
    client
      .getEmailActivityUnreadCount("email")
      .then((r) => setEmailActivityUnread(r.unread_count))
      .catch(() => setEmailActivityUnread(0));
    client
      .getEmailActivityUnreadCount("whatsapp")
      .then((r) => setWhatsappActivityUnread(r.unread_count))
      .catch(() => setWhatsappActivityUnread(0));
    const inboxTimer = window.setInterval(pollInbox, INBOX_POLL_INTERVAL_MS);
    const whatsappTimer = window.setInterval(pollWhatsAppInbox, WHATSAPP_POLL_INTERVAL_MS);
    const followUpTimer = window.setInterval(pollInterestedFollowUps, FOLLOW_UP_POLL_INTERVAL_MS);
    const meetingTimer = window.setInterval(pollQuotationMeetings, MEETING_POLL_INTERVAL_MS);
    const interestedActivityTimer = window.setInterval(
      pollInterestedClientsActivity,
      INTERESTED_ACTIVITY_POLL_INTERVAL_MS,
    );
    const activityTimer = window.setInterval(() => {
      client
        .getEmailActivityUnreadCount("email")
        .then((r) => setEmailActivityUnread(r.unread_count))
        .catch(() => undefined);
      client
        .getEmailActivityUnreadCount("whatsapp")
        .then((r) => setWhatsappActivityUnread(r.unread_count))
        .catch(() => undefined);
    }, INBOX_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(inboxTimer);
      window.clearInterval(whatsappTimer);
      window.clearInterval(followUpTimer);
      window.clearInterval(meetingTimer);
      window.clearInterval(interestedActivityTimer);
      window.clearInterval(activityTimer);
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [
    loadDiscoverLeadsCount,
    loadEmailTemplateCount,
    loadWhatsappTemplateCount,
    loadMailCounts,
    loadMailExtras,
    loadTableCounts,
    loadAssigneeNavUsers,
    pollInbox,
    pollWhatsAppInbox,
    pollInterestedFollowUps,
    pollQuotationMeetings,
    pollInterestedClientsActivity,
  ]);

  function handleSelectLead(leadId: number) {
    setError(null);
    setSelectedLeadId(leadId);
  }

  function handleBackFromProfile() {
    setSelectedLeadId(null);
    void loadDiscoverLeadsCount();
    void loadTableCounts();
    void loadMailCounts();
    void loadEmailTemplateCount();
  }

  function handleSelectTab(nextTab: Tab) {
    if (nextTab === "personalized-emails") {
      sessionStorage.setItem("kafi.aiModePanel", "personalized");
      setTab("ai-mode");
      setSelectedLeadId(null);
      return;
    }
    setTab(nextTab);
    if (nextTab !== "leads" && nextTab !== "table" && nextTab !== "calls") {
      setSelectedLeadId(null);
    }
  }

  function handleSelectTableSection(section: LeadsTableSection) {
    setTableSection(section);
    setSelectedLeadId(null);
  }

  function handleSelectMailSection(section: MailSection) {
    setMailSection(section);
    setSelectedLeadId(null);
    if (section === "activity") {
      setTab("activity");
      return;
    }
    if (section === "email-templates") {
      setTab("email-templates");
      return;
    }
    if (section === "personalized-emails") {
      sessionStorage.setItem("kafi.aiModePanel", "personalized");
      setTab("ai-mode");
      return;
    }
    setTab("inbox");
  }

  async function openMailerApp(nextPath = "/inbox") {
    try {
      const session = await client.createMailerSession();
      const url = new URL(session.url);
      if (nextPath.startsWith("/") && !nextPath.startsWith("//")) {
        url.searchParams.set("next", nextPath);
      }
      window.location.href = url.toString();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open Bulk Email Sender");
    }
  }

  function toggleSidebar() {
    setSidebarOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(SIDEBAR_OPEN_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function handleSelectWhatsAppSection(section: WhatsAppSection) {
    setSelectedLeadId(null);
    setTab(section);
  }

  function handleOpenWhatsAppChat(contactId: number) {
    setSelectedLeadId(null);
    setPendingWhatsAppContactId(contactId);
    setTab("whatsapp-inbox");
  }

  const handleMailCountsChange = useCallback(
    (counts: {
      inbox: number;
      sent: number;
      trash: number;
      archive: number;
    }) => {
      setMailCounts(counts);
    },
    [],
  );

  function handleCallFollowUpSaved(_outcome: string | null | undefined) {
    void loadTableCounts();
    void loadEmailTemplateCount();
    setLeadsTableRefreshToken((token) => token + 1);
  }

  function handleViewInterestedClient(
    buyerId: number,
    section: LeadsTableSection = "interested_clients",
  ) {
    setTab("table");
    setTableSection(section);
    setSelectedLeadId(buyerId);
  }

  function handleOpenIndexesSection(sectionNumber: number) {
    sessionStorage.setItem("kafi.indexSection", String(sectionNumber));
    handleSelectTab("indexes");
  }

  function handleIndexNavigate(action: IndexAction) {
    switch (action.type) {
      case "tab":
        handleSelectTab(action.tab);
        break;
      case "table":
        handleSelectTab("table");
        handleSelectTableSection(action.section);
        break;
      case "mail":
        handleSelectMailSection(action.section);
        break;
      case "whatsapp":
        handleSelectWhatsAppSection(action.section);
        break;
      case "ai-mode":
        if (action.panel) {
          sessionStorage.setItem("kafi.aiModePanel", action.panel);
        }
        if (action.stage) {
          sessionStorage.setItem("kafi.aiModeStage", action.stage);
        }
        handleSelectTab("ai-mode");
        break;
      case "external":
        window.open(action.url, "_blank", "noopener,noreferrer");
        break;
      case "mailer":
        void openMailerApp();
        break;
      default:
        break;
    }
  }

  function handleViewInterestedClientsFeed() {
    sessionStorage.setItem("kafi.aiModeStage", "interested");
    setTab("ai-mode");
    setSelectedLeadId(null);
  }

  function handleViewQuotationMeeting(buyerId: number) {
    sessionStorage.setItem("kafi.aiModeStage", "quotation_sent");
    setTab("ai-mode");
    setSelectedLeadId(buyerId);
  }

  async function handleAcknowledgeInterestedFollowUp(buyerId: number) {
    await client.acknowledgeInterestedFollowUp(buyerId);
    const reminders = await client.listInterestedFollowUps();
    for (const reminder of reminders) {
      seenFollowUpIdsRef.current.add(reminder.id);
    }
    setLeadsTableRefreshToken((token) => token + 1);
  }

  const assigneeSectionUsers: AppUser[] = assigneeNavUsers;

  // Drop stale "Leads Sent To" selection if that user was removed.
  useEffect(() => {
    if (!isAssignedLeadsSection(tableSection)) return;
    const selectedId = assignedUserIdFromSection(tableSection);
    if (selectedId == null) return;
    const stillExists = assigneeSectionUsers.some((u) => u.id === selectedId);
    if (!stillExists) {
      setTableSection("master");
    }
  }, [assigneeSectionUsers, tableSection]);

  const assigneeNavChildren = assigneeSectionUsers.map((u) => ({
    id: `assigned:${u.id}`,
    label: `Leads Sent To ${u.username}`,
    count: tableCounts.by_assignee?.[String(u.id)] ?? 0,
  }));

  const clientSectionNavChildren = [
    {
      id: "master" as const,
      label: "Master Table",
      count: tableCounts.master ?? 0,
    },
    {
      id: "all" as const,
      label: "New search lead",
      count: tableCounts.all,
    },
    {
      id: "old_clients" as const,
      label: "Old clients",
      count: tableCounts.old_clients,
    },
    ...(!isAdmin
      ? [
          {
            id: "my_assigned" as const,
            label: "Assigned",
            count: tableCounts.my_assigned ?? 0,
          },
        ]
      : []),
    {
      id: "interested_clients" as const,
      label: "Follow up clients",
      count: tableCounts.interested_clients,
    },
    {
      id: "sales_interested_clients" as const,
      label: "Interested Clients",
      count: tableCounts.sales_interested_clients ?? 0,
    },
    {
      id: "not_interested_clients" as const,
      label: "Not interested",
      count: tableCounts.not_interested_clients,
    },
    {
      id: "not_received_call_clients" as const,
      label: "Did not receive call",
      count: tableCounts.not_received_call_clients,
    },
    {
      id: "hyperstore_targeted" as const,
      label: "Hyperstore Target",
      count: tableCounts.hyperstore_targeted ?? 0,
    },
    {
      id: "targeted_distributor" as const,
      label: "Targeted Distributors",
      count: tableCounts.targeted_distributor ?? 0,
    },
    {
      id: "targeted_client" as const,
      label: "Targeted Client",
      count: tableCounts.targeted_client ?? 0,
    },
    {
      id: "incomplete_archives" as const,
      label: "Incomplete Data from Archives",
      count: tableCounts.incomplete_archives ?? 0,
    },
  ];

  const defaultTableSection: LeadsTableSection = "master";

  const indexAssignees = assigneeSectionUsers.map((u) => ({
    id: u.id,
    username: u.username,
  }));

  const navItems: NavItem[] = [
    { id: "indexes", label: "Indexes", count: 0 },
    { id: "user-manual", label: "User Manual", count: 0 },
    {
      id: "whatsapp-inbox",
      label: "WhatsApp",
      count: 0,
      alert: whatsappInboxUnread > 0,
      children: [
        {
          id: "whatsapp-inbox",
          label: "WhatsApp inbox",
          count: whatsappInboxUnread,
          alert: whatsappInboxUnread > 0,
        },
        {
          id: "whatsapp-templates",
          label: "WhatsApp templates",
          count: whatsappTemplateCount,
        },
        {
          id: "whatsapp-activity",
          label: "WhatsApp Activity",
          count: whatsappActivityUnread,
        },
      ],
    },
    { id: "leads" as const, label: "Searched by AI", count: discoverLeadsCount },
    ...(isAdmin ? [{ id: "data-synthesis" as const, label: "Smart Data Clean & Merge", count: 0 }] : []),
    {
      id: "table",
      label: "Master Table",
      count: tableCounts.master ?? 0,
      children: [
        ...clientSectionNavChildren,
        ...assigneeNavChildren,
      ],
    },
    {
      id: "inbox",
      label: "Emails",
      count: 0,
      alert: inboxUnread > 0,
      children: [
        { id: "inbox", label: "Inbox", count: mailCounts.inbox, alert: inboxUnread > 0 },
        { id: "sent", label: "Sent", count: mailCounts.sent },
        { id: "drafts", label: "Drafts", count: mailDraftCount },
        { id: "trash", label: "Trash", count: mailCounts.trash },
        { id: "archive", label: "Archive", count: mailCounts.archive },
        {
          id: "activity",
          label: "Email Activity",
          count: emailActivityUnread,
        },
        {
          id: "email-templates",
          label: "Email templates",
          count: emailTemplateCount,
        },
        ...mailLabels.map((label) => ({
          id: mailLabelSectionId(label),
          label: label.name,
          count: label.count,
        })),
      ],
    },
    {
      id: "mail",
      label: "Bulk Email Sender",
      count: 0,
      openMailer: true,
    },
    { id: "calls", label: "Call Center", count: 0 },
    { id: "client-history", label: "Client History", count: 0 },
    { id: "helpful-guidance", label: "Helpful Guidance", count: 0 },
    {
      id: "quotation-agent",
      label: "CNF or FOB",
      count: 0,
      external: QUOTATION_AGENT_URL,
    },
    { id: "chatbot", label: "Brand assistant", count: 0 },
    {
      id: "sales-assistant",
      label: "FAQ (Management & Sales)",
      count: 0,
      openSalesAssistant: true,
    },
    {
      id: "ai-mode",
      label: "AI Mode",
      count: personalizedEmailCount,
      alert: personalizedEmailCount > 0,
    },
    { id: "kpi", label: "KPI", count: 0 },
    ...(isAdmin ? [{ id: "users" as const, label: "Users", count: 0 }] : []),
    ...(isAdmin ? [{ id: "settings" as const, label: "Settings", count: 0 }] : []),
  ];

  return (
    <TwilioVoiceProvider>
      <CallQueueProvider>
      <PostCallRemarksModal
        onError={setError}
        onSaved={(outcome) => {
          handleCallFollowUpSaved(outcome);
        }}
      />
      <CallingCardOverlay />
      <BulkCallQueueHost onError={setError} />
      <FloatingDialpad onError={setError} />
      <FloatingSalesAssistant onNavigate={handleIndexNavigate} onError={setError} />
      <div className="min-h-dvh flex">
        <InboxAlertToasts
          onOpenInbox={() => {
            setMailSection("inbox");
            handleSelectTab("inbox");
          }}
        />
        <WhatsAppAlertToasts
          onOpenWhatsAppInbox={() => {
            handleSelectWhatsAppSection("whatsapp-inbox");
          }}
        />
        <InterestedFollowUpAlertToasts
          onViewClient={handleViewInterestedClient}
          onAcknowledge={handleAcknowledgeInterestedFollowUp}
        />
        <QuotationMeetingAlertToasts onViewClient={handleViewQuotationMeeting} />
        <InterestedClientsActivityToasts onViewFeed={handleViewInterestedClientsFeed} />
        <AppSidebar
          navItems={navItems}
          activeTab={tab}
          tableSection={tableSection}
          defaultTableSection={defaultTableSection}
          mailSection={mailSection}
          onSelectTab={handleSelectTab}
          onSelectTableSection={handleSelectTableSection}
          onSelectMailSection={handleSelectMailSection}
          onDeleteMailLabel={(labelId) => void handleDeleteMailLabel(labelId)}
          onSelectWhatsAppSection={handleSelectWhatsAppSection}
          onOpenMailer={() => void openMailerApp()}
          onOpenSalesAssistant={() => {
            window.dispatchEvent(new CustomEvent(OPEN_SALES_ASSISTANT_EVENT));
          }}
          userLabel={displayDashboardUserLabel(user)}
          userRole={user?.role}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
          desktopOpen={sidebarOpen}
          onToggleDesktop={toggleSidebar}
        />

        <div className="flex-1 min-w-0 flex flex-col overflow-x-hidden transition-[margin] duration-200">
          <header className="lg:hidden sticky top-0 z-30 flex items-center gap-2 border-b border-slate-800 bg-slate-950/95 backdrop-blur px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="shrink-0 rounded-lg p-2 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              aria-label="Open menu"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-100 truncate">{APP_BRAND_NAME}</p>
              <p className="text-[11px] text-slate-500 truncate capitalize">
                {displayDashboardUserLabel(user) || "Signed in"}
              </p>
            </div>
            <AppTopActions
              compact
              onRefresh={refreshAll}
              onLogout={() => void logout()}
              whatsappUnread={whatsappActivityUnread}
              emailUnread={inboxUnread + emailActivityUnread}
              onOpenWhatsApp={() => handleSelectWhatsAppSection("whatsapp-inbox")}
              onOpenEmail={() => {
                setMailSection("inbox");
                handleSelectTab("inbox");
              }}
            />
          </header>

          <div className="hidden lg:flex sticky top-0 z-30 items-center gap-2 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur px-4 sm:px-6 lg:px-8 py-2.5">
            <button
              type="button"
              onClick={toggleSidebar}
              className="shrink-0 rounded-lg p-2 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            {error ? (
              <p className="flex-1 min-w-0 text-xs sm:text-sm text-red-200 truncate px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/30">
                {error}
              </p>
            ) : (
              <div className="flex-1" />
            )}
            <AppTopActions
              onRefresh={refreshAll}
              onLogout={() => void logout()}
              whatsappUnread={whatsappActivityUnread}
              emailUnread={inboxUnread + emailActivityUnread}
              onOpenWhatsApp={() => handleSelectWhatsAppSection("whatsapp-inbox")}
              onOpenEmail={() => {
                setMailSection("inbox");
                handleSelectTab("inbox");
              }}
            />
          </div>

          <main className="w-full max-w-none min-w-0 mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8">
            <CallInitBanner />
            {error ? (
              <div className="lg:hidden mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-200 text-sm">
                {error}
              </div>
            ) : null}

            {tab === "indexes" && (
              <IndexesPage
                isAdmin={isAdmin}
                quotationAgentUrl={QUOTATION_AGENT_URL}
                assignees={indexAssignees}
                onNavigate={handleIndexNavigate}
              />
            )}
            {tab === "user-manual" && (
              <UserManualPage
                isAdmin={isAdmin}
                quotationAgentUrl={QUOTATION_AGENT_URL}
                assignees={indexAssignees}
                onNavigate={handleIndexNavigate}
                onOpenIndexesSection={handleOpenIndexesSection}
              />
            )}
            {tab === "activity" && (
              <EmailActivityPage
                channel="email"
                onError={setError}
                onUnreadChange={setEmailActivityUnread}
              />
            )}
            {tab === "email-templates" && (
              <EmailTemplatesPage
                onError={setError}
                onCountChange={setEmailTemplateCount}
              />
            )}
            {tab === "whatsapp-templates" && (
              <WhatsAppTemplatesPage
                onError={setError}
                onCountChange={setWhatsappTemplateCount}
              />
            )}
            {tab === "whatsapp-activity" && (
              <EmailActivityPage
                channel="whatsapp"
                onError={setError}
                onUnreadChange={setWhatsappActivityUnread}
              />
            )}
            {tab === "whatsapp-qr" && <WhatsAppQrPage onError={setError} />}
            {tab === "whatsapp-inbox" && (
              <WhatsAppInboxPage
                onError={setError}
                initialContactId={pendingWhatsAppContactId}
                onInitialContactConsumed={() => setPendingWhatsAppContactId(null)}
              />
            )}
            {tab === "leads" && selectedLeadId !== null && (
              <BuyerProfile
                leadId={selectedLeadId}
                onBack={handleBackFromProfile}
                onError={setError}
                onCallFollowUpSaved={handleCallFollowUpSaved}
                onOpenWhatsAppChat={handleOpenWhatsAppChat}
                canDiscover
              />
            )}
            {tab === "leads" && selectedLeadId === null && (
              <LeadsPage
                onError={setError}
                onSelectLead={handleSelectLead}
                onTotalChange={setDiscoverLeadsCount}
              />
            )}
            {tab === "data-synthesis" && isAdmin && (
              <DataSynthesisPage onError={setError} />
            )}
            {tab === "table" && selectedLeadId !== null && (
              <BuyerProfile
                leadId={selectedLeadId}
                onBack={handleBackFromProfile}
                onError={setError}
                onCallFollowUpSaved={handleCallFollowUpSaved}
                onOpenWhatsAppChat={handleOpenWhatsAppChat}
                canDiscover
              />
            )}
            {tab === "table" && selectedLeadId === null && (
              <LeadsTablePage
                section={tableSection}
                refreshToken={leadsTableRefreshToken}
                onError={setError}
                onSelectLead={handleSelectLead}
                onSectionCountsChange={setTableCounts}
              />
            )}
            {tab === "inbox" && (
              <InboxPage
                section={mailSection}
                onError={setError}
                onUnreadChange={setInboxUnread}
                onFolderCountsChange={handleMailCountsChange}
                onMailExtrasChange={() => void loadMailExtras()}
                onSelectMailSection={handleSelectMailSection}
                onOpenMailerCompose={() => void openMailerApp("/compose")}
              />
            )}
            {tab === "calls" && selectedLeadId !== null && (
              <BuyerProfile
                leadId={selectedLeadId}
                onBack={handleBackFromProfile}
                onError={setError}
                onCallFollowUpSaved={handleCallFollowUpSaved}
                onOpenWhatsAppChat={handleOpenWhatsAppChat}
                canDiscover
              />
            )}
            {tab === "calls" && selectedLeadId === null && (
              <CallsPage
                onError={setError}
                onSelectLead={handleSelectLead}
                onCallFollowUpSaved={handleCallFollowUpSaved}
              />
            )}
            {tab === "client-history" && (
              <ClientHistoryPage
                onError={setError}
                onOpenClient={(buyerId) => {
                  setSelectedLeadId(buyerId);
                  setTab("table");
                }}
              />
            )}
            {tab === "helpful-guidance" && (
              <HelpfulGuidancePage onError={setError} />
            )}
            {tab === "chatbot" && <ChatbotPage onError={setError} />}
            {tab === "ai-mode" && (
              <AiModePage
                onError={setError}
                onPersonalizedCountChange={setPersonalizedEmailCount}
                onLeadsAssigned={() => {
                  void loadTableCounts();
                  setLeadsTableRefreshToken((token) => token + 1);
                }}
              />
            )}
            {tab === "kpi" && <KpiPage onError={setError} />}
            {tab === "users" && isAdmin && (
              <UsersPage
                onError={setError}
                onUsersChanged={() => {
                  void loadAssigneeNavUsers();
                  void loadTableCounts();
                }}
              />
            )}
            {tab === "settings" && isAdmin && <SettingsPage onError={setError} />}
          </main>
        </div>
      </div>
      </CallQueueProvider>
    </TwilioVoiceProvider>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400 text-sm">
        Checking session…
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <DashboardApp />;
}
