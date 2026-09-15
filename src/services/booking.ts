import { formatDkk } from "../domain/money.js";
import { one } from "./repo.js";
import { getWedding } from "./weddings.js";
import { getVendor } from "./vendors.js";
import { priceLabel } from "./dashboard.js";
import type { Quote, Thread } from "../domain/types.js";

export interface BookingSummary {
  vendor: { name: string; email: string | null; phone: string | null; website: string | null };
  wedding: { couple: string; date: string | null; guests: string; region: string };
  quote: Quote | null;
  price_label: string;
  open_points: string[];
  draft_email_subject: string;
  draft_email_body: string;
  disclaimer: string;
}

/**
 * Agenten booker ikke. Den samler det parret skal bruge for selv at sige ja:
 * kontaktoplysninger, hvad der faktisk er tilbudt, hvad der stadig er uafklaret,
 * og et udkast til bekræftelsesmail de selv sender.
 *
 * Udkastet skrives med en skabelon, ikke af modellen. Ved et skridt med
 * retsvirkning skal ordlyden være forudsigelig og revisérbar.
 */
export async function buildBookingSummary(vendorId: string): Promise<BookingSummary> {
  const vendor = await getVendor(vendorId);
  if (!vendor) throw new Error("Leverandør findes ikke.");
  const wedding = await getWedding(vendor.wedding_id);
  if (!wedding) throw new Error("Bryllup findes ikke.");

  const quote = await one<Quote>(
    `SELECT * FROM quotes WHERE vendor_id = $1 AND is_current = TRUE`,
    [vendorId],
  );
  const thread = await one<Thread>(`SELECT * FROM threads WHERE vendor_id = $1`, [vendorId]);

  const openPoints: string[] = [];
  if (!quote) openPoints.push("Der er ikke registreret et tilbud fra leverandøren endnu.");
  if (quote?.needs_human_review && !quote.human_reviewed_at) {
    openPoints.push("Tilbuddet er ikke gennemlæst af jer endnu — tallene er ikke verificeret.");
  }
  if (quote && quote.availability !== "available") {
    openPoints.push("Leverandøren har ikke skriftligt bekræftet, at datoen er ledig.");
  }
  if (quote && quote.price_includes_vat === null) {
    openPoints.push("Det fremgår ikke, om prisen er inkl. eller ekskl. moms.");
  }
  if (quote && quote.price_basis === "unknown") {
    openPoints.push("Det fremgår ikke, om prisen er samlet eller pr. gæst/time.");
  }
  if (!quote?.deposit_text) openPoints.push("Depositum og betalingsbetingelser er ikke afklaret.");
  if (!quote?.conditions_text) openPoints.push("Afbestillingsvilkår er ikke afklaret.");

  const dateLine = wedding.wedding_date ?? "(dato ikke fastlagt)";
  const priceLine = quote ? priceLabel(quote, wedding) : "ikke oplyst";

  const body = [
    `Kære ${vendor.name}`,
    "",
    `Tak for jeres tilbud. Vi vil gerne gå videre med en booking til vores bryllup den ${dateLine}.`,
    "",
    "Som vi har forstået det:",
    `- Pris: ${priceLine}`,
    `- Antal gæster: ${wedding.guest_count_min}-${wedding.guest_count_max}`,
    quote?.conditions_text ? `- Betingelser: ${quote.conditions_text}` : null,
    quote?.deposit_text ? `- Depositum: ${quote.deposit_text}` : null,
    "",
    "Vil I bekræfte, at det er korrekt, og sende en kontrakt samt oplysninger om depositum?",
    "",
    "Med venlig hilsen",
    wedding.couple_names,
    wedding.contact_phone ? `Tlf. ${wedding.contact_phone}` : null,
    wedding.contact_email,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  return {
    vendor: {
      name: vendor.name,
      email: vendor.contact_email,
      phone: vendor.phone,
      website: vendor.website,
    },
    wedding: {
      couple: wedding.couple_names,
      date: wedding.wedding_date,
      guests: `${wedding.guest_count_min}-${wedding.guest_count_max}`,
      region: wedding.region,
    },
    quote,
    price_label: quote
      ? `${priceLabel(quote, wedding)}${
          quote.estimated_total_max ? ` · sammenligningstal: ${formatDkk(quote.estimated_total_max)}` : ""
        }`
      : "Ingen pris registreret",
    open_points: openPoints,
    draft_email_subject: thread ? `Bekræftelse: ${thread.subject}` : `Booking – ${vendor.name}`,
    draft_email_body: body,
    disclaimer:
      "Agenten sender ikke denne mail og indgår ingen aftale. Læs udkastet igennem, ret det, og send det selv fra jeres egen mail.",
  };
}
