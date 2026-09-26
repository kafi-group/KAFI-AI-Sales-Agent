/**
 * Edge / other browsers often keep a stale index.html that points at an old
 * hashed JS bundle. When a newer deploy is live, reload once so everyone
 * lands on the same UI without manual cache clears.
 */

function currentBundleName(): string | null {
  const scripts = Array.from(document.getElementsByTagName("script"));
  for (const el of scripts) {
    const src = el.getAttribute("src") || "";
    const m = src.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
    if (m) return m[1];
  }
  return null;
}

async function latestBundleName(): Promise<string | null> {
  const res = await fetch(`/?_deploy_check=${Date.now()}`, {
    cache: "no-store",
    headers: { Pragma: "no-cache", "Cache-Control": "no-cache" },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  return m ? m[1] : null;
}

export function watchForNewDeploy(): void {
  if (typeof window === "undefined") return;
  // Vite dev always serves /src/main.tsx — skip.
  if (import.meta.env.DEV) return;

  const mine = currentBundleName();
  if (!mine) return;

  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const latest = await latestBundleName();
      if (latest && latest !== mine) {
        // One hard reload to pick up the new index → new assets.
        window.location.reload();
      }
    } catch {
      /* ignore network blips */
    } finally {
      checking = false;
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
  window.addEventListener("focus", () => void check());
  // First check shortly after load (covers long-lived Edge tabs).
  window.setTimeout(() => void check(), 2500);
  window.setInterval(() => void check(), 3 * 60 * 1000);
}
