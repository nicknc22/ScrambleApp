// The roster helpers (src/lib/roster.ts): text parsing, the create form's groom picker, the
// POST /api/trips validator and Setup's bulk add. Name limits are cross-checked against the reducer.
import { describe, expect, it } from "vitest";
import { applyOp } from "@/lib/reducer";
import type { Op } from "@/lib/ops";
import { MAX_NAME_CHARS as SETUP_MAX_NAME_CHARS } from "@/components/setup/model";
import {
  DEFAULT_GROOM_NAME,
  DEFAULT_ROSTER,
  MAX_PLAYER_NAME_CHARS,
  MAX_ROSTER_SIZE,
  bulkAddEntries,
  bulkAddToast,
  carryGroomChoice,
  cleanPlayerName,
  defaultRosterText,
  groomChoiceLost,
  nameKey,
  nameList,
  parseRosterText,
  planRosterAdds,
  resolveGroomIndex,
  rosterPayload,
  validateRosterInput,
} from "@/lib/roster";
import { at, makeTrip } from "./fixtures";

const BOYS = ["Caster", "Joe", "Greg", "Rich", "Reitman", "Drew", "Will", "Ross", "Conner", "Mark"];

describe("DEFAULT_ROSTER", () => {
  it("is the crew, in order, with Caster (first: the commissioner) as the one groom", () => {
    expect(DEFAULT_ROSTER.map((p) => p.name)).toEqual(BOYS);
    expect(DEFAULT_ROSTER.filter((p) => p.is_groom).map((p) => p.name)).toEqual(["Caster"]);
    expect(DEFAULT_GROOM_NAME).toBe("Caster");
    expect(Object.isFrozen(DEFAULT_ROSTER)).toBe(true);
  });

  it("defaultRosterText is one name per line and parses back to the roster", () => {
    expect(defaultRosterText()).toBe(BOYS.join("\n"));
    expect(parseRosterText(defaultRosterText())).toEqual(BOYS);
  });

  it("passes its own validator", () => {
    const v = validateRosterInput(DEFAULT_ROSTER);
    expect(v).toEqual({ ok: true, roster: BOYS.map((name) => ({ name, is_groom: name === "Caster" })) });
  });
});

describe("parseRosterText", () => {
  it("splits on newlines (any style) and commas, trims and drops empties", () => {
    expect(parseRosterText("Joe\nGreg\r\nRich\rDrew")).toEqual(["Joe", "Greg", "Rich", "Drew"]);
    expect(parseRosterText("Joe, Greg,Rich ,, ,\n\n  \nWill")).toEqual(["Joe", "Greg", "Rich", "Will"]);
    expect(parseRosterText("")).toEqual([]);
    expect(parseRosterText("  \n , \n")).toEqual([]);
  });

  it("collapses inner whitespace (tabs, double spaces) and turns control characters into spaces", () => {
    expect(parseRosterText("  Big   Joe \t Smith  ")).toEqual(["Big Joe Smith"]);
    expect(parseRosterText("Joe\u0000Smith\u0007")).toEqual(["Joe Smith"]);
  });

  it("drops duplicates case-insensitively, keeping the first spelling", () => {
    expect(parseRosterText("Joe\nGREG\njoe\n  Joe  \ngreg\nRich")).toEqual(["Joe", "GREG", "Rich"]);
    expect(parseRosterText("Big Joe\nbig   joe")).toEqual(["Big Joe"]);
  });

  it("strips list markers pasted from a group chat, but not real names", () => {
    expect(parseRosterText("1. Joe\n2) Greg\n- Rich\n• Drew\n* Will\n-Ross")).toEqual(["Joe", "Greg", "Rich", "Drew", "Will", "Ross"]);
    expect(parseRosterText("2Chainz\nJ.R.\n10 Cent")).toEqual(["2Chainz", "J.R.", "10 Cent"]);
  });

  it("caps each name at the player-name limit without splitting an emoji", () => {
    const long = "A".repeat(200);
    expect(parseRosterText(long)).toEqual(["A".repeat(MAX_PLAYER_NAME_CHARS)]);
    const emojiAtEdge = "B".repeat(MAX_PLAYER_NAME_CHARS - 1) + "🍺🍺";
    const [cut] = parseRosterText(emojiAtEdge);
    expect(cut).toBe("B".repeat(MAX_PLAYER_NAME_CHARS - 1));
    expect(cut.length).toBeLessThanOrEqual(MAX_PLAYER_NAME_CHARS);
    // A cut that lands on a space doesn't leave a trailing one.
    expect(parseRosterText("C".repeat(MAX_PLAYER_NAME_CHARS - 1) + " Smith")).toEqual(["C".repeat(MAX_PLAYER_NAME_CHARS - 1)]);
  });

  it("caps the list (default MAX_ROSTER_SIZE), counting only kept names", () => {
    const many = Array.from({ length: 60 }, (_, i) => `Guy ${i + 1}`);
    expect(parseRosterText(many.join("\n"))).toHaveLength(MAX_ROSTER_SIZE);
    expect(parseRosterText(many.join("\n"), 3)).toEqual(["Guy 1", "Guy 2", "Guy 3"]);
    expect(parseRosterText("Joe\njoe\nJOE\nGreg", 2)).toEqual(["Joe", "Greg"]);
  });

  it("tolerates junk input", () => {
    expect(parseRosterText(undefined as unknown as string)).toEqual([]);
    expect(parseRosterText(null as unknown as string)).toEqual([]);
  });
});

