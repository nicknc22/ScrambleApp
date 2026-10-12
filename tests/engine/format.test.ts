import { describe, expect, it } from "vitest";
import { formatCents, formatFeetInches, formatToPar, ordinal } from "@/lib/engine/format";

describe("formatToPar", () => {
  it("shows E for even, a plus sign over par, a minus under par", () => {
    expect(formatToPar(0)).toBe("E");
    expect(formatToPar(-0)).toBe("E");
    expect(formatToPar(3)).toBe("+3");
    expect(formatToPar(1)).toBe("+1");
    expect(formatToPar(-2)).toBe("-2");
    expect(formatToPar(-14)).toBe("-14");
  });
});

describe("formatCents", () => {
  it("drops cents on whole dollars", () => {
    expect(formatCents(1200)).toBe("$12");
    expect(formatCents(0)).toBe("$0");
    expect(formatCents(100)).toBe("$1");
  });
  it("shows two decimals otherwise", () => {
    expect(formatCents(1250)).toBe("$12.50");
    expect(formatCents(1205)).toBe("$12.05");
    expect(formatCents(1)).toBe("$0.01");
    expect(formatCents(99)).toBe("$0.99");
  });
  it("puts the minus sign before the dollar sign", () => {
    expect(formatCents(-500)).toBe("-$5");
    expect(formatCents(-1250)).toBe("-$12.50");
    expect(formatCents(-7)).toBe("-$0.07");
  });
  it("groups thousands", () => {
    expect(formatCents(100000)).toBe("$1,000");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(-250000)).toBe("-$2,500");
  });
  it("rounds stray fractional cents and survives garbage", () => {
    expect(formatCents(1249.6)).toBe("$12.50");
    expect(formatCents(-0.4)).toBe("$0");
    expect(formatCents(Number.NaN)).toBe("$0");
  });
});

describe("formatFeetInches", () => {
  it("formats feet and inches", () => {
    expect(formatFeetInches(12.5)).toBe(`12' 6"`);
    expect(formatFeetInches(3 + 4 / 12)).toBe(`3' 4"`);
    expect(formatFeetInches(10)).toBe(`10' 0"`);
  });
  it("shows inches only under a foot", () => {
    expect(formatFeetInches(0.75)).toBe(`9"`);
    expect(formatFeetInches(0)).toBe(`0"`);
  });
  it("rounds to the nearest inch, carrying into feet", () => {
    expect(formatFeetInches(11.99)).toBe(`12' 0"`);
    expect(formatFeetInches(2.04)).toBe(`2' 0"`);
    expect(formatFeetInches(2.05)).toBe(`2' 1"`);
  });
});

describe("ordinal", () => {
  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [10, "10th"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [22, "22nd"],
    [23, "23rd"],
    [101, "101st"],
    [111, "111th"],
    [112, "112th"],
  ])("%i -> %s", (n, label) => {
    expect(ordinal(n)).toBe(label);
  });
});
