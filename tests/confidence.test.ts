import { describe, expect, it } from "vitest";
import { groundExtraction, quoteIsGrounded } from "../src/domain/confidence.js";
import type { VendorReplyExtraction } from "../src/domain/schema.js";
import { splitEmail } from "../src/domain/emailText.js";
import { fixture } from "./helpers.js";

const base: VendorReplyExtraction = {
  reply_intent: "quote",
  price_min: null,
  price_max: null,
  currency: "DKK",
  price_basis: "unknown",
  price_includes_vat: null,
  price_quote: null,
  availability: "unknown",
  availability_quote: null,
  capacity_max: null,
  conditions_text: null,
  deposit_text: null,
  valid_until: null,
  vendor_questions: [],
  confidence: 0.9,
  uncertainty_notes: null,
  summary_da: "",
};

function source(file: string): string {
  const s = splitEmail(fixture(file));
  return [s.reply, s.signature].filter(Boolean).join("\n\n");
}

describe("groundExtraction", () => {
  it("godkender et udtræk der er dækket af leverandørens egen tekst", () => {
    const text = source("photographer-package-range.txt");
    const result = groundExtraction({
      threshold: 0.7,
      sourceText: text,
      extraction: {
        ...base,
        price_min: 15500,
        price_max: 24900,
        price_basis: "total",
        price_includes_vat: true,
        price_quote: 'Pakke "Hele dagen" – 24.900 kr.',
        availability: "available",
        availability_quote: "Jeg har 12. juni 2026 ledig",
      },
    });
    expect(result.needsHumanReview).toBe(false);
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("blokerer en pris der ikke findes i mailen", () => {
    const text = source("photographer-package-range.txt");
    const result = groundExtraction({
      threshold: 0.7,
      sourceText: text,
      extraction: {
        ...base,
        price_min: 21500,
        price_max: 21500,
        price_basis: "total",
        price_quote: "Prisen er 21.500 kr.",
        confidence: 0.95,
      },
    });
    expect(result.needsHumanReview).toBe(true);
    expect(result.reasons.map((r) => r.code)).toContain("price_min_not_in_text");
    expect(result.reasons.map((r) => r.code)).toContain("price_quote_not_found");
  });

  it("blokerer ledighed uden ordret belæg", () => {
    const result = groundExtraction({
      threshold: 0.7,
      sourceText: source("ambiguous-price.txt"),
      extraction: { ...base, availability: "available", availability_quote: null },
    });
    expect(result.reasons.map((r) => r.code)).toContain("availability_quote_not_found");
    expect(result.needsHumanReview).toBe(true);
  });

  it("flager når modellen selv er usikker", () => {
    const result = groundExtraction({
      threshold: 0.7,
      sourceText: source("ambiguous-price.txt"),
      extraction: {
        ...base,
        price_min: 40000,
        price_max: 80000,
        price_basis: "from",
        price_quote: "vi ligger typisk et sted mellem 40 og 80.000",
        confidence: 0.45,
        uncertainty_notes: "Leverandøren tager forbehold for alt.",
      },
    });
    expect(result.needsHumanReview).toBe(true);
    expect(result.reasons.map((r) => r.code)).toContain("model_low_confidence");
  });

  it("fanger et omvendt prisspænd", () => {
    const result = groundExtraction({
      threshold: 0.7,
      sourceText: source("photographer-package-range.txt"),
      extraction: {
        ...base,
        price_min: 24900,
        price_max: 15500,
        price_basis: "total",
        price_quote: "24.900 kr.",
      },
    });
    expect(result.reasons.map((r) => r.code)).toContain("price_range_inverted");
  });

  it("advarer, men blokerer ikke, når momsgrundlaget mangler", () => {
    const result = groundExtraction({
      threshold: 0.5,
      sourceText: source("outlook-history.txt"),
      extraction: {
        ...base,
        price_min: 45000,
        price_max: 45000,
        price_basis: "total",
        price_includes_vat: null,
        price_quote: "Prisen er 45.000 kr. samlet for hele weekenden",
        availability: "available",
        availability_quote: "Datoen er ledig",
        confidence: 0.95,
      },
    });
    expect(result.reasons.map((r) => r.code)).toContain("vat_unknown");
    expect(result.reasons.every((r) => r.severity === "warn")).toBe(true);
    expect(result.needsHumanReview).toBe(false);
  });
});

describe("quoteIsGrounded", () => {
  it("tåler forskelle i mellemrum og anførselstegn", () => {
    expect(quoteIsGrounded('  "1.250  kr. pr. kuvert" ', "koster 1.250 kr. pr. kuvert inkl. moms")).toBe(
      true,
    );
  });

  it("afviser en omskrevet sætning", () => {
    expect(quoteIsGrounded("Vi tilbyder fri bar hele natten", "Husets vin indgår i fire timer")).toBe(
      false,
    );
  });
});
