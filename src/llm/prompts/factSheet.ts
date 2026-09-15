import type { Wedding } from "../../domain/types.js";
import { formatDkk } from "../../domain/money.js";

/**
 * Faktaarket er agentens ENESTE kilde til oplysninger om brylluppet.
 * Prompterne instruerer eksplicit i, at alt uden for arket er ukendt.
 * Renderes deterministisk, så prompt-caching faktisk rammer.
 */
export function renderFactSheet(w: Wedding, answered: Array<{ question: string; answer: string }> = []): string {
  const lines: string[] = [];
  lines.push(`Par: ${w.couple_names}`);
  lines.push(
    `Dato: ${w.wedding_date ?? "ikke fastlagt"}${w.date_flexible ? " (fleksibel)" : " (fast)"}`,
  );
  lines.push(`Område: ${w.region}`);
  lines.push(
    w.guest_count_min === w.guest_count_max
      ? `Antal gæster: ${w.guest_count_max}`
      : `Antal gæster: ${w.guest_count_min}-${w.guest_count_max}`,
  );
  lines.push(
    w.budget_min || w.budget_max
      ? `Samlet budget: ${formatDkk(w.budget_min)} - ${formatDkk(w.budget_max)}`
      : "Samlet budget: ikke oplyst",
  );
  lines.push(w.style_tags.length ? `Stil: ${w.style_tags.join(", ")}` : "Stil: ikke oplyst");
  lines.push(w.must_haves.length ? `Skal-krav: ${w.must_haves.join("; ")}` : "Skal-krav: ingen oplyst");
  lines.push(w.notes ? `Øvrige noter fra parret: ${w.notes}` : "Øvrige noter fra parret: ingen");
  lines.push(`Kontaktmail: ${w.contact_email}`);
  lines.push(`Kontakttelefon: ${w.contact_phone ?? "ikke oplyst"}`);

  if (answered.length > 0) {
    lines.push("");
    lines.push("Efterfølgende svar fra parret:");
    for (const a of answered) lines.push(`- Spørgsmål: ${a.question}\n  Svar: ${a.answer}`);
  }
  return lines.join("\n");
}
