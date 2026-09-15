import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import {
  buildReferences,
  extractReplyToken,
  newReplyToken,
  parseAddress,
  replyToAddress,
} from "../src/email/threading.js";
import { fingerprintInbound, htmlToText, normalizeInbound } from "../src/email/inbound.js";

describe("svaradresser", () => {
  it("kan læse sit eget token tilbage", () => {
    const token = newReplyToken();
    expect(extractReplyToken(replyToAddress(token))).toBe(token);
  });

  it("finder token i en adresse med visningsnavn", () => {
    const token = newReplyToken();
    expect(extractReplyToken(`"Bryllup" <${replyToAddress(token)}>`)).toBe(token);
  });

  it("ignorerer adresser på et fremmed domæne", () => {
    expect(extractReplyToken(`${config.email.replyLocalPart}+abcdef@andetdomæne.dk`)).toBeNull();
  });
});

describe("buildReferences", () => {
  it("lægger den besvarede mail sidst uden dubletter", () => {
    expect(buildReferences("<a@x> <b@x>", "<b@x>")).toBe("<a@x> <b@x>");
    expect(buildReferences("<a@x>", "<c@x>")).toBe("<a@x> <c@x>");
    expect(buildReferences(null, null)).toBeNull();
  });
});

describe("parseAddress", () => {
  it("håndterer både vinkelparenteser og bar adresse", () => {
    expect(parseAddress("Anne <Anne@Soegaard.DK>")).toEqual({
      name: "Anne",
      email: "anne@soegaard.dk",
    });
    expect(parseAddress("anne@soegaard.dk").email).toBe("anne@soegaard.dk");
  });
});

describe("normalizeInbound", () => {
  it("læser Postmark-formatet", () => {
    const email = normalizeInbound({
      From: "Anne <anne@soegaard.dk>",
      To: "reply+tok123@example.com",
      Subject: "SV: Forespørgsel",
      TextBody: "Datoen er ledig.",
      MessageID: "abc-123",
      Headers: [{ Name: "In-Reply-To", Value: "<vores@example.com>" }],
    });
    expect(email.fromEmail).toBe("anne@soegaard.dk");
    expect(email.toEmails).toContain("reply+tok123@example.com");
    expect(email.messageId).toBe("<abc-123>");
    expect(email.headers["in-reply-to"]).toBe("<vores@example.com>");
  });

  it("læser SendGrid/Mailgun-felter og envelope", () => {
    const email = normalizeInbound({
      from: "Bo <bo@boegelund.dk>",
      subject: "SV",
      "body-plain": "Ledig.",
      envelope: JSON.stringify({ to: "reply+xyz789@example.com" }),
    });
    expect(email.fromEmail).toBe("bo@boegelund.dk");
    expect(email.toEmails).toContain("reply+xyz789@example.com");
  });

  it("falder tilbage til HTML når der ikke er ren tekst", () => {
    const email = normalizeInbound({
      from: "a@b.dk",
      html: "<p>Prisen er <b>45.000 kr.</b></p><p>Mvh</p>",
    });
    expect(email.textBody).toContain("45.000 kr.");
    expect(email.textBody).not.toContain("<b>");
  });

  it("giver samme fingeraftryk for samme levering", () => {
    const payload = { from: "a@b.dk", TextBody: "Hej", MessageID: "m-1" };
    expect(fingerprintInbound(normalizeInbound(payload))).toBe(
      fingerprintInbound(normalizeInbound(payload)),
    );
  });
});

describe("htmlToText", () => {
  it("bevarer linjeskift fra blokelementer", () => {
    expect(htmlToText("<p>Linje 1</p><p>Linje 2</p>")).toBe("Linje 1\n\nLinje 2");
  });
});
