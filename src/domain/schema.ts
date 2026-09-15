import { z } from "zod";

export const PRICE_BASIS = ["total", "per_guest", "per_hour", "per_day", "from", "unknown"] as const;
export const AVAILABILITY = ["available", "unavailable", "tentative", "unknown"] as const;
export const REPLY_INTENT = [
  "quote",
  "question",
  "unavailable",
  "referral",
  "not_interested",
  "acknowledgement",
  "other",
] as const;

/**
 * Skema for udtræk af ét indgående leverandørsvar.
 *
 * `price_quote` og `availability_quote` er ordrette uddrag fra mailen. De er
 * ikke pynt: efter modelkaldet tjekkes det i kode, at uddraget faktisk står i
 * teksten. Gør det ikke det, er udtrækket ikke funderet, og svaret ryger til
 * manuel læsning i stedet for at blive vist som en pris.
 */
export const VendorReplyExtractionSchema = z.object({
  reply_intent: z.enum(REPLY_INTENT),
  price_min: z.number().nullable(),
  price_max: z.number().nullable(),
  currency: z.string().nullable(),
  price_basis: z.enum(PRICE_BASIS),
  price_includes_vat: z.boolean().nullable(),
  price_quote: z.string().nullable(),
  availability: z.enum(AVAILABILITY),
  availability_quote: z.string().nullable(),
  capacity_max: z.number().nullable(),
  conditions_text: z.string().nullable(),
  deposit_text: z.string().nullable(),
  valid_until: z.string().nullable(),
  vendor_questions: z.array(z.string()),
  confidence: z.number(),
  uncertainty_notes: z.string().nullable(),
  summary_da: z.string(),
});

export type VendorReplyExtraction = z.infer<typeof VendorReplyExtractionSchema>;

/**
 * Skema for agentens svar tilbage til leverandøren.
 *
 * `unanswerable_questions` er den vigtigste feltet: spørgsmål agenten ikke kan
 * besvare ud fra intake-data skal ende her og gå videre til parret — ikke
 * blive besvaret på må og få.
 */
export const FollowUpDraftSchema = z.object({
  should_reply: z.boolean(),
  body_da: z.string(),
  answered_questions: z.array(z.string()),
  unanswerable_questions: z.array(z.string()),
  needs_human: z.boolean(),
  needs_human_reason: z.string().nullable(),
});

export type FollowUpDraft = z.infer<typeof FollowUpDraftSchema>;

export const OutreachDraftSchema = z.object({
  subject: z.string(),
  body_da: z.string(),
});

export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;
