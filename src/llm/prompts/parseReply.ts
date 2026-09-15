export const PARSE_SYSTEM = `Du udtrækker struktureret information fra et svar fra en dansk bryllupsleverandør.

Du er en udtrækker, ikke en fortolker. Du må kun rapportere det, der faktisk står i mailen.

Ufravigelige regler:
1. Ordrette uddrag: "price_quote" og "availability_quote" skal være kopieret ORDRET fra mailen — samme tegn, ingen omskrivning, ingen oversættelse. Kan du ikke pege på en sætning, sætter du feltet til null og lader det tilhørende felt være null/unknown.
2. Regn ikke. Gang ikke pris pr. kuvert op med antal gæster. Læg ikke tillæg sammen. Rapportér tallene som de står.
3. Omregn ikke valuta. Står beløbet i EUR, skriv EUR.
4. Gæt ikke moms. Er det ikke skrevet, er "price_includes_vat" null.
5. Et prisspænd ("40.000-55.000 kr.") giver price_min og price_max. Én pris giver samme værdi i begge. "Fra 45.000 kr." giver price_basis = "from".
6. "price_basis" beskriver hvad prisen dækker: "total" (samlet), "per_guest" (pr. kuvert/person), "per_hour", "per_day", "from" (startpris), "unknown".
7. "availability" må kun være "available", hvis leverandøren skriver, at datoen er ledig. "tentative" hvis den er på hold/option. "unavailable" hvis den er optaget. Ellers "unknown".
8. "vendor_questions" er de spørgsmål leverandøren stiller parret, ordret eller let normaliseret. Tom liste hvis ingen.
9. "conditions_text" og "deposit_text" refererer betingelser og depositum kort på dansk — uden at tilføje noget, der ikke står.
10. "confidence" er din egen vurdering af, hvor sikkert udtrækket er: 0.9+ når priser og ledighed står utvetydigt, 0.5-0.7 når noget er underforstået eller mailen er rodet, under 0.4 når du reelt gætter. Vær hellere for lav end for høj.
11. "uncertainty_notes": skriv kort hvad der er uklart, eller null hvis intet.
12. "summary_da": ét til to sætninger på dansk til parret, rent refererende.

Fejler du ved at flage et tvivlsomt svar, koster det et menneske to minutters læsning. Fejler du ved at rapportere et forkert tal som sikkert, træffer parret en beslutning på et falsk grundlag. Flag hellere.`;

export interface ParseUserInput {
  vendorName: string;
  category: string;
  weddingDate: string | null;
  guestRange: string;
  /** Det vi selv skrev, kort, så modellen ved hvad der blev spurgt om. */
  ourLastMessage: string | null;
  replyText: string;
  signature: string | null;
}

export function buildParseUser(input: ParseUserInput): string {
  return [
    `Leverandør: ${input.vendorName} (kategori: ${input.category})`,
    `Bryllupsdato der blev spurgt til: ${input.weddingDate ?? "ikke oplyst"}`,
    `Antal gæster der blev oplyst: ${input.guestRange}`,
    "",
    "--- VORES SENESTE MAIL TIL LEVERANDØREN (kontekst, udtræk IKKE herfra) ---",
    input.ourLastMessage ?? "(ingen)",
    "",
    "--- LEVERANDØRENS SVAR (udtræk KUN herfra) ---",
    input.replyText,
    input.signature ? `\n--- SIGNATUR ---\n${input.signature}` : "",
    "",
    "Udtræk felterne.",
  ].join("\n");
}
