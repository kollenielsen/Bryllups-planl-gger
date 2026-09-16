import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { config } from "../src/config.js";
import { freshDb, fixture } from "./helpers.js";
import { createApp } from "../src/http/server.js";
import { ScriptedLlmClient, setLlm } from "../src/llm/client.js";
import { RecordingEmailProvider, setEmailProvider } from "../src/email/provider.js";
import { createWedding } from "../src/services/weddings.js";
import { upsertVendor } from "../src/services/vendors.js";
import { getOrCreateThread } from "../src/services/threads.js";
import { currentQuotes } from "../src/services/quotes.js";
import { replyToAddress } from "../src/email/threading.js";
import type { Thread } from "../src/domain/types.js";

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
  conditions_text: null,
  deposit_text: null,
  valid_until: null,
  vendor_questions: [],
  confidence: 0.92,
  uncertainty_notes: null,
  summary_da: "1.250 kr. pr. kuvert.",
};

let server: Server;
let base: string;
let originalSecret: string;
let originalEnv: string;

async function listen(): Promise<void> {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("Ingen port.");
  base = `http://127.0.0.1:${addr.port}`;
}

async function setupThread(): Promise<Thread> {
  const wedding = await createWedding({
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
  const vendor = await upsertVendor({
    wedding_id: wedding.id,
    name: "Søgaard Gods",
    category: "venue",
    contact_email: "anne@soegaard-gods.example.com",
    source: "demo",
  });
  return getOrCreateThread(vendor, "Forespørgsel 12. juni 2026");
}

/** Postmark-formet payload — den form udbyderen faktisk POSTer. */
function postmarkPayload(thread: Thread, body: string): Record<string, unknown> {
  return {
    From: "Anne <anne@soegaard-gods.example.com>",
    FromFull: { Email: "anne@soegaard-gods.example.com", Name: "Anne" },
    To: replyToAddress(thread.reply_token),
    Subject: "SV: Forespørgsel 12. juni 2026",
    TextBody: body,
    MessageID: `pm-${Math.random().toString(36).slice(2)}`,
    Headers: [{ Name: "Auto-Submitted", Value: "no" }],
  };
}

interface InboundResponse {
  outcome: string;
  needsHuman?: boolean;
  detail?: string;
}

async function outcomeOf(res: Response): Promise<InboundResponse> {
  return (await res.json()) as InboundResponse;
}

function post(payload: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/webhooks/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(payload),
  });
}

beforeEach(async () => {
  await freshDb();
  setEmailProvider(new RecordingEmailProvider());
  setLlm(new ScriptedLlmClient({ parse_reply: [QUOTE_EXTRACTION] }));
  originalSecret = config.email.inboundSecret;
  originalEnv = config.env;
  config.sending.dryRun = false;
  config.sending.requireApproval = false;
  config.agent.confidenceThreshold = 0.7;
  await listen();
});

afterEach(async () => {
  config.email.inboundSecret = originalSecret;
  config.env = originalEnv;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("POST /webhooks/inbound", () => {
  it("afviser en levering med forkert hemmelighed", async () => {
    config.email.inboundSecret = "korrekt-hemmelighed";
    const thread = await setupThread();
    const res = await post(postmarkPayload(thread, "Hej"), {
      headers: { "x-webhook-secret": "forkert" },
    });
    expect(res.status).toBe(401);
    expect(await currentQuotes(thread.wedding_id)).toHaveLength(0);
  });

  it("afviser uden at kaste når hemmeligheden har en anden længde", async () => {
    // timingSafeEqual kaster på ulige længder; sammenligningen skal afvise før.
    config.email.inboundSecret = "kort";
    const thread = await setupThread();
    const res = await post(postmarkPayload(thread, "Hej"), {
      headers: { "x-webhook-secret": "en-noget-laengere-streng" },
    });
    expect(res.status).toBe(401);
  });

  it("lukker ikke et åbent endpoint ud i produktion", async () => {
    config.email.inboundSecret = "";
    config.env = "production";
    const thread = await setupThread();
    expect((await post(postmarkPayload(thread, "Hej"))).status).toBe(401);
  });

  it("tager imod token på querystring", async () => {
    config.email.inboundSecret = "s3kret";
    const thread = await setupThread();
    const res = await fetch(`${base}/webhooks/inbound?token=s3kret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(postmarkPayload(thread, fixture("venue-quote-per-guest.txt"))),
    });
    expect(res.status).toBe(200);
    expect((await outcomeOf(res)).outcome).toBe("parsed");
  });

  it("kører en rigtig Postmark-levering hele vejen til et gemt tilbud", async () => {
    config.email.inboundSecret = "s3kret";
    const thread = await setupThread();
    const res = await post(postmarkPayload(thread, fixture("venue-quote-per-guest.txt")), {
      headers: { "x-webhook-secret": "s3kret" },
    });

    expect(res.status).toBe(200);
    expect((await outcomeOf(res)).outcome).toBe("parsed");

    const [quote] = await currentQuotes(thread.wedding_id);
    expect(quote?.price_min).toBe(1250);
    expect(quote?.estimated_total_max).toBe(112500);
  });

  it("svarer 200 på en dublet, så udbyderen ikke gentager i det uendelige", async () => {
    config.email.inboundSecret = "s3kret";
    const thread = await setupThread();
    const payload = postmarkPayload(thread, fixture("venue-quote-per-guest.txt"));
    const headers = { "x-webhook-secret": "s3kret" };

    expect((await outcomeOf(await post(payload, { headers }))).outcome).toBe("parsed");
    const second = await post(payload, { headers });
    expect(second.status).toBe(200);
    expect((await outcomeOf(second)).outcome).toBe("duplicate");
    expect(await currentQuotes(thread.wedding_id)).toHaveLength(1);
  });

  it("svarer 200 og ikke 5xx når modelkaldet fejler", async () => {
    // En 5xx får udbyderen til at genlevere. Mailen er allerede gemt, så en
    // genlevering ville ikke hjælpe — fejlen hører til i dashboardet.
    config.email.inboundSecret = "s3kret";
    setLlm(new ScriptedLlmClient({}));
    const thread = await setupThread();
    const res = await post(postmarkPayload(thread, fixture("venue-quote-per-guest.txt")), {
      headers: { "x-webhook-secret": "s3kret" },
    });
    expect(res.status).toBe(200);
    const body = await outcomeOf(res);
    expect(body.outcome).toBe("parse_failed");
    expect(body.needsHuman).toBe(true);
  });

  it("ignorerer en levering uden brødtekst", async () => {
    config.email.inboundSecret = "s3kret";
    const thread = await setupThread();
    const res = await post(
      { ...postmarkPayload(thread, ""), TextBody: "   " },
      { headers: { "x-webhook-secret": "s3kret" } },
    );
    expect(res.status).toBe(200);
    expect((await outcomeOf(res)).outcome).toBe("ignored");
  });
});
