import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { derive } from "@/lib/engine";
import type { Derived } from "@/lib/engine/types";
import type { FeedEvent, FeedEventType, TripState } from "@/lib/types";
import { noWindowRoast, renderFeedEvent, TEMPLATE_VARIANT_COUNTS, type RenderedEvent } from "@/lib/events/templates";
import { makeTrip } from "../fixtures";

// ---------------------------------------------------------------------------
// Fixture: 10 players (A1 is the groom), A2 has a nickname.
// ---------------------------------------------------------------------------

const f = makeTrip({ teams: [4, 3, 3] });
const P = f.player;
const T = f.team;
const state: TripState = {
  ...f.state,
  players: f.state.players.map((p) => (p.id === P.A2 ? { ...p, nickname: "Bombs" } : p)),
};
const d: Derived = derive(state);

let seq = 0;
function ev(type: FeedEventType, payload: Record<string, unknown>, x: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: `ev-${++seq}`,
    trip_id: state.trip.id,
    type,
    team_id: T.A,
    player_id: null,
    actor_id: null,
    payload,
    photo_path: null,
    text: null,
    dedupe_key: null,
    created_at: "2026-10-24T18:00:00.000Z",
    updated_at: "2026-10-24T18:00:00.000Z",
    deleted_at: null,
    ...x,
  };
}

const render = (e: FeedEvent, s: TripState = state) => renderFeedEvent(e, s, s === state ? d : derive(s));
const withId = (e: FeedEvent, id: string): FeedEvent => ({ ...e, id });
/** Render the same event under many ids: every variant shows up. */
function allVariants(e: FeedEvent, n = 600): RenderedEvent[] {
  const out = new Map<string, RenderedEvent>();
  for (let i = 0; i < n; i++) {
    const r = render(withId(e, `variant-${i}-${e.type}`));
    out.set(`${r.title}\n${r.body}`, r);
  }
  return [...out.values()];
}

