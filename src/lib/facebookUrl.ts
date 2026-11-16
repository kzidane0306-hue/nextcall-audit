/**
 * Facebook page URL helpers — pure functions, safe to import on the server
 * AND in client components.
 *
 * The operator screenshots the Facebook About panel with the browser address
 * bar visible, so the vision read returns the page URL as printed. These
 * helpers turn that raw string into the three things the app needs:
 *
 *   1. A canonical page URL  — stored on the prospect, opened by the button.
 *   2. A stable identity key — "f:<vanity-or-id>", a dedupe key so the same
 *      page screenshotted twice still matches one business.
 *   3. Deep links            — an m.me Messenger link and an m.facebook.com
 *      variant that tends to stay inside the mobile browser instead of
 *      bouncing into the installed app.
 */

const FACEBOOK_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "mbasic.facebook.com",
  "web.facebook.com",
  "fb.com",
  "www.fb.com",
  "fb.me",
  "www.fb.me",
  "m.fb.me",
]);

/** Paths that are sharing UI, not a page of their own. */
const INVALID_PATHS = [
  "/sharer.php",
  "/share.php",
  "/share",
  "/dialog/",
  "/login",
  "/watch",
  "/marketplace",
  "/gaming",
  "/save",
];

export interface FacebookPageIdentity {
  /** Canonical browser URL, always https://www.facebook.com/... */
  url: string;
  /** Stable identity: "f:<vanity-or-id>" for the duplicate check. */
  key: string;
}

/**
 * Normalises anything the vision model might read out of an address bar into
 * a canonical Facebook page URL + identity key. Returns null for anything
 * that is not recognisably a Facebook page (google.com, a bare business
 * website, empty text…).
 */
export function normalizeFacebookPageUrl(raw: string | null | undefined): FacebookPageIdentity | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  // Accept inputs with or without a scheme; strip wrapping punctuation the
  // model sometimes adds (quotes, angle brackets).
  const cleaned = trimmed.replace(/^[<("'\s]+|[>)"'\s.,]+$/g, "");
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(cleaned)
    ? cleaned
    : `https://${cleaned}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!FACEBOOK_HOSTS.has(host)) return null;

  // profile.php?id=… — numeric-id pages, exactly what mobile screenshots show.
  if (parsed.pathname === "/profile.php") {
    const id = parsed.searchParams.get("id")?.trim();
    if (id && /^\d{5,}$/.test(id)) {
      return { url: `https://www.facebook.com/profile.php?id=${id}`, key: `f:${id}` };
    }
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const first = segments[0].toLowerCase();
  if (INVALID_PATHS.some((path) => first === path.slice(1))) return null;

  // /people/<Name>/<id> — the mobile "people" card is a page profile.
  if (first === "people" && segments.length >= 3) {
    const id = segments[segments.length - 1];
    if (/^\d{5,}$/.test(id)) {
      return { url: `https://www.facebook.com/profile.php?id=${id}`, key: `f:${id}` };
    }
    return null;
  }

  // /pages/<Name>/<id> — the classic page permalink.
  if (first === "pages" && segments.length >= 3) {
    const id = segments[segments.length - 1];
    if (/^\d{5,}$/.test(id)) {
      return { url: `https://www.facebook.com/profile.php?id=${id}`, key: `f:${id}` };
    }
    return null;
  }

  // A vanity path: keep the first segment only, so /UtahFloodGuys/about
  // normalises to /UtahFloodGuys. Groups keep their /groups/<id> prefix.
  if (first === "groups" && segments.length >= 2) {
    const groupId = segments[1];
    return {
      url: `https://www.facebook.com/groups/${groupId}`,
      key: `f:group:${groupId.toLowerCase()}`,
    };
  }

  // Reject obvious non-page paths (search, hashtags, events are borderline —
  // events are not messageable pages).
  if (["search", "hashtag", "events", "policies", "help", "legal"].includes(first)) {
    return null;
  }

  const vanity = segments[0];
  if (vanity.length < 2) return null;

  // All-digit vanity of 5+ chars is a numeric page id in disguise.
  if (/^\d{5,}$/.test(vanity)) {
    return { url: `https://www.facebook.com/profile.php?id=${vanity}`, key: `f:${vanity}` };
  }

  return {
    url: `https://www.facebook.com/${vanity}`,
    key: `f:${vanity.toLowerCase()}`,
  };
}

/** The m.me deep link — opens a Messenger thread with the page. */
export function buildMessengerUrl(pageUrl: string | null | undefined): string | null {
  const identity = normalizeFacebookPageUrl(pageUrl);
  if (!identity) return null;

  // Groups route to the group chat; numeric-id pages pass the id through;
  // vanity pages keep their original casing (Facebook resolves it either way,
  // but the canonical spelling looks right in the UI).
  if (identity.url.includes("/groups/")) {
    const groupId = identity.url.split("/groups/")[1] ?? "";
    return groupId ? `https://m.me/${groupId}` : null;
  }
  if (identity.url.includes("/profile.php?id=")) {
    const id = identity.url.split("/profile.php?id=")[1] ?? "";
    return id ? `https://m.me/${id}` : null;
  }
  const vanity = identity.url.replace("https://www.facebook.com/", "");
  return vanity ? `https://m.me/${vanity}` : null;
}

/**
 * The "stay in the browser" variant: m.facebook.com serves the mobile web
 * page and is far less aggressive about forcing the installed app than the
 * www host, which is the best available trick when the operator wants the
 * page inside the browser on their phone.
 */
export function buildBrowserFacebookUrl(pageUrl: string | null | undefined): string | null {
  const identity = normalizeFacebookPageUrl(pageUrl);
  if (!identity) return null;
  return identity.url.replace("://www.facebook.com", "://m.facebook.com");
}
