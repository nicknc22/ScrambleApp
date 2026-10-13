// Setup tab: pure helpers (money, shuffle, pre-flight, settings patch, team names, dnd ids).
// The pre-flight's blocking checks are cross-checked against the reducer's trip.start.
import { describe, expect, it } from "vitest";
import { applyOp } from "@/lib/reducer";
import type { Op } from "@/lib/ops";
import type { TripState } from "@/lib/types";
import { makeTrip, at } from "../fixtures";
import {
  addMinutes,
  centsToInput,
  contestHoles,
  draftOfPlayer,
  duplicateName,
  firstShare,
  maxExposureCents,
  membersByTeam,
  nextTeamName,
  normalizeTeeTime,
  optKey,
  optOutSet,
  parseDollars,
  payoutLabel,
  payoutMode,
  payoutValid,
  pinChangeError,
  planShuffle,
  potKeys,
  potLongLabel,
  potShortLabel,
  preflight,
  sameDraft,
  settingsDraft,
  settingsPatch,
  shuffleSizes,
  shuffleTeamCount,
  sizesLabel,
  splitPayout,
  teamIssues,
  teamSizeStatus,
  teeTimeSuggestions,
  unassignedPlayers,
  unfinishedTeams,
  validatePlayerDraft,
} from "@/components/setup/model";
import { LOCAL_TEAM_NAMES, cleanNames, generateTeamNames, localTeamNames } from "@/components/setup/teamNames";
import { POOL_ID, playerDragId, playerIdOfDragId, teamDropId, teamIdOfDropId } from "@/components/setup/dnd";

/** Seeded PRNG (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let opSeq = 0;
function op(o: Record<string, unknown>): Op {
  return { id: `op-${++opSeq}`, at: at(opSeq), by: null, ...o } as unknown as Op;
}
const ctx = { now: at(0), is_commissioner: true, side: "server" as const };

function setupTrip(teams: number[], settings: Record<string, unknown> = {}) {
  return makeTrip({ teams, status: "setup", settings: { team_match_ante_cents: 2000, contest_ante_cents: 500, ...settings } });
}

/** Give every long-drive hole a tee point so that warning goes away. */
function withLdTees(s: TripState): TripState {
  return { ...s, holes: s.holes.map((h) => (h.contest === "ld" ? { ...h, tee_lat: 41.09, tee_lng: -75.65 } : h)) };
}

describe("money", () => {
  it("parses dollars into cents", () => {
    expect(parseDollars("20")).toBe(2000);
    expect(parseDollars("$20")).toBe(2000);
    expect(parseDollars(" 12.5 ")).toBe(1250);
    expect(parseDollars("12.50")).toBe(1250);
    expect(parseDollars("0.05")).toBe(5);
    expect(parseDollars("1,000")).toBe(100000);
    expect(parseDollars("")).toBe(0);
    expect(parseDollars(".5")).toBe(50);
    expect(parseDollars("12.345")).toBeNull();
    expect(parseDollars("-5")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars(".")).toBeNull();
    expect(parseDollars("99999")).toBeNull();
  });

  it("formats cents for the input", () => {
    expect(centsToInput(2000)).toBe("20");
    expect(centsToInput(1250)).toBe("12.50");
    expect(centsToInput(5)).toBe("0.05");
    expect(centsToInput(0)).toBe("0");
    for (const c of [0, 5, 99, 100, 1250, 2000, 123456]) expect(parseDollars(centsToInput(c))).toBe(c);
  });

  it("max exposure = team ante + contest ante per contest hole (8 at Jack Frost)", () => {
    const f = setupTrip([4, 3, 3]);
    const holes = contestHoles(f.state.holes);
    expect(holes.map((h) => h.number)).toEqual([3, 4, 8, 9, 11, 12, 16, 18]);
    expect(maxExposureCents(f.state.trip.settings, holes.length)).toBe(2000 + 500 * 8);
  });

  it("payout rules", () => {
    expect(payoutMode([100])).toBe("winner");
    expect(payoutMode([70, 30])).toBe("split");
    expect(splitPayout(70)).toEqual([70, 30]);
    expect(splitPayout(72.4)).toEqual([72, 28]);
    expect(splitPayout(40)).toEqual([50, 50]);
    expect(splitPayout(100)).toEqual([100]);
    expect(firstShare([100])).toBe(70);
    expect(firstShare([60, 40])).toBe(60);
    expect(payoutLabel([100])).toBe("Winner take all");
    expect(payoutLabel([70, 30])).toBe("70% / 30%");
    for (const f of [50, 55, 70, 95]) expect(payoutValid(splitPayout(f))).toBe(true);
    expect(payoutValid([70, 20])).toBe(false);
    expect(payoutValid([])).toBe(false);
  });

  it("every split the UI can make is accepted by trip.update", () => {
    const f = setupTrip([4, 3, 3]);
    for (let first = 50; first <= 95; first += 5) {
      const r = applyOp(f.state, op({ type: "trip.update", patch: { settings: { team_match_payout: splitPayout(first) } } }), ctx);
      expect(r.ok, `split ${first}`).toBe(true);
    }
  });
});

