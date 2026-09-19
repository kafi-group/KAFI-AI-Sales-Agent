/** Compose editor text color vs outbound (inbox) text color. */

export type MailerUiTheme = "dark" | "light";

const DARK_TEXT = "#ffffff";
const LIGHT_TEXT = "#111827";
const WRAP_ATTR = "data-kafi-compose-color";

const TEXT_TAGS = new Set([
  "P",
  "DIV",
  "SPAN",
  "LI",
  "TD",
  "TH",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "A",
  "LABEL",
  "FONT",
  "STRONG",
  "EM",
  "B",
  "I",
  "U",
  "BLOCKQUOTE",
  "PRE",
]);

function cleanColorToken(color: string): string {
  return String(color || "")
    .replace(/\s*!important\s*/gi, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function parseRgb(color: string): [number, number, number] | null {
  const raw = cleanColorToken(color).toLowerCase();
  if (!raw) return null;

  const short = /^#([0-9a-f]{3})$/i.exec(raw);
  if (short) {
    const h = short[1];
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  const full = /^#([0-9a-f]{6})$/i.exec(raw);
  if (full) {
    const h = full[1];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  // Word/Outlook sometimes omit '#'
  const bare = /^([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (bare) return parseRgb(`#${bare[1]}`);

  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(raw);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  if (raw === "black" || raw === "windowtext" || raw === "text") return [0, 0, 0];
  if (raw === "white") return [255, 255, 255];
  return null;
}

/** Relative luminance 0 (black) … 1 (white). */
function luminance(color: string): number | null {
  const rgb = parseRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isDarkColor(color: string): boolean {
  const lum = luminance(color);
  if (lum == null) return false;
  return lum < 0.55;
}

function isLightColor(color: string): boolean {
  const lum = luminance(color);
  if (lum == null) return false;
  return lum > 0.72;
}

/** Detect mailer chrome theme from CSS variables / color-scheme. */
export function getMailerUiTheme(): MailerUiTheme {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return "dark";
  }
  const root = document.documentElement;
  const scheme = (getComputedStyle(root).colorScheme || "").toLowerCase();
  if (scheme.includes("light") && !scheme.includes("dark")) return "light";
  if (scheme.includes("dark")) return "dark";

  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (bg) {
    const lum = luminance(bg);
    if (lum != null) return lum < 0.45 ? "dark" : "light";
  }
  // Mailer ships dark by default.
  return "dark";
}

export function getComposeDefaultTextColor(theme?: MailerUiTheme): string {
  const t = theme ?? getMailerUiTheme();
  return t === "dark" ? DARK_TEXT : LIGHT_TEXT;
}

function shouldForceColor(cssColor: string, theme: MailerUiTheme): boolean {
  const v = cleanColorToken(cssColor);
  if (!v || v === "inherit" || v === "currentcolor" || v === "transparent") {
    return false;
  }
  if (theme === "dark") return isDarkColor(v);
  return isLightColor(v);
}

function rewriteInlineColor(style: string, theme: MailerUiTheme, target: string): string {
  return style.replace(/(^|;)\s*color\s*:\s*([^;]+)/gi, (full, lead: string, value: string) => {
    if (!shouldForceColor(value, theme)) return full;
    return `${lead} color: ${target}`;
  });
}

function unwrapComposeWrappers(root: HTMLElement) {
  while (root.children.length === 1) {
    const only = root.children[0] as HTMLElement;
    if (only?.getAttribute?.(WRAP_ATTR)) {
      root.innerHTML = only.innerHTML;
      continue;
    }
    break;
  }
}

/**
 * Force template/pasted body text to be readable on the compose chrome:
 * dark UI → white text; light UI → black text.
 */
export function normalizeEditorTextColor(
  html: string,
  theme?: MailerUiTheme,
): string {
  if (!html) return html;
  const ui = theme ?? getMailerUiTheme();
  const target = getComposeDefaultTextColor(ui);

  if (typeof DOMParser === "undefined") {
    if (ui === "dark") {
      return html
        .replace(/color\s*:\s*#0{3,8}\b/gi, `color:${target}`)
        .replace(/color\s*:\s*#111827\b/gi, `color:${target}`)
        .replace(/color\s*:\s*#1f2937\b/gi, `color:${target}`)
        .replace(/color\s*:\s*#374151\b/gi, `color:${target}`)
        .replace(/color\s*:\s*black\b/gi, `color:${target}`)
        .replace(/color\s*:\s*rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)/gi, `color:${target}`);
    }
    return html;
  }

  const doc = new DOMParser().parseFromString(
    `<div id="kafi-compose-root">${html}</div>`,
    "text/html",
  );
  const root = doc.getElementById("kafi-compose-root");
  if (!root) return html;

  unwrapComposeWrappers(root);

  const walk = (el: Element) => {
    if (el.hasAttribute("style")) {
      el.setAttribute(
        "style",
        rewriteInlineColor(el.getAttribute("style") || "", ui, target),
      );
    }
    if (el.tagName === "FONT" && el.hasAttribute("color")) {
      const c = el.getAttribute("color") || "";
      if (shouldForceColor(c, ui)) el.setAttribute("color", target);
    }
    if (TEXT_TAGS.has(el.tagName)) {
      const st = el.getAttribute("style") || "";
      if (!/color\s*:/i.test(st)) {
        el.setAttribute("style", `color:${target}${st ? `;${st}` : ""}`);
      }
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(root);

  return `<div ${WRAP_ATTR}="${target}" style="color:${target}">${root.innerHTML}</div>`;
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
