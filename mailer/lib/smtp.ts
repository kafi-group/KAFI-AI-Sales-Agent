import nodemailer from "nodemailer";
import { normalizeOutboundTextColor } from "./emailTextColor";

const USER_ENV: Record<string, { email: string; password: string; display?: string }> = {
  admin: {
    email: "MAILBOX_ADMIN_EMAIL",
    password: "MAILBOX_ADMIN_PASSWORD",
    display: "MAILBOX_ADMIN_DISPLAY_NAME",
  },
  asim: {
    email: "MAILBOX_ASIM_EMAIL",
    password: "MAILBOX_ASIM_PASSWORD",
    display: "MAILBOX_ASIM_DISPLAY_NAME",
  },
  usmankhan: {
    email: "MAILBOX_USMAN_EMAIL",
    password: "MAILBOX_USMAN_PASSWORD",
    display: "MAILBOX_USMAN_DISPLAY_NAME",
  },
  sadia: {
    email: "MAILBOX_SADIA_EMAIL",
    password: "MAILBOX_SADIA_PASSWORD",
    display: "MAILBOX_SADIA_DISPLAY_NAME",
  },
};

type MailboxCreds = {
  email: string;
  password: string;
  displayName?: string;
};

/** Shared Kafi mailboxes — fixed public From name, not the logged-in rep. */
const PUBLIC_SENDER_NAMES: Record<string, string> = {
  "info@kafi-group.com": "Asad Ali",
  "marketing@kafi-group.com": "Anjum Ali",
};

function senderDisplayName(email: string, fallback?: string): string | undefined {
  const mapped = PUBLIC_SENDER_NAMES[email.trim().toLowerCase()];
  if (mapped) return mapped;
  const cleaned = (fallback || "").trim();
  return cleaned || undefined;
}

function withPublicSenderName(creds: MailboxCreds): MailboxCreds {
  return {
    ...creds,
    displayName: senderDisplayName(creds.email, creds.displayName),
  };
}

export function resolveMailbox(username: string, fallbackEmail?: string): MailboxCreds | null {
  const map = USER_ENV[username.toLowerCase()];
  if (map) {
    const email = (process.env[map.email] || "").trim();
    // Trim password — trailing newlines in Vercel env cause SMTP 535 failures.
    const password = (process.env[map.password] || "").trim();
    const displayName = (map.display && process.env[map.display]) || undefined;
    if (email && password) {
      return withPublicSenderName({
        email,
        password,
        displayName: displayName?.trim() || undefined,
      });
    }
  }
  // Fallback: match by email against any configured mailbox
  if (fallbackEmail) {
    for (const key of Object.keys(USER_ENV)) {
      const cfg = USER_ENV[key];
      const email = (process.env[cfg.email] || "").trim().toLowerCase();
      if (email && email === fallbackEmail.trim().toLowerCase()) {
        const password = (process.env[cfg.password] || "").trim();
        if (password) {
          return withPublicSenderName({
            email,
            password,
            displayName: (cfg.display && process.env[cfg.display])?.trim() || undefined,
          });
        }
      }
    }
  }
  return null;
}

function normalizeAddrList(value?: string | null): string | undefined {
  const cleaned = (value || "")
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter((part) => part.includes("@"));
  return cleaned.length ? cleaned.join(", ") : undefined;
}

function looksLikeHtml(body: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(body || "");
}

function htmlToPlain(body: string): string {
  if (!looksLikeHtml(body)) return body || "";
  return (body || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toHtmlBody(body: string): string {
  const html = looksLikeHtml(body) ? body : (body || "").replace(/\n/g, "<br/>");
  return normalizeOutboundTextColor(html);
}

export function smtpBodyHasContent(body: string): boolean {
  return htmlToPlain(body || "").trim().length > 0;
}

export async function sendSmtp(options: {
  username: string;
  mailboxEmail?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: boolean;
  /** Prefer Sales Agent DB mailbox password over Vercel env (fixes 535 drift). */
  credsOverride?: {
    email: string;
    password: string;
    displayName?: string | null;
  } | null;
  attachments?: Array<{
    filename: string;
    content: string;
    contentType?: string;
  }>;
}): Promise<{ ok: boolean; message: string }> {
  let creds: MailboxCreds | null = null;
  if (options.credsOverride?.email && options.credsOverride?.password) {
    creds = withPublicSenderName({
      email: options.credsOverride.email.trim(),
      password: options.credsOverride.password.trim(),
      displayName: options.credsOverride.displayName?.trim() || undefined,
    });
  } else {
    creds = resolveMailbox(options.username, options.mailboxEmail);
  }
  if (!creds) {
    return {
      ok: false,
      message: `No SMTP credentials on mailer for user "${options.username}". Set MAILBOX_* env on Vercel or configure the mailbox on Sales Agent Users page.`,
    };
  }

  const host = process.env.MAILBOX_SMTP_HOST || "67.23.252.42";
  const port = Number(process.env.MAILBOX_SMTP_PORT || "465");
  const sslHostname = process.env.MAILBOX_SSL_HOSTNAME || "mail.kafi-group.com";

  async function attempt(authUser: string): Promise<{ ok: boolean; message: string }> {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user: authUser, pass: creds!.password },
      tls: {
        servername: sslHostname,
        rejectUnauthorized: true,
      },
      connectionTimeout: 25_000,
      greetingTimeout: 25_000,
      socketTimeout: 40_000,
    });

    const from = creds!.displayName
      ? `"${creds!.displayName}" <${creds!.email}>`
      : creds!.email;

    const cc = normalizeAddrList(options.cc);
    const bcc = normalizeAddrList(options.bcc);

    try {
      const mailAttachments = (options.attachments || [])
        .filter((item) => item.filename && item.content)
        .map((item) => ({
          filename: item.filename,
          content: Buffer.from(item.content, "base64"),
          contentType: item.contentType || undefined,
        }));

      await transporter.sendMail({
        from,
        to: options.to,
        ...(cc ? { cc } : {}),
        ...(bcc ? { bcc } : {}),
        subject: options.subject,
        text: htmlToPlain(options.body),
        html: options.html ? toHtmlBody(options.body) : undefined,
        replyTo: creds!.email,
        ...(mailAttachments.length ? { attachments: mailAttachments } : {}),
      });
      return { ok: true, message: "sent" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg };
    } finally {
      try {
        transporter.close();
      } catch {
        /* ignore close errors */
      }
    }
  }

  // Prefer full email login; some cPanel hosts accept local-part only.
  const first = await attempt(creds.email);
  if (first.ok) return first;
  const local = creds.email.includes("@") ? creds.email.split("@")[0] : "";
  if (
    local &&
    local.toLowerCase() !== creds.email.toLowerCase() &&
    /535|authentication|login/i.test(first.message)
  ) {
    const second = await attempt(local);
    if (second.ok) return second;
    return {
      ok: false,
      message: `${first.message} (also tried login as ${local}: ${second.message})`,
    };
  }
  return first;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
