import { describe, expect, it } from "vitest";
import {
  amountAppearsInText,
  estimateTotal,
  findAmounts,
  parseDanishAmount,
} from "../src/domain/money.js";
import { fixture } from "./helpers.js";

describe("parseDanishAmount", () => {
  const cases: Array<[string, number | null]> = [
    ["45.000 kr.", 45000],
    ["kr. 45.000", 45000],
    ["45.000,-", 45000],
    ["1.250 kr. pr. kuvert", 1250],
    ["24.900 kr.", 24900],
    ["1.500.000 kr.", 1500000],
    ["1,5 mio. kr.", 1500000],
    ["45k", 45000],
    ["12.500,50 kr.", 12501],
    ["ingen tal her", null],
  ];
  for (const [input, expected] of cases) {
    it(`læser "${input}"`, () => {
      expect(parseDanishAmount(input)).toBe(expected);
    });
  }
});

describe("findAmounts", () => {
  it("finder begge pakkepriser i fotografens mail", () => {
    const amounts = findAmounts(fixture("photographer-package-range.txt"));
    expect(amounts).toContain(24900);
    expect(amounts).toContain(15500);
  });

  it("finder kuvertpris og depositum i lokalets mail", () => {
    const amounts = findAmounts(fixture("venue-quote-per-guest.txt"));
    expect(amounts).toContain(1250);
    expect(amounts).toContain(10000);
  });
});

describe("amountAppearsInText", () => {
  const text = fixture("photographer-package-range.txt");

  it("godtager et beløb der står i mailen", () => {
    expect(amountAppearsInText(24900, text)).toBe(true);
  });

  it("afviser et beløb modellen har fundet på", () => {
    expect(amountAppearsInText(21500, text)).toBe(false);
  });

  it("godtager null (intet at efterprøve)", () => {
    expect(amountAppearsInText(null, text)).toBe(true);
  });

  it("finder også beløb skrevet uden enhed", () => {
    expect(amountAppearsInText(45000, "Prisen er 45000 for hele weekenden")).toBe(true);
  });
});

describe("estimateTotal", () => {
  it("ganger kuvertpris op med gæstetallet", () => {
    expect(estimateTotal(1250, "per_guest", { guests: 90 })).toBe(112500);
  });

  it("returnerer null når grundlaget mangler", () => {
    expect(estimateTotal(1250, "per_guest", { guests: null })).toBeNull();
    expect(estimateTotal(2500, "per_hour", { hours: null })).toBeNull();
    expect(estimateTotal(45000, "unknown", {})).toBeNull();
  });

  it("lader samlet pris stå urørt", () => {
    expect(estimateTotal(45000, "total", { guests: 90 })).toBe(45000);
  });
});
