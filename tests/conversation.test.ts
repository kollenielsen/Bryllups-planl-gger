import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { freshDb, fixture } from "./helpers.js";
import { ScriptedLlmClient, setLlm } from "../src/llm/client.js";
import { RecordingEmailProvider, setEmailProvider } from "../src/email/provider.js";
import { createWedding, listOpenQuestions } from "../src/services/weddings.js";
import { getVendor, upsertVendor } from "../src/services/vendors.js";
import { getOrCreateThread, listMessages } from "../src/services/threads.js";
import { startOutreach } from "../src/services/outreach.js";
import { listOutbox, processOutbox } from "../src/services/outbox.js";
import { decideNextStep, handleInbound } from "../src/services/conversation.js";
import { currentQuotes } from "../src/services/quotes.js";
import { replyToAddress } from "../src/email/threading.js";
import { many, one } from "../src/services/repo.js";
import type { InboundEmail } from "../src/email/inbound.js";
import type { Thread, Vendor, Wedding } from "../src/domain/types.js";

const OUTREACH = {
  subject: "Forespørgsel: bryllup 12. juni 2026, 60-90 gæster",
  body_da: "Kære Søgaard Gods\n\nVi skriver på vegne af Mia og Jonas…",
};

const QUOTE_EXTRACTION = {
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
  conditions_text: "Depositum 10.000 kr. ved reservation. Gratis afbestilling frem til 90 dage før.",
  deposit_text: "10.000 kr. ved reservation",
  valid_until: null,
  vendor_questions: [
    "Hvornår regner I med at ankomme, og hvor længe skal festen vare?",
    "Skal der være vielse i haven, eller kommer I direkte fra kirken?",
  ],
  confidence: 0.92,
  uncertainty_notes: null,
  summary_da: "Lokalet er ledigt med forbehold og koster 1.250 kr. pr. kuvert.",
};

const UNAVAILABLE_EXTRACTION = {
  reply_intent: "unavailable",
  price_min: null,
  price_max: null,
  currency: null,
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
  summary_da: "Datoen er optaget.",
};

const CLOSING_FOLLOWUP = {
  should_reply: true,
  body_da: "Tak for det hurtige svar — så leder vi videre. Held og lykke med sæsonen.",
  answered_questions: [],
  unanswerable_questions: [],
  needs_human: false,
  needs_human_reason: null,
};

const FOLLOWUP = {
  should_reply: true,
  body_da: "Tak for det hurtige svar. Vi kommer fra kirken og forventer at ankomme ca. kl. 16.",
  answered_questions: ["Skal der være vielse i haven?"],
  unanswerable_questions: ["Hvor længe skal festen vare?"],
  needs_human: false,
  needs_human_reason: null,
};

function scripted(overrides: Record<string, unknown[]> = {}): ScriptedLlmClient {
  const client = new ScriptedLlmClient({
    outreach: [OUTREACH],
    parse_reply: [QUOTE_EXTRACTION],
    followup: [FOLLOWUP],
    ...overrides,
  });
  setLlm(client);
  return client;
}

async function setupWedding(): Promise<{ wedding: Wedding; vendor: Vendor; thread: Thread }> {
  const wedding = await createWedding({
    couple_names: "Mia og Jonas",
    contact_email: "mia@example.dk",
    wedding_date: "2026-06-12",
    region: "Sjælland",
    guest_count_min: 60,
    guest_count_max: 90,
    budget_min: 150000,
    budget_max: 250000,
    style_tags: ["rustik"],
    must_haves: ["plads til 90"],
  });
  const vendor = await upsertVendor({
    wedding_id: wedding.id,
    name: "Søgaard Gods",
    category: "venue",
    contact_email: "anne@soegaard-gods.example.com",
    source: "demo",
  });
  const thread = await getOrCreateThread(vendor, "Forespørgsel 12. juni 2026");
  return { wedding, vendor, thread };
}