describe("pots and opt-outs", () => {
  it("lists the team match plus one pot per contest hole", () => {
    const f = setupTrip([4, 3, 3]);
    const keys = potKeys(f.state.holes);
    expect(keys).toEqual(["team_match", "contest:3", "contest:4", "contest:8", "contest:9", "contest:11", "contest:12", "contest:16", "contest:18"]);
    expect(potShortLabel("team_match", f.state.holes)).toBe("Team");
    expect(potShortLabel("contest:3", f.state.holes)).toBe("#3 CTP");
    expect(potShortLabel("contest:4", f.state.holes)).toBe("#4 LD");
    expect(potLongLabel("contest:4", f.state.holes)).toBe("Hole 4 · Long drive");
    // Every key is one the reducer accepts.
    for (const k of keys) {
      const r = applyOp(f.state, op({ type: "pot.optout", pot_key: k, player_id: f.player.A1, out: true }), ctx);
      expect(r.ok, k).toBe(true);
    }
  });

  it("opt-out set tracks active rows only", () => {
    const f = setupTrip([4, 3, 3]);
    f.optOut("B2", "contest:3");
    const s1 = optOutSet(f.state);
    expect(s1.has(optKey("contest:3", f.player.B2))).toBe(true);
    const r = applyOp(f.state, op({ type: "pot.optout", pot_key: "contest:3", player_id: f.player.B2, out: false }), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(optOutSet(r.state).has(optKey("contest:3", f.player.B2))).toBe(false);
  });
});

describe("team sizes and shuffle", () => {
  it("classifies sizes", () => {
    expect([0, 1, 2, 3, 4, 5].map(teamSizeStatus)).toEqual(["empty", "short", "ok", "ok", "full", "over"]);
  });

  it("picks a team count and even sizes", () => {
    expect(shuffleTeamCount(10, 0)).toBe(3);
    expect(shuffleTeamCount(10, 3)).toBe(3);
    expect(shuffleTeamCount(10, 4)).toBe(4);
    expect(shuffleTeamCount(10, 6)).toBe(3); // 6 teams can't work for 10 (max 5)
    expect(shuffleTeamCount(1, 0)).toBe(0);
    expect(shuffleSizes(10, 3)).toEqual([4, 3, 3]);
    expect(shuffleSizes(9, 3)).toEqual([3, 3, 3]);
    expect(shuffleSizes(11, 3)).toEqual([4, 4, 3]);
    expect(shuffleSizes(5, 2)).toEqual([3, 2]);
    expect(shuffleSizes(10, 2)).toEqual([]);
    expect(shuffleSizes(3, 2)).toEqual([]);
    expect(sizesLabel([4, 3, 3])).toBe("4/3/3");
    for (let n = 2; n <= 16; n++) {
      const sizes = shuffleSizes(n, shuffleTeamCount(n, 0));
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
      expect(sizes.every((s) => s >= 2 && s <= 4)).toBe(true);
    }
  });

  it("plans a shuffle that assigns everyone exactly once", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const plan = planShuffle(ids, 1, seeded(7));
    expect(plan).not.toBeNull();
    expect(plan!.sizes).toEqual([4, 3, 3]);
    expect(plan!.create).toBe(2);
    expect(new Set(plan!.assignments.map((a) => a.player_id)).size).toBe(10);
    const counts = [0, 0, 0];
    for (const a of plan!.assignments) counts[a.team_index]++;
    expect(counts).toEqual([4, 3, 3]);
    expect(planShuffle(["solo"], 0)).toBeNull();
  });

  it("the shuffle's op sequence (clear, then assign) never trips the 4-player cap", () => {
    // Start from full teams in a different arrangement and replay what the UI dispatches.
    const f = setupTrip([4, 4, 2]);
    let s = f.state;
    const players = s.players.map((p) => p.id);
    const teams = s.teams.map((t) => t.id);
    const plan = planShuffle(players, teams.length, seeded(3))!;
    expect(plan.create).toBe(0);
    for (const p of players) {
      const r = applyOp(s, op({ type: "team.assign", player_id: p, team_id: null }), ctx);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.state;
    }
    for (const a of plan.assignments) {
      const r = applyOp(s, op({ type: "team.assign", player_id: a.player_id, team_id: teams[a.team_index] }), ctx);
      expect(r.ok, r.ok ? "" : r.reason).toBe(true);
      if (r.ok) s = r.state;
    }
    expect([...membersByTeam(s).values()].map((m) => m.length)).toEqual(plan.sizes);
    expect(unassignedPlayers(s)).toEqual([]);
  });

  it("names new teams past the ones already taken", () => {
    const f = setupTrip([4, 3, 3]);
    expect(nextTeamName(f.state.teams)).toBe("Team 4");
    expect(nextTeamName(f.state.teams, 1)).toBe("Team 5");
    const renamed = f.state.teams.map((t, i) => (i === 0 ? { ...t, name: "Team 4" } : t));
    expect(nextTeamName(renamed)).toBe("Team 5");
    expect(nextTeamName([])).toBe("Team 1");
  });
});