// One well-formed sample per variant table (keys match TEMPLATE_VARIANT_COUNTS).
const SAMPLES: Record<string, FeedEvent> = {
  drinks: ev("drinks", { hole: 7, drink_ids: ["x1", "x2", "x3"], player_ids: [P.A1, P.A2, P.A1], logged_by_ids: [P.A1, P.A2, P.A1], count: 3 }),
  shotgun: ev("shotgun", { drink_id: "x4", drink_type: "shotgun", hole: 4, player_id: P.A2, logged_by: P.A3, value: 1, banked_mulligan: true }, { player_id: P.A2 }),
  shot: ev("shot", { drink_id: "x5", drink_type: "shot", hole: 4, player_id: P.A3, logged_by: P.A3, value: 1, banked_mulligan: true }, { player_id: P.A3 }),
  ghost_beer: ev("ghost_beer", { drink_id: "x6", drink_type: "drink", hole: 5, player_id: P.B1, value: 2, seq: 3 }, { team_id: T.B, player_id: P.B1 }),
  mulligan_used: ev("mulligan_used", { mulligan_id: "m1", hole: 3, source: "earned", used_by: P.A2, available: 1 }),
  groom_mulligan: ev("groom_mulligan", { mulligan_id: "m2", hole: 9, source: "groom", used_by: P.A1, groom_id: P.A1 }, { player_id: P.A1 }),
  lead_change: ev("lead_change", { leader_team_ids: [T.A], previous_leader_team_ids: [T.B], net_to_par: -3, thru: 6 }),
  tee_off: ev("tee_off", { hole: 1 }),
  round_started: ev("round_started", { team_count: 3, player_count: 10 }, { team_id: null }),
  "score_notable:birdie": ev("score_notable", { kind: "birdie", hole: 2, par: 4, strokes: 3, to_par: -1, credit: 0, net: 3, ace: false }),
  "score_notable:eagle": ev("score_notable", { kind: "eagle", hole: 4, par: 5, strokes: 3, to_par: -2, credit: 0, net: 3, ace: false }),
  "score_notable:albatross": ev("score_notable", { kind: "albatross", hole: 4, par: 5, strokes: 2, to_par: -3, credit: 0, net: 2, ace: false }),
  "score_notable:ace": ev("score_notable", { kind: "eagle", hole: 3, par: 3, strokes: 1, to_par: -2, credit: 0, net: 1, ace: true }),
  "score_notable:double": ev("score_notable", { kind: "double", hole: 6, par: 4, strokes: 6, to_par: 2, credit: 0, net: 6, ace: false }),
  "score_notable:triple_plus": ev("score_notable", { kind: "triple_plus", hole: 6, par: 4, strokes: 8, to_par: 4, credit: 0, net: 8, ace: false }),
  "score_notable:net_zero": ev("score_notable", { kind: "net_zero", hole: 7, par: 4, strokes: 4, to_par: 0, credit: 5, net: -1, ace: false }),
  "score_notable:last_at_turn": ev("score_notable", {
    kind: "last_at_turn",
    hole: 9,
    par: 5,
    strokes: 7,
    to_par: 2,
    credit: 1,
    net: 6,
    ace: false,
    pos_label: "3",
    net_to_par: 6,
  }),
  score_edit: ev("score_edit", { hole: 6, from: 5, to: 4, par: 4, edit_count: 1 }, { actor_id: P.A3 }),
  "drive_warning:hard": ev("drive_warning", { nine: 1, level: "hard", remaining: 2, needing: [P.A3, P.A4] }),
  "drive_warning:impossible": ev("drive_warning", { nine: 2, level: "impossible", remaining: 1, needing: [P.A3, P.A4] }),
  drive_miss: ev("drive_miss", { nine: 2, missed: [P.B2], commissioner_flag: true }, { team_id: T.B }),
  "contest_entry:ctp": ev(
    "contest_entry",
    { entry_id: "e1", hole: 3, contest_type: "ctp", distance: 12.5, unit: "ft", rank: 2, valid: true, status: "ok", flag_reason: null, invalid_reason: null, replaced: false, valid_count: 3 },
    { player_id: P.A2, photo_path: "trips/t/contest/1.jpg" },
  ),
  "contest_entry:ld": ev(
    "contest_entry",
    { entry_id: "e2", hole: 4, contest_type: "ld", distance: 287, unit: "yd", rank: 1, valid: true, status: "ok", flag_reason: null, invalid_reason: null, replaced: false, valid_count: 2 },
    { player_id: P.B1, team_id: T.B },
  ),
  "contest_entry:flagged": ev(
    "contest_entry",
    { entry_id: "e3", hole: 12, contest_type: "ld", distance: 330, unit: "yd", rank: null, valid: false, status: "flagged", flag_reason: "GPS was weak", invalid_reason: "Needs commissioner review: GPS was weak", replaced: false, valid_count: 0 },
    { player_id: P.C1, team_id: T.C },
  ),
  contest_lead: ev("contest_lead", { hole: 3, contest_type: "ctp", leader_ids: [P.B1], previous_leader_ids: [P.A2], distance: 4.25, unit: "ft" }, { team_id: T.B, player_id: P.B1 }),
  commissioner_override: ev("commissioner_override", { op_type: "drink.move", summary: "moved a drink from hole 6 to hole 7" }, { actor_id: P.A1 }),
  round_complete: ev("round_complete", { gross: 80, net: 61, net_to_par: -11, gross_to_par: 8, pos_label: "T2", thru: 18, drinks: 19, ghost_beers: 2, last: false }),
  "round_complete:last": ev("round_complete", { gross: 95, net: 90, net_to_par: 18, gross_to_par: 23, pos_label: "3", thru: 18, drinks: 5, ghost_beers: 0, last: true }, { team_id: T.C }),
  final_results: ev("final_results", { finalized_at: "2026-10-24T23:00:00.000Z", champion_team_ids: [T.A], champion_player_ids: [], standings: [{ team_id: T.A, net_to_par: -14 }] }, { team_id: T.A }),
};

const OTHER_SAMPLES: FeedEvent[] = [
  ev("post", {}, { player_id: P.B2, actor_id: P.B2, text: "Who parked the cart in the bunker" }),
  ev("roast", { trigger_event_id: "ev-1" }, { text: "Team A putts like they're defusing a bomb." }),
  ev("ai_judge", { entry_id: "e1", hole: 3, claimed_ft: 2, estimate_ft: 14, confidence: "high", suspicious: true, roast: "That's not 2 feet, that's a zip code." }, { player_id: P.A2 }),
  ev("ai_judge", { entry_id: "e1", hole: 3, claimed_ft: 12, estimate_ft: 13, confidence: "medium", suspicious: false, roast: null }, { player_id: P.A2 }),
];

const ALL_TYPES: FeedEventType[] = [
  "post",
  "round_started",
  "tee_off",
  "score_notable",
  "score_edit",
  "drinks",
  "shotgun",
  "shot",
  "ghost_beer",
  "mulligan_used",
  "groom_mulligan",
  "lead_change",
  "contest_entry",
  "contest_lead",
  "ai_judge",
  "drive_warning",
  "drive_miss",
  "commissioner_override",
  "round_complete",
  "final_results",
  "roast",
];