function inbound(thread: Thread, body: string, overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    fromEmail: "anne@soegaard-gods.example.com",
    fromName: "Anne",
    toEmails: [replyToAddress(thread.reply_token)],
    subject: "SV: Forespørgsel 12. juni 2026",
    textBody: body,
    messageId: `<${Math.random().toString(36).slice(2)}@soegaard.dk>`,
    inReplyTo: null,
    references: null,
    headers: {},
    providerId: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await freshDb();
  setEmailProvider(new RecordingEmailProvider());
  config.sending.dryRun = false;
  config.sending.requireApproval = false;
  config.sending.minGapSeconds = 0;
  config.sending.jitterSeconds = 0;
  config.sending.sendWindowStartHour = 0;
  config.sending.sendWindowEndHour = 24;
  config.sending.maxPerHour = 50;
  config.agent.maxTurnsPerThread = 6;
  config.agent.confidenceThreshold = 0.7;
});

describe("førstehenvendelse", () => {
  it("skriver udkast, lægger det i kø og sender det gennem køen", async () => {
    scripted();
    const { wedding, vendor } = await setupWedding();

    const result = await startOutreach({ weddingId: wedding.id, category: "venue" });
    expect(result.queued).toBe(1);

    const queued = await listOutbox(wedding.id);
    expect(queued[0]?.status).toBe("queued");
    expect(queued[0]?.subject).toBe(OUTREACH.subject);
    // Signatur og afmeldingslinje lægges på uden for modellen.
    expect(queued[0]?.body_text).toContain("på vegne af Mia og Jonas");
    expect(queued[0]?.body_text).toContain("Ønsker I ikke henvendelser");

    expect(await processOutbox()).toBe(1);
    const after = await getVendor(vendor.id);
    expect(after?.status).toBe("contacted");
    const messages = await listMessages(queued[0]!.thread_id);
    expect(messages.filter((m) => m.direction === "outbound")).toHaveLength(1);
  });

  it("springer leverandører uden mailadresse over", async () => {
    scripted();
    const { wedding } = await setupWedding();
    await upsertVendor({
      wedding_id: wedding.id,
      name: "Ukendt Lokale",
      category: "venue",
      contact_email: null,
      source: "places",
    });
    const result = await startOutreach({ weddingId: wedding.id, category: "venue" });
    expect(result.skipped.some((s) => s.reason.includes("ingen mailadresse"))).toBe(true);
  });
});