describe("cleanPlayerName / nameKey", () => {
  it("cleans and keys names", () => {
    expect(cleanPlayerName("  Joe   Smith ")).toBe("Joe Smith");
    expect(cleanPlayerName("   ")).toBe("");
    expect(nameKey("  JOE   smith ")).toBe("joe smith");
    expect(nameKey("Joe Smith")).toBe(nameKey("joe  SMITH"));
  });
});

describe("name limit matches the reducer and Setup", () => {
  const upsert = (name: string): Op => ({ id: "op-1", at: at(0), by: null, type: "player.upsert", player: { id: "p-new", name } });
  const ctx = { now: at(0), is_commissioner: true, side: "server" as const };

  it("a cleaned name at the cap is accepted by player.upsert; one longer is rejected", () => {
    const s = makeTrip({ teams: [], status: "setup" }).state;
    expect(applyOp(s, upsert(cleanPlayerName("Z".repeat(500))), ctx).ok).toBe(true);
    expect(applyOp(s, upsert("Z".repeat(MAX_PLAYER_NAME_CHARS + 1)), ctx).ok).toBe(false);
    expect(MAX_PLAYER_NAME_CHARS).toBe(SETUP_MAX_NAME_CHARS);
  });
});

describe("resolveGroomIndex / rosterPayload (home page create form)", () => {
  it("untouched: the default groom when he's on the list, else nobody", () => {
    expect(resolveGroomIndex(BOYS, null)).toBe(0);
    expect(resolveGroomIndex(["Joe", "caster"], null)).toBe(1);
    expect(resolveGroomIndex(["Joe", "Greg"], null)).toBe(-1);
    expect(resolveGroomIndex([], null)).toBe(-1);
  });

  it("an explicit pick wins; explicit 'No groom yet' sticks", () => {
    expect(resolveGroomIndex(BOYS, nameKey("Greg"))).toBe(2);
    expect(resolveGroomIndex(BOYS, "")).toBe(-1);
  });

  it("a picked name that's gone is no groom (never a silent switch back to Caster)", () => {
    expect(resolveGroomIndex(BOYS, nameKey("Gregory"))).toBe(-1);
    expect(resolveGroomIndex(["Joe", "Rich"], nameKey("Gregory"))).toBe(-1);
    expect(groomChoiceLost(BOYS, nameKey("Gregory"))).toBe(true);
    expect(groomChoiceLost(BOYS, nameKey("Greg"))).toBe(false);
    expect(groomChoiceLost(BOYS, null)).toBe(false);
    expect(groomChoiceLost(BOYS, "")).toBe(false);
  });

  it("carryGroomChoice: fixing the groom's spelling keeps the crown on his line", () => {
    // The reported slip: pick Joe, then fix the list to "Caster / Joey / Greg". The crown stays on Joey.
    const before = ["Caster", "Joe", "Greg"];
    const after = ["Caster", "Joey", "Greg"];
    const carried = carryGroomChoice(before, after, nameKey("Joe"));
    expect(carried).toBe(nameKey("Joey"));
    expect(resolveGroomIndex(after, carried)).toBe(1);
    // Untouched (Caster by default) renamed in place: the crown follows too.
    expect(resolveGroomIndex(["Casterr", "Joe"], carryGroomChoice(["Caster", "Joe"], ["Casterr", "Joe"], null))).toBe(0);
  });

  it("carryGroomChoice: other edits leave the pick alone; a deleted groom line asks again", () => {
    const joe = nameKey("Joe");
    expect(carryGroomChoice(BOYS, [...BOYS, "NewGuy"], joe)).toBe(joe);
    expect(carryGroomChoice(BOYS, ["Caster", "Joe", "Gregory"], joe)).toBe(joe);
    expect(carryGroomChoice(BOYS, BOYS, "")).toBe("");
    // Joe's line removed (one fewer name): the pick goes stale -> "No groom yet" + "pick him again".
    const gone = BOYS.filter((n) => n !== "Joe");
    const stale = carryGroomChoice(BOYS, gone, joe);
    expect(resolveGroomIndex(gone, stale)).toBe(-1);
    expect(groomChoiceLost(gone, stale)).toBe(true);
    // Untouched with Caster's line removed: still untouched (re-adding Caster crowns him again).
    expect(carryGroomChoice(BOYS, BOYS.slice(1), null)).toBeNull();
  });

  it("rosterPayload flags exactly the chosen groom", () => {
    expect(rosterPayload(["Caster", "Joe"], 0)).toEqual([
      { name: "Caster", is_groom: true },
      { name: "Joe", is_groom: false },
    ]);
    expect(rosterPayload(["Caster", "Joe"], -1).every((p) => !p.is_groom)).toBe(true);
    expect(rosterPayload([], -1)).toEqual([]);
  });

  it("whatever the form builds passes the server validator", () => {
    const names = parseRosterText(defaultRosterText());
    for (const choice of [null, "", nameKey("Mark")]) {
      expect(validateRosterInput(rosterPayload(names, resolveGroomIndex(names, choice))).ok).toBe(true);
    }
  });
});

