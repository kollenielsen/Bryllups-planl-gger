# bryllupsplaner

De to sider, der er publiceret som Artifacts på claude.ai. Kilden ligger her, så
den kan versionsstyres, rettes lokalt og genpubliceres.

| Fil | Hvad det er | Publiceret |
| --- | --- | --- |
| `bryllupsagenten.html` | Selve agenten: oplæg → leverandørforslag → mails → verifikation af svar | <https://claude.ai/artifact/3ApBGvWJSCmreYt6Gf1Xko> |
| `oversigt.html` | Præsentationssiden, der forklarer hvad der er bygget | <https://claude.ai/artifact/TC1ghqxvDBjB32yqR15A8B> |

Begge er private. De kan kun åbnes af ejeren, indtil de deles fra Share-menuen
på siden.

## Forholdet til resten af repoet

`src/` er serverversionen: Node, Postgres, udgående kø, webhook til indgående
mail. Den automatiserer afsendelse og modtagelse, men kræver et domæne med SPF,
DKIM og DMARC, før den kan sende noget.

`bryllupsplaner/bryllupsagenten.html` er samme produkt uden mailtransport.
Parret kopierer mailen over i sit eget mailprogram og indsætter svaret bagefter.
**Verifikationslaget er det samme i begge** — reglerne fra `src/domain/confidence.ts`
og `src/domain/money.ts` er portet til siden, så et beløb, der ikke kan genfindes
i leverandørens mail, heller ikke her må vises som en pris.

Ændrer du en verifikationsregel ét sted, skal den følge med det andet. De to
kopier er en bevidst afvejning: siden kan ikke importere fra `src/`, fordi en
Artifact er én selvstændig fil.

## Sådan ser du dem lokalt

Filerne er *Artifact-kilder*. Platformen pakker dem selv ind i
`<!doctype html><html><head>…</head><body>` ved publicering, så de starter
direkte med `<title>`. Browsere er tolerante og viser dem fint alligevel:

```
open bryllupsagenten.html        # macOS
xdg-open bryllupsagenten.html    # Linux
```

Vil du have dem helt som i den publicerede udgave — med viewport-meta og
sikkerhedsmargener til telefoner — så byg indpakkede kopier i `_lokal/`:

```
./byg-lokal.sh
```

Bemærk, at `bryllupsagenten.html` kun er halvt levende uden for claude.ai.
Den henter `window.claude` for at gemme data og for at spørge Claude, og dem
findes ikke i en almindelig browser. Siden er skrevet til at klare det: den
tegner sig selv alligevel og skriver øverst, at den hverken kan gemme eller
lade agenten arbejde. `oversigt.html` er ren HTML og ser ens ud overalt.

## Sådan genpubliceres de

Redigér filen her, og bed Claude publicere den til den samme URL. Samme URL
kræver, at der publiceres med `url`-parameteren — ellers oprettes en ny,
selvstændig Artifact ved siden af.
