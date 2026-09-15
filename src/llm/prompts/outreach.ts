import type { Vendor, Wedding } from "../../domain/types.js";
import { renderFactSheet } from "./factSheet.js";

const CATEGORY_LABEL: Record<string, string> = {
  venue: "bryllupslokale/festlokale",
  photographer: "bryllupsfotograf",
};

const CATEGORY_ASK: Record<string, string> = {
  venue:
    "om datoen er ledig, hvad lokalet koster for det antal gæster (og om prisen er pr. kuvert eller samlet), hvad der er inkluderet, og om der er krav om fast cateringleverandør",
  photographer:
    "om datoen er ledig, hvad en fuld bryllupsdag koster, hvor mange timers dækning der indgår, og hvornår billederne leveres",
};

export const OUTREACH_SYSTEM = `Du skriver den første henvendelse til en dansk bryllupsleverandør på vegne af et par.

Du skriver som parrets planlægger, ikke som parret selv. Modtageren er en travl professionel, der får mange forespørgsler.

Ufravigelige regler:
- Brug UDELUKKENDE oplysninger fra faktaarket. Opfind aldrig detaljer om parret, brylluppet eller budgettet. Er noget ikke i arket, findes det ikke.
- Nævn aldrig parrets budget som et tal over for leverandøren.
- Lov ikke noget, book ikke noget, og accepter ikke vilkår.
- Skriv dansk. Ingen emojis. Ingen udråbstegn i hver sætning. Ingen salgsfloskler.
- 120-180 ord. Konkret og let at svare på.
- Stil præcis de spørgsmål, der er nævnt i opgaven — ikke flere. Hvert spørgsmål på sin egen linje med bindestreg.
- Nævn leverandørens navn og mindst ét konkret træk ved brylluppet, så mailen ikke kan forveksles med en masseudsendelse.
- Afslut med at det er planlæggeren, der skriver på vegne af parret, og at svar sendes retur på denne mail.
- Emnelinje: kort, faktuel, med dato og kategori. Ingen "Hej" i emnelinjen.`;

export function buildOutreachUser(input: {
  wedding: Wedding;
  vendor: Vendor;
  answered?: Array<{ question: string; answer: string }>;
}): string {
  const { wedding, vendor } = input;
  const label = CATEGORY_LABEL[vendor.category] ?? vendor.category;
  const ask = CATEGORY_ASK[vendor.category] ?? "pris og ledighed";
  return [
    `Leverandør: ${vendor.name} (${label})`,
    vendor.city ? `By: ${vendor.city}` : null,
    vendor.website ? `Hjemmeside: ${vendor.website}` : null,
    "",
    "FAKTAARK OM BRYLLUPPET (eneste tilladte kilde):",
    renderFactSheet(wedding, input.answered ?? []),
    "",
    `Formålet med mailen: få svar på ${ask}.`,
    "",
    "Skriv emnelinje og brødtekst.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}
