import { amountAppearsInText } from "./money.js";
import type { VendorReplyExtraction } from "./schema.js";

export type Severity = "block" | "warn";

export interface ReviewReason {
  code: string;
  severity: Severity;
  detail: string;
}

export interface GroundingResult {
  /** Modellens egen score, justeret ned for hvert fund. */
  confidence: number;
  needsHumanReview: boolean;
  reasons: ReviewReason[];
}

const PENALTY: Record<Severity, number> = { block: 0.35, warn: 0.1 };

/** Nedre/øvre plausibilitetsgrænse i DKK for de to MVP-kategorier. */
const PLAUSIBLE = { min: 300, max: 2_000_000 };

/**
 * Efterprøver et modeludtræk mod kildeteksten.
 *
 * Princippet: modellen må gerne læse mailen, men den må ikke være eneste
 * kilde til et tal parret træffer beslutning på. Alt der ikke kan verificeres
 * i teksten, flages — det bliver ikke gættet.
 */
export function groundExtraction(input: {
  extraction: VendorReplyExtraction;
  sourceText: string;
  threshold: number;
}): GroundingResult {
  const { extraction: x, sourceText, threshold } = input;
  const reasons: ReviewReason[] = [];
  const add = (code: string, severity: Severity, detail: string) =>
    reasons.push({ code, severity, detail });

  const hasPrice = x.price_min !== null || x.price_max !== null;

  if (hasPrice) {
    if (!x.price_quote || !quoteIsGrounded(x.price_quote, sourceText)) {
      add("price_quote_not_found", "block", "Prisuddraget står ikke i leverandørens mail.");
    }
    if (!amountAppearsInText(x.price_min, sourceText)) {
      add("price_min_not_in_text", "block", `Beløbet ${x.price_min} findes ikke i mailen.`);
    }
    if (x.price_max !== x.price_min && !amountAppearsInText(x.price_max, sourceText)) {
      add("price_max_not_in_text", "block", `Beløbet ${x.price_max} findes ikke i mailen.`);
    }
    if (x.price_min !== null && x.price_max !== null && x.price_min > x.price_max) {
      add("price_range_inverted", "block", "Minimumsprisen er højere end maksimumsprisen.");
    }
    for (const p of new Set([x.price_min, x.price_max])) {
      if (p !== null && (p < PLAUSIBLE.min || p > PLAUSIBLE.max)) {
        add("price_implausible", "block", `Beløbet ${p} DKK ligger uden for et realistisk spænd.`);
      }
    }
    if (x.price_basis === "unknown") {
      add("price_basis_unknown", "warn", "Uklart om prisen er total eller pr. kuvert/time.");
    }
    if (x.price_includes_vat === null) {
      add("vat_unknown", "warn", "Uklart om prisen er inkl. eller ekskl. moms.");
    }
    if (x.currency && x.currency.toUpperCase() !== "DKK") {
      add("non_dkk_currency", "warn", `Valuta angivet som ${x.currency}.`);
    }
  }

  if (x.availability !== "unknown") {
    if (!x.availability_quote || !quoteIsGrounded(x.availability_quote, sourceText)) {
      add(
        "availability_quote_not_found",
        "block",
        "Udsagnet om ledighed kan ikke genfindes i mailen.",
      );
    }
  }

  if (x.reply_intent === "quote" && !hasPrice) {
    add("quote_without_price", "warn", "Svaret er læst som tilbud, men uden pris.");
  }
  if (x.reply_intent === "unavailable" && x.availability === "available") {
    add("intent_availability_conflict", "block", "Modellen modsiger sig selv om ledighed.");
  }
  if (x.uncertainty_notes && x.uncertainty_notes.trim().length > 0) {
    add("model_flagged_uncertainty", "warn", x.uncertainty_notes.trim());
  }
  if (x.confidence < threshold) {
    add("model_low_confidence", "warn", `Modellens egen score var ${x.confidence.toFixed(2)}.`);
  }

  let confidence = clamp01(x.confidence);
  for (const r of reasons) confidence -= PENALTY[r.severity];
  confidence = clamp01(confidence);

  const needsHumanReview = reasons.some((r) => r.severity === "block") || confidence < threshold;

  return { confidence, needsHumanReview, reasons };
}

/** Ordret uddrag skal kunne genfindes; 80 % ordoverlap accepteres som match. */
export function quoteIsGrounded(quote: string, source: string): boolean {
  const q = normalize(quote);
  const s = normalize(source);
  if (q.length === 0) return false;
  if (s.includes(q)) return true;

  const tokens = q.split(" ").filter((t) => t.length >= 3);
  if (tokens.length === 0) return s.includes(q);
  const hits = tokens.filter((t) => s.includes(t)).length;
  return hits / tokens.length >= 0.8;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ /g, " ")
    .replace(/[“”„"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
