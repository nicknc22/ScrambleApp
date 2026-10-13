// "Send the link": always the clean /t/<code> link (never ?tab= or a player's ?me=), through the
// share sheet when there is one, else copied.
import { describe, expect, it } from "vitest";
import { SHARE_TEXT, shareTripLink, tripLink } from "@/components/shell/shareLink";

const URL = "https://scramble.test/t/gv9akf9k9k";

describe("tripLink", () => {
  it("is origin + /t/<code>, nothing else", () => {
    expect(tripLink("https://scramble.test", "gv9akf9k9k")).toBe(URL);
    expect(tripLink("https://scramble.test/", "gv9akf9k9k")).toBe(URL);
    expect(tripLink("http://localhost:3100", "abc123")).toBe("http://localhost:3100/t/abc123");
  });
});

describe("shareTripLink", () => {
  it("uses the share sheet with the clean link and the pitch", async () => {
    const shared: ShareData[] = [];
    const copied: string[] = [];
    const out = await shareTripLink({
      url: URL,
      title: "Caster's Last Scramble",
      nav: { share: async (d) => void shared.push(d) },
      copy: async (t) => (copied.push(t), true),
    });
    expect(out).toBe("shared");
    expect(shared).toEqual([{ title: "Caster's Last Scramble", text: SHARE_TEXT, url: URL }]);
    expect(copied).toEqual([]);
  });

  it("closing the share sheet is not an error and copies nothing", async () => {
    const copied: string[] = [];
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const out = await shareTripLink({ url: URL, title: "T", nav: { share: async () => Promise.reject(abort) }, copy: async (t) => (copied.push(t), true) });
    expect(out).toBe("cancelled");
    expect(copied).toEqual([]);
  });

  it("no share sheet, or sharing refused: copies the link instead", async () => {
    const copied: string[] = [];
    const copy = async (t: string) => (copied.push(t), true);
    expect(await shareTripLink({ url: URL, title: "T", nav: null, copy })).toBe("copied");
    expect(await shareTripLink({ url: URL, title: "T", nav: {}, copy })).toBe("copied");
    const refused = Object.assign(new Error("no activation"), { name: "NotAllowedError" });
    expect(await shareTripLink({ url: URL, title: "T", nav: { share: async () => Promise.reject(refused) }, copy })).toBe("copied");
    expect(copied).toEqual([URL, URL, URL]);
  });

  it("says when even copying failed (never throws)", async () => {
    expect(await shareTripLink({ url: URL, title: "T", nav: null, copy: async () => false })).toBe("failed");
    expect(await shareTripLink({ url: URL, title: "T", nav: null, copy: async () => Promise.reject(new Error("x")) })).toBe("failed");
  });
});