describe("validateRosterInput (POST /api/trips roster)", () => {
  const err = (raw: unknown) => {
    const v = validateRosterInput(raw);
    expect(v.ok).toBe(false);
    return v.ok ? "" : v.error;
  };

  it("absent, null or empty: no players", () => {
    expect(validateRosterInput(undefined)).toEqual({ ok: true, roster: [] });
    expect(validateRosterInput(null)).toEqual({ ok: true, roster: [] });
    expect(validateRosterInput([])).toEqual({ ok: true, roster: [] });
  });

  it("takes plain strings and {name, is_groom} objects, mixed, in order; squishes names", () => {
    expect(validateRosterInput(["  Joe  ", { name: "Caster", is_groom: true }, { name: "Big   Greg" }, { name: "Rich", is_groom: false }])).toEqual({
      ok: true,
      roster: [
        { name: "Joe", is_groom: false },
        { name: "Caster", is_groom: true },
        { name: "Big Greg", is_groom: false },
        { name: "Rich", is_groom: false },
      ],
    });
    expect(validateRosterInput([{ name: "Joe", is_groom: null }])).toEqual({ ok: true, roster: [{ name: "Joe", is_groom: false }] });
  });

  it("rejects non-arrays and non-name entries", () => {
    expect(err("Joe, Greg")).toMatch(/list of names/);
    expect(err({ name: "Joe" })).toMatch(/list of names/);
    expect(err(42)).toMatch(/list of names/);
    expect(err(["Joe", 7])).toMatch(/Player 2/);
    expect(err([["Joe"]])).toMatch(/Player 1/);
    expect(err([{ name: 5 }])).toMatch(/needs a name/);
    expect(err([{ nickname: "Shank" }])).toMatch(/needs a name/);
    expect(err([{ name: "Joe", is_groom: "yes" }])).toMatch(/groom flag/);
  });

  it("rejects empty and too-long names", () => {
    expect(err(["Joe", "   "])).toMatch(/Player 2.*needs a name/);
    expect(err([""])).toMatch(/needs a name/);
    expect(err(["J".repeat(MAX_PLAYER_NAME_CHARS + 1)])).toMatch(/par 5/);
    expect(validateRosterInput(["J".repeat(MAX_PLAYER_NAME_CHARS)]).ok).toBe(true);
  });

  it("rejects duplicates (case-insensitive) and more than one groom", () => {
    expect(err(["Joe", "JOE "])).toMatch(/twice/);
    expect(err([{ name: "Joe", is_groom: true }, { name: "Greg", is_groom: true }])).toMatch(/Two grooms/);
  });

  it("caps the size at MAX_ROSTER_SIZE", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `Guy ${i}`);
    expect(validateRosterInput(names(MAX_ROSTER_SIZE)).ok).toBe(true);
    expect(err(names(MAX_ROSTER_SIZE + 1))).toMatch(new RegExp(`${MAX_ROSTER_SIZE} max`));
  });
});

