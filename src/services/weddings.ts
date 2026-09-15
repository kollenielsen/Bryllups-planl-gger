import { exec, many, newId, one, toIsoDate } from "./repo.js";
import type { OpenQuestion, Wedding } from "../domain/types.js";

export interface WeddingInput {
  couple_names: string;
  contact_email: string;
  contact_phone?: string | null;
  wedding_date?: string | null;
  date_flexible?: boolean;
  region: string;
  guest_count_min: number;
  guest_count_max: number;
  budget_min?: number | null;
  budget_max?: number | null;
  style_tags?: string[];
  must_haves?: string[];
  notes?: string | null;
}

export function validateWeddingInput(input: Partial<WeddingInput>): string[] {
  const errors: string[] = [];
  if (!input.couple_names?.trim()) errors.push("couple_names mangler.");
  if (!input.contact_email?.includes("@")) errors.push("contact_email er ikke en mailadresse.");
  if (!input.region?.trim()) errors.push("region mangler.");
  const min = Number(input.guest_count_min);
  const max = Number(input.guest_count_max);
  if (!Number.isFinite(min) || min < 1) errors.push("guest_count_min skal være mindst 1.");
  if (!Number.isFinite(max) || max < 1) errors.push("guest_count_max skal være mindst 1.");
  if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
    errors.push("guest_count_min må ikke overstige guest_count_max.");
  }
  if (input.wedding_date && !/^\d{4}-\d{2}-\d{2}$/.test(input.wedding_date)) {
    errors.push("wedding_date skal være YYYY-MM-DD.");
  }
  if (
    input.budget_min != null &&
    input.budget_max != null &&
    Number(input.budget_min) > Number(input.budget_max)
  ) {
    errors.push("budget_min må ikke overstige budget_max.");
  }
  return errors;
}

export async function createWedding(input: WeddingInput): Promise<Wedding> {
  const id = newId("wed");
  await exec(
    `INSERT INTO weddings (id, couple_names, contact_email, contact_phone, wedding_date,
       date_flexible, region, guest_count_min, guest_count_max, budget_min, budget_max,
       style_tags, must_haves, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      input.couple_names.trim(),
      input.contact_email.trim().toLowerCase(),
      input.contact_phone ?? null,
      input.wedding_date ?? null,
      input.date_flexible ?? false,
      input.region.trim(),
      input.guest_count_min,
      input.guest_count_max,
      input.budget_min ?? null,
      input.budget_max ?? null,
      input.style_tags ?? [],
      input.must_haves ?? [],
      input.notes ?? null,
    ],
  );
  const w = await getWedding(id);
  if (!w) throw new Error("Bryllup kunne ikke oprettes.");
  return w;
}

export async function getWedding(id: string): Promise<Wedding | null> {
  const row = await one<Record<string, unknown>>(`SELECT * FROM weddings WHERE id = $1`, [id]);
  return row ? mapWedding(row) : null;
}

export async function listWeddings(): Promise<Wedding[]> {
  const rows = await many<Record<string, unknown>>(
    `SELECT * FROM weddings ORDER BY created_at DESC`,
  );
  return rows.map(mapWedding);
}

export function mapWedding(row: Record<string, unknown>): Wedding {
  return {
    ...(row as unknown as Wedding),
    wedding_date: toIsoDate(row["wedding_date"]),
    style_tags: (row["style_tags"] as string[]) ?? [],
    must_haves: (row["must_haves"] as string[]) ?? [],
  };
}

export async function listOpenQuestions(
  weddingId: string,
  status?: "open" | "answered" | "dismissed",
): Promise<OpenQuestion[]> {
  return many<OpenQuestion>(
    status
      ? `SELECT * FROM open_questions WHERE wedding_id = $1 AND status = $2 ORDER BY created_at`
      : `SELECT * FROM open_questions WHERE wedding_id = $1 ORDER BY created_at`,
    status ? [weddingId, status] : [weddingId],
  );
}

/** Besvarede spørgsmål udvider faktaarket — det er den eneste måde ny viden kommer ind. */
export async function answeredQuestions(
  weddingId: string,
): Promise<Array<{ question: string; answer: string }>> {
  const rows = await many<{ question: string; answer: string }>(
    `SELECT question, answer FROM open_questions
     WHERE wedding_id = $1 AND status = 'answered' AND answer IS NOT NULL
     ORDER BY answered_at`,
    [weddingId],
  );
  return rows;
}

export async function answerQuestion(id: string, answer: string): Promise<void> {
  await exec(
    `UPDATE open_questions SET answer = $2, status = 'answered', answered_at = now() WHERE id = $1`,
    [id, answer],
  );
}

export async function addOpenQuestion(input: {
  weddingId: string;
  vendorId?: string | null;
  threadId?: string | null;
  question: string;
}): Promise<string | null> {
  const text = input.question.trim();
  if (!text) return null;
  // Samme spørgsmål stilles ofte af flere leverandører; spørg kun parret én gang.
  const existing = await one<{ id: string }>(
    `SELECT id FROM open_questions
     WHERE wedding_id = $1 AND lower(question) = lower($2) AND status <> 'dismissed'`,
    [input.weddingId, text],
  );
  if (existing) return existing.id;

  const id = newId("q");
  await exec(
    `INSERT INTO open_questions (id, wedding_id, vendor_id, thread_id, question)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, input.weddingId, input.vendorId ?? null, input.threadId ?? null, text],
  );
  return id;
}
