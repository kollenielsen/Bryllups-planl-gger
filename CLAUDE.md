# CLAUDE.md

Orientering for en ny session. `README.md` beskriver produktet og arkitekturen;
denne fil holder styr på det, der ikke fremgår af koden selv: hvor vi arbejder,
hvad der er to kopier af, og hvad der ikke må gå tabt ved en ændring.

## Repoet er to versioner af det samme produkt

| | `src/` | `bryllupsplaner/bryllupsagenten.html` |
| --- | --- | --- |
| Hvad | Serverversionen: Node, Postgres, udgående kø, webhook til indgående mail | Samme produkt uden mailtransport, publiceret som Artifact på claude.ai |
| Mail | Automatiseret — men kan ikke sende rigtigt endnu | Parret kopierer mailen over i sit eget mailprogram og indsætter svaret bagefter |
| Kørsel | `npm run dev`, `npm run demo` | Én selvstændig HTML-fil, `window.claude` til lagring og modelkald |

Serverversionen kan **ikke sende rigtig mail**, før der findes et maildomæne med
SPF, DKIM og DMARC på `EMAIL_REPLY_DOMAIN`. Indtil da er `DRY_RUN=true` default,
og alt skrives som `.eml` til `./outbox`. Det er ikke en midlertidig
bekvemmelighed — uden domænet ryger henvendelserne i spam, og så virker resten
af produktet heller ikke. Sæt aldrig `DRY_RUN=false` som en del af en ændring.

`bryllupsplaner/README.md` har artifact-URL'erne og hvordan siderne
genpubliceres (samme URL kræver `url`-parameteren, ellers oprettes en ny).

## Branch og PR

**Default-branchen hedder `claude/wedding-vendor-outreach-mvp-u82pk4`.** Repoet
har ingen `main` — det er værd at vide, før du leder efter en.

