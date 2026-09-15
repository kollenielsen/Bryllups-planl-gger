/**
 * Beløbshåndtering for danske leverandørmails.
 *
 * Bruges to steder: til at normalisere det modellen skriver, og som
 * hallucinationsværn — et beløb der ikke optræder i kildeteksten må ikke
 * vises til parret som faktum.
 */

const MULTIPLIERS: Array<[RegExp, number]> = [
  [/\bmio\.?\b|\bmillion(?:er)?\b/i, 1_000_000],
  [/\bt\.?kr\.?\b|\btusind(?:e)?\b/i, 1_000],
];

/** "45.000,-", "kr. 45.000", "1,5 mio.", "45k" -> tal. */
export function parseDanishAmount(input: string): number | null {
  if (!input) return null;
  const s = input
    .replace(/ /g, " ")
    .replace(/(?:dkk|kr\.?|kroner)/gi, " ")
    .replace(/,-/g, " ")
    .trim();

  const numMatch = /(\d[\d.\s]*(?:,\d{1,2})?)/.exec(s);
  if (!numMatch || !numMatch[1]) return null;

  const rest = s.slice(numMatch.index + numMatch[1].length);
  let value = normalizeNumber(numMatch[1]);
  if (value === null) return null;

  if (/^\s*k\b/i.test(rest)) value *= 1_000;
  else {
    for (const [re, mult] of MULTIPLIERS) {
      if (re.test(rest.slice(0, 12))) {
        value *= mult;
        break;
      }
    }
  }
  return Math.round(value);
}

function normalizeNumber(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "");
  // Dansk: "." er tusindtalsseparator (altid grupper à 3), "," er decimal.
  const withoutThousands = cleaned.replace(/\.(?=\d{3}\b)/g, "");
  const normalized = withoutThousands.replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

const AMOUNT_TOKEN =
  /(?:kr\.?|dkk)\s*([\d][\d.\s]*(?:,\d{1,2})?)(?:\s*,-)?|([\d][\d.\s]*(?:,\d{1,2})?)\s*(?:,-|kr\.?|kroner|dkk|k\b|t\.?kr\.?|mio\.?)/gi;

/** Alle beløb der faktisk står i teksten. */
export function findAmounts(text: string): number[] {
  const out: number[] = [];
  const src = text.replace(/ /g, " ");
  for (const m of src.matchAll(AMOUNT_TOKEN)) {
    const numeric = m[1] ?? m[2];
    if (!numeric) continue;
    const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 12);
    const parsed = parseDanishAmount(`${numeric} ${suffixOf(m[0])} ${tail}`);
    if (parsed !== null && parsed > 0) out.push(parsed);
  }
  return dedupe(out);
}

function suffixOf(token: string): string {
  const m = /(k|t\.?kr\.?|mio\.?)\s*$/i.exec(token.trim());
  return m?.[1] ?? "";
}

function dedupe(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

/**
 * Er beløbet dækket af kildeteksten? Tolerance på 1 kr. for afrunding.
 * Bruges til at flage udtræk hvor modellen har fundet på et tal.
 */
export function amountAppearsInText(amount: number | null | undefined, text: string): boolean {
  if (amount === null || amount === undefined) return true;
  const found = findAmounts(text);
  if (found.some((f) => Math.abs(f - amount) <= 1)) return true;
  // Rå ciffersekvens uden enhed, fx "Prisen er 45000 for hele weekenden".
  const digits = String(Math.round(amount));
  const bare = new RegExp(`(?<![\\d.,])${digits}(?![\\d.,])`);
  return bare.test(text.replace(/[.\s]/g, (c) => (c === "." ? "" : c)));
}

export type PriceBasis = "total" | "per_guest" | "per_hour" | "per_day" | "from" | "unknown";

/**
 * Sammenligneligt totalbudget. Et lokale der koster 1.250 kr. pr. kuvert kan
 * ikke stilles op mod en fotograf til 22.000 kr. uden dette skridt.
 * Beregnes i kode, ikke af modellen — så tallet altid kan efterprøves.
 */
export function estimateTotal(
  price: number | null,
  basis: PriceBasis,
  ctx: { guests?: number | null; hours?: number | null },
): number | null {
  if (price === null) return null;
  switch (basis) {
    case "total":
    case "from":
      return price;
    case "per_guest":
      return ctx.guests ? Math.round(price * ctx.guests) : null;
    case "per_hour":
      return ctx.hours ? Math.round(price * ctx.hours) : null;
    case "per_day":
      return price;
    default:
      return null;
  }
}

export function formatDkk(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "–";
  return `${amount.toLocaleString("da-DK")} kr.`;
}