describe("indgående svar", () => {
  it("udtrækker et tilbud, gemmer det og svarer på leverandørens spørgsmål", async () => {
    scripted();
    const { wedding, vendor, thread } = await setupWedding();
    await startOutreach({ weddingId: wedding.id, category: "venue" });
    await processOutbox();

    const result = await handleInbound(inbound(thread, fixture("venue-quote-per-guest.txt")));
    expect(result.outcome).toBe("parsed");

    const [quote] = await currentQuotes(wedding.id);
    expect(quote?.price_min).toBe(1250);
    expect(quote?.price_basis).toBe("per_guest");
    // Totalen beregnes i kode ud fra det højeste gæstetal.
    expect(quote?.estimated_total_max).toBe(112500);
    expect(quote?.needs_human_review).toBe(false);
    // Option er ikke bekræftet ledighed.
    expect(quote?.availability_confirmed).toBe(false);

    const outbox = await listOutbox(wedding.id);
    expect(outbox.some((o) => o.kind === "followup")).toBe(true);

    const questions = await listOpenQuestions(wedding.id, "open");
    expect(questions.map((q) => q.question)).toContain("Hvor længe skal festen vare?");

    // Der ER en pris, så leverandøren tæller som "tilbud modtaget", selv om
    // der stadig er ubesvarede spørgsmål i tråden.
    const after = await getVendor(vendor.id);
    expect(after?.status).toBe("quoted");
  });

  it("flager et udtræk hvor prisen ikke findes i mailen", async () => {
    scripted({
      parse_reply: [{ ...QUOTE_EXTRACTION, price_min: 999, price_max: 999, vendor_questions: [] }],
    });
    const { wedding, thread } = await setupWedding();

    const result = await handleInbound(inbound(thread, fixture("venue-quote-per-guest.txt")));
    expect(result.needsHuman).toBe(true);

    const [quote] = await currentQuotes(wedding.id);
    expect(quote?.needs_human_review).toBe(true);
    expect(quote?.review_reasons.join(" ")).toContain("price_min_not_in_text");

    const t = await one<Thread>(`SELECT * FROM threads WHERE id = $1`, [thread.id]);
    expect(t?.state).toBe("needs_human");
  });

  it("behandler den samme levering én gang", async () => {
    scripted();
    const { thread } = await setupWedding();
    const email = inbound(thread, fixture("venue-quote-per-guest.txt"));
    expect((await handleInbound(email)).outcome).toBe("parsed");
    expect((await handleInbound(email)).outcome).toBe("duplicate");
  });

  it("bruger ikke et modelkald på et autosvar", async () => {
    const llm = scripted();
    const { thread } = await setupWedding();
    const result = await handleInbound(inbound(thread, fixture("autoreply-vacation.txt")));
    expect(result.outcome).toBe("auto_reply");
    expect(llm.calls).toHaveLength(0);
  });

  it("blokerer adressen ved en bounce", async () => {
    const llm = scripted();
    const { wedding, vendor, thread } = await setupWedding();
    const result = await handleInbound(
      inbound(thread, fixture("bounce.txt"), { fromEmail: "mailer-daemon@example.com" }),
    );
    expect(result.outcome).toBe("bounce");
    expect(llm.calls).toHaveLength(0);
    expect((await getVendor(vendor.id))?.status).toBe("bounced");

    const suppressed = await many(`SELECT * FROM suppressions`);
    expect(suppressed).toHaveLength(1);

    // Ingen nye mails må lægges i kø til en blokeret adresse.
    await startOutreach({ weddingId: wedding.id, category: "venue" });
    expect(await listOutbox(wedding.id)).toHaveLength(0);
  });

  it("stopper alt ved en framelding", async () => {
    const llm = scripted();
    const { wedding, vendor, thread } = await setupWedding();
    await startOutreach({ weddingId: wedding.id, category: "venue" });

    const result = await handleInbound(inbound(thread, fixture("opt-out.txt")));
    expect(result.outcome).toBe("opt_out");
    expect(llm.calls).toHaveLength(1); // kun udkastet til førstehenvendelsen
    expect((await getVendor(vendor.id))?.status).toBe("opted_out");
    const outbox = await listOutbox(wedding.id);
    expect(outbox.every((o) => o.status === "cancelled")).toBe(true);
  });

  it("melder en mail der ikke kan knyttes til en tråd", async () => {
    scripted();
    await setupWedding();
    const result = await handleInbound({
      fromEmail: "fremmed@ukendt.dk",
      fromName: null,
      toEmails: ["reply+detfindesikke@example.com"],
      subject: "Hej",
      textBody: "Jeg er ikke en del af nogen tråd.",
      messageId: "<x@ukendt.dk>",
      inReplyTo: null,
      references: null,
      headers: {},
      providerId: null,
    });
    expect(result.outcome).toBe("unmatched");
  });

  it("matcher på In-Reply-To når plus-adressen er væk", async () => {
    scripted();
    const { wedding, thread } = await setupWedding();
    await startOutreach({ weddingId: wedding.id, category: "venue" });
    await processOutbox();
    const ourMessage = (await listMessages(thread.id)).find((m) => m.direction === "outbound");

    const result = await handleInbound(
      inbound(thread, fixture("venue-quote-per-guest.txt"), {
        toEmails: ["bryllup@example.com"],
        inReplyTo: ourMessage?.message_id_hdr ?? null,
      }),
    );
    expect(result.outcome).toBe("parsed");
    expect(result.threadId).toBe(thread.id);
  });
});

