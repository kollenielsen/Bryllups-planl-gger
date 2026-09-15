import { exec, many, newId, one } from "./repo.js";
import { estimateTotal } from "../domain/money.js";
import type { GroundingResult } from "../domain/confidence.js";
import type { Quote, Wedding } from "../domain/types.js";
import type { VendorReplyExtraction } from "../domain/schema.js";

export async function saveQuote(input: {
  wedding: Wedding;
  vendorId: string;
  threadId: string;
  messageId: string;
  extraction: VendorReplyExtraction;
  grounding: GroundingResult;
}): Promise<Quote> {
  const { extraction: x, wedding, grounding } = input;

  // Totalen beregnes her, ikke af modellen, så tallet altid kan efterprøves.
  // Pr.-kuvert-priser regnes op på det højeste gæstetal — det konservative valg.
  const ctx = { guests: wedding.guest_count_max, hours: null };
  const estMin = estimateTotal(x.price_min, x.price_basis, ctx);
  const estMax = estimateTotal(x.price_max, x.price_basis, ctx);

  await exec(`UPDATE quotes SET is_current = FALSE WHERE vendor_id = $1`, [input.vendorId]);

  const id = newId("quo");
  await exec(
    `INSERT INTO quotes (id, wedding_id, vendor_id, thread_id, message_id, price_min, price_max,
       currency, price_basis, price_includes_vat, estimated_total_min, estimated_total_max,
       availability, availability_confirmed, capacity_max, conditions_text, deposit_text,
       valid_until, confidence_score, needs_human_review, review_reasons, raw_extraction, is_current)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,TRUE)`,
    [
      id,
      wedding.id,
      input.vendorId,
      input.threadId,
      input.messageId,
      x.price_min,
      x.price_max,
      (x.currency ?? "DKK").toUpperCase(),
      x.price_basis,
      x.price_includes_vat,
      estMin,
      estMax,
      x.availability,
      // Ledighed regnes kun som bekræftet hvis udtrækket er funderet.
      x.availability === "available" && !grounding.needsHumanReview,
      x.capacity_max,
      x.conditions_text,
      x.deposit_text,
      isoDateOrNull(x.valid_until),
      grounding.confidence,
      grounding.needsHumanReview,
      grounding.reasons.map((r) => `${r.severity}:${r.code}: ${r.detail}`),
      JSON.stringify(x),
    ],
  );

  const created = await one<Quote>(`SELECT * FROM quotes WHERE id = $1`, [id]);
  if (!created) throw new Error("Tilbud kunne ikke gemmes.");
  return created;
}

export async function currentQuotes(weddingId: string): Promise<Quote[]> {
  return many<Quote>(
    `SELECT * FROM quotes WHERE wedding_id = $1 AND is_current = TRUE ORDER BY created_at DESC`,
    [weddingId],
  );
}

export async function quotesNeedingReview(weddingId: string): Promise<Quote[]> {
  return many<Quote>(
    `SELECT * FROM quotes WHERE wedding_id = $1 AND is_current = TRUE
       AND needs_human_review = TRUE AND human_reviewed_at IS NULL
     ORDER BY created_at`,
    [weddingId],
  );
}

/** Menneskets læsning gør udtrækket gyldigt — den kan ikke sættes af agenten. */
export async function markQuoteReviewed(
  quoteId: string,
  overrides: Partial<Pick<Quote, "price_min" | "price_max" | "price_basis" | "availability" | "conditions_text">> = {},
): Promise<void> {
  const sets: string[] = ["needs_human_review = FALSE", "human_reviewed_at = now()"];
  const params: unknown[] = [quoteId];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  await exec(`UPDATE quotes SET ${sets.join(", ")} WHERE id = $1`, params);
}

function isoDateOrNull(v: string | null): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}
