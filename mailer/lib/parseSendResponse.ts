/** Vercel serverless POST body limit (~4.5 MB on Hobby). */
export const MAILER_MAX_SEND_BYTES = 4 * 1024 * 1024;

export function estimateSendPayloadBytes(payload: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function attachmentSizeMessage(totalBytes: number): string | null {
  if (totalBytes <= MAILER_MAX_SEND_BYTES) return null;
  const mb = (totalBytes / (1024 * 1024)).toFixed(1);
  return (
    `This email is too large to send from the mailer (${mb} MB). ` +
    "Vercel allows about 4 MB per send including attachments. " +
    "Remove or shrink the PDF, host the file online and paste a link, or send without the attachment."
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
          "Attachment too large for Vercel mailer (about 4 MB max per send). " +
          "Remove the PDF, use a smaller file, or add a download link in the body instead.",
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
