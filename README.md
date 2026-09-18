# Bryllupsplanlægger — outreach-agent til leverandører

Et par beskriver deres bryllup én gang. Derefter finder agenten lokaler og
fotografer, skriver til dem, fører samtalen videre når de svarer, og lægger
priser, ledighed og betingelser op i en sammenligningsvisning. Parret
godkender og booker — de skriver ikke selv mails.

MVP dækker to kategorier: **lokale** og **fotograf**.

## Hvad der virker nu

- Intake-formular → bryllupsprofil i databasen.
- Leverandørsøgning: kurateret demoliste eller Google Places (New) med
  efterfølgende skrabning af mailadresse fra leverandørens hjemmeside.
- Personlige førstehenvendelser skrevet af Claude ud fra et faktaark.
- Indgående svar via webhook: trådmatchning, rensning, klassificering,
  struktureret udtræk, verifikation mod kildeteksten, opfølgende svar.
- Sammenligningsvisning med pris, ledighed, betingelser og hele tråden.
- Bookingoversigt med udkast til bekræftelsesmail, som parret selv sender.

## Kom i gang

```bash
npm install
cp .env.example .env     # virker også uden — alt har defaults
npm run demo             # kører hele forløbet igennem med en scriptet model
npm run dev              # http://localhost:3000
```

`npm run demo` kræver hverken API-nøgle, database eller mailserver. Den
kører den rigtige kode hele vejen — kø, trådtilstand, verifikation, flagning
— men med faste modelsvar i stedet for API-kald, og skriver mails til
`./outbox` i stedet for at sende dem. Et af de scriptede svar indeholder
bevidst en pris, der ikke står i leverandørens mail, så man kan se
verifikationen fange den.

For rigtig drift skal `ANTHROPIC_API_KEY` sættes.

## Arkitektur

```
Intake ──► Leverandørsøgning ──► Udkast (Claude) ──► Udgående kø ──► Mail
                                                                      │
                                     ┌────────────────────────────────┘
                                     ▼
Webhook ──► Trådmatch ──► Rensning ──► Klassificering ──► Udtræk (Claude)
                                            │                    │
                                     bounce/framelding/      Verifikation
                                     autosvar: stop her           │
                                                     ┌────────────┴────────┐
                                                     ▼                     ▼
                                              Tilbud i dashboard    Til manuel læsning
                                                     │
                                                     ▼
                                          Opfølgende svar (Claude) ──► kø
```

| Lag | Filer |
|---|---|
| Skema | `db/schema.sql` |
| Domænelogik uden IO | `src/domain/` — tekstrensning, beløb, verifikation, skemaer |
| Modelkald | `src/llm/` — klient, prompter, faktaark |
| Mail | `src/email/` — udbydere, trådmatchning, webhook-normalisering |
| Leverandørsøgning | `src/discovery/` |
| Forretningslogik | `src/services/` |
| API + frontend | `src/http/`, `src/public/` |

Databasen er Postgres. Uden `DATABASE_URL` kører den på PGlite (Postgres
kompileret til WASM) med filpersistens i `./data/pgdata` — samme SQL, intet
at installere. Sættes `DATABASE_URL`, bruges `pg` mod fx Supabase. Skiftet
kræver ingen kodeændringer.

## De fire risici og hvad der er gjort ved dem

### 1. Udtræk af indgående mails

Bygget først, og testet på rigtige mailformer før dashboardet.

- **Citeret historik skæres væk** før modellen ser mailen — både Gmails
  `Den … skrev …:` og Outlooks `Fra:/Sendt:/Til:/Emne:`-blok. Ellers
  udtrækkes vores egen forrige mail som om den var leverandørens svar.
- **Billige afgørelser før dyre.** Bounce, framelding og autosvar fanges
  med mønstre og headere. De koster ingen tokens og må ikke fejltolkes:
  en feriehilsen er ikke et tilbud.
- **Ordrette uddrag.** Modellen skal returnere `price_quote` og
  `availability_quote` kopieret ordret fra mailen. Bagefter tjekkes det i
  kode, at uddraget faktisk står der (`quoteIsGrounded`), og at beløbet
  optræder i teksten (`amountAppearsInText`). Gør det ikke det, er
  udtrækket ikke funderet, uanset hvor sikker modellen lyder.
- **Modellen regner ikke.** Kuvertpriser ganges op med gæstetallet i
  `estimateTotal()`, ikke i prompten. Et sammenligningstal skal kunne
  efterprøves.

### 2. Tilstand over flere runder

