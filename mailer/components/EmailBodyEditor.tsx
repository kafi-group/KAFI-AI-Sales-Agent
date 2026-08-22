"use client";

import {
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";

export type EmailBodyEditorProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
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

export function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (!looksLikeHtml(html)) return html;
  if (typeof DOMParser === "undefined") {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trimEnd();
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body?.innerText || "").replace(/\u00a0/g, " ").trimEnd();
}

export function emailBodyHasContent(html: string): boolean {
  return htmlToPlainText(html).trim().length > 0;
}

function ToolbarButton({
  title,
  disabled,
  onMouseDown,
  children,
}: {
  title: string;
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
      className="rte-tool"
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="rte-divider" aria-hidden />;
}

export function EmailBodyEditor({
  value,
  onChange,
  placeholder = "Write your message…",
  rows = 10,
  disabled = false,
  className = "",
}: EmailBodyEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastHtml = useRef<string>("");
  const reactId = useId();

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

  function emitChange() {
    const el = editorRef.current;
    if (!el) return;
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
      /* ignore */
    }
    emitChange();
  }

  function onTool(e: MouseEvent, command: string, commandValue?: string) {
    e.preventDefault();
    run(command, commandValue);
  }

  const minHeight = Math.max(8, rows) * 1.5;

  return (
    <div className={`rte ${className}`.trim()}>
      <div className="rte-toolbar" role="toolbar" aria-label="Text formatting">
        <select
          id={`${reactId}-size`}
          disabled={disabled}
          defaultValue="3"
          title="Font size"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => run("fontSize", e.target.value)}
          className="rte-select"
        >
          {FONT_SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <Divider />

        <ToolbarButton title="Bold" disabled={disabled} onMouseDown={(e) => onTool(e, "bold")}>
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton title="Italic" disabled={disabled} onMouseDown={(e) => onTool(e, "italic")}>
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          title="Underline"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "underline")}
        >
          <span style={{ textDecoration: "underline" }}>U</span>
        </ToolbarButton>

        <select
          id={`${reactId}-color`}
          disabled={disabled}
          defaultValue={COLORS[0].value}
          title="Text color"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => run("foreColor", e.target.value)}
          className="rte-select"
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
          <span className="rte-align" data-align="left" />
        </ToolbarButton>
        <ToolbarButton
          title="Align center"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "justifyCenter")}
        >
          <span className="rte-align" data-align="center" />
        </ToolbarButton>
        <ToolbarButton
          title="Align right"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "justifyRight")}
        >
          <span className="rte-align" data-align="right" />
        </ToolbarButton>

        <Divider />

        <ToolbarButton
          title="Numbered list"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "insertOrderedList")}
        >
          1.
        </ToolbarButton>
        <ToolbarButton
          title="Bullet list"
          disabled={disabled}
          onMouseDown={(e) => onTool(e, "insertUnorderedList")}
        >
          •
        </ToolbarButton>
      </div>

      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={emitChange}
        onBlur={emitChange}
        className="rte-editor"
        style={{ minHeight: `${minHeight}rem` }}
      />
    </div>
  );
}
