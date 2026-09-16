import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { freshDb } from "./helpers.js";
import { getDashboard } from "../src/services/dashboard.js";
import { saveQuote } from "../src/services/quotes.js";
import { createWedding } from "../src/services/weddings.js";
import { upsertVendor } from "../src/services/vendors.js";
import { getOrCreateThread, addMessage } from "../src/services/threads.js";
import { groundExtraction } from "../src/domain/confidence.js";
import type { Wedding } from "../src/domain/types.js";
import type { VendorReplyExtraction } from "../src/domain/schema.js";

const BASE: VendorReplyExtraction = {
  reply_intent: "quote",
  price_min: null,
  price_max: null,
  currency: "DKK",
  price_basis: "total",
  price_includes_vat: true,
  price_quote: null,
  availability: "available",
  availability_quote: null,
  capacity_max: null,
  conditions_text: null,
  deposit_text: null,
  valid_until: null,
  vendor_questions: [],
  confidence: 0.95,
  uncertainty_notes: null,
  summary_da: "",
};

let wedding: Wedding;

/** Gemmer et tilbud gennem den rigtige verifikation mod kildeteksten. */
async function quoteFor(
  name: string,
  extraction: Partial<VendorReplyExtraction>,
  sourceText: string,
): Promise<void> {
  const vendor = await upsertVendor({
    wedding_id: wedding.id,
    name,
    category: "venue",
    contact_email: `${name.toLowerCase().replace(/\W+/g, "")}@example.com`,
    source: "demo",
  });
  const thread = await getOrCreateThread(vendor, `Forespørgsel ${name}`);
  const msg = await addMessage({
    threadId: thread.id,
    direction: "inbound",
    rawText: sourceText,
    cleanText: sourceText,
  });
  const full = { ...BASE, ...extraction };
  await saveQuote({
    wedding,
    vendorId: vendor.id,
    threadId: thread.id,
    messageId: msg.id,
    extraction: full,
    grounding: groundExtraction({
      extraction: full,
      sourceText,
      threshold: config.agent.confidenceThreshold,
    }),
  });
}

beforeEach(async () => {
  await freshDb();
  config.agent.confidenceThreshold = 0.7;
  wedding = await createWedding({
    couple_names: "Mia og Jonas",
    contact_email: "mia@example.dk",
    wedding_date: "2026-06-12",
    region: "Sjælland",
    guest_count_min: 60,
    guest_count_max: 90,
    budget_min: null,
    budget_max: null,
    style_tags: [],
    must_haves: [],
  });
});

describe("sammenligningsvisning", () => {
  it("lader ikke et ubekræftet tal tage pladsen som billigst", async () => {
    // Billigt, men tallet står ikke i mailen — modellen har læst det ind.
    await quoteFor(
      "Ubekræftet Gods",
      { price_min: 62000, price_max: 62000, price_quote: "62.000 kr. i alt" },
      "Prisen afhænger af hvad I vil have — vi ligger typisk mellem 40 og 80.000.",
    );
    // Dyrere, men ordret belæg i mailen.
    await quoteFor(
      "Bekræftet Lokale",
      {
        price_min: 112500,
        price_max: 112500,
        price_quote: "112.500 kr. inkl. moms",
        availability_quote: "datoen er ledig",
      },
      "Et selskab i jeres størrelse koster 112.500 kr. inkl. moms, og datoen er ledig.",
    );

    const dash = await getDashboard(wedding.id);
    const venues = dash.categories["venue"] ?? [];

    // Den bekræftede står først, selv om den er dyrere.
    expect(venues.map((c) => c.vendor.name)).toEqual(["Bekræftet Lokale", "Ubekræftet Gods"]);
    expect(venues[0]?.price_verified).toBe(true);
    expect(venues[1]?.price_verified).toBe(false);
  });

  it("regner ikke ledighed som bekræftet når udtrækket ikke kunne verificeres", async () => {
    await quoteFor(
      "Ubekræftet Gods",
      { price_min: 62000, price_max: 62000, price_quote: "62.000 kr. i alt" },
      "Vi ligger typisk mellem 40 og 80.000. Ring endelig.",
    );
    const card = (await getDashboard(wedding.id)).categories["venue"]?.[0];

    // Modellen sagde "available", men intet i mailen bekræfter det.
    expect(card?.quote?.availability).toBe("available");
    expect(card?.quote?.availability_confirmed).toBe(false);
    expect(card?.price_verified).toBe(false);
  });

  it("viser en bekræftet pris som bekræftet", async () => {
    await quoteFor(
      "Bekræftet Lokale",
      {
        price_min: 45000,
        price_max: 45000,
        price_quote: "45.000 kr.",
        availability_quote: "datoen er ledig",
      },
      "Det koster 45.000 kr. ekskl. moms, og datoen er ledig hos os.",
    );
    const card = (await getDashboard(wedding.id)).categories["venue"]?.[0];
    expect(card?.price_verified).toBe(true);
    expect(card?.quote?.availability_confirmed).toBe(true);
    expect(dashNeedsReview(await getDashboard(wedding.id))).toBe(0);
  });
});

function dashNeedsReview(d: Awaited<ReturnType<typeof getDashboard>>): number {
  return d.needs_review.length;
}
