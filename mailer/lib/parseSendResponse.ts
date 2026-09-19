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
