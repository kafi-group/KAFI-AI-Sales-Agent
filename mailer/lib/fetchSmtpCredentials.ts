/** Fetch SMTP login from Sales Agent (same password that powers IMAP inbox).

 * Reps never enter the mailbox password — they only log into Sales Agent.
 * Mailer must use this endpoint; do not rely on stale Vercel MAILBOX_* passwords.
 */

export type SmtpCreds = {
  email: string;
  password: string;
  displayName?: string | null;
};

function apiBase(): string {
  return (
    process.env.KAFI_API_BASE_URL ||
    process.env.NEXT_PUBLIC_KAFI_API_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
}

export async function fetchSmtpCredentialsFromSalesAgent(opts: {
  authToken?: string;
  handoffToken?: string;
}): Promise<SmtpCreds | null> {
  const base = apiBase();
  if (!base) {
    console.error(
      "[mailer] KAFI_API_BASE_URL missing — cannot load mailbox password from Sales Agent",
    );
    return null;
  }

  const authToken = (opts.authToken || "").trim();
  const handoffToken = (opts.handoffToken || "").trim();
  if (!authToken && !handoffToken) return null;

  const url = new URL(`${base}/mailer/smtp-credentials`);
  if (handoffToken) url.searchParams.set("token", handoffToken);

  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  try {
    const res = await fetch(url.toString(), {
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(
        `[mailer] smtp-credentials HTTP ${res.status}: ${detail.slice(0, 200)}`,
      );
      return null;
    }
    const data = (await res.json()) as {
      email?: string;
      password?: string;
      display_name?: string | null;
    };
    const email = (data.email || "").trim();
    const password = (data.password || "").trim();
    if (!email || !password) {
      console.error("[mailer] smtp-credentials response missing email/password");
      return null;
    }
    return {
      email,
      password,
      displayName: data.display_name ?? null,
    };
  } catch (err) {
    console.error("[mailer] smtp-credentials fetch failed", err);
    return null;
  }
}