describe("tee times", () => {
  it("normalizes and adds minutes", () => {
    expect(normalizeTeeTime("9:05")).toBe("09:05");
    expect(normalizeTeeTime("12:50")).toBe("12:50");
    expect(normalizeTeeTime("24:00")).toBeNull();
    expect(normalizeTeeTime("noonish")).toBeNull();
    expect(addMinutes("12:50", 10)).toBe("13:00");
    expect(addMinutes("23:55", 10)).toBe("00:05");
  });

  it("suggests the next free 10-minute slots", () => {
    const teams = [
      { id: "a", tee_time: "12:50" },
      { id: "b", tee_time: null },
      { id: "c", tee_time: "13:00" },
    ];
    expect(teeTimeSuggestions(teams, "b")).toEqual(["13:10", "13:20", "13:30", "13:40"]);
    // A team's own time doesn't block its own suggestions.
    expect(teeTimeSuggestions(teams, "a")[0]).toBe("12:50");
  });

  it("suggested tee times pass the reducer", () => {
    const f = setupTrip([4, 3, 3]);
    for (const t of teeTimeSuggestions(f.state.teams, f.team.A)) {
      const r = applyOp(f.state, op({ type: "team.upsert", team: { id: f.team.A, tee_time: t } }), ctx);
      expect(r.ok, t).toBe(true);
    }
  });
});

