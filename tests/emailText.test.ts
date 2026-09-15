import { describe, expect, it } from "vitest";
import { classifyReply, splitEmail } from "../src/domain/emailText.js";
import { fixture } from "./helpers.js";

describe("splitEmail", () => {
  it("skærer Gmail-citeret historik væk", () => {
    const { reply, quoted } = splitEmail(fixture("venue-quote-per-guest.txt"));
    expect(reply).toContain("1.250 kr. pr. kuvert");
    expect(reply).not.toContain("Vi skriver på vegne af Mia og Jonas");
    expect(quoted).toContain("Vi skriver på vegne af Mia og Jonas");
  });

  it("skærer Outlook-headerblok væk", () => {
    const { reply, quoted } = splitEmail(fixture("outlook-history.txt"));
    expect(reply).toContain("45.000 kr. samlet");
    expect(reply).not.toContain("Sendt: 3. marts 2026");
    expect(quoted).toContain("Sendt: 3. marts 2026");
  });

  it("skiller signaturen fra brødteksten", () => {
    const { reply, signature } = splitEmail(fixture("venue-quote-per-guest.txt"));
    expect(signature).toContain("Anne Sørensen");
    expect(reply).not.toContain("Anne Sørensen");
  });

  it("tømmer ikke en mail der kun består af en hilsen", () => {
    const { reply } = splitEmail("Mvh Anne");
    expect(reply).toBe("Mvh Anne");
  });
});

describe("classifyReply", () => {
  const cases: Array<[string, string]> = [
    ["autoreply-vacation.txt", "auto_reply"],
    ["bounce.txt", "bounce"],
    ["opt-out.txt", "opt_out"],
    ["venue-quote-per-guest.txt", "normal"],
    ["photographer-questions.txt", "normal"],
  ];

  for (const [file, expected] of cases) {
    it(`klassificerer ${file} som ${expected}`, () => {
      expect(classifyReply({ body: fixture(file) })).toBe(expected);
    });
  }

  it("fanger autosvar via header selv uden nøgleord i teksten", () => {
    expect(
      classifyReply({ body: "Tak for din mail.", headers: { "Auto-Submitted": "auto-replied" } }),
    ).toBe("auto_reply");
  });

  it("lader framelding vinde over alt andet", () => {
    expect(classifyReply({ body: "Vi holder ferie. Fjern os fra jeres liste." })).toBe("opt_out");
  });
});
