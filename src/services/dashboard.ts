import { many } from "./repo.js";
import { getWedding, listOpenQuestions } from "./weddings.js";
import { formatDkk } from "../domain/money.js";
import type { Quote, Thread, Vendor, Wedding } from "../domain/types.js";

export interface VendorCard {
  vendor: Vendor;
  thread: Thread | null;
  quote: Quote | null;
  message_count: number;
  last_activity: string | null;
  /** Kort dansk linje til kortet, fx "1.250 kr. pr. kuvert (ca. 100.000 kr. i alt)". */
  price_label: string;
  comparable_total: number | null;
}

export interface Dashboard {
  wedding: Wedding;
  categories: Record<string, VendorCard[]>;
  needs_review: VendorCard[];
  open_questions: Array<{ id: string; question: string; vendor_id: string | null }>;
  counts: Record<string, number>;
}

export async function getDashboard(weddingId: string): Promise<Dashboard> {
  const wedding = await getWedding(weddingId);
  if (!wedding) throw new Error("Bryllup findes ikke.");

  const rows = await many<Record<string, unknown>>(
    `SELECT
       v.*,
       t.id AS t_id, t.reply_token AS t_reply_token, t.subject AS t_subject,
       t.state AS t_state, t.turn_count AS t_turn_count,
       t.last_inbound_at AS t_last_inbound_at, t.last_outbound_at AS t_last_outbound_at,
       q.id AS q_id, q.price_min, q.price_max, q.currency, q.price_basis,
       q.price_includes_vat, q.estimated_total_min, q.estimated_total_max,
       q.availability, q.availability_confirmed, q.capacity_max, q.conditions_text,
       q.deposit_text, q.valid_until, q.confidence_score, q.needs_human_review,
       q.review_reasons, q.human_reviewed_at, q.created_at AS q_created_at,
       (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
     FROM vendors v
     LEFT JOIN threads t ON t.vendor_id = v.id
     LEFT JOIN quotes q ON q.vendor_id = v.id AND q.is_current = TRUE
     WHERE v.wedding_id = $1
     ORDER BY v.category, v.name`,
    [weddingId],
  );

  const categories: Record<string, VendorCard[]> = {};
  const needsReview: VendorCard[] = [];
  const counts: Record<string, number> = {};

  for (const row of rows) {
    const card = toCard(row, wedding);
    (categories[card.vendor.category] ??= []).push(card);
    counts[card.vendor.status] = (counts[card.vendor.status] ?? 0) + 1;
    if (card.quote?.needs_human_review && !card.quote.human_reviewed_at) needsReview.push(card);
  }

  for (const list of Object.values(categories)) {
    // Sortering: billigst sammenlignelige først, leverandører uden pris sidst.
    list.sort((a, b) => {
      const av = a.comparable_total ?? Number.POSITIVE_INFINITY;
      const bv = b.comparable_total ?? Number.POSITIVE_INFINITY;
      return av - bv || a.vendor.name.localeCompare(b.vendor.name, "da");
    });
  }

  const questions = await listOpenQuestions(weddingId, "open");

  return {
    wedding,
    categories,
    needs_review: needsReview,
    open_questions: questions.map((q) => ({
      id: q.id,
      question: q.question,
      vendor_id: q.vendor_id,
    })),
    counts,
  };
}

function toCard(row: Record<string, unknown>, wedding: Wedding): VendorCard {
  const vendor = {
    id: row["id"],
    wedding_id: row["wedding_id"],
    name: row["name"],
    category: row["category"],
    contact_email: row["contact_email"],
    website: row["website"],
    phone: row["phone"],
    address: row["address"],
    city: row["city"],
    source: row["source"],
    source_ref: row["source_ref"],
    rating: row["rating"],
    status: row["status"],
    excluded: row["excluded"],
    exclude_reason: row["exclude_reason"],
  } as unknown as Vendor;

  const thread = row["t_id"]
    ? ({
        id: row["t_id"],
        wedding_id: vendor.wedding_id,
        vendor_id: vendor.id,
        reply_token: row["t_reply_token"],
        subject: row["t_subject"],
        state: row["t_state"],
        turn_count: row["t_turn_count"],
        last_inbound_at: stamp(row["t_last_inbound_at"]),
        last_outbound_at: stamp(row["t_last_outbound_at"]),
      } as unknown as Thread)
    : null;

  const quote = row["q_id"]
    ? ({
        id: row["q_id"],
        wedding_id: vendor.wedding_id,
        vendor_id: vendor.id,
        thread_id: thread?.id ?? "",
        message_id: null,
        price_min: numOrNull(row["price_min"]),
        price_max: numOrNull(row["price_max"]),
        currency: row["currency"],
        price_basis: row["price_basis"],
        price_includes_vat: row["price_includes_vat"],
        estimated_total_min: numOrNull(row["estimated_total_min"]),
        estimated_total_max: numOrNull(row["estimated_total_max"]),
        availability: row["availability"],
        availability_confirmed: row["availability_confirmed"],
        capacity_max: numOrNull(row["capacity_max"]),
        conditions_text: row["conditions_text"],
        deposit_text: row["deposit_text"],
        valid_until: row["valid_until"] ? String(row["valid_until"]).slice(0, 10) : null,
        confidence_score: Number(row["confidence_score"] ?? 0),
        needs_human_review: Boolean(row["needs_human_review"]),
        review_reasons: (row["review_reasons"] as string[]) ?? [],
        human_reviewed_at: stamp(row["human_reviewed_at"]),
        raw_extraction: {},
        is_current: true,
        created_at: stamp(row["q_created_at"]) ?? "",
      } as unknown as Quote)
    : null;

  return {
    vendor,
    thread,
    quote,
    message_count: Number(row["message_count"] ?? 0),
    last_activity: latest(stamp(row["t_last_inbound_at"]), stamp(row["t_last_outbound_at"])),
    price_label: priceLabel(quote, wedding),
    comparable_total: quote?.estimated_total_max ?? quote?.estimated_total_min ?? null,
  };
}

export function priceLabel(quote: Quote | null, wedding: Wedding): string {
  if (!quote || (quote.price_min === null && quote.price_max === null)) return "Ingen pris endnu";
  const range =
    quote.price_min !== null && quote.price_max !== null && quote.price_min !== quote.price_max
      ? `${formatDkk(quote.price_min)} – ${formatDkk(quote.price_max)}`
      : formatDkk(quote.price_max ?? quote.price_min);

  const basis: Record<string, string> = {
    total: "samlet",
    per_guest: "pr. kuvert",
    per_hour: "pr. time",
    per_day: "pr. dag",
    from: "startpris",
    unknown: "grundlag uoplyst",
  };
  const suffix = basis[quote.price_basis] ?? "";
  const estimate =
    quote.price_basis === "per_guest" && quote.estimated_total_max
      ? ` (ca. ${formatDkk(quote.estimated_total_max)} ved ${wedding.guest_count_max} gæster)`
      : "";
  const vat =
    quote.price_includes_vat === null
      ? " · moms uoplyst"
      : quote.price_includes_vat
        ? " · inkl. moms"
        : " · ekskl. moms";
  return `${range} ${suffix}${estimate}${vat}`;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stamp(v: unknown): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
