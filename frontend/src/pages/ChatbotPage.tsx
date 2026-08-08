import { useCallback, useEffect, useRef, useState } from "react";
import { client, type ChatMessage } from "../api/client";
import { CreateLeadForm } from "../components/CreateLeadForm";
import { capitalizeFirstLetter } from "../utils/spelling";
import { parseBrandAssistantLead } from "../utils/parseBrandAssistantLead";

interface ChatbotPageProps {
  onError: (msg: string) => void;
}

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  imagePreview?: string;
  provider?: string;
  loading?: boolean;
}

const WELCOME: UIMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Upload a product image — I'll identify the brand and pull everything about that company: " +
    "contact details, address, website, social media, and company background from the pack and the web.",
};

const ACCEPTED_IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/gif";
const MAX_MB = 10;

function msgId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function ProviderBadge({ provider }: { provider?: string }) {
  if (!provider) return null;
  const styles: Record<string, string> = {
    gemini: "bg-blue-900/50 text-blue-300 border-blue-700/40",
    openai: "bg-emerald-900/50 text-emerald-300 border-emerald-700/40",
    anthropic: "bg-purple-900/50 text-purple-300 border-purple-700/40",
  };
  const labels: Record<string, string> = {
    gemini: "Gemini",
    openai: "OpenAI",
    anthropic: "Claude",
  };
  const cls = styles[provider] ?? "bg-slate-800 text-slate-400 border-slate-700";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${cls}`}>
      {labels[provider] ?? provider}
    </span>
  );
}

function AssistantAvatar() {
  return (
    <span className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-amber-600/20 border border-amber-600/40 text-amber-400 text-xs font-bold">
      K
    </span>
  );
}

function UserAvatar() {
  return (
    <span className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-slate-700 border border-slate-600 text-slate-300 text-xs font-bold">
      U
    </span>
  );
}

function MessageBubble({
  msg,
  onAddLead,
}: {
  msg: UIMessage;
  onAddLead?: (content: string) => void;
}) {
  const isUser = msg.role === "user";

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {isUser ? <UserAvatar /> : <AssistantAvatar />}
      <div className={`max-w-[75%] flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        {msg.imagePreview && (
          <img
            src={msg.imagePreview}
            alt="Uploaded product"
            className="rounded-lg border border-slate-700 max-w-[240px] max-h-[200px] object-cover"
          />
        )}
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
            isUser
              ? "bg-amber-600 text-white rounded-tr-sm"
              : msg.loading
                ? "bg-slate-800 border border-slate-700 text-slate-400 rounded-tl-sm animate-pulse"
                : "bg-slate-800 border border-slate-700 text-slate-100 rounded-tl-sm"
          }`}
        >
          {msg.loading ? (
            <span className="flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:0ms]" />
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:150ms]" />
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:300ms]" />
            </span>
          ) : (
            msg.content
          )}
        </div>
        {!isUser && msg.provider && !msg.loading && (
          <div className="flex flex-wrap items-center gap-2 pl-1">
            <ProviderBadge provider={msg.provider} />
            {onAddLead && msg.content.trim().length > 40 ? (
              <button
                type="button"
                onClick={() => onAddLead(msg.content)}
                className="text-xs px-2.5 py-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
              >
                Add new lead
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatbotPage({ onError }: ChatbotPageProps) {
  const [messages, setMessages] = useState<UIMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [providers, setProviders] = useState<{
    gemini: boolean;
    openai: boolean;
    anthropic: boolean;
  } | null>(null);
  const [leadDraft, setLeadDraft] = useState<ReturnType<typeof parseBrandAssistantLead> | null>(
    null,
  );
  const [leadNotice, setLeadNotice] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    client.getChatbotStatus().then(setProviders).catch(() => null);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function selectImage(file: File) {
    if (file.size > MAX_MB * 1024 * 1024) {
      onError(`Image too large. Max ${MAX_MB} MB.`);
      return;
    }
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) selectImage(f);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("image/")) selectImage(f);
  }

  function clearImage() {
    setImageFile(null);
    setImagePreview(null);
  }

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    const history: ChatMessage[] = messages
      .filter((m) => !m.loading && m.id !== "welcome")
      .map((m) => ({ role: m.role, content: m.content }));

    const userMsg: UIMessage = {
      id: msgId(),
      role: "user",
      content: text,
      imagePreview: imagePreview ?? undefined,
    };
    const thinkingMsg: UIMessage = { id: msgId(), role: "assistant", content: "", loading: true };

    setMessages((prev) => [...prev, userMsg, thinkingMsg]);
    setInput("");
    clearImage();
    setSending(true);

    try {
      const resp = await client.sendChatbotMessage({
        message: text,
        image: imageFile ?? undefined,
        history,
      });

      setMessages((prev) =>
        prev.map((m) =>
          m.id === thinkingMsg.id
            ? {
                ...m,
                content: resp.reply,
                provider: resp.provider,
                loading: false,
              }
            : m,
        ),
      );
    } catch (err) {
      const errText =
        err instanceof Error ? err.message : "The product assistant could not respond right now.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === thinkingMsg.id
            ? { ...m, content: `Error: ${errText}`, loading: false }
            : m,
        ),
      );
      onError(errText);
    } finally {
      setSending(false);
    }
  }, [input, sending, messages, imageFile, imagePreview, onError]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  function clearChat() {
    setMessages([WELCOME]);
    clearImage();
  }

  const activeCount = providers
    ? [providers.gemini, providers.openai, providers.anthropic].filter(Boolean).length
    : 0;

  return (
    <div className="flex flex-col h-[calc(100dvh-6rem)] sm:h-[calc(100vh-5rem)] min-h-[520px] w-full min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-slate-800">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Brand assistant</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Upload a product image — brand identification and full company details first.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {providers && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">{activeCount} provider{activeCount !== 1 ? "s" : ""} active</span>
              <div className="flex gap-1">
                {[
                  { key: "gemini", label: "G", title: "Gemini Flash", active: providers.gemini, cls: "bg-blue-900/60 border-blue-700/50 text-blue-300" },
                  { key: "openai", label: "O", title: "OpenAI", active: providers.openai, cls: "bg-emerald-900/60 border-emerald-700/50 text-emerald-300" },
                  { key: "anthropic", label: "A", title: "Claude", active: providers.anthropic, cls: "bg-purple-900/60 border-purple-700/50 text-purple-300" },
                ].map((p) => (
                  <span
                    key={p.key}
                    title={`${p.title}: ${p.active ? "configured" : "not configured"}`}
                    className={`w-6 h-6 flex items-center justify-center rounded border text-[10px] font-bold transition-opacity ${p.active ? p.cls : "bg-slate-800 border-slate-700 text-slate-600 opacity-40"}`}
                  >
                    {p.label}
                  </span>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={clearChat}
            className="text-xs text-slate-500 hover:text-slate-300 px-2 py-1 rounded border border-slate-700 hover:border-slate-600 transition-colors"
          >
            Clear chat
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto py-6 flex flex-col gap-5"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            onAddLead={
              msg.role === "assistant" && !msg.loading && msg.id !== "welcome"
                ? (content) => setLeadDraft(parseBrandAssistantLead(content))
                : undefined
            }
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {leadDraft ? (
        <div className="border-t border-slate-800 pt-4">
          {leadNotice ? (
            <p className="mb-3 text-sm text-emerald-300">{leadNotice}</p>
          ) : null}
          <CreateLeadForm
            title="Add lead from Brand assistant"
            source="manual"
            initialValues={leadDraft}
            onCancel={() => {
              setLeadDraft(null);
              setLeadNotice(null);
            }}
            onError={onError}
            onSuccess={(id) => {
              setLeadDraft(null);
              setLeadNotice(`Lead #${id} created — open Master table or New search lead to review.`);
              window.setTimeout(() => setLeadNotice(null), 6000);
            }}
          />
        </div>
      ) : null}

      {/* Input area */}
      <div className="border-t border-slate-800 pt-4 flex flex-col gap-3">
        {/* Image preview */}
        {imagePreview && (
          <div className="flex items-start gap-3 p-3 rounded-xl bg-slate-800/60 border border-slate-700">
            <img
              src={imagePreview}
              alt="Product to analyse"
              className="w-16 h-16 rounded-lg object-cover border border-slate-700 shrink-0"
            />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-400 font-medium truncate">{imageFile?.name}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {imageFile ? `${(imageFile.size / 1024).toFixed(0)} KB` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={clearImage}
              className="text-slate-500 hover:text-slate-300 text-lg leading-none shrink-0"
              aria-label="Remove image"
            >
              ×
            </button>
          </div>
        )}

        {/* Text + send */}
        <div className="flex items-end gap-2">
          {/* Image upload button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            title="Upload product image"
            className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-40"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(capitalizeFirstLetter(e.target.value))}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={
              imagePreview
                ? "Ask about this product…"
                : "Upload an image or ask a product question…"
            }
            disabled={sending}
            className="flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 text-slate-100 placeholder-slate-500 px-4 py-2.5 text-sm focus:outline-none focus:border-amber-600/70 focus:ring-1 focus:ring-amber-600/30 transition-colors disabled:opacity-50 max-h-32 overflow-y-auto"
            style={{ lineHeight: "1.5" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
            }}
          />

          {/* Send button */}
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="Send"
          >
            {sending ? (
              <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            )}
          </button>
        </div>

        <p className="text-xs text-slate-600 text-center">
          Drag &amp; drop an image anywhere · Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
