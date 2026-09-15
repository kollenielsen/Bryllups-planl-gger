import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { migrate } from "../db/migrate.js";
import { getDb } from "../db/index.js";
import { ScriptedLlmClient, setLlm } from "../llm/client.js";
import { createWedding, listOpenQuestions } from "../services/weddings.js";
import { discoverVendors } from "../discovery/index.js";
import { listVendors } from "../services/vendors.js";
import { startOutreach } from "../services/outreach.js";
import { processOutbox } from "../services/outbox.js";
import { handleInbound } from "../services/conversation.js";
import { getDashboard } from "../services/dashboard.js";
import { one } from "../services/repo.js";
import { replyToAddress } from "../email/threading.js";
import type { Thread } from "../domain/types.js";

/**
 * Kører hele forløbet fra intake til sammenligningsvisning med en scriptet
 * model i stedet for et rigtigt API-kald, så dashboardet kan ses uden nøgle
 * og uden at der sendes mail. Alt andet — kø, trådtilstand, verifikation,
 * flagning — er den rigtige kode.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, "../../tests/fixtures/emails");
const read = (f: string): string => fs.readFileSync(path.join(fixtures, f), "utf8");

config.sending.dryRun = true;
config.sending.requireApproval = false;
config.sending.minGapSeconds = 0;
config.sending.jitterSeconds = 0;
config.sending.sendWindowStartHour = 0;
config.sending.sendWindowEndHour = 24;
config.sending.maxPerHour = 100;

setLlm(
  new ScriptedLlmClient({
    outreach: [
      {
        subject: "Forespørgsel: bryllup 12. juni 2026 for 60-90 gæster",
        body_da:
          "Kære leverandør\n\nVi skriver på vegne af Mia og Jonas, der bliver gift den 12. juni 2026. De regner med 60-90 gæster og leder efter et sted på Sjælland med plads til lange borde og mulighed for udendørs vielse.\n\nVi vil gerne høre:\n- Er datoen ledig?\n- Hvad koster et selskab i den størrelse, og er prisen pr. kuvert eller samlet?\n- Hvad er inkluderet?",
      },
    ],
    parse_reply: [
      {
        reply_intent: "quote",
        price_min: 1250,
        price_max: 1250,
        currency: "DKK",
        price_basis: "per_guest",
        price_includes_vat: true,
        price_quote: "1.250 kr. pr. kuvert inkl. moms",
        availability: "tentative",
        availability_quote: "datoen fortsat er ledig hos os, men vi har en forespørgsel liggende",
        capacity_max: null,
        conditions_text:
          "Depositum 10.000 kr. ved reservation. Gratis afbestilling frem til 90 dage før.",
        deposit_text: "10.000 kr. ved reservation",
        valid_until: null,
        vendor_questions: [
          "Hvornår regner I med at ankomme, og hvor længe skal festen vare?",
          "Skal der være vielse i haven, eller kommer I direkte fra kirken?",
        ],
        confidence: 0.92,
        uncertainty_notes: null,
        summary_da: "Ledigt med forbehold. 1.250 kr. pr. kuvert inkl. moms.",
      },
      {
        reply_intent: "unavailable",
        price_min: null,
        price_max: null,
        currency: "DKK",
        price_basis: "unknown",
        price_includes_vat: null,
        price_quote: null,
        availability: "unavailable",
        availability_quote: "den 12. juni 2026 allerede booket hos os",
        capacity_max: null,
        conditions_text: null,
        deposit_text: null,
        valid_until: null,
        vendor_questions: [],
        confidence: 0.95,
        uncertainty_notes: null,
        summary_da: "Datoen er optaget. Foreslår 5. eller 19. juni.",
      },
      {
        reply_intent: "quote",
        price_min: 62000,
        price_max: 62000,
        currency: "DKK",
        price_basis: "total",
        price_includes_vat: true,
        price_quote: "Prisen er 62.000 kr. for et bryllup i jeres størrelse",
        availability: "available",
        availability_quote: "Ja, vi har plads den dag",
        capacity_max: null,
        conditions_text: null,
        deposit_text: null,
        valid_until: null,
        vendor_questions: [],
        confidence: 0.81,
        uncertainty_notes: null,
        summary_da: "Har plads og oplyser en samlet pris.",
      },
      {
        reply_intent: "quote",
        price_min: 15500,
        price_max: 24900,
        currency: "DKK",
        price_basis: "total",
        price_includes_vat: true,
        price_quote: "Pakke \"Hele dagen\" – 24.900 kr.",
        availability: "available",
        availability_quote: "Jeg har 12. juni 2026 ledig",
        capacity_max: null,
        conditions_text: "Inkl. transport på Sjælland. Levering senest 6 uger efter.",
        deposit_text: null,
        valid_until: null,
        vendor_questions: [],
        confidence: 0.94,
        uncertainty_notes: null,
        summary_da: "Ledig. To pakker: 15.500 kr. og 24.900 kr. inkl. moms.",
      },
    ],
    followup: [
      {
        should_reply: true,
        body_da:
          "Tak for det hurtige svar. Parret kommer direkte fra kirken og forventer at ankomme omkring kl. 16. Hvor længe festen skal vare, vender vi tilbage med.",
        answered_questions: ["Skal der være vielse i haven, eller kommer I direkte fra kirken?"],
        unanswerable_questions: ["Hvor længe skal festen vare?"],
        needs_human: false,
        needs_human_reason: null,
      },
      {
        should_reply: true,
        body_da:
          "Tak for svaret, og ærgerligt at datoen er optaget. Vi holder fast i den 12. juni, men tak fordi I vendte tilbage.",
        answered_questions: [],
        unanswerable_questions: [],
        needs_human: false,
        needs_human_reason: null,
      },
    ],
  }),
);

await migrate();

const wedding = await createWedding({
  couple_names: "Mia og Jonas",
  contact_email: "mia.og.jonas@example.dk",
  contact_phone: "20 11 22 33",
  wedding_date: "2026-06-12",
  region: "Sjælland",
  guest_count_min: 60,
  guest_count_max: 90,
  budget_min: 150000,
  budget_max: 250000,
  style_tags: ["rustik", "udendørs vielse", "lange borde"],
  must_haves: ["plads til 90 siddende", "egen catering tilladt"],
  notes: "Vielsen er i kirken kl. 14. Festen begynder ca. kl. 16.",
});

for (const category of ["venue", "photographer"] as const) {
  await discoverVendors({ weddingId: wedding.id, category, region: wedding.region });
  await startOutreach({ weddingId: wedding.id, category });
}
const sent = await processOutbox();

const vendors = await listVendors(wedding.id);
const venues = vendors.filter((v) => v.category === "venue");
const photographers = vendors.filter((v) => v.category === "photographer");

// Rækkefølgen matcher de scriptede udtræk ovenfor: tilbud, optaget,
// uklart svar med opdigtet pris (skal flages), og et fotograftilbud.
const replies: Array<{ vendorId: string | undefined; file: string }> = [
  { vendorId: venues[0]?.id, file: "venue-quote-per-guest.txt" },
  { vendorId: venues[1]?.id, file: "venue-unavailable.txt" },
  { vendorId: venues[2]?.id, file: "ambiguous-price.txt" },
  { vendorId: photographers[0]?.id, file: "photographer-package-range.txt" },
];

let n = 0;
for (const { vendorId, file } of replies) {
  if (!vendorId) continue;
  n += 1;
  const vendor = vendors.find((v) => v.id === vendorId)!;
  const thread = await one<Thread>(`SELECT * FROM threads WHERE vendor_id = $1`, [vendorId]);
  if (!thread) continue;
  const result = await handleInbound({
    fromEmail: vendor.contact_email,
    fromName: vendor.name,
    toEmails: [replyToAddress(thread.reply_token)],
    subject: `SV: ${thread.subject}`,
    textBody: read(file),
    messageId: `<demo-${n}@example.com>`,
    inReplyTo: null,
    references: null,
    headers: {},
    providerId: null,
  });
  console.log(`  ${vendor.name}: ${result.outcome}${result.detail ? ` — ${result.detail}` : ""}`);
}

const dashboard = await getDashboard(wedding.id);
const questions = await listOpenQuestions(wedding.id, "open");

console.log("");
console.log(`Demo klar. ${sent} mails skrevet til ./outbox (tør-kørsel, intet sendt).`);
console.log(
  `Leverandører: ${Object.entries(dashboard.categories)
    .map(([k, v]) => `${k} ${v.length}`)
    .join(", ")}`,
);
console.log(`Til manuel læsning: ${dashboard.needs_review.length}`);
console.log(`Spørgsmål til parret: ${questions.length}`);
console.log(`\nStart serveren: npm run dev  ->  ${config.baseUrl}`);

await (await getDb()).close();