PR [#1](https://github.com/kollenielsen/Bryllups-planl-gger/pull/1) er merget
ind i den, så alt ligger nu på default: verifikationslaget, adgangskoden, CI
og hele deployet. Nyt arbejde brancher fra default og får sin egen PR.

## Før du ændrer noget

```bash
npm install && npm test     # 100 tests, ingen netværk, ingen API-nøgle
npm run typecheck
```

Alle 100 skal være grønne, før du rører ved noget. Testene kører hele den
indgående vej mod en scriptet model og en Postgres i hukommelsen, med rigtige
danske leverandørsvar i `tests/fixtures/emails/`.

### Databasen lokalt

Uden `DATABASE_URL` kører appen på PGlite — Postgres i WASM, intet at
installere. Det er default og fint til at komme i gang.

Produktionen er Render Postgres, og `npm test` rammer **aldrig** pg-driveren i
`src/db/index.ts`: testharnessen bruger `useInMemoryDb()`, som altid er PGlite.
Vil du teste den sti, så kør en rigtig Postgres:

```bash
docker compose up -d db     # Postgres 16 på localhost:5432
# i .env:  DATABASE_URL=postgresql://bryllup:bryllup@localhost:5432/bryllup
npm run dev
```

`docker compose up --build` kører hele stakken i containere i stedet.
`docker compose down -v` sletter også data.

`DATABASE_SSL` afgør TLS mod databasen. Usat gættes der på værtsnavnet:
localhost uden, alt andet med. En Postgres i Docker taler ren TCP og afviser
SSLRequest, så mod et compose-servicenavn (`db`) skal den sættes til `false`
— ellers er det en hård forbindelsesfejl, ikke bare et unødigt håndtryk.

### CI

`.github/workflows/ci.yml` kører på hvert push og hver PR: `npm run typecheck`
+ `npm test`, og et separat job der kører `npm run migrate` to gange mod en
rigtig Postgres 16. Det andet job findes, fordi skemaet og pg-driveren ellers
kun er afprøvet mod PGlite — og fordi skemaet påstår at være idempotent.

`npm run eval:parse` kræver `ANTHROPIC_API_KEY` og kalder den rigtige model.
Kør den før og efter enhver ændring i `PARSE_SYSTEM` — det er den eneste måde
at vide, om en promptændring hjalp.

## Kernen: verifikationslaget findes i to kopier

`src/domain/confidence.ts` og `src/domain/money.ts` er produktets kerne. Reglen
er én sætning: **et beløb, der ikke kan genfindes ordret i leverandørens mail,
må aldrig vises som en pris.** Modellen må læse mailen, men den må ikke være
eneste kilde til et tal, parret træffer beslutning på.

De samme regler er portet til almindelig ES5-JavaScript inde i
`bryllupsplaner/bryllupsagenten.html`, ca. linje 275–400:

| `src/domain/` | `bryllupsagenten.html` |
| --- | --- |
| `money.ts` · `parseDanishAmount`, `findAmounts`, `amountAppearsInText`, `estimateTotal`, `formatDkk` | samme navne, linje ~287–398 |
| `confidence.ts` · `quoteIsGrounded`, `groundExtraction`, `PENALTY`, `PLAUSIBLE` | samme navne, linje ~334–385 |
| `services/dashboard.ts` · `price_verified`, `availability_confirmed`, sortering | `quoteVerified()`, "Pris ikke bekræftet", "Ledig — ikke bekræftet", linje ~1160, ~1271, ~1286 |

**Ændrer du en verifikationsregel ét sted, skal den følge med det andet.**
Duplikeringen er en bevidst afvejning: en Artifact er én selvstændig fil og kan
ikke importere fra `src/`. Testene dækker kun `src/`-siden, så HTML-kopien
fanges ikke af `npm test` — den skal tjekkes i hånden.

### Bevidste forskelle mellem de to kopier

Disse er med vilje og skal ikke "rettes" til at ligne hinanden:

- `estimateTotal` i HTML tager kun `guests`, ikke `hours`, og understøtter
  derfor ikke `per_hour`. Siden indsamler ikke timetal.
- Tærsklen er hårdkodet `THRESHOLD = 0.7` i HTML; i `src/` kommer den fra
  `config.agent.confidenceThreshold`.
- `amountAppearsInText` bruger `(?:^|[^\d.,])` i HTML mod lookbehind
  `(?<![\d.,])` i `src/` — samme resultat, men uden lookbehind af hensyn til
  ældre browsere.

## Adgang

`/api/*` og den statiske frontend er bag Basic Auth (`src/http/auth.ts`,
`APP_USER` / `APP_PASSWORD`). Appen er bygget til ét par ad gangen og har
ingen brugerkonti; skal flere par dele en installation, er svaret rigtige
konti — ikke en ekstra delt kode.

To ting står bevidst åbne, og rækkefølgen i `createApp()` er selve politikken:

- `/health`, så en platform kan sundhedstjekke appen.
- `/webhooks/*`, fordi mailudbyderen ikke kan sende Basic Auth. Den har sin
  egen hemmelighed i `INBOUND_WEBHOOK_SECRET`.

Uden `APP_PASSWORD` er appen åben lokalt, men **nægter at starte** med
`NODE_ENV=production`. Det er med vilje: en gate, der falder tilbage til at
lukke op, er værre end ingen gate, fordi en glemt miljøvariabel så lægger alt
åbent uden at nogen opdager det.

## Deploy

Alt kører på Render, i workspacet *Magnus Kolle*, region frankfurt:

| | |
| --- | --- |
| Service | `bryllupsplanlaegger` · <https://bryllupsplanlaegger.onrender.com> |
| Database | `bryllup-db` · Render Postgres 17 |

Servicen bygger Dockerfilen fra repoets branch og auto-deployer ved push.
Skemaet kører af sig selv ved opstart. Se README for miljøvariabler.

**Vi bruger ikke længere Supabase, og dermed heller ikke Vercel.** Supabase-
projektet `supabase-citrine-pebble` lå i en Vercel-provisioneret organisation,
hvor projekter kun kan oprettes gennem Vercels dashboard. Render leverer selv
Postgres, så hele den binding er væk. Det, der stadig ligger på den Supabase-
instans, tilhører en anden app (`profiler`) — ikke denne.

Tre ting om driften:

- **Gratis-databasen udløber efter 30 dage.** Renders API returnerer et
  `expiresAt` ved oprettelsen. Med rigtige data skal den opgraderes inden da.
- **En gratis web service lukker ned ved inaktivitet**, og så stopper
  outbox-worker'en. Køen takter mails over timer, så det fejler ikke synligt
  — afsendelsen holder bare op.
- **`tsx` er en runtime-afhængighed, ikke en dev-afhængighed.** `npm start`
  er `tsx src/main.ts`, og `NODE_ENV=production npm ci` springer
  devDependencies over. Flyttes den tilbage, starter appen ikke i produktion.
- **`DATABASE_URL` skal være sat i drift.** Uden den falder `getDb()` tilbage
  på PGlite — en hel Postgres i WebAssembly inde i Node-processen. Den fylder
  mere end de 512 MB på Renders gratis-instans, og appen dør under opstart,
  før den åbner en port. Fejlen ligner et hostingproblem, men er et
  databasevalg. PGlite-importen er dynamisk, så en sat `DATABASE_URL`
  betyder, at WASM'en aldrig indlæses.

Dashboardet findes også som et fastfrosset øjebliksbillede, man kan browse
uden server, nøgle eller adgangskode:
<https://claude.ai/artifact/3LyVb57eSYoxeMyNj2uuRE>

Det er ikke en fil i repoet, men genereret: kør `npm run demo`, start serveren
mod den samme `PGLITE_DIR`, hent `/api/config`, `/api/weddings`,
`/api/weddings/:id/dashboard`, `/api/weddings/:id/outbox` og `/api/threads/:id`,
og læg dem ind bag en `fetch`-shim sammen med `src/public/`. Den går stale, hvis
frontend'en ændrer sig — så genskab den frem for at rette i den.

Servicen skal deploye fra default-branchen. Renders API kan ikke ændre den
indstilling — kun oprette services, læse dem og sætte miljøvariabler — så
branchen skiftes i dashboardet under *Settings*.

## Regler der ikke må regressere

Hver af disse er en fejl, der har været der én gang, og som en test nu holder
fast. Ændrer du noget i nærheden, så læs testen først.

- **Koden beslutter, modellen skriver.** `decideNextStep()` i
  `src/services/conversation.ts` afgør *om* der skal svares. Modellen leverer
  kun teksten. Flyt aldrig den beslutning ind i en prompt.
- **Modellen regner ikke.** Kuvertpriser ganges op i `estimateTotal()`, ikke i
  prompten. Et sammenligningstal skal kunne efterprøves.
- **Trådmatchning må ikke gætte.** Tre trin: plus-adresse i `Reply-To` →
  `In-Reply-To`/`References` → afsenderadresse. Sidste trin bruges kun, hvis
  matchet er entydigt. Den samme leverandør kan være kontaktet for to
  bryllupper; et gæt ville svare med det forkerte pars dato og budget. Ved tvivl
  ender mailen som uparret.
- **`MAX_TURNS_PER_THREAD` tælles på agentens egne mails i tråden**, inklusive
  dem der stadig ligger i køen — ikke på `turn_count`, som tæller begge veje.
- **Kun førstehenvendelsen flytter leverandørstatus.** En opfølgning må ikke
  rulle `quoted` eller `rejected` tilbage til `contacted`.
- **Et ublokeret tal er ikke en bekræftet pris.** Verifikationen kan afvise et
  beløb korrekt, og dashboardet kan stadig vise det med samme typografi som en
  verificeret pris og sortere det øverst som det billigste. `price_verified`
  findes netop for at den regel ligger ét sted. Gælder begge versioner.
- **Ukendte svar gættes ikke.** Spørgsmål fra leverandøren, som ikke kan
  besvares ud fra faktaarket, lander i `open_questions` til parret.
- **SQL-kolonnenavne kommer aldrig fra en request-body.** `markQuoteReviewed()`
  bygger sin `SET`-liste fra en fast kolonneliste.
- **Nye tabeller skal have RLS.** `db/schema.sql` slår Row Level Security til
  på alle tabeller uden policies. På Render Postgres er det et no-op, men
  linjerne bliver stående: peges `DATABASE_URL` nogensinde mod en Supabase-
  instans, ligger `public` bag et HTTP-API, hvor nye tabeller automatisk får
  rettigheder til den offentlige `anon`-rolle. Uden RLS ville parrets og
  leverandørernes kontaktoplysninger og hele mailtråde stå åbne. Glemmes
  linjen på en ny tabel, er den beskyttelse væk.
- **Adgangskoden må aldrig fejle åben.** Mangler `APP_PASSWORD` i produktion,
  skal appen nægte at starte — ikke lukke op. Sammenligningen af koden sker i
  konstant tid.
- **Agenten accepterer ikke tilbud.** `buildBookingSummary()` laver et udkast,
  parret selv sender. Ingen depositum, ingen underskrift.

## Sprog og konventioner

Alt brugervendt er dansk: kode-kommentarer, commit-beskeder, PR-tekst,
README'er og selve produktet. Identifikatorer og kolonnenavne er engelske.
Dokumentér *hvorfor*, ikke *hvad* — de eksisterende kommentarer forklarer
afvejninger, ikke syntaks. Hold den tone.

`src/discovery/seed.json` er opdigtet og bruger `example.com` med vilje, så en
fejlkonfigureret kørsel ikke kan ramme en rigtig leverandør. Lad den være det.
