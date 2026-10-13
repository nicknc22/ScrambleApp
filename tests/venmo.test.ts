import { describe, expect, it } from "vitest";
import { buildVenmoPayLinks, encodeComponent, formatVenmoAmount, normalizeVenmoHandle, venmoAt, venmoNote } from "@/lib/venmo";

describe("normalizeVenmoHandle", () => {
  it("strips @ signs and whitespace", () => {
    expect(normalizeVenmoHandle("@Nick-Caster")).toBe("Nick-Caster");
    expect(normalizeVenmoHandle("  @@nick_c  ")).toBe("nick_c");
    expect(normalizeVenmoHandle("nick")).toBe("nick");
    expect(normalizeVenmoHandle("@ nick")).toBe("nick");
  });

  it("pulls the username out of a pasted profile link", () => {
    expect(normalizeVenmoHandle("https://venmo.com/u/Nick-Caster")).toBe("Nick-Caster");
    expect(normalizeVenmoHandle("https://account.venmo.com/u/Nick-Caster")).toBe("Nick-Caster");
    expect(normalizeVenmoHandle("venmo.com/Nick-Caster?txn=pay")).toBe("Nick-Caster");
    expect(normalizeVenmoHandle("http://www.venmo.com/dave99/")).toBe("dave99");
  });

  it("rejects empty and non-username input", () => {
    expect(normalizeVenmoHandle(null)).toBeNull();
    expect(normalizeVenmoHandle(undefined)).toBeNull();
    expect(normalizeVenmoHandle("")).toBeNull();
    expect(normalizeVenmoHandle("   ")).toBeNull();
    expect(normalizeVenmoHandle("@")).toBeNull();
    expect(normalizeVenmoHandle("Nick Caster")).toBeNull();
    expect(normalizeVenmoHandle("nick&amount=999")).toBeNull();
    expect(normalizeVenmoHandle("nick/../../x")).toBeNull();
    expect(normalizeVenmoHandle("💸")).toBeNull();
  });

  it("venmoAt adds the @", () => {
    expect(venmoAt("nick")).toBe("@nick");
  });
});

describe("formatVenmoAmount", () => {
  it("always two decimals, no commas or $", () => {
    expect(formatVenmoAmount(1250)).toBe("12.50");
    expect(formatVenmoAmount(1200)).toBe("12.00");
    expect(formatVenmoAmount(5)).toBe("0.05");
    expect(formatVenmoAmount(99)).toBe("0.99");
    expect(formatVenmoAmount(123456)).toBe("1234.56");
    expect(formatVenmoAmount(100000)).toBe("1000.00");
  });

  it("rounds stray fractional cents and rejects non-positive amounts", () => {
    expect(formatVenmoAmount(1249.6)).toBe("12.50");
    expect(formatVenmoAmount(0)).toBeNull();
    expect(formatVenmoAmount(-500)).toBeNull();
    expect(formatVenmoAmount(Number.NaN)).toBeNull();
    expect(formatVenmoAmount(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("encodeComponent / venmoNote", () => {
  it("encodes spaces as %20 and the reserved characters encodeURIComponent skips", () => {
    expect(encodeComponent("a b")).toBe("a%20b");
    expect(encodeComponent("it's (fine)!*")).toBe("it%27s%20%28fine%29%21%2A");
    expect(encodeComponent("A&B=C?#/+")).toBe("A%26B%3DC%3F%23%2F%2B");
    expect(encodeComponent("🍺 café")).toBe("%F0%9F%8D%BA%20caf%C3%A9");
  });

  it("builds the note from the app and trip names", () => {
    expect(venmoNote("Scramble", "Jack Frost Scramble")).toBe("Scramble: Jack Frost Scramble settle-up");
    expect(venmoNote("  Bach   Golf ", " Nick's\nBachelor ")).toBe("Bach Golf: Nick's Bachelor settle-up");
    expect(venmoNote("", "Trip")).toBe("Scramble: Trip settle-up");
    expect(venmoNote("Scramble", "")).toBe("Scramble settle-up");
    expect(venmoNote(null, null)).toBe("Scramble settle-up");
  });
});

describe("buildVenmoPayLinks", () => {
  it("builds the app deep link and the web fallback", () => {
    const links = buildVenmoPayLinks({ handle: "@Nick-Caster", amountCents: 1250, note: "Scramble: Jack Frost Scramble settle-up" });
    expect(links).not.toBeNull();
    expect(links!.handle).toBe("Nick-Caster");
    expect(links!.amount).toBe("12.50");
    expect(links!.app).toBe(
      "venmo://paycharge?txn=pay&recipients=Nick-Caster&amount=12.50&note=Scramble%3A%20Jack%20Frost%20Scramble%20settle-up",
    );
    expect(links!.web).toBe("https://venmo.com/Nick-Caster?txn=pay&amount=12.50&note=Scramble%3A%20Jack%20Frost%20Scramble%20settle-up");
  });

  it("round-trips the note through URL parsing", () => {
    const note = "Bros & Brews: Nick's #1 (final) settle-up";
    const links = buildVenmoPayLinks({ handle: "dave", amountCents: 4999, note })!;
    const web = new URL(links.web);
    expect(web.searchParams.get("note")).toBe(note);
    expect(web.searchParams.get("amount")).toBe("49.99");
    expect(web.searchParams.get("txn")).toBe("pay");
    // The custom scheme parses the same way.
    const app = new URL(links.app);
    expect(app.protocol).toBe("venmo:");
    expect(app.searchParams.get("recipients")).toBe("dave");
    expect(app.searchParams.get("note")).toBe(note);
    expect(links.app).not.toContain("+");
  });

  it("returns null without a usable handle or amount", () => {
    expect(buildVenmoPayLinks({ handle: null, amountCents: 1000, note: "x" })).toBeNull();
    expect(buildVenmoPayLinks({ handle: "Nick Caster", amountCents: 1000, note: "x" })).toBeNull();
    expect(buildVenmoPayLinks({ handle: "nick", amountCents: 0, note: "x" })).toBeNull();
    expect(buildVenmoPayLinks({ handle: "nick", amountCents: -100, note: "x" })).toBeNull();
  });
});