Hver leverandør har præcis én tråd (`threads.vendor_id` er unik) med sin
egen `reply_token`, `state` og `turn_count`. Svar matches i tre trin:
plus-adressering i `Reply-To` → `In-Reply-To`/`References` mod vores egne
`Message-ID`'er → leverandørens afsenderadresse. Ingen af dem holder alene:
plus-adressen overlever klienter der taber `References`, og
`In-Reply-To` overlever leverandører der skriver til afsenderadressen.
Sidste trin bruges kun hvis matchet er entydigt — den samme leverandør kan
være kontaktet for flere bryllupper, og et gæt ville svare med det forkerte
pars oplysninger. Er der tvivl, ender mailen som uparret.

Beslutningen om, *hvorvidt* der skal svares, ligger i `decideNextStep()` —
almindelig kode, ikke i modellen. Modellen skriver teksten. Loftet
`MAX_TURNS_PER_THREAD` tælles på agentens egne mails i tråden, inklusive dem
der stadig ligger i køen; derover stopper agenten og overlader tråden til
parret.

### 3. Lav sikkerhed → menneske

`groundExtraction()` giver hvert fund en alvorlighed. Alt med `block` — pris
uden belæg, omvendt prisspænd, ledighed uden citat, modstrid i udtrækket —
sender svaret i kø til manuel læsning og viser aldrig tallet som faktum.
`warn` (manglende momsoplysning, uklart prisgrundlag) trækker ned i scoren,
men blokerer ikke alene.

Samme princip gælder den anden vej: spørgsmål fra leverandøren, som ikke
kan besvares ud fra faktaarket, bliver aldrig gættet. De lander i
`open_questions` og vises i dashboardet under "Venter på jer". Agenten
skriver i mellemtiden, at den vender tilbage med svar.

### 4. Afsendelse og leverbarhed

Ingen kode sender mail direkte. Alt går gennem `outbox`:

- `DRY_RUN=true` som default — intet forlader maskinen, mails skrives til
  `./outbox` som `.eml`.
- Førstehenvendelser kræver godkendelse i dashboardet
  (`REQUIRE_SEND_APPROVAL`). Opfølgninger i en igangværende tråd sender
  agenten selv — ellers er samtaleløkken ikke en løkke.
- Maks. antal pr. time, minimumsafstand mellem to mails, tilfældigt spring
  oveni, og et kontortidsvindue. Tyve mails fra samme adresse på ét minut
  er den hurtigste vej i spamfilteret.
- Blokliste ved bounce og framelding. En blokeret adresse kan ikke lægges
  i kø igen, heller ikke fra en anden kodesti.

## Test

```bash
npm test              # 84 tests, ingen netværk, ingen API-nøgle
npm run typecheck
npm run eval:parse    # kræver ANTHROPIC_API_KEY — kalder den rigtige model
```

`npm test` kører hele den indgående vej mod en scriptet model
(`ScriptedLlmClient`) og en Postgres i hukommelsen, med rigtige danske
leverandørsvar som testdata i `tests/fixtures/emails/`.

`npm run eval:parse` kører udtrækket med den rigtige model mod de samme
mails og holder resultatet op mod `tests/fixtures/expectations.json`. Kør
den før og efter enhver ændring i `PARSE_SYSTEM` — det er den eneste måde
at vide, om en promptændring hjalp.

## Deploy: Render + Supabase

Backend'en er en Express-server med en outbox-worker, der takter mails over
timer (fire minutters mellemrum, kontortid, maks. seks i timen). Den skal køre
som én vedvarende proces. `render.yaml` beskriver servicen; `Dockerfile` er
byggeartefaktet.

1. **Supabase.** Opret projektet, og hent forbindelsesstrengen under *Connect*.
   Fejler den direkte streng med en netværksfejl, så tag session pooler-strengen
   — den direkte vært er IPv6 på nyere projekter. Skemaet kører af sig selv ved
   opstart; `migrate()` er idempotent.
2. **Render.** Importér `render.yaml`, eller opret en web service manuelt med
   samme indstillinger. Vælg **ikke** gratis-planen: den lukker ned ved
   inaktivitet, og så holder worker'en op med at tikke, uden at noget fejler
   synligt.
3. **Miljøvariabler.** `DATABASE_URL`, `ANTHROPIC_API_KEY` og `BASE_URL` sættes
   i dashboardet. `APP_PASSWORD` og `INBOUND_WEBHOOK_SECRET` genererer Render.
   `NODE_ENV=production` er ikke valgfri — den er det, der gør adgangskoden
   påkrævet.
4. **`DRY_RUN` bliver stående på `true`**, indtil maildomænet er på plads.

### Tabellerne er lukket for Supabases Data API