describe("pre-flight", () => {
  it("all green for 4/3/3 with antes, groom, tee points and tee times", () => {
    const f = setupTrip([4, 3, 3]);
    const s = withLdTees({ ...f.state, teams: f.state.teams.map((t, i) => ({ ...t, tee_time: ["12:50", "13:00", "13:10"][i] })) });
    const pf = preflight(s);
    expect(pf.items.filter((i) => i.level !== "ok")).toEqual([]);
    expect(pf.canStart).toBe(true);
    expect(applyOp(s, op({ type: "trip.start" }), ctx).ok).toBe(true);
  });

  it("warns (doesn't block) on no groom, no antes, missing long-drive tees and tee times", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup" });
    const s: TripState = { ...f.state, players: f.state.players.map((p) => ({ ...p, is_groom: false })) };
    const pf = preflight(s);
    expect(pf.canStart).toBe(true);
    const warn = pf.items.filter((i) => i.level === "warn").map((i) => i.id);
    expect(warn).toEqual(["groom", "antes", "tees", "tee_times"]);
    expect(pf.items.find((i) => i.id === "tees")?.detail).toContain("4, 9, 12, 18");
    expect(pf.items.find((i) => i.id === "tees")?.section).toBe("course");
  });

  it("blocks on an unassigned player and agrees with trip.start", () => {
    const f = setupTrip([4, 3, 3]);
    const r = applyOp(f.state, op({ type: "team.assign", player_id: f.player.C3, team_id: null }), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pf = preflight(r.state);
    expect(pf.canStart).toBe(false);
    expect(pf.items.find((i) => i.id === "assigned")).toMatchObject({ level: "block", detail: "Player C3" });
    expect(teamIssues(r.state)).toBe(1);
    expect(applyOp(r.state, op({ type: "trip.start" }), ctx).ok).toBe(false);
  });

  it("blocks on a 1-player or empty team and agrees with trip.start", () => {
    const f = setupTrip([4, 4, 1]);
    const pf = preflight(f.state);
    expect(pf.canStart).toBe(false);
    expect(pf.items.find((i) => i.id === "sizes")).toMatchObject({ level: "block", detail: "Team C has 1" });
    expect(applyOp(f.state, op({ type: "trip.start" }), ctx).ok).toBe(false);

    const g = setupTrip([4, 3, 3]);
    const added = applyOp(g.state, op({ type: "team.upsert", team: { id: "team-empty", name: "Ghost Team" } }), ctx);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(preflight(added.state).canStart).toBe(false);
    expect(applyOp(added.state, op({ type: "trip.start" }), ctx).ok).toBe(false);
  });

  it("blocks with no teams or no players", () => {
    const f = setupTrip([2]);
    const empty: TripState = { ...f.state, players: [], teams: [], team_members: [] };
    const pf = preflight(empty);
    expect(pf.canStart).toBe(false);
    expect(pf.items.filter((i) => i.level === "block").map((i) => i.id)).toEqual(["players", "teams"]);
    expect(applyOp(empty, op({ type: "trip.start" }), ctx).ok).toBe(false);
  });
});

describe("finalize summary", () => {
  it("lists teams that haven't tapped Round complete", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "live" });
    f.teeOff("A", 1);
    f.score("A", 1, 4);
    f.teeOff("A", 2);
    f.teeOff("B", 1);
    f.complete("B");
    const u = unfinishedTeams(f.state);
    expect(u.map((x) => [x.team.name, x.label])).toEqual([
      ["Team A", "on hole 2, 1 scored"],
      ["Team C", "hasn't teed off"],
    ]);
  });
});

