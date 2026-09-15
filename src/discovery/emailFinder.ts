/**
 * Google Places giver hjemmeside, ikke mail. Her hentes forsiden og et par
 * oplagte kontaktsider, og den mest sandsynlige kontaktadresse vælges.
 * Bevidst konservativ: finder vi intet, får leverandøren status "no_contact"
 * og havner i listen over emner til manuel håndtering.
 */

const CONTACT_PATHS = ["", "/kontakt", "/kontakt-os", "/contact", "/om-os", "/booking", "/priser"];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const BAD_LOCAL_PARTS = [
  "noreply",
  "no-reply",
  "donotreply",
  "webmaster",
  "postmaster",
  "abuse",
  "privacy",
  "gdpr",
  "support@wix",
  "example",
];

const BAD_DOMAINS = ["sentry.io", "wixpress.com", "squarespace.com", "godaddy.com", "example.com"];

const PREFERRED_LOCAL_PARTS = ["booking", "kontakt", "info", "hej", "mail", "selskab", "fest"];

export interface EmailFinderOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxPages?: number;
}

export async function findContactEmail(
  website: string,
  opts: EmailFinderOptions = {},
): Promise<string | null> {
  const candidates = await collectEmails(website, opts);
  return pickBest(candidates, website);
}

export async function collectEmails(
  website: string,
  opts: EmailFinderOptions = {},
): Promise<string[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxPages = opts.maxPages ?? 3;

  let base: URL;
  try {
    base = new URL(website);
  } catch {
    return [];
  }

  const found = new Set<string>();
  let pages = 0;
  for (const path of CONTACT_PATHS) {
    if (pages >= maxPages) break;
    const url = new URL(path || base.pathname, base).toString();
    pages += 1;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "bryllupsplanlaegger-mvp/0.1 (+kontakt via hjemmeside)" },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const html = await res.text();
      for (const email of extractEmails(html)) found.add(email);
      if (found.size > 0 && path !== "") break;
    } catch {
      continue;
    }
  }
  return [...found];
}

export function extractEmails(html: string): string[] {
  const out = new Set<string>();
  // mailto-links er den mest pålidelige kilde; obfuskeret tekst fanges bagefter.
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    if (m[1]) out.add(decodeURIComponent(m[1]).toLowerCase());
  }
  const deobfuscated = html
    .replace(/\s*\(at\)\s*|\s*\[at\]\s*|\s+at\s+/gi, "@")
    .replace(/\s*\(dot\)\s*|\s*\[dot\]\s*/gi, ".");
  for (const m of deobfuscated.matchAll(EMAIL_RE)) {
    out.add(m[0].toLowerCase());
  }
  return [...out].filter(isPlausible);
}

function isPlausible(email: string): boolean {
  if (email.length > 100) return false;
  if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(email)) return false;
  const [local, domain] = email.split("@");
  if (!local || !domain) return false;
  if (BAD_LOCAL_PARTS.some((b) => local.startsWith(b))) return false;
  if (BAD_DOMAINS.some((b) => domain.endsWith(b))) return false;
  return true;
}

function pickBest(candidates: string[], website: string): string | null {
  if (candidates.length === 0) return null;
  let siteDomain = "";
  try {
    siteDomain = new URL(website).hostname.replace(/^www\./, "");
  } catch {
    /* ignoreres */
  }

  const scored = candidates.map((email) => {
    const [local = "", domain = ""] = email.split("@");
    let score = 0;
    if (siteDomain && domain.endsWith(siteDomain)) score += 10;
    const rank = PREFERRED_LOCAL_PARTS.indexOf(local);
    if (rank >= 0) score += 5 - rank * 0.1;
    if (/^(gmail|hotmail|outlook|live|yahoo)\./.test(domain)) score -= 2;
    return { email, score };
  });
  scored.sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));
  return scored[0]?.email ?? null;
}
