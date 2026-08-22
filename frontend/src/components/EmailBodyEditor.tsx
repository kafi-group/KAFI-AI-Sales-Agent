import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";

export type EmailBodyEditorProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  /** Extra class on the editable surface */
  editorClassName?: string;
};

const FONT_SIZES = [
  { label: "Small", value: "2" },
  { label: "Medium", value: "3" },
  { label: "Large", value: "5" },
] as const;

const COLORS = [
  { label: "Black", value: "#111827" },
  { label: "Gray", value: "#4b5563" },
  { label: "Red", value: "#b91c1c" },
  { label: "Blue", value: "#1d4ed8" },
  { label: "Green", value: "#047857" },
] as const;

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value || "");
}

/** Convert plain text (or mixed) into simple HTML for the editor. */
export function plainTextToEditorHtml(text: string): string {
  const raw = text || "";
  if (!raw.trim()) return "";
  if (looksLikeHtml(raw)) return raw;
  return raw
    .split(/\n{2,}/)
    .map((block) => {
      const withBreaks = block
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
      return `<p>${withBreaks || "<br>"}</p>`;
    })
    .join("");
}

/** Strip tags for WhatsApp / plain-text fallbacks. */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (!looksLikeHtml(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body?.innerText || "").replace(/\u00a0/g, " ").trimEnd();
}

export function emailBodyHasContent(html: string): boolean {
  return htmlToPlainText(html).trim().length > 0;
}

/** Append a template placeholder into plain or HTML email body. */
export function appendEmailPlaceholder(body: string, token: string): string {
  const t = (token || "").trim();
  if (!t) return body || "";
  const current = body || "";
  if (!current.trim()) return `<p>${t}</p>`;
  if (looksLikeHtml(current)) {
    return `${current.replace(/\s+$/, "")}<p>${t}</p>`;
  }
  return `${current}${current.endsWith("\n") ? "" : "\n"}${t}`;
}

