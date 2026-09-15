import type { Vendor, Wedding } from "../../domain/types.js";
import { renderFactSheet } from "./factSheet.js";

export const FOLLOWUP_SYSTEM = `Du skriver et svar tilbage til en dansk bryllupsleverandør i en igangværende mailtråd, på vegne af et par.

Ufravigelige regler:
- Faktaarket er din eneste kilde. Kan et spørgsmål ikke besvares ud fra arket, må du IKKE gætte, skønne eller formulere dig uden om. Læg spørgsmålet i "unanswerable_questions" og skriv i mailen, at du vender tilbage med svar.
- Det gælder også tilsyneladende harmløse detaljer: ankomsttidspunkt, menuvalg, om der er børn med, om der skal være tale om vielse på stedet. Står det ikke i arket, ved du det ikke.
- Accepter ikke tilbud, bekræft ikke booking, godkend ikke betingelser og aftal ikke depositum. Beder leverandøren om underskrift, depositum, kontrakt eller et telefonmøde, sættes "needs_human" til true.
- Er datoen optaget, eller er leverandøren ikke interesseret: svar kort og pænt, og sæt "should_reply" til true med en afsluttende mail. Er der intet meningsfuldt at svare (fx ren kvittering), sæt "should_reply" til false.
- Skriv dansk, 60-140 ord, ingen emojis, ingen gentagelse af hele den forrige mail.
- Skriv kun brødteksten. Ingen emnelinje, ingen citeret historik.
- Slutter du med at spørge om noget, så stil højst to spørgsmål.`;

export function buildFollowUpUser(input: {
  wedding: Wedding;
  vendor: Vendor;
  transcript: Array<{ direction: "outbound" | "inbound"; text: string }>;
  vendorQuestions: string[];
  answered: Array<{ question: string; answer: string }>;
  /** Fri instruks fra parret, fx "spørg om de har overnatning". */
  coupleInstruction?: string | null;
}): string {
  const transcript = input.transcript
    .map((m) => `[${m.direction === "outbound" ? "OS" : "LEVERANDØR"}]\n${m.text}`)
    .join("\n\n");

  return [
    `Leverandør: ${input.vendor.name} (${input.vendor.category})`,
    "",
    "FAKTAARK OM BRYLLUPPET (eneste tilladte kilde):",
    renderFactSheet(input.wedding, input.answered),
    "",
    "--- TRÅDEN INDTIL NU ---",
    transcript,
    "",
    "Spørgsmål leverandøren har stillet:",
    input.vendorQuestions.length
      ? input.vendorQuestions.map((q) => `- ${q}`).join("\n")
      : "- (ingen direkte spørgsmål)",
    "",
    ...(input.coupleInstruction
      ? [`Parret har desuden bedt om, at denne mail dækker: ${input.coupleInstruction}`, ""]
      : []),
    "Skriv svaret.",
  ].join("\n");
}
