import {
  EMAIL_ATTACHMENT_MAX_BYTES,
  estimateEncodedMessageBytes,
  formatAttachmentSize,
} from "./hostAttachments";

/**
 * Blocking check — returns an error string when attachments will likely bounce
 * (recipient 552 / ~25 MB message cap after base64).
 */
export function attachmentSizeMessage(totalBytes: number): string | null {
  if (totalBytes <= EMAIL_ATTACHMENT_MAX_BYTES) return null;
  const wire = estimateEncodedMessageBytes(totalBytes);
  const maxMb = EMAIL_ATTACHMENT_MAX_BYTES / (1024 * 1024);
  return (
    `This email is too large (${formatAttachmentSize(totalBytes)} files ≈ ` +
    `${formatAttachmentSize(wire)} on the wire). ` +
    `Keep attachments under ${maxMb} MB total — SMTP encoding adds ~33%, ` +
    "and recipient servers reject around 25 MB (error 552)."
  );
}

export async function parseSendApiResponse(res: Response): Promise<{
  ok: boolean;
  error?: string;
  message?: string;
  saved_to_sent?: boolean;
}> {
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    if (res.status === 413 || /request entity too large/i.test(text)) {
      return {
        ok: false,
        error:
          "Send payload too large. Attachments should upload to Sales Agent first " +
          "(hosted by id) so the mailer request stays small. Remove and re-attach the file.",
      };
    }
    return { ok: false, error: text.trim() || res.statusText || "Send failed" };
  }

  if (!res.ok) {
    const err =
      (typeof data?.error === "string" && data.error) ||
      (typeof data?.detail === "string" && data.detail) ||
      text ||
      res.statusText ||
      "Send failed";
    return { ok: false, error: err };
  }

  return {
    ok: data?.ok !== false,
    message: typeof data?.message === "string" ? data.message : undefined,
    saved_to_sent: data?.saved_to_sent === true,
    error: typeof data?.error === "string" ? data.error : undefined,
  };
}
