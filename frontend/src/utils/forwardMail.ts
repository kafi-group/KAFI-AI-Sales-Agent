import type { InboxMessageDetail } from "../api/client";
import { plainTextToEditorHtml } from "../components/EmailBodyEditor";

/** "Fwd: subject" without stacking prefixes ("Fwd: Fwd: ..."). */
export function forwardSubject(original: string | null | undefined): string {
  const subject = (original || "").trim();
  if (!subject) return "Fwd:";
  if (/^(fwd?|fw):/i.test(subject)) return subject;
  return `Fwd: ${subject}`;
}

const ALLOWED_TAGS = new Set([
  "a", "b", "strong", "i", "em", "u", "p", "br", "div", "span", "ul", "ol", "li", "blockquote",
  "table", "thead", "tbody", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "pre",
  "code", "img", "font",
]);

// Removed together with everything inside them.
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select",
  "link", "meta", "head", "title", "svg", "math", "audio", "video", "base", "noscript",
]);

/**
 * Cleans a received email's HTML before it is placed into the compose editor: keeps basic
 * formatting, drops scripts/forms/styles and every attribute except safe links and https images.
 */
export function sanitizeForwardHtml(html: string): string {
  if (!html || typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        node.removeChild(child);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) {
        node.removeChild(el);
        continue;
      }

      walk(el); // clean the children first

      if (!ALLOWED_TAGS.has(tag)) {
        // Unknown wrapper: keep its (already cleaned) content, drop the tag.
        while (el.firstChild) node.insertBefore(el.firstChild, el);
        node.removeChild(el);
        continue;
      }

      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (tag === "a" && name === "href" && /^(https?:|mailto:)/i.test(value)) continue;
        if (tag === "img" && name === "src" && /^https:/i.test(value)) continue;
        if (tag === "img" && (name === "alt" || name === "width" || name === "height")) continue;
        if ((tag === "td" || tag === "th") && (name === "colspan" || name === "rowspan")) continue;
        el.removeAttribute(attr.name);
      }
      if (tag === "img" && !el.getAttribute("src")) {
        node.removeChild(el); // image whose source was unsafe — drop it instead of a broken box
        continue;
      }
      if (tag === "a") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
  };

  walk(doc.body);
  return doc.body.innerHTML;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Standard "Forwarded message" block (headers + the original text) as editor HTML. */
export function buildForwardBodyHtml(msg: InboxMessageDetail): string {
  const sender = msg.from_name
    ? `${esc(msg.from_name)} &lt;${esc(msg.from_email || "")}&gt;`
    : esc(msg.from_email || "Unknown sender");

  let dateLabel = msg.date || "";
  if (dateLabel) {
    const parsed = new Date(dateLabel);
    if (!Number.isNaN(parsed.getTime())) dateLabel = parsed.toLocaleString();
  }

  const lines = [
    "---------- Forwarded message ----------",
    `From: ${sender}`,
    `Date: ${esc(dateLabel)}`,
    `Subject: ${esc(msg.subject || "(no subject)")}`,
    `To: ${esc((msg.to || []).join(", "))}`,
  ];
  if (msg.cc && msg.cc.length) lines.push(`Cc: ${esc(msg.cc.join(", "))}`);

  const attachmentNames = (msg.attachments || [])
    .map((a) => (a.filename || "").trim())
    .filter(Boolean);
  const attachmentNote = attachmentNames.length
    ? `<p><em>Original attachments (not included — please re-attach if needed): ${esc(
        attachmentNames.join(", "),
      )}</em></p>`
    : "";

  const original = msg.body_html
    ? sanitizeForwardHtml(msg.body_html)
    : plainTextToEditorHtml(msg.body_text || "");

  return `<p><br></p><p>${lines.join("<br>")}</p>${attachmentNote}<blockquote>${original}</blockquote>`;
}
