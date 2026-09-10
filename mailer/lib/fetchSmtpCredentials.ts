/** Fetch SMTP login from Sales Agent (same password that powers IMAP inbox). */

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
  if (!base) return null;

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
    if (!res.ok) return null;
    const data = (await res.json()) as {
      email?: string;
      password?: string;
      display_name?: string | null;
    };
    const email = (data.email || "").trim();
    const password = (data.password || "").trim();
    if (!email || !password) return null;
    return {
      email,
      password,
      displayName: data.display_name ?? null,
    };
  } catch {
    return null;
  }
}
