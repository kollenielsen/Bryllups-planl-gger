/**
 * Deterministisk forbehandling af indgående mails.
 *
 * Alt her køres FØR modellen. Formålet er dobbelt: skære citeret historik
 * væk så modellen ikke udtrækker et gammelt tilbud igen, og fange de
 * svartyper (autosvar, bounce, framelding) hvor et LLM-kald er spild og
 * direkte farligt at fejltolke.
 */

export interface SplitEmail {
  /** Selve det nye svar. */
  reply: string;
  /** Signaturblok, hvis den kunne skilles ud (indeholder ofte telefon/CVR). */
  signature: string | null;
  /** Citeret historik, afkortet. */
  quoted: string | null;
}

const QUOTE_HEADERS: RegExp[] = [
  // Gmail dansk: "Den 12. maj 2026 kl. 14.32 skrev Anne <anne@x.dk>:"
  /^\s*Den .{3,80}skrev .{1,120}:\s*$/im,
  // Gmail engelsk
  /^\s*On .{3,120}wrote:\s*$/im,
  // Outlook dansk/engelsk headerblok
  /^\s*Fra:\s.+$/im,
  /^\s*From:\s.+$/im,
  /^\s*-{2,}\s*Oprindelig meddelelse\s*-{2,}\s*$/im,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
  // Outlook web divider
  /^_{10,}\s*$/m,
  // Videresendt
  /^\s*-{2,}\s*Videresendt meddelelse\s*-{2,}\s*$/im,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
];

const SIGNATURE_MARKERS: RegExp[] = [
  /^--\s*$/m,
  /^\s*(?:Med\s+)?(?:venlig|bedste|k(?:æ|ae)rlig)\s+hils(?:en|ner)[.,!]?\s*$/im,
  /^\s*(?:mvh|m\.?v\.?h\.?|vh|de bedste hilsner)[.,!:]?\s*$/im,
  /^\s*(?:Best|Kind)\s+regards[.,!]?\s*$/im,
];

const AUTO_REPLY_PATTERNS: RegExp[] = [
  /automatisk\s+svar/i,
  /autosvar/i,
  /auto[-\s]?reply/i,
  /out\s+of\s+office/i,
  /ikke\s+på\s+kontoret/i,
  /(?:jeg|vi)\s+(?:er|holder)\s+(?:på\s+)?ferie/i,
  /afholder\s+ferie/i,
  /vender\s+tilbage\s+(?:efter|den)\b/i,
  /vi\s+har\s+modtaget\s+din\s+(?:henvendelse|mail)/i,
];

const BOUNCE_PATTERNS: RegExp[] = [
  /mail\s+delivery\s+(?:subsystem|failed)/i,
  /undelivered\s+mail\s+returned/i,
  /delivery\s+status\s+notification\s*\(failure\)/i,
  /address\s+not\s+found/i,
  /recipient\s+address\s+rejected/i,
  /\b5\.[01]\.[0-9]\b/,
  /user\s+unknown/i,
];

const OPT_OUT_PATTERNS: RegExp[] = [
  /frabede?r?\s+(?:mig|os)\b/i,
  /(?:fjern|slet)\s+(?:mig|os)\b/i,
  /afmeld/i,
  /ikke\s+kontakte[s]?\s+(?:mig|os)/i,
  /unsubscribe/i,
  /ingen\s+henvendelser/i,
];

/** Fjerner citeret historik og skiller signaturen fra. */
export function splitEmail(raw: string, maxQuotedChars = 2000): SplitEmail {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/ /g, " ");

  let cut = normalized.length;
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(normalized);
    if (m && m.index < cut) cut = m.index;
  }

  // Sammenhængende blok af ">"-citerede linjer tæller også som historik.
  const quotedBlock = /^(?:>.*\n?){2,}/m.exec(normalized.slice(0, cut));
  if (quotedBlock && quotedBlock.index < cut) cut = quotedBlock.index;

  let body = normalized.slice(0, cut).trim();
  const quotedRaw = normalized.slice(cut).trim();

  let signature: string | null = null;
  for (const re of SIGNATURE_MARKERS) {
    const m = re.exec(body);
    // Kun hvis der faktisk er brødtekst før signaturen — ellers er hele
    // mailen bare "Mvh Anne" og skal ikke tømmes.
    if (m && m.index > 20) {
      signature = body.slice(m.index).trim();
      body = body.slice(0, m.index).trim();
      break;
    }
  }

  return {
    reply: collapseBlankLines(body),
    signature: signature ? collapseBlankLines(signature) : null,
    quoted: quotedRaw ? collapseBlankLines(quotedRaw).slice(0, maxQuotedChars) : null,
  };
}

function collapseBlankLines(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

export type ReplyClass = "normal" | "auto_reply" | "bounce" | "opt_out";

/**
 * Klassificering der ikke kræver et modelkald. Rækkefølgen er bevidst:
 * bounce før autosvar (en bounce nævner ofte "automatisk"), og framelding
 * vinder over alt andet, fordi konsekvensen er at vi aldrig skriver igen.
 */
export function classifyReply(input: {
  subject?: string | null;
  body: string;
  headers?: Record<string, string | undefined>;
  fromEmail?: string | null;
}): ReplyClass {
  const hay = `${input.subject ?? ""}\n${input.body}`;
  const headers = lowercaseKeys(input.headers ?? {});

  if (
    headers["x-failed-recipients"] ||
    /mailer-daemon|postmaster/i.test(input.fromEmail ?? "") ||
    BOUNCE_PATTERNS.some((re) => re.test(hay))
  ) {
    return "bounce";
  }

  if (OPT_OUT_PATTERNS.some((re) => re.test(hay))) return "opt_out";

  const autoSubmitted = headers["auto-submitted"];
  if (
    (autoSubmitted && autoSubmitted.toLowerCase() !== "no") ||
    headers["x-autoreply"] ||
    headers["x-autorespond"] ||
    AUTO_REPLY_PATTERNS.some((re) => re.test(hay))
  ) {
    return "auto_reply";
  }

  return "normal";
}

function lowercaseKeys(h: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}