// Off-limits topics: partners/fiancées, families, jobs, appearance.
const BANNED_WORDS = [
  "wife", "wives", "girlfriend", "boyfriend", "husband", "spouse", "bride", "wedding", "marriage", "married",
  "mom", "mommy", "mother", "dad", "daddy", "father", "brother", "sister", "son", "daughter", "kid", "kids", "family", "parents",
  "job", "jobs", "boss", "career", "office", "salary", "unemployed", "coworker",
  "fat", "ugly", "bald", "hair", "belly", "weight", "chubby", "skinny", "face", "looks",
];
const BANNED_SUBSTRINGS = ["fianc", "wife", "girlfriend", "husband", "mom", "dad", "fat", "ugly", "bald", "boss", "job", "marri", "wedding"];

function bannedHits(text: string): string[] {
  const lower = text.toLowerCase();
  const hits = BANNED_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
  hits.push(...BANNED_SUBSTRINGS.filter((s) => lower.includes(s)));
  return hits;
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error");
});
afterEach(() => {
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------

describe("renderFeedEvent", () => {
  it("renders every FeedEventType from a well-formed payload", () => {
    const samples = [...Object.values(SAMPLES), ...OTHER_SAMPLES];
    for (const type of ALL_TYPES) expect(samples.some((s) => s.type === type), type).toBe(true);
    for (const s of samples) {
      const r = render(s);
      expect(r.title.length, s.type).toBeGreaterThan(0);
      expect(r.emoji.length, s.type).toBeGreaterThan(0);
      expect(r.body.length, s.type).toBeGreaterThan(0);
      expect(r.body, s.type).not.toMatch(/undefined|NaN|null|\[object/);
      expect(r.title, s.type).not.toMatch(/undefined|NaN|null|\[object/);
      expect(["hype", "roast", "info", "alert", "fanfare"]).toContain(r.tone);
    }
  });

  it("never throws on empty or garbage payloads (old rows, other producers)", () => {
    const garbage: Record<string, unknown>[] = [
      {},
      { hole: "seven", count: "lots", drink_ids: "nope", player_ids: [1, 2], leader_team_ids: null, standings: "x", missed: {}, kind: 42 },
    ];
    for (const type of [...ALL_TYPES, "mystery_type" as FeedEventType]) {
      for (const payload of garbage) {
        const r = render(ev(type, payload, { team_id: null }));
        expect(typeof r.title).toBe("string");
        expect(typeof r.body).toBe("string");
        expect(r.body).not.toMatch(/undefined|NaN|\[object/);
      }
    }
    // A null payload from a broken row still renders.
    expect(() => render(ev("drinks", null as unknown as Record<string, unknown>))).not.toThrow();
  });

  it("marks exactly the oversized events as big", () => {
    const big = new Set(["groom_mulligan", "ghost_beer", "final_results", "lead_change"]);
    for (const s of [...Object.values(SAMPLES), ...OTHER_SAMPLES]) expect(render(s).big, s.type).toBe(big.has(s.type));
  });

  it("is deterministic per event id", () => {
    for (const s of Object.values(SAMPLES)) expect(render(s)).toEqual(render({ ...s }));
  });

  it("score_edit always says 'changed hole N from a A to a B'", () => {
    for (const r of allVariants(SAMPLES.score_edit)) expect(r.body).toContain("changed hole 6 from a 5 to a 4");
    // Actor named when known; else the team does the changing.
    expect(render(SAMPLES.score_edit).body).toContain("Player A3");
    const anon = render(ev("score_edit", { hole: 12, from: 8, to: 7 }, { team_id: T.B }));
    expect(anon.body).toContain("changed hole 12 from a 8 to a 7");
    expect(anon.body).toContain("Team B");
  });

  it("drinks posts say 'N drinks on hole H' with who drank", () => {
    for (const r of allVariants(SAMPLES.drinks)) {
      expect(r.body).toContain("3 drinks on hole 7");
      expect(r.body).toContain("Player A1 👑 ×2");
      expect(r.body).toContain("Bombs");
    }
    expect(render(ev("drinks", { hole: 2, drink_ids: ["y"], player_ids: [P.B3], count: 1 })).body).toContain("1 drink on hole 2");
  });

  it("drinks posts count only drinks that are still active", () => {
    const g = makeTrip({ teams: [4, 3] });
    g.teeOff("A", 7);
    const d1 = g.drink("A", "A1", 7);
    const d2 = g.drink("A", "A2", 7);
    const d3 = g.drink("A", "A2", 7);
    g.deleteDrink(d2);
    const e = ev("drinks", { hole: 7, drink_ids: [d1, d2, d3], player_ids: [g.player.A1, g.player.A2, g.player.A2], count: 3 }, { team_id: g.team.A });
    const r = renderFeedEvent(e, g.state, derive(g.state));
    expect(r.body).toContain("2 drinks on hole 7");
  });

  it("ghost beers are big with GHOST BEER in the title", () => {
    for (const r of allVariants(SAMPLES.ghost_beer)) {
      expect(r.title).toContain("GHOST BEER");
      expect(r.big).toBe(true);
      expect(r.body).toContain("Player B1");
    }
  });

  it("shotguns and shots bank a mulligan and show who logged it", () => {
    for (const r of [...allVariants(SAMPLES.shotgun), ...allVariants(SAMPLES.shot)]) {
      expect(r.body.toLowerCase()).toContain("mulligan");
      expect(r.body.toLowerCase()).toContain("bank");
    }
    for (const r of allVariants(SAMPLES.shotgun)) {
      expect(r.body).toContain("Bombs"); // nickname over name
      expect(r.body).not.toContain("Player A2");
      expect(r.body).toContain("(logged by Player A3)");
    }
    for (const r of allVariants(SAMPLES.shot)) expect(r.body).not.toContain("logged by");
  });

  it("the groom gets his crown and the Groom's Mulligan is a big fanfare", () => {
    for (const r of allVariants(SAMPLES.groom_mulligan)) {
      expect(r.body).toContain("Player A1 👑");
      expect(r.big).toBe(true);
      expect(r.tone).toBe("fanfare");
    }
  });

  it("post and roast render their text", () => {
    const post = render(OTHER_SAMPLES[0]);
    expect(post.body).toBe("Who parked the cart in the bunker");
    expect(post.title).toBe("Player B2");
    expect(render(ev("post", {}, { player_id: P.A1, photo_path: "p.jpg", text: null })).emoji).toBe("📸");
    expect(render(OTHER_SAMPLES[1]).body).toBe("Team A putts like they're defusing a bomb.");
  });

  it("lead changes name the leaders, ties and who got knocked off", () => {
    const single = render(SAMPLES.lead_change);
    expect(single.title).toBe("NEW LEADER");
    expect(single.body).toContain("Team A");
    expect(single.body).toContain("-3");
    const tie = render(ev("lead_change", { leader_team_ids: [T.A, T.C], previous_leader_team_ids: [T.A], net_to_par: 0 }));
    expect(tie.title).toBe("TIE FOR THE LEAD");
    expect(tie.body).toContain("Team A and Team C");
    expect(tie.body).toContain(" E");
  });

  it("contest entries format distances, ranks and review status", () => {
    expect(render(SAMPLES["contest_entry:ctp"]).body).toContain(`12' 6"`);
    expect(render(SAMPLES["contest_entry:ctp"]).body).toContain("Currently 2nd.");
    expect(render(SAMPLES["contest_entry:ld"]).body).toContain("287 yd");
    for (const r of allVariants(SAMPLES["contest_entry:flagged"])) {
      expect(r.body.toLowerCase()).toContain("commissioner");
      expect(r.body).toContain("GPS was weak");
      expect(r.tone).toBe("alert");
    }
    // A replaced entry says so.
    const g = makeTrip({ teams: [4, 3] });
    const id = g.entry({ hole: 3, player_id: g.player.A2, type: "ctp", distance_value: 10 });
    g.state = { ...g.state, contest_entries: g.state.contest_entries.map((e) => ({ ...e, deleted_at: "2026-10-24T18:00:00.000Z" })) };
    const r = renderFeedEvent(
      ev("contest_entry", { entry_id: id, hole: 3, contest_type: "ctp", distance: 10, unit: "ft", rank: 1, valid: true, status: "ok", valid_count: 1 }, { player_id: g.player.A2 }),
      g.state,
      derive(g.state),
    );
    expect(r.body).toContain("(Since re-measured.)");
  });

  it("AI judge shows the estimate and flags suspicious entries", () => {
    const sus = render(OTHER_SAMPLES[2]);
    expect(sus.title).toBe("AI JUDGE: SUSPICIOUS");
    expect(sus.tone).toBe("alert");
    expect(sus.body).toContain(`claimed 2' 0"`);
    expect(sus.body).toContain(`~14' 0"`);
    expect(sus.body).toContain("zip code");
    const ok = render(OTHER_SAMPLES[3]);
    expect(ok.title).toBe("AI JUDGE");
    expect(ok.tone).toBe("info");
  });

  it("commissioner overrides show the summary, and who did it", () => {
    for (const r of allVariants(SAMPLES.commissioner_override)) {
      expect(r.body).toContain("Player A1 👑 moved a drink from hole 6 to hole 7");
      expect(r.title).toBe("COMMISSIONER OVERRIDE");
    }
    const anon = render(ev("commissioner_override", { op_type: "trip.reopen", summary: "reopened the round" }));
    expect(anon.body).toContain("The commissioner reopened the round");
  });

  it("drive warnings and misses name the players", () => {
    for (const r of [...allVariants(SAMPLES["drive_warning:hard"]), ...allVariants(SAMPLES["drive_warning:impossible"])]) {
      expect(r.body).toContain("Player A3");
      expect(r.tone).toBe("alert");
    }
    for (const r of allVariants(SAMPLES.drive_miss)) {
      expect(r.body).toContain("Player B2");
      expect(r.body).toContain("back nine");
    }
  });

  it("final results crown the champions", () => {
    const r = render(SAMPLES.final_results);
    expect(r.body).toContain("Team A");
    expect(r.body).toContain("-14");
    expect(r.big).toBe(true);
    const tie = render(ev("final_results", { champion_team_ids: [T.A, T.B], standings: [{ team_id: T.A, net_to_par: -2 }] }));
    expect(tie.body).toContain("Team A and Team B");
  });

  it("round complete uses ordinal positions", () => {
    expect(render(SAMPLES.round_complete).body).toMatch(/T2nd|-11/);
    for (const r of allVariants(SAMPLES["round_complete:last"])) expect(r.tone).toBe("roast");
  });
});

describe("variants", () => {
  const FREQUENT = [
    "drinks",
    "shotgun",
    "shot",
    "ghost_beer",
    "score_notable:birdie",
    "score_notable:eagle",
    "score_notable:albatross",
    "score_notable:ace",
    "score_notable:double",
    "score_notable:triple_plus",
    "score_notable:net_zero",
    "score_notable:last_at_turn",
    "score_edit",
    "mulligan_used",
    "lead_change",
    "drive_warning:hard",
    "drive_warning:impossible",
    "drive_miss",
    "contest_entry:ctp",
    "contest_entry:ld",
    "round_complete",
    "round_complete:last",
  ];

  it("every variant table has a sample and every variant gets rendered", () => {
    for (const key of Object.keys(TEMPLATE_VARIANT_COUNTS)) {
      if (key === "no_window") continue;
      expect(SAMPLES[key], key).toBeDefined();
      expect(allVariants(SAMPLES[key]).length, key).toBe(TEMPLATE_VARIANT_COUNTS[key]);
    }
  });

  it("frequent events have at least 4 variants", () => {
    for (const key of FREQUENT) expect(TEMPLATE_VARIANT_COUNTS[key], key).toBeGreaterThanOrEqual(4);
  });

  it("no variant touches partners, families, jobs or appearance", () => {
    const texts: string[] = [];
    for (const s of [...Object.values(SAMPLES), ...OTHER_SAMPLES]) {
      for (const r of allVariants(s)) texts.push(r.title, r.body);
    }
    for (let i = 0; i < 300; i++) texts.push(noWindowRoast(`seed-${i}`));
    expect(texts.length).toBeGreaterThan(150);
    const offenders = texts.map((t) => ({ t, hits: bannedHits(t) })).filter((x) => x.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it("the banned-topic scanner actually catches things", () => {
    expect(bannedHits("Your fiancée called")).toContain("fianc");
    expect(bannedHits("tell your MOM")).toContain("mom");
    expect(bannedHits("Swings like a dad")).toContain("dad");
    expect(bannedHits("nice haircut, baldy")).toContain("bald");
    expect(bannedHits("great drive")).toEqual([]);
  });
});

describe("noWindowRoast", () => {
  it("has at least 5 variants, all about drinking before teeing off, deterministic per seed", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(noWindowRoast(`drink-${i}`));
    expect(seen.size).toBe(TEMPLATE_VARIANT_COUNTS.no_window);
    expect(seen.size).toBeGreaterThanOrEqual(5);
    for (const s of seen) expect(s).toMatch(/tee|count|round/i);
    expect(noWindowRoast("abc")).toBe(noWindowRoast("abc"));
  });
});