Supabase lægger `public` bag et HTTP-API, og nye tabeller dér får automatisk
rettigheder til rollerne `anon` og `authenticated`. Anon-nøglen er offentlig
by design. Uden yderligere tiltag ville parrets og leverandørernes navne,
mailadresser, telefonnumre og hele mailtråde altså kunne læses og skrives af
enhver, der kender projektets URL.

Derfor slår `db/schema.sql` Row Level Security til på alle elleve tabeller og
opretter bevidst ingen policies: RLS uden policies nægter alt. Appen selv
rammes ikke — den forbinder som tabellernes ejer, og en ejer er ikke underlagt
RLS. Uden for Supabase er det et no-op.

**Opretter du en ny tabel, skal den have samme linje.** Ellers står den åben.

## Klar til produktion — huskeliste

1. **Maildomæne.** SPF, DKIM og DMARC på `EMAIL_REPLY_DOMAIN`. Uden dem
   ryger henvendelserne i spam, og så virker resten ikke.
2. **Indgående webhook.** Peg udbyderen (Postmark, SendGrid Inbound Parse,
   Mailgun) på `POST /webhooks/inbound` og sæt `INBOUND_WEBHOOK_SECRET`.
   Webhooken svarer 200 også ved fejl, så udbyderen ikke genleverer i
   ring — fejlen logges i `events`.
3. **Database.** Sæt `DATABASE_URL` til Supabase eller anden Postgres.
   Nye tabeller skal have RLS slået til — se ovenfor.
4. **`ANTHROPIC_API_KEY`.**
5. **`DRY_RUN=false`** — bevidst, som sidste skridt.
6. **Leverandørliste.** Demolisten i `src/discovery/seed.json` er opdigtet
   og bruger `example.com`, netop for at en fejlkonfigureret kørsel ikke
   kan ramme en rigtig leverandør. Skift til `DISCOVERY_PROVIDER=places`
   eller indlæs en kurateret liste.

### En juridisk bemærkning, ikke juridisk rådgivning

Henvendelserne er konkrete forespørgsler på et tilbud, ikke markedsføring,
og går til virksomheders kontaktadresser. Hver mail indeholder en fast
linje om, at man bare skal sige til, hvis man ikke ønsker henvendelser, og
en framelding sætter adressen på bloklisten med det samme. Agenten
accepterer aldrig tilbud, aftaler ikke depositum og skriver ikke under —
`buildBookingSummary()` laver et udkast, som parret selv sender.

## API

| Metode | Sti | Hvad |
|---|---|---|
| `POST` | `/api/weddings` | Opret bryllup (intake) |
| `GET` | `/api/weddings/:id/dashboard` | Samlet visning |
| `POST` | `/api/weddings/:id/discover` | Find leverandører |
| `POST` | `/api/weddings/:id/outreach` | Skriv førstehenvendelser (kategori) |
| `GET` | `/api/weddings/:id/outbox` | Kø |
| `POST` | `/api/outbox/:id/approve` · `/cancel` · `/api/outbox/run` | Styr køen |
| `GET` | `/api/weddings/:id/review` | Tilbud der skal læses manuelt |
| `POST` | `/api/quotes/:id/review` | Marker som læst, evt. med rettede tal |
| `GET` | `/api/weddings/:id/questions` · `POST /api/questions/:id/answer` | Spørgsmål til parret |
| `GET` | `/api/threads/:id` · `POST /api/threads/:id/followup` | Tråd og opfølgning |
| `GET` | `/api/vendors/:id/booking-summary` · `POST /api/vendors/:id/book` | Booking |
| `POST` | `/webhooks/inbound` | Indgående mail |
| `POST` | `/api/dev/simulate-reply` | Injicér et svar uden mailserver |

## Kendte begrænsninger

- Kun dansk, kun mail, kun lokale og fotograf.
- Google Places returnerer ikke mailadresser. Skrabningen af hjemmesiden
  finder en adresse for de fleste, men ikke alle. Leverandører uden fundet
  mail får status `no_contact` og skal håndteres manuelt.
- Ingen vedhæftede filer. Sender en leverandør sit tilbud som PDF, ser
  agenten kun brødteksten og flager svaret.
- Ingen autentificering på API'et. Det skal på plads før flere par deler
  installationen.
- `processOutbox()` kører i samme proces som webserveren. Ved flere
  instanser skal `UPDATE ... RETURNING`-låsen i køen suppleres med en
  rigtig jobkø.

## Næste skridt

1. Vedhæftede filer: hent PDF-tilbud ind i udtrækket.
2. Flere kategorier — catering, musik, blomster. Skemaet er klar; kun
   `CATEGORY_ASK` i outreach-prompten og kategorilisten skal udvides.
3. Autentificering og flere brugere pr. installation.
4. Genopfriskning: leverandører der ikke har svaret efter fem dage.