describe("tilstand efter afsendelse", () => {
  it("ruller ikke leverandørens status tilbage når en opfølgning sendes", async () => {
    scripted();
    const { wedding, vendor, thread } = await setupWedding();
    await startOutreach({ weddingId: wedding.id, category: "venue" });
    await processOutbox();

    await handleInbound(inbound(thread, fixture("venue-quote-per-guest.txt")));
    expect((await getVendor(vendor.id))?.status).toBe("quoted");

    // Opfølgningen ligger i køen. Når den sendes, er leverandøren stadig en
    // der har givet tilbud — ikke en vi lige har skrevet til første gang.
    expect(await processOutbox()).toBe(1);
    expect((await getVendor(vendor.id))?.status).toBe("quoted");
  });

  it("lukker tråden efter den afsluttende mail på et afslag", async () => {
    scripted({
      parse_reply: [UNAVAILABLE_EXTRACTION],
      followup: [CLOSING_FOLLOWUP],
    });
    const { wedding, vendor, thread } = await setupWedding();
    await startOutreach({ weddingId: wedding.id, category: "venue" });
    await processOutbox();

    await handleInbound(inbound(thread, fixture("venue-unavailable.txt")));
    expect((await one<Thread>(`SELECT * FROM threads WHERE id = $1`, [thread.id]))?.state).toBe(
      "closed",
    );

    // Afsendelsen af den afsluttende mail må ikke sætte tråden til at vente
    // på en leverandør, der allerede har sagt nej.
    expect(await processOutbox()).toBe(1);
    expect((await one<Thread>(`SELECT * FROM threads WHERE id = $1`, [thread.id]))?.state).toBe(
      "closed",
    );
    expect((await getVendor(vendor.id))?.status).toBe("rejected");
  });

  it("tæller mails der stadig ligger i køen med i rundeloftet", async () => {
    scripted();
    config.agent.maxTurnsPerThread = 1;
    const { wedding, thread } = await setupWedding();
    // Førstehenvendelsen er lagt i kø, men ikke sendt endnu. Den tæller med,
    // ellers kan agenten nå at lægge en opfølgning i kø oven i den.
    await startOutreach({ weddingId: wedding.id, category: "venue" });

    const result = await handleInbound(inbound(thread, fixture("venue-quote-per-guest.txt")));
    expect(result.needsHuman).toBe(true);
    const outbox = await listOutbox(wedding.id);
    expect(outbox.filter((o) => o.kind === "followup")).toHaveLength(0);
  });
});

describe("trådmatchning", () => {
  it("gætter ikke når den samme adresse er brugt til flere bryllupper", async () => {
    scripted();
    const first = await setupWedding();
    const second = await createWedding({
      couple_names: "Ida og Peter",
      contact_email: "ida@example.dk",
      wedding_date: "2026-08-01",
      region: "Sjælland",
      guest_count_min: 40,
      guest_count_max: 50,
      budget_min: null,
      budget_max: null,
      style_tags: [],
      must_haves: [],
    });
    const sameVendor = await upsertVendor({
      wedding_id: second.id,
      name: "Søgaard Gods",
      category: "venue",
      contact_email: "anne@soegaard-gods.example.com",
      source: "demo",
    });
    await getOrCreateThread(sameVendor, "Forespørgsel 1. august 2026");

    // Uden token og uden In-Reply-To er afsenderadressen tvetydig: to åbne
    // tråde matcher. Så skal mailen til manuel håndtering, ikke i en tilfældig.
    const result = await handleInbound(
      inbound(first.thread, fixture("venue-quote-per-guest.txt"), {
        toEmails: ["bryllup@example.com"],
      }),
    );
    expect(result.outcome).toBe("unmatched");
  });
});

describe("decideNextStep", () => {
  const base = {
    intent: "quote",
    vendorQuestions: [] as string[],
    availability: "available",
    hasPrice: true,
    turnCount: 2,
    maxTurns: 6,
    needsHumanReview: false,
  };

  it("overlader tråden til mennesket når runderne er brugt", () => {
    const step = decideNextStep({ ...base, turnCount: 6 });
    expect(step.reply).toBe(false);
    expect(step.state).toBe("needs_human");
  });

  it("svarer når leverandøren spørger om noget", () => {
    expect(decideNextStep({ ...base, vendorQuestions: ["Hvor mange gæster?"] }).reply).toBe(true);
  });

  it("spørger videre når prisen er der, men ledigheden ikke er", () => {
    expect(decideNextStep({ ...base, availability: "unknown" }).reply).toBe(true);
  });

  it("stopper ved et fuldt tilbud", () => {
    const step = decideNextStep(base);
    expect(step.reply).toBe(false);
    expect(step.state).toBe("quoted");
  });

  it("sender en afsluttende mail ved afslag", () => {
    const step = decideNextStep({ ...base, intent: "unavailable" });
    expect(step.reply).toBe(true);
    expect(step.state).toBe("closed");
  });
});
