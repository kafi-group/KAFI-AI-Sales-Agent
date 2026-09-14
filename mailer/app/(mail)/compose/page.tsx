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
  parseSendApiResponse,
} from "@/lib/parseSendResponse";
import {
  formatAttachmentSize,
  uploadAttachmentToSalesAgent,
  type HostedAttachment,
} from "@/lib/hostAttachments";
import {
  hostDataUriImagesInBrowser,
  htmlHasDataUriImages,
} from "@/lib/hostInlineImagesClient";

function defaultComposeBody(contactName: string, companyName: string): string {
  const name = contactName.trim() || "[Contact Name]";
  void companyName;
  return plainTextToEditorHtml(`Dear ${name},\n\n`);
}

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
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attachments, setAttachments] = useState<HostedAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
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

  const attachmentBytes = attachments.reduce((sum, file) => sum + (file.size || 0), 0);
  const attachmentWarning =
    attachments.length > 0 ? attachmentSizeMessage(attachmentBytes) : null;

  async function addAttachments(files: FileList | null) {
    if (!files?.length) return;
    const auth = token || getStoredToken();
    if (!auth) {
      setError("Not signed in — cannot upload attachments");
      return;
    }
    setUploadingAttachments(true);
    setError(null);
    setNotice("Uploading attachment(s) to Sales Agent…");
    try {
      const next: HostedAttachment[] = [];
      for (const file of Array.from(files)) {
        next.push(await uploadAttachmentToSalesAgent(file, { authToken: auth }));
      }
      setAttachments((prev) => [...prev, ...next]);
      setNotice(
        next.length === 1
          ? `Attached ${next[0].filename} (${formatAttachmentSize(next[0].size)})`
          : `Attached ${next.length} files`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Attachment upload failed");
    } finally {
      setUploadingAttachments(false);
    }
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
    setSending(true);
    setError(null);
    try {
      // Convert pasted data:image blobs to HTTPS URLs before hitting /api/send
      // (avoids Vercel body-size limits and Gmail raw-base64 rendering).
      let sendHtml = body;
      if (htmlHasDataUriImages(body)) {
        setNotice("Uploading inline images…");
        sendHtml = await hostDataUriImagesInBrowser(body, { authToken: auth });
        setBody(sendHtml);
      }
      if (attachmentWarning) {
        setError(attachmentWarning);
        return;
      }
      const payload = {
        auth_token: auth,
        to: to.trim(),
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject: subject.trim(),
        body: sendHtml,
        html: true,
        buyer_id: buyerId,
        company_name: mergeCompany.trim() || undefined,
        contact_name: mergeContact.trim() || undefined,
        designation: mergeDesignation.trim() || undefined,
        // Hosted refs only — never base64 PDFs through Vercel (4.5 MB body limit).
        attachments: attachments.length
          ? attachments.map((file) => ({
              id: file.id,
              url: file.url,
              filename: file.filename,
              contentType: file.contentType,
              size: file.size,
            }))
          : undefined,
      };

      setNotice(attachments.length ? "Sending with attachment(s)…" : null);
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
        disabled={uploadingAttachments || sending}
        onChange={(e) => {
          void addAttachments(e.target.files);
          e.target.value = "";
        }}
      />
      <p className="muted small">
        PDFs and files upload to Sales Agent first (up to ~24 MB each), then send via SMTP —
        not limited by Vercel&apos;s 4 MB request size.
      </p>
      {uploadingAttachments && <p className="muted small">Uploading…</p>}
      {attachments.length > 0 && (
        <>
          <ul className="small muted">
            {attachments.map((file, index) => (
              <li key={`${file.id}-${index}`}>
                {file.filename} ({formatAttachmentSize(file.size)}){" "}
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
        <button
          type="button"
          className="btn"
          disabled={sending || uploadingAttachments || Boolean(attachmentWarning)}
          onClick={() => void send()}
        >
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