describe("planRosterAdds / bulk add copy (Setup)", () => {
  const roster = [
    { name: "Caster", deleted_at: null },
    { name: "Joe", deleted_at: null },
    { name: "Greg", deleted_at: "2026-10-20T00:00:00.000Z" }, // deleted: can come back
  ];

  it("adds names not on the active roster (case-insensitive), skipping the rest, in order", () => {
    expect(planRosterAdds(roster, ["joe", "Rich", "GREG", "caster", "Drew"])).toEqual({
      add: ["Rich", "GREG", "Drew"],
      skipped: ["joe", "caster"],
    });
    expect(planRosterAdds([], BOYS)).toEqual({ add: BOYS, skipped: [] });
    expect(planRosterAdds(roster, [])).toEqual({ add: [], skipped: [] });
  });

  it("never adds the same name twice in one paste", () => {
    expect(planRosterAdds([], ["Rich", "rich ", " RICH"])).toEqual({ add: ["Rich"], skipped: ["rich ", " RICH"] });
  });

  it("nameList reads like a sentence", () => {
    expect(nameList([])).toBe("");
    expect(nameList(["Joe"])).toBe("Joe");
    expect(nameList(["Joe", "Greg"])).toBe("Joe and Greg");
    expect(nameList(["Joe", "Greg", "Rich"])).toBe("Joe, Greg and Rich");
    expect(nameList(["Joe", "Greg", "Rich", "Drew"])).toBe("Joe, Greg, Rich and Drew");
    expect(nameList(["Joe", "Greg", "Rich", "Drew", "Will"])).toBe("Joe, Greg, Rich and 2 more");
  });

  it("bulkAddEntries crowns the default groom only when the roster has none (Fill in the crew)", () => {
    const noGroom = [
      { name: "Joe", is_groom: false, deleted_at: null },
      { name: "Caster", is_groom: true, deleted_at: "2026-10-20T00:00:00.000Z" }, // deleted: doesn't count
    ];
    expect(bulkAddEntries(noGroom, ["Greg", "Caster", "Rich"])).toEqual([
      { name: "Greg", is_groom: false },
      { name: "Caster", is_groom: true },
      { name: "Rich", is_groom: false },
    ]);
    expect(bulkAddEntries([], ["caster"])).toEqual([{ name: "caster", is_groom: true }]);
    // Somebody already has the crown: nobody new gets it (it would move).
    const crowned = [{ name: "Joe", is_groom: true, deleted_at: null }];
    expect(bulkAddEntries(crowned, ["Caster"])).toEqual([{ name: "Caster", is_groom: false }]);
    expect(bulkAddEntries([], ["Greg", "Rich"]).some((e) => e.is_groom)).toBe(false);
  });

  it("bulkAddToast says how many were added and who got skipped", () => {
    expect(bulkAddToast(7, [], 10)).toEqual({ title: "Added 7", message: "10 on the roster." });
    expect(bulkAddToast(1, ["Joe", "Greg"], 3)).toEqual({ title: "Added 1", message: "3 on the roster. Skipped Joe and Greg: already on it." });
    expect(bulkAddToast(0, ["Joe"], 2).title).toBe("Nobody new");
  });
});