function ToolbarButton({
  title,
  active,
  disabled,
  onMouseDown,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onMouseDown: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={onMouseDown}
      className={`min-w-8 h-8 px-1.5 rounded-md text-sm font-semibold inline-flex items-center justify-center border transition-colors ${
        active
          ? "bg-slate-700 border-slate-500 text-white"
          : "bg-transparent border-transparent text-slate-300 hover:bg-slate-800 hover:border-slate-700"
      } disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-slate-700 shrink-0" aria-hidden />;
}

export function EmailBodyEditor({
  value,
  onChange,
  placeholder = "Write your message…",
  rows = 10,
  disabled = false,
  className = "",
  editorClassName = "",
}: EmailBodyEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastHtml = useRef<string>("");
  const reactId = useId();

  // Sync external value → editor (avoid cursor jumps when unchanged).
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const next = plainTextToEditorHtml(value);
    if (next === lastHtml.current) return;
    if (el.innerHTML === next) {
      lastHtml.current = next;
      return;
    }
    el.innerHTML = next || "";
    lastHtml.current = next;
  }, [value]);

  /** Uppercase the first letter in the contentEditable document (live typing). */
  function ensureLeadingCapital(root: HTMLElement) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent ?? "";
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (!/\p{L}/u.test(ch)) continue;
        const upper = ch.toLocaleUpperCase("en");
        if (ch === upper) return;
        const sel = window.getSelection();
        const anchorNode = sel?.anchorNode ?? null;
        const anchorOffset = sel?.anchorOffset ?? 0;
        node.textContent = text.slice(0, i) + upper + text.slice(i + 1);
        if (sel && anchorNode && root.contains(anchorNode)) {
          try {
            const range = document.createRange();
            const target = anchorNode === node || anchorNode.parentNode === node
              ? node
              : anchorNode;
            const len = (target.textContent || "").length;
            range.setStart(target, Math.min(anchorOffset, len));
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          } catch {
            /* ignore selection restore failures */
          }
        }
        return;
      }
    }
  }

  function emitChange() {
    const el = editorRef.current;
    if (!el) return;
    ensureLeadingCapital(el);
    const html = el.innerHTML === "<br>" ? "" : el.innerHTML;
    lastHtml.current = html;
    onChange(html);
  }

  function run(command: string, commandValue?: string) {
    if (disabled) return;
    editorRef.current?.focus();
    try {
      document.execCommand(command, false, commandValue);
    } catch {
      /* ignore unsupported commands */
    }
    emitChange();
  }

  function onTool(e: MouseEvent, command: string, commandValue?: string) {
    e.preventDefault();
    run(command, commandValue);
  }

  const minHeight = Math.max(8, rows) * 1.5;

  return (
    <div
      className={`rounded-lg border border-slate-700 bg-slate-950 overflow-hidden ${className}`}
    >
      <div
        className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-slate-800 bg-slate-900/80"
        role="toolbar"
        aria-label="Text formatting"
      >
        <label className="sr-only" htmlFor={`${reactId}-size`}>
          Font size
        </label>
        <select
          id={`${reactId}-size`}
          disabled={disabled}
          defaultValue="3"
          title="Font size"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => run("fontSize", e.target.value)}
          className="h-8 rounded-md bg-slate-950 border border-slate-700 text-xs text-slate-200 px-1.5 mr-0.5"
        >
          {FONT_SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <Divider />

        <ToolbarButton title="Bold" disabled={disabled} onMouseDown={(e) => onTool(e, "bold")}>
          <span className="font-bold">B</span>
        </ToolbarButton>
        <ToolbarButton title="Italic" disabled={disabled} onMouseDown={(e) => onTool(e, "italic")}>
          <span className="italic font-serif">I</span>
        </ToolbarButton>
        <ToolbarButton
          title="Underline"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "underline")}
        >
          <span className="underline">U</span>
        </ToolbarButton>

        <label className="sr-only" htmlFor={`${reactId}-color`}>
          Text color
        </label>
        <select
          id={`${reactId}-color`}
          disabled={disabled}
          defaultValue={COLORS[0].value}
          title="Text color"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => run("foreColor", e.target.value)}
          className="h-8 rounded-md bg-slate-950 border border-slate-700 text-xs text-slate-200 px-1.5"
        >
          {COLORS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>

        <Divider />

        <ToolbarButton
          title="Align left"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "justifyLeft")}
        >
          <AlignIcon align="left" />
        </ToolbarButton>
        <ToolbarButton
          title="Align center"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "justifyCenter")}
        >
          <AlignIcon align="center" />
        </ToolbarButton>
        <ToolbarButton
          title="Align right"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "justifyRight")}
        >
          <AlignIcon align="right" />
        </ToolbarButton>

        <Divider />

        <ToolbarButton
          title="Numbered list"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "insertOrderedList")}
        >
          <span className="text-[11px] tracking-tight">1.</span>
        </ToolbarButton>
        <ToolbarButton
          title="Bullet list"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "insertUnorderedList")}
        >
          <span className="text-base leading-none">•</span>
        </ToolbarButton>
      </div>

      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-placeholder={placeholder}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={emitChange}
        onBlur={emitChange}
        className={`email-body-editor w-full px-3 py-2 text-sm text-slate-100 outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-slate-600 ${editorClassName}`}
        style={{ minHeight: `${minHeight}rem` }}
      />
    </div>
  );
}

function AlignIcon({ align }: { align: "left" | "center" | "right" }) {
  const widths =
    align === "left"
      ? ["w-3.5", "w-2.5", "w-3", "w-2"]
      : align === "right"
        ? ["w-3.5 ml-auto", "w-2.5 ml-auto", "w-3 ml-auto", "w-2 ml-auto"]
        : ["w-3.5 mx-auto", "w-2.5 mx-auto", "w-3 mx-auto", "w-2 mx-auto"];
  return (
    <span className="flex flex-col gap-0.5 w-3.5" aria-hidden>
      {widths.map((w, i) => (
        <span key={i} className={`block h-0.5 rounded-full bg-current ${w}`} />
      ))}
    </span>
  );
}
