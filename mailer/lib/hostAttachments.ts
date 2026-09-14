/**
 * Host large compose attachments on Railway so Vercel /api/send stays under
 * the ~4.5 MB serverless body limit. SMTP still runs on Vercel; it fetches
 * file bytes by id/url before nodemailer send.
 */

import { getApiBase, getStoredToken } from "./api";

/** Practical per-file ceiling (email providers reject ~25 MB total). */
export const EMAIL_ATTACHMENT_MAX_BYTES = 24 * 1024 * 1024;

export type HostedAttachment = {
  id: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
};

export type SendAttachmentRef = {
  filename: string;
  contentType?: string;
  /** Base64 — only for small inline payloads (legacy). */
  content?: string;
  id?: string;
  url?: string;
  size?: number;
};

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function uploadAttachmentToSalesAgent(
  file: File,
  options?: { authToken?: string | null; handoffToken?: string },
): Promise<HostedAttachment> {
  if (file.size > EMAIL_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `${file.name} is ${formatAttachmentSize(file.size)} — keep each file under ${
        EMAIL_ATTACHMENT_MAX_BYTES / (1024 * 1024)
      } MB (email providers reject ~25 MB messages).`,
    );
  }
  const base = getApiBase();
  if (!base) {
    throw new Error("Sales Agent API URL is not configured — cannot upload attachment.");
  }
  const auth = options?.authToken ?? getStoredToken();
  const form = new FormData();
  form.append("file", file, file.name);
  if (options?.handoffToken) form.append("token", options.handoffToken);

  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = `Bearer ${auth}`;

  const res = await fetch(`${base}/mailer/attachment-upload`, {
    method: "POST",
    headers,
    body: form,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const json = JSON.parse(text) as { detail?: string; error?: string };
      detail = json.detail || json.error || detail;
    } catch {
      /* keep text */
    }
    throw new Error(detail || `Attachment upload failed (${res.status})`);
  }
  const data = (await res.json()) as {
    id?: string;
    url?: string;
    filename?: string;
    content_type?: string;
    size?: number;
  };
  if (!data.id || !data.url) {
    throw new Error("Attachment upload returned no id/url");
  }
  return {
    id: data.id,
    url: data.url,
    filename: data.filename || file.name,
    contentType: data.content_type || file.type || "application/octet-stream",
    size: typeof data.size === "number" ? data.size : file.size,
  };
}

/** Resolve attachment refs to base64 buffers for nodemailer (server-side). */
export async function resolveAttachmentsForSmtp(
  refs: SendAttachmentRef[] | undefined,
): Promise<Array<{ filename: string; content: string; contentType?: string }>> {
  if (!refs?.length) return [];
  const out: Array<{ filename: string; content: string; contentType?: string }> = [];
  for (const ref of refs) {
    if (ref.content) {
      out.push({
        filename: ref.filename,
        content: ref.content,
        contentType: ref.contentType,
      });
      continue;
    }
    const url = (ref.url || "").trim();
    if (!url) {
      throw new Error(`Attachment "${ref.filename}" is missing url/content`);
    }
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(
        `Could not load attachment "${ref.filename}" from Sales Agent (${res.status})`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    out.push({
      filename: ref.filename,
      content: buf.toString("base64"),
      contentType:
        ref.contentType ||
        res.headers.get("content-type")?.split(";")[0]?.trim() ||
        "application/octet-stream",
    });
  }
  return out;
}
