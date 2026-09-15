import { Router } from "express";
import type { Request, Response } from "express";
import { config } from "../../config.js";
import { VENDOR_CATEGORIES, type VendorCategory } from "../../domain/types.js";
import {
  answerQuestion,
  createWedding,
  getWedding,
  listOpenQuestions,
  listWeddings,
  validateWeddingInput,
} from "../../services/weddings.js";
import { discoverVendors } from "../../discovery/index.js";
import { excludeVendor, listVendors, setVendorStatus, upsertVendor } from "../../services/vendors.js";
import { startOutreach } from "../../services/outreach.js";
import { getDashboard } from "../../services/dashboard.js";
import { buildBookingSummary } from "../../services/booking.js";
import { markQuoteReviewed, quotesNeedingReview } from "../../services/quotes.js";
import {
  approveAllForWedding,
  approveOutboxItem,
  cancelOutboxItem,
  listOutbox,
  processOutbox,
} from "../../services/outbox.js";
import { getThread, listMessages } from "../../services/threads.js";
import { handleInbound, requestFollowUp } from "../../services/conversation.js";
import { many } from "../../services/repo.js";
import { replyToAddress } from "../../email/threading.js";

export const api: Router = Router();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response): void => {
    fn(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[api] ${req.method} ${req.path}:`, message);
      if (!res.headersSent) res.status(500).json({ error: message });
    });
  };

function category(value: unknown): VendorCategory {
  const v = String(value ?? "");
  if ((VENDOR_CATEGORIES as string[]).includes(v)) return v as VendorCategory;
  throw new Error(`Ukendt kategori '${v}'. Gyldige: ${VENDOR_CATEGORIES.join(", ")}.`);
}

api.get("/config", (_req, res) => {
  res.json({
    dry_run: config.sending.dryRun,
    require_approval: config.sending.requireApproval,
    email_provider: config.email.provider,
    discovery_provider: config.discovery.provider,
    max_vendors_per_category: config.sending.maxVendorsPerCategory,
    confidence_threshold: config.agent.confidenceThreshold,
    model: config.anthropic.model,
    has_api_key: Boolean(config.anthropic.apiKey),
  });
});

api.get("/weddings", wrap(async (_req, res) => {
  res.json(await listWeddings());
}));

api.post("/weddings", wrap(async (req, res) => {
  const errors = validateWeddingInput(req.body ?? {});
  if (errors.length > 0) {
    res.status(400).json({ errors });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const wedding = await createWedding({
    couple_names: String(body["couple_names"]),
    contact_email: String(body["contact_email"]),
    contact_phone: body["contact_phone"] ? String(body["contact_phone"]) : null,
    wedding_date: body["wedding_date"] ? String(body["wedding_date"]) : null,
    date_flexible: Boolean(body["date_flexible"]),
    region: String(body["region"]),
    guest_count_min: Number(body["guest_count_min"]),
    guest_count_max: Number(body["guest_count_max"]),
    budget_min: body["budget_min"] != null ? Number(body["budget_min"]) : null,
    budget_max: body["budget_max"] != null ? Number(body["budget_max"]) : null,
    style_tags: toList(body["style_tags"]),
    must_haves: toList(body["must_haves"]),
    notes: body["notes"] ? String(body["notes"]) : null,
  });
  res.status(201).json(wedding);
}));

api.get("/weddings/:id", wrap(async (req, res) => {
  const wedding = await getWedding(String(req.params["id"]));
  if (!wedding) {
    res.status(404).json({ error: "Bryllup findes ikke." });
    return;
  }
  res.json(wedding);
}));

api.get("/weddings/:id/dashboard", wrap(async (req, res) => {
  res.json(await getDashboard(String(req.params["id"])));
}));

api.get("/weddings/:id/vendors", wrap(async (req, res) => {
  res.json(await listVendors(String(req.params["id"])));
}));

api.post("/weddings/:id/discover", wrap(async (req, res) => {
  const weddingId = String(req.params["id"]);
  const wedding = await getWedding(weddingId);
  if (!wedding) {
    res.status(404).json({ error: "Bryllup findes ikke." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const cats = body["category"] ? [category(body["category"])] : VENDOR_CATEGORIES;
  const out: Record<string, number> = {};
  for (const cat of cats) {
    const found = await discoverVendors({
      weddingId,
      category: cat,
      region: wedding.region,
      limit: body["limit"] != null ? Number(body["limit"]) : undefined,
    });
    out[cat] = found.length;
  }
  res.json({ discovered: out });
}));

api.post("/weddings/:id/vendors", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const vendor = await upsertVendor({
    wedding_id: String(req.params["id"]),
    name: String(body["name"] ?? "").trim(),
    category: category(body["category"]),
    contact_email: body["contact_email"] ? String(body["contact_email"]) : null,
    website: body["website"] ? String(body["website"]) : null,
    city: body["city"] ? String(body["city"]) : null,
    source: "manual",
  });
  res.status(201).json(vendor);
}));

api.post("/weddings/:id/outreach", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await startOutreach({
    weddingId: String(req.params["id"]),
    category: category(body["category"]),
    limit: body["limit"] != null ? Number(body["limit"]) : undefined,
    vendorIds: Array.isArray(body["vendor_ids"]) ? (body["vendor_ids"] as string[]) : undefined,
  });
  res.json(result);
}));

api.get("/weddings/:id/outbox", wrap(async (req, res) => {
  res.json(await listOutbox(String(req.params["id"])));
}));

api.post("/weddings/:id/outbox/approve-all", wrap(async (req, res) => {
  const approved = await approveAllForWedding(String(req.params["id"]));
  res.json({ approved });
}));

api.post("/outbox/:id/approve", wrap(async (req, res) => {
  await approveOutboxItem(String(req.params["id"]));
  res.json({ ok: true });
}));

api.post("/outbox/:id/cancel", wrap(async (req, res) => {
  await cancelOutboxItem(String(req.params["id"]));
  res.json({ ok: true });
}));

/** Kører køen med det samme i stedet for at vente på workeren. */
api.post("/outbox/run", wrap(async (_req, res) => {
  res.json({ sent: await processOutbox() });
}));

api.get("/weddings/:id/review", wrap(async (req, res) => {
  res.json(await quotesNeedingReview(String(req.params["id"])));
}));

api.post("/quotes/:id/review", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  await markQuoteReviewed(String(req.params["id"]), {
    price_min: body["price_min"] != null ? Number(body["price_min"]) : undefined,
    price_max: body["price_max"] != null ? Number(body["price_max"]) : undefined,
    availability: body["availability"] as never,
    conditions_text: body["conditions_text"] as never,
  });
  res.json({ ok: true });
}));

api.get("/weddings/:id/questions", wrap(async (req, res) => {
  res.json(await listOpenQuestions(String(req.params["id"])));
}));

api.post("/questions/:id/answer", wrap(async (req, res) => {
  const answer = String(((req.body ?? {}) as Record<string, unknown>)["answer"] ?? "").trim();
  if (!answer) {
    res.status(400).json({ error: "answer mangler." });
    return;
  }
  await answerQuestion(String(req.params["id"]), answer);
  res.json({ ok: true });
}));

api.get("/threads/:id", wrap(async (req, res) => {
  const thread = await getThread(String(req.params["id"]));
  if (!thread) {
    res.status(404).json({ error: "Tråd findes ikke." });
    return;
  }
  const messages = await listMessages(thread.id);
  res.json({ thread, messages, reply_to: replyToAddress(thread.reply_token) });
}));

api.post("/threads/:id/followup", wrap(async (req, res) => {
  const instruction = String(
    ((req.body ?? {}) as Record<string, unknown>)["instruction"] ?? "",
  ).trim();
  if (!instruction) {
    res.status(400).json({ error: "instruction mangler." });
    return;
  }
  res.json(await requestFollowUp(String(req.params["id"]), instruction));
}));

api.post("/vendors/:id/reject", wrap(async (req, res) => {
  const reason = String(((req.body ?? {}) as Record<string, unknown>)["reason"] ?? "fravalgt");
  await excludeVendor(String(req.params["id"]), reason);
  await setVendorStatus(String(req.params["id"]), "rejected", { reason });
  res.json({ ok: true });
}));

api.get("/vendors/:id/booking-summary", wrap(async (req, res) => {
  res.json(await buildBookingSummary(String(req.params["id"])));
}));

/** Markerer som booket. Sender ingenting — parret skriver selv under. */
api.post("/vendors/:id/book", wrap(async (req, res) => {
  const summary = await buildBookingSummary(String(req.params["id"]));
  await setVendorStatus(String(req.params["id"]), "booked", { by: "couple" });
  res.json({ ok: true, summary });
}));

api.get("/weddings/:id/events", wrap(async (req, res) => {
  res.json(
    await many(
      `SELECT type, payload, created_at, vendor_id, thread_id FROM events
       WHERE wedding_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [String(req.params["id"])],
    ),
  );
}));

/**
 * Demoindgang: simulerer et leverandørsvar uden en rigtig mailserver.
 * Kører nøjagtig samme kode som webhooken.
 */
api.post("/dev/simulate-reply", wrap(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const threadId = String(body["thread_id"] ?? "");
  const text = String(body["text"] ?? "");
  const thread = await getThread(threadId);
  if (!thread || !text) {
    res.status(400).json({ error: "thread_id og text er påkrævet." });
    return;
  }
  const vendorRow = await many<{ contact_email: string | null; name: string }>(
    `SELECT contact_email, name FROM vendors WHERE id = $1`,
    [thread.vendor_id],
  );
  const result = await handleInbound({
    fromEmail: vendorRow[0]?.contact_email ?? "leverandoer@example.com",
    fromName: vendorRow[0]?.name ?? null,
    toEmails: [replyToAddress(thread.reply_token)],
    subject: `SV: ${thread.subject}`,
    textBody: text,
    messageId: `<sim-${Date.now()}@example.com>`,
    inReplyTo: null,
    references: null,
    headers: {},
    providerId: null,
  });
  res.json(result);
}));

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}