describe("players", () => {
  it("validates and cleans the draft", () => {
    expect(validatePlayerDraft({ name: "  Nick ", nickname: " Big Nick ", venmo: "@Nick-Caster", is_groom: true }).value).toEqual({
      name: "Nick",
      nickname: "Big Nick",
      venmo_handle: "Nick-Caster",
      is_groom: true,
    });
    expect(validatePlayerDraft({ name: "Dave", nickname: "", venmo: "", is_groom: false }).value).toEqual({
      name: "Dave",
      nickname: null,
      venmo_handle: null,
      is_groom: false,
    });
    const bad = validatePlayerDraft({ name: " ", nickname: "", venmo: "Dave T", is_groom: false });
    expect(bad.value).toBeNull();
    expect(bad.errors.name).toBeTruthy();
    expect(bad.errors.venmo).toBeTruthy();
    expect(validatePlayerDraft({ name: "x".repeat(81), nickname: "", venmo: "", is_groom: false }).errors.name).toBeTruthy();
    expect(draftOfPlayer(null)).toEqual({ name: "", nickname: "", venmo: "", is_groom: false });
  });

  it("the cleaned draft is a valid player.upsert", () => {
    const f = setupTrip([4, 3, 3]);
    const v = validatePlayerDraft({ name: "Gus", nickname: "The Shank", venmo: "@gus_g", is_groom: true }).value!;
    const r = applyOp(f.state, op({ type: "player.upsert", player: { id: "new-gus", ...v } }), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gus = r.state.players.find((p) => p.id === "new-gus")!;
    expect(gus).toMatchObject({ name: "Gus", nickname: "The Shank", venmo_handle: "gus_g", is_groom: true });
    // One groom per trip.
    expect(r.state.players.filter((p) => p.is_groom).map((p) => p.id)).toEqual(["new-gus"]);
  });

  it("spots duplicate names", () => {
    const f = setupTrip([4, 3, 3]);
    expect(duplicateName(f.state.players, " player a1 ", null)?.id).toBe(f.player.A1);
    expect(duplicateName(f.state.players, "Player A1", f.player.A1)).toBeNull();
    expect(duplicateName(f.state.players, "", null)).toBeNull();
  });
});

describe("settings draft", () => {
  it("round-trips with no changes", () => {
    const f = setupTrip([4, 3, 3]);
    const d = settingsDraft(f.state.trip);
    expect(sameDraft(d, settingsDraft(f.state.trip))).toBe(true);
    expect(settingsPatch(f.state.trip, d)).toEqual({ errors: {}, patch: {} });
    expect(d.push_throttle_min).toBe(2);
    expect(d.judge_pct).toBe(50);
    expect(d.drink_cap).toBe("");
  });

  it("patches only what changed, and the reducer takes it", () => {
    const f = setupTrip([4, 3, 3]);
    const d = {
      ...settingsDraft(f.state.trip),
      app_name: "Nick's Last Stand",
      base_team_size: 3,
      roasts_enabled: false,
      ld_max_yd: "380",
      judge_pct: 40,
      push_throttle_min: 1.5,
      drink_cap: "12",
      tee_set: "advanced" as const,
    };
    const { errors, patch } = settingsPatch(f.state.trip, d);
    expect(errors).toEqual({});
    expect(patch).toEqual({
      app_name: "Nick's Last Stand",
      base_team_size: 3,
      settings: {
        tee_set: "advanced",
        roasts_enabled: false,
        ld_max_yd: 380,
        judge_suspicious_ratio: 0.4,
        push_throttle_sec: 90,
        drink_cap: 12,
      },
    });
    const r = applyOp(f.state, op({ type: "trip.update", patch: patch! }), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.trip.app_name).toBe("Nick's Last Stand");
    expect(r.state.trip.settings.drink_cap).toBe(12);
    // Saved state reads back as the same draft.
    expect(sameDraft(settingsDraft(r.state.trip), d)).toBe(true);
  });

  it("never validates or rewrites fields that weren't edited", () => {
    // A 100 s throttle shows as 1.5 min and a script-set roast cap is above the UI's max.
    const f = setupTrip([4, 3, 3], { push_throttle_sec: 100, roast_cap: 1000, judge_suspicious_ratio: 1 / 3 });
    const d = { ...settingsDraft(f.state.trip), app_name: "Renamed" };
    expect(settingsPatch(f.state.trip, d)).toEqual({ errors: {}, patch: { app_name: "Renamed" } });
  });

  it("clearing the drink cap sends null", () => {
    const f = setupTrip([4, 3, 3], { drink_cap: 10 });
    const { patch } = settingsPatch(f.state.trip, { ...settingsDraft(f.state.trip), drink_cap: "" });
    expect(patch).toEqual({ settings: { drink_cap: null } });
  });

  it("rejects bad input with field errors", () => {
    const f = setupTrip([4, 3, 3]);
    const base = settingsDraft(f.state.trip);
    expect(settingsPatch(f.state.trip, { ...base, app_name: "  " }).errors.app_name).toBeTruthy();
    expect(settingsPatch(f.state.trip, { ...base, ld_min_yd: "450", ld_max_yd: "400" }).errors.ld_max_yd).toBeTruthy();
    expect(settingsPatch(f.state.trip, { ...base, ld_max_yd: "900" }).errors.ld_max_yd).toBeTruthy();
    expect(settingsPatch(f.state.trip, { ...base, ld_min_yd: "" }).errors.ld_min_yd).toBeTruthy();
    expect(settingsPatch(f.state.trip, { ...base, drink_cap: "0" }).errors.drink_cap).toBeTruthy();
    expect(settingsPatch(f.state.trip, { ...base, base_team_size: 5 }).errors.base_team_size).toBeTruthy();
    expect(settingsPatch(f.state.trip, { ...base, name: "" }).patch).toBeNull();
  });
});

describe("PIN change", () => {
  it("validates before calling the server", () => {
    expect(pinChangeError("2468", "1357", "1357")).toBeNull();
    expect(pinChangeError("", "1357", "1357")).toBeTruthy();
    expect(pinChangeError("2468", "12", "12")).toBeTruthy();
    expect(pinChangeError("2468", "1357", "1358")).toMatch(/match/);
    expect(pinChangeError("2468", "2468", "2468")).toBeTruthy();
  });
});

describe("team names", () => {
  it("ships 40+ distinct, short local names", () => {
    expect(LOCAL_TEAM_NAMES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(LOCAL_TEAM_NAMES.map((n) => n.toLowerCase())).size).toBe(LOCAL_TEAM_NAMES.length);
    for (const n of LOCAL_TEAM_NAMES) expect(n.length).toBeLessThanOrEqual(40);
  });

  it("picks 5 distinct local names, skipping ones in use", () => {
    const names = localTeamNames(5, ["Bogey Nights", "fore play"], seeded(1));
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
    expect(names).not.toContain("Bogey Nights");
    expect(names).not.toContain("Fore Play");
  });

  it("cleans AI output", () => {
    expect(cleanNames(["1. \"Grip It & Sip It\"", "- Bogey Nights", "bogey nights", "", 42, "x".repeat(41), "Fore Play"])).toEqual([
      "Grip It & Sip It",
      "Bogey Nights",
      "Fore Play",
    ]);
    expect(cleanNames("nope")).toEqual([]);
  });

  it("uses the AI route when it answers", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ names: ["A", "B", "C", "D", "E", "F"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await generateTeamNames({ code: "abc", fetchImpl });
    expect(calls).toEqual(["/api/t/abc/ai/team-names"]);
    expect(r).toEqual({ names: ["A", "B", "C", "D", "E"], source: "ai" });
  });

  it("labels the route's own built-in names as the house list", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ names: ["V", "W", "X", "Y", "Z"], ai: false }), { status: 200 })) as unknown as typeof fetch;
    expect(await generateTeamNames({ code: "abc", fetchImpl })).toEqual({ names: ["V", "W", "X", "Y", "Z"], source: "local" });
  });

  it("tops up a short AI answer with local names", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ names: ["Only One"] }), { status: 200 })) as unknown as typeof fetch;
    const r = await generateTeamNames({ code: "abc", fetchImpl, random: seeded(2) });
    expect(r.source).toBe("ai");
    expect(r.names).toHaveLength(5);
    expect(r.names[0]).toBe("Only One");
  });

  it("falls back to the house list on errors, 404s, timeouts or AI off", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const notFound = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const hanging = ((_u: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    for (const r of [
      await generateTeamNames({ code: "abc", fetchImpl: failing }),
      await generateTeamNames({ code: "abc", fetchImpl: notFound }),
      await generateTeamNames({ code: "abc", fetchImpl: hanging, timeoutMs: 20 }),
      await generateTeamNames({ code: "abc", fetchImpl: spy, aiEnabled: false }),
    ]) {
      expect(r.source).toBe("local");
      expect(r.names).toHaveLength(5);
      for (const n of r.names) expect(LOCAL_TEAM_NAMES).toContain(n);
    }
    expect(called).toBe(false);
  });
});

describe("drag ids", () => {
  it("round-trips drop and drag ids", () => {
    expect(teamIdOfDropId(POOL_ID)).toBeNull();
    expect(teamIdOfDropId(teamDropId("t1"))).toBe("t1");
    expect(teamIdOfDropId("something")).toBeUndefined();
    expect(teamIdOfDropId(null)).toBeUndefined();
    expect(playerIdOfDragId(playerDragId("p1"))).toBe("p1");
    expect(playerIdOfDragId("team:x")).toBeNull();
  });
});
