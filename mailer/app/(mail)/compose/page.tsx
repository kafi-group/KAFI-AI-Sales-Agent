"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, getStoredToken } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { TemplatePicker } from "@/components/TemplatePicker";
import {
  AiComposeAssist,
  type ComposeWriteMode,
} from "@/components/AiComposeAssist";
import {
  EmailBodyEditor,
  emailBodyHasContent,
  plainTextToEditorHtml,
} from "@/components/EmailBodyEditor";
import { ensureDearSalutation } from "@/lib/personalizeEmail";
import {
  attachmentSizeMessage,
  estimateSendPayloadBytes,
  parseSendApiResponse,
} from "@/lib/parseSendResponse";

function defaultComposeBody(contactName: string, companyName: string): string {
  const name = contactName.trim() || "[Contact Name]";
  void companyName;
  return plainTextToEditorHtml(`Dear ${name},\n\n`);
}

type ComposeSendMode = "regular" | "test";

const TEST_EMAIL_OPTIONS = (
  process.env.NEXT_PUBLIC_TEST_EMAIL_RECIPIENTS ||
  "khalid.paracha@kafi-group.com,izaanmujeeb420@gmail.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.includes("@"));

function ComposeInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { token, user } = useAuth();
  const [to, setTo] = useState(params.get("to") || "");
  const [cc, setCc] = useState(params.get("cc") || "");
  const [bcc, setBcc] = useState(params.get("bcc") || "");
  const [showCc, setShowCc] = useState(Boolean(params.get("cc")));
  const [showBcc, setShowBcc] = useState(Boolean(params.get("bcc")));
  const [subject, setSubject] = useState(params.get("subject") || "");
  const [body, setBody] = useState(() => {
    const fromParam = params.get("body") || "";
    if (fromParam) return fromParam;
    const contact = params.get("contact_name") || "";
    const company = params.get("company_name") || "";
    if (contact || company) {
      return defaultComposeBody(contact, company);
    }
    return "";
  });
  const [templateId, setTemplateId] = useState("");
  const [writeMode, setWriteMode] = useState<ComposeWriteMode>("free");
  const [sendMode, setSendMode] = useState<ComposeSendMode>("regular");
  const [testRecipient, setTestRecipient] = useState(TEST_EMAIL_OPTIONS[0] || "");
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attachments, setAttachments] = useState<
    Array<{ filename: string; content: string; contentType: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const draftId = params.get("draft_id");
  const buyerIdParam = params.get("buyer_id");
  const buyerId =
    buyerIdParam && /^\d+$/.test(buyerIdParam) ? Number(buyerIdParam) : undefined;
  const mergeCompany = params.get("company_name") || "";
  const mergeContact = params.get("contact_name") || "";
  const mergeDesignation = params.get("designation") || "";

  const aiContextHint = [
    mergeContact ? `Contact name: ${mergeContact}` : "",
    mergeCompany ? `Company: ${mergeCompany}` : "",
    mergeDesignation ? `Designation: ${mergeDesignation}` : "",
    "Use [Contact Name] and [Company Name] placeholders — they are filled automatically on send.",
  ]
    .filter(Boolean)
    .join(". ");

  const attachmentWarning =
    attachments.length > 0
      ? attachmentSizeMessage(estimateSendPayloadBytes({ attachments }))
      : null;

  async function addAttachments(files: FileList | null) {
    if (!files?.length) return;
    const next: Array<{ filename: string; content: string; contentType: string }> = [];
    for (const file of Array.from(files)) {
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || "");
          const base64 = result.includes(",") ? result.split(",")[1] : result;
          resolve(base64);
        };
        reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
        reader.readAsDataURL(file);
      });
      next.push({
        filename: file.name,
        content,
        contentType: file.type || "application/octet-stream",
      });
    }
    setAttachments((prev) => [...prev, ...next]);
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  async function saveDraft() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch("/inbox/drafts", {
        method: "POST",
        body: JSON.stringify({
          id: draftId ? Number(draftId) : undefined,
          to_addrs: to,
          cc_addrs: cc,
          subject,
          body,
        }),
      });
      setNotice("Draft saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function send() {
    const auth = token || getStoredToken();
    if (!auth) {
      setError("Not signed in");
      return;
    }
    if (!to.includes("@") || !subject.trim() || !emailBodyHasContent(body)) {
      setError("To, subject, and body are required");
      return;
    }
    const effectiveTo = sendMode === "test" ? testRecipient.trim() : to.trim();
    if (!effectiveTo.includes("@")) {
      setError("Pick a valid test email address");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const payload = {
        auth_token: auth,
        to: effectiveTo,
        cc: sendMode === "test" ? undefined : cc.trim() || undefined,
        bcc: sendMode === "test" ? undefined : bcc.trim() || undefined,
        subject: sendMode === "test" ? `[TEST] ${subject.trim()}` : subject.trim(),
        body,
        html: true,
        buyer_id: sendMode === "test" ? undefined : buyerId,
        company_name: mergeCompany.trim() || undefined,
        contact_name: mergeContact.trim() || undefined,
        designation: mergeDesignation.trim() || undefined,
        attachments: attachments.length ? attachments : undefined,
        send_mode: sendMode,
      };
      const tooLarge = attachmentSizeMessage(estimateSendPayloadBytes(payload));
      if (tooLarge) {
        setError(tooLarge);
        return;
      }

      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseSendApiResponse(res);
      if (!data.ok) throw new Error(data.error || "Send failed");
      if (draftId) {
        void apiFetch(`/inbox/drafts/${draftId}`, { method: "DELETE" }).catch(() => null);
      }
      setNotice("Sent via Vercel SMTP");
      window.setTimeout(() => router.push("/sent"), 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="pad compose-page">
      <h2 className="folder-title">Compose</h2>
      <p className="muted small">
        From: {user?.mailbox_email || user?.username} · Sends via Vercel SMTP (not Railway)
      </p>
      {error && <p className="bad">{error}</p>}
      {notice && <p className="ok">{notice}</p>}

      <TemplatePicker
        value={templateId}
        onChange={(id, tpl) => {
          setTemplateId(id);
          if (tpl) {
            setSubject(tpl.subject);
            const salutationName = mergeContact.trim() || "[Contact Name]";
            setBody(ensureDearSalutation(tpl.body, salutationName));
            setWriteMode("free");
            setNotice(`Loaded template “${tpl.name}” — edit before send if needed`);
          }
        }}
      />

      <AiComposeAssist
        mode={writeMode}
        onModeChange={setWriteMode}
        toHint={to}
        contextHint={aiContextHint || undefined}
        subject={subject}
        body={body}
        onDraft={(draft) => {
          setSubject(draft.subject);
          setBody(draft.body);
        }}
        onNotice={setNotice}
        onError={setError}
      />

      {(mergeCompany || mergeContact) && (
        <p className="muted small">
          Merge fields on send:{" "}
          {mergeContact ? (
            <>
              contact <strong>{mergeContact}</strong>
            </>
          ) : null}
          {mergeCompany ? (
            <>
              {mergeContact ? " · " : ""}
              company <strong>{mergeCompany}</strong>
            </>
          ) : null}
        </p>
      )}

      <div className="compose-send-mode">
        <span className="muted small">Send as</span>
        <div className="compose-send-mode-options">
          <label>
            <input
              type="radio"
              name="send-mode"
              checked={sendMode === "regular"}
              onChange={() => setSendMode("regular")}
            />
            Regular
          </label>
          <label>
            <input
              type="radio"
              name="send-mode"
              checked={sendMode === "test"}
              onChange={() => setSendMode("test")}
            />
            Test
          </label>
        </div>
        <p className="muted small">
          Regular = one-off email (Cc/Bcc OK). Bulk campaigns use the Bulk Email Sender from
          Leads. Test sends to a safe inbox and is tracked separately in KPI.
        </p>
      </div>

      {sendMode === "test" ? (
        <label className="block">
          <span className="muted small">Test recipient</span>
          <select
            value={testRecipient}
            onChange={(e) => setTestRecipient(e.target.value)}
            className="w-full"
          >
            {TEST_EMAIL_OPTIONS.map((email) => (
              <option key={email} value={email}>
                {email}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="compose-to-row">
        <label className="compose-to-label">To</label>
        <div className="compose-cc-toggles">
          {!showCc && (
            <button type="button" className="linkish" onClick={() => setShowCc(true)}>
              Cc
            </button>
          )}
          {!showBcc && (
            <button type="button" className="linkish" onClick={() => setShowBcc(true)}>
              Bcc
            </button>
          )}
        </div>
      </div>
      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="name@example.com"
      />

      {showCc && (
        <>
          <label>Cc</label>
          <input
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="cc@example.com — comma-separated for multiple"
          />
        </>
      )}

      {showBcc && (
        <>
          <label>Bcc</label>
          <input
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
            placeholder="bcc@example.com — comma-separated for multiple"
          />
        </>
      )}

      <label>Subject</label>
      <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      <label>Attachments</label>
      <input
        type="file"
        multiple
        onChange={(e) => {
          void addAttachments(e.target.files);
          e.target.value = "";
        }}
      />
      {attachments.length > 0 && (
        <>
          <ul className="small muted">
            {attachments.map((file, index) => (
              <li key={`${file.filename}-${index}`}>
                {file.filename}{" "}
                <button type="button" className="linkish" onClick={() => removeAttachment(index)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {attachmentWarning && <p className="bad small">{attachmentWarning}</p>}
        </>
      )}
      <label>Body</label>
      <EmailBodyEditor value={body} onChange={setBody} rows={14} />
      <div className="detail-actions">
        <button type="button" className="btn" disabled={sending} onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
        </button>
        <button type="button" className="btn ghost" disabled={saving} onClick={() => void saveDraft()}>
          {saving ? "Saving…" : "Save draft"}
        </button>
      </div>
    </div>
  );
}

export default function ComposePage() {
  return (
    <Suspense fallback={<div className="pad muted">Loading…</div>}>
      <ComposeInner />
    </Suspense>
  );
}
