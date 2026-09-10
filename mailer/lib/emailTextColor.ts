/** Dark-UI editor: force hard-to-read dark/green text to white while composing. */
export function normalizeEditorTextColor(html: string): string {
  if (!html) return html;
  return html
    .replace(/color\s*:\s*#047857\b/gi, "color:#ffffff")
    .replace(/color\s*:\s*#059669\b/gi, "color:#ffffff")
    .replace(/color\s*:\s*#065f46\b/gi, "color:#ffffff")
    .replace(/color\s*:\s*#111827\b/gi, "color:#ffffff")
    .replace(/color\s*:\s*#000000\b/gi, "color:#ffffff")
    .replace(/color\s*:\s*#000\b/gi, "color:#ffffff")
    .replace(/color\s*:\s*black\b/gi, "color:#ffffff")
    .replace(/color\s*=\s*["']?#047857\b/gi, 'color="#ffffff"')
    .replace(/color\s*=\s*["']?#111827\b/gi, 'color="#ffffff"')
    .replace(/color\s*=\s*["']?#000000\b/gi, 'color="#ffffff"')
    .replace(/color\s*=\s*["']?black\b/gi, 'color="#ffffff"');
}

/** Outbound email: white compose color must become dark for recipient inboxes. */
export function normalizeOutboundTextColor(html: string): string {
  if (!html) return html;
  return html
    .replace(/color\s*:\s*#ffffff\b/gi, "color:#111827")
    .replace(/color\s*:\s*#fff\b/gi, "color:#111827")
    .replace(/color\s*:\s*#f8fafc\b/gi, "color:#111827")
    .replace(/color\s*:\s*#e5e7eb\b/gi, "color:#111827")
    .replace(/color\s*:\s*white\b/gi, "color:#111827")
    .replace(/color\s*=\s*["']?#ffffff\b/gi, 'color="#111827"')
    .replace(/color\s*=\s*["']?#fff\b/gi, 'color="#111827"')
    .replace(/color\s*=\s*["']?white\b/gi, 'color="#111827"');
}
