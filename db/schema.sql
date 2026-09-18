-- Bryllups-planlægger: skema (Postgres 15+ / PGlite).
-- Kør via `npm run migrate`. Idempotent.

CREATE TABLE IF NOT EXISTS weddings (
  id               TEXT PRIMARY KEY,
  couple_names     TEXT NOT NULL,
  contact_email    TEXT NOT NULL,
  contact_phone    TEXT,
  wedding_date     DATE,
  date_flexible    BOOLEAN NOT NULL DEFAULT FALSE,
  region           TEXT NOT NULL,
  guest_count_min  INTEGER NOT NULL,
  guest_count_max  INTEGER NOT NULL,
  budget_min       INTEGER,
  budget_max       INTEGER,
  currency         TEXT NOT NULL DEFAULT 'DKK',
  style_tags       TEXT[] NOT NULL DEFAULT '{}',
  must_haves       TEXT[] NOT NULL DEFAULT '{}',
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kategori-budget pr. bryllup (fx 60% af totalbudget til lokale).
CREATE TABLE IF NOT EXISTS category_budgets (
  wedding_id  TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  budget_min  INTEGER,
  budget_max  INTEGER,
  PRIMARY KEY (wedding_id, category)
);

CREATE TABLE IF NOT EXISTS vendors (
  id             TEXT PRIMARY KEY,
  wedding_id     TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN ('venue', 'photographer')),
  contact_email  TEXT,
  website        TEXT,
  phone          TEXT,
  address        TEXT,
  city           TEXT,
  source         TEXT NOT NULL DEFAULT 'manual',
  source_ref     TEXT,
  rating         REAL,
  status         TEXT NOT NULL DEFAULT 'discovered'
                 CHECK (status IN ('discovered','no_contact','approved_for_outreach','contacted',
                                   'replied','awaiting_info','quoted','rejected','booked','bounced','opted_out')),
  excluded       BOOLEAN NOT NULL DEFAULT FALSE,
  exclude_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wedding_id, category, contact_email)
);
CREATE INDEX IF NOT EXISTS vendors_wedding_idx ON vendors (wedding_id, category);

-- En tråd pr. leverandør. reply_token bruges til plus-adressering, så
-- indgående svar altid kan matches selv hvis In-Reply-To mangler.
CREATE TABLE IF NOT EXISTS threads (
  id           TEXT PRIMARY KEY,
  wedding_id   TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  vendor_id    TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  reply_token  TEXT NOT NULL UNIQUE,
  subject      TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'draft'
               CHECK (state IN ('draft','awaiting_vendor','needs_agent_reply','needs_human',
                                'quoted','closed')),
  turn_count   INTEGER NOT NULL DEFAULT 0,
  last_inbound_at  TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id)
);
CREATE INDEX IF NOT EXISTS threads_wedding_idx ON threads (wedding_id, state);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction      TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  from_email     TEXT,
  to_email       TEXT,
  subject        TEXT,
  raw_text       TEXT NOT NULL,
  clean_text     TEXT,
  message_id_hdr TEXT,
  in_reply_to    TEXT,
  refs           TEXT,
  provider_id    TEXT,
  meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS messages_msgid_idx ON messages (message_id_hdr);

-- Struktureret udtræk af ét indgående svar. Historik bevares; is_current
-- markerer det senest gældende tilbud pr. leverandør.
CREATE TABLE IF NOT EXISTS quotes (
  id                   TEXT PRIMARY KEY,
  wedding_id           TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  vendor_id            TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  thread_id            TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id           TEXT REFERENCES messages(id) ON DELETE SET NULL,
  price_min            INTEGER,
  price_max            INTEGER,
  currency             TEXT NOT NULL DEFAULT 'DKK',
  price_basis          TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (price_basis IN ('total','per_guest','per_hour','per_day','from','unknown')),
  price_includes_vat   BOOLEAN,
  estimated_total_min  INTEGER,
  estimated_total_max  INTEGER,
  availability         TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (availability IN ('available','unavailable','tentative','unknown')),
  availability_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  capacity_max         INTEGER,
  conditions_text      TEXT,
  deposit_text         TEXT,
  valid_until          DATE,
  confidence_score     REAL NOT NULL DEFAULT 0,
  needs_human_review   BOOLEAN NOT NULL DEFAULT TRUE,
  review_reasons       TEXT[] NOT NULL DEFAULT '{}',
  human_reviewed_at    TIMESTAMPTZ,
  raw_extraction       JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_current           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quotes_vendor_idx ON quotes (vendor_id, is_current);

-- Spørgsmål leverandøren stiller, som ikke kan besvares ud fra intake-data.
-- Agenten gætter aldrig; den lægger spørgsmålet her til parret.
CREATE TABLE IF NOT EXISTS open_questions (
  id          TEXT PRIMARY KEY,
  wedding_id  TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  vendor_id   TEXT REFERENCES vendors(id) ON DELETE CASCADE,
  thread_id   TEXT REFERENCES threads(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  answer      TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS open_questions_wedding_idx ON open_questions (wedding_id, status);

-- Udgående kø. Alt sendes herfra, aldrig direkte, så rate-limit og
-- dry-run gælder uanset hvilken kodesti der udløser en mail.
CREATE TABLE IF NOT EXISTS outbox (
  id            TEXT PRIMARY KEY,
  wedding_id    TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  to_email      TEXT NOT NULL,
  reply_to      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body_text     TEXT NOT NULL,
  in_reply_to   TEXT,
  refs          TEXT,
  kind          TEXT NOT NULL DEFAULT 'outreach' CHECK (kind IN ('outreach','followup','manual')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','needs_approval','sending','sent','failed','cancelled')),
  scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  dry_run       BOOLEAN NOT NULL DEFAULT TRUE,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox (status, scheduled_at);

-- Global blokliste: afmeldinger, bounces, testadresser.
CREATE TABLE IF NOT EXISTS suppressions (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Revisionsspor. Alt hvad agenten gør, logges her.
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  wedding_id  TEXT,
  vendor_id   TEXT,
  thread_id   TEXT,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_wedding_idx ON events (wedding_id, created_at DESC);

-- Idempotens for indgående webhooks (samme mail kan leveres flere gange).
CREATE TABLE IF NOT EXISTS inbound_dedup (
  fingerprint TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Er databasen en Supabase-instans, ligger `public` bag Data API'et, og nye
-- tabeller får automatisk SELECT/INSERT/UPDATE/DELETE til rollerne `anon` og
-- `authenticated`. Anon-nøglen er offentlig by design. Uden RLS ville parrets
-- og leverandørernes navne, mailadresser, telefonnumre og hele mailtråde
-- altså kunne læses — og skrives — af enhver, der kender projektets URL.
--
-- Der oprettes bevidst ingen policies. RLS uden policies nægter alt, og det
-- er præcis, hvad vi vil: ingen skal nå disse tabeller gennem Data API'et.
-- Appen selv rammes ikke. Den forbinder over DATABASE_URL som tabellernes
-- ejer, og en ejer er ikke underlagt RLS, medmindre FORCE slås til.
--
-- Uden for Supabase er det et no-op med en omkostning på nul.
-- ---------------------------------------------------------------------------
ALTER TABLE weddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_dedup ENABLE ROW LEVEL SECURITY;
