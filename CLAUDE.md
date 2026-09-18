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

Vi arbejder på `claude/eloquent-bell-2u0836`. PR er
[#1](https://github.com/kollenielsen/Bryllups-planl-gger/pull/1), åben som
draft. Basen er `claude/wedding-vendor-outreach-mvp-u82pk4`, ikke
default-branchen — tjek hvad du brancher fra.

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

Produktionen er rigtig Postgres (Supabase), og `npm test` rammer **aldrig**
pg-driveren i `src/db/index.ts`: testharnessen bruger `useInMemoryDb()`, som
altid er PGlite. Vil du teste den sti, så kør en rigtig Postgres:

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

Render kører backend'en fra `Dockerfile` efter `render.yaml`; Supabase er
databasen. Se README for trinene.

Supabase-projektet er `supabase-citrine-pebble`
(`ubndlpawbcmpmoiidreo`, eu-central-1, Postgres 17). Skemaet er lagt ind, og
alle elleve tabeller har RLS slået til. Bemærk to ting om det projekt:

- **Det deles med en anden app.** `public.profiler` og funktionen
  `public.opret_profil()` hører ikke til her. Lad dem være.
- **Organisationen er Vercel-provisioneret** (`vercel_icfg_…`). Ifølge
  Supabases dokumentation kan projekter i sådan en organisation *kun*
  oprettes via Vercels dashboard, og faktureringen løber over Vercel. Et nyt
  projekt kan altså ikke oprettes herfra.

To ting er værd at huske om driften:

- **Ikke gratis-planen på Render.** En service, der lukker ned ved
  inaktivitet, stopper outbox-worker'en, og køen takter mails over timer.
  Det fejler ikke synligt — afsendelsen holder bare op.
- **`tsx` er en runtime-afhængighed, ikke en dev-afhængighed.** `npm start`
  er `tsx src/main.ts`, og `NODE_ENV=production npm ci` springer
  devDependencies over. Flyttes den tilbage, starter appen ikke i produktion.

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
- **Nye tabeller skal have RLS.** Supabase lægger `public` bag et HTTP-API og
  giver nye tabeller rettigheder til den offentlige `anon`-rolle automatisk.
  `db/schema.sql` slår derfor Row Level Security til på alle tabeller uden
  policies — RLS uden policies nægter alt, og appen rammes ikke, fordi den
  forbinder som ejer. Glemmes linjen på en ny tabel, står den åben.
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
