import "dotenv/config";

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Som bool(), men uden default: usat betyder "afgør det selv", ikke "fra". */
function triBool(v: string | undefined): boolean | null {
  if (v === undefined || v === "") return null;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: int(process.env.PORT, 3000),
  baseUrl: process.env.BASE_URL ?? `http://localhost:${int(process.env.PORT, 3000)}`,

  auth: {
    // Basic Auth på dashboard og API. Tom: åben lokalt, men appen nægter at
    // svare i produktion uden den — se src/http/auth.ts.
    user: process.env.APP_USER ?? "bryllup",
    password: process.env.APP_PASSWORD ?? "",
  },

  db: {
    // Sat = rigtig Postgres (Supabase m.fl.). Tom = PGlite på disk, samme SQL-dialekt.
    url: process.env.DATABASE_URL ?? "",
    pgliteDir: process.env.PGLITE_DIR ?? "./data/pgdata",
    // Usat: afgøres ud fra værtsnavnet. Sat: bestemmer selv — nødvendigt for
    // en Postgres i Docker, hvis værtsnavn hverken er localhost eller fjernt.
    ssl: triBool(process.env.DATABASE_SSL),
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
    // Udtræk af svar er højvolumen og skemabundet; effort kan skrues ned.
    parseEffort: (process.env.ANTHROPIC_PARSE_EFFORT ?? "medium") as
      | "low" | "medium" | "high" | "xhigh" | "max",
    draftEffort: (process.env.ANTHROPIC_DRAFT_EFFORT ?? "medium") as
      | "low" | "medium" | "high" | "xhigh" | "max",
  },

  email: {
    // console | smtp
    provider: (process.env.EMAIL_PROVIDER ?? "console") as "console" | "smtp",
    fromName: process.env.EMAIL_FROM_NAME ?? "Bryllupsplanlægger",
    fromAddress: process.env.EMAIL_FROM ?? "bryllup@example.com",
    // Plus-adressering: reply+<token>@domæne. Domænet skal matche fromAddress.
    replyDomain: process.env.EMAIL_REPLY_DOMAIN ?? "example.com",
    replyLocalPart: process.env.EMAIL_REPLY_LOCALPART ?? "reply",
    smtp: {
      host: process.env.SMTP_HOST ?? "",
      port: int(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER ?? "",
      pass: process.env.SMTP_PASS ?? "",
    },
    inboundSecret: process.env.INBOUND_WEBHOOK_SECRET ?? "",
    outboxDir: process.env.OUTBOX_DIR ?? "./outbox",
  },

  sending: {
    // Deliverability: aldrig blast. Default er tør-kørsel — intet forlader
    // maskinen før DRY_RUN sættes til false bevidst.
    dryRun: bool(process.env.DRY_RUN, true),
    maxPerHour: int(process.env.SEND_MAX_PER_HOUR, 6),
    minGapSeconds: int(process.env.SEND_MIN_GAP_SECONDS, 240),
    jitterSeconds: int(process.env.SEND_JITTER_SECONDS, 180),
    maxVendorsPerCategory: int(process.env.MAX_VENDORS_PER_CATEGORY, 8),
    // Kun send inden for normal kontortid (lokal servertid), 0-23.
    sendWindowStartHour: int(process.env.SEND_WINDOW_START_HOUR, 8),
    sendWindowEndHour: int(process.env.SEND_WINDOW_END_HOUR, 18),
    workerIntervalMs: int(process.env.OUTBOX_WORKER_INTERVAL_MS, 20_000),
    // Hver udgående mail kræver eksplicit godkendelse i dashboardet.
    requireApproval: bool(process.env.REQUIRE_SEND_APPROVAL, true),
  },

  agent: {
    // Maks. mails agenten selv sender i én tråd, inkl. førstehenvendelsen.
    // Derover stopper den og beder mennesket tage over.
    maxTurnsPerThread: int(process.env.MAX_TURNS_PER_THREAD, 6),
    // Under denne tærskel flages udtrækket til manuel læsning.
    confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD ?? 0.7),
  },

  discovery: {
    googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY ?? "",
    // seed = lokal kurateret liste (virker uden nøgler), places = Google Places API
    provider: (process.env.DISCOVERY_PROVIDER ?? "seed") as "seed" | "places",
    scrapeEmails: bool(process.env.DISCOVERY_SCRAPE_EMAILS, true),
    maxResults: int(process.env.DISCOVERY_MAX_RESULTS, 20),
  },
};

export type Config = typeof config;
