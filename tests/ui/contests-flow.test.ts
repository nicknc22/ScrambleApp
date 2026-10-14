// Contest entry flows: GPS retry state machine, long drive distance/verdict, closest-to-pin wizard,
// who can enter, op building (checked against the real reducer + engine), undo, and the
// Contests tab view-model.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { derive } from "@/lib/engine";
import { applyOp } from "@/lib/reducer";
import type { Op, OpInput } from "@/lib/ops";
import type { ContestEntry, TripState } from "@/lib/types";
import type { GeoReading } from "@/lib/client/geo";
import { at, makeTrip } from "../fixtures";
import {
  GPS_INITIAL,
  MAX_GPS_TRIES,
  canAcceptWeak,
  clampFeet,
  clampInches,
  ctpCanAdvance,
  ctpDistance,
  ctpNextStep,
  ctpPhotoPath,
  ctpPrevStep,
  ctpSubmitInput,
  defaultEntrant,
  entrantChoices,
  entryAccess,
  gpsReducer,
  isAccurate,
  ldDistanceYards,
  ldRange,
  ldSubmitInput,
  ldVerdict,
  previewRank,
  teamReachedHole,
  teePoint,
  triesLeft,
  undoInputs,
  type CtpDraft,
  type GpsEvent,
  type GpsFlow,
} from "@/components/contests/flow";
import { aiVerdict, contestCounts, entryBadges, entryNote, entryOf, formatContestDistance, leaderLine, plotEntries, potInfo } from "@/components/contests/model";

const reading = (accuracy: number, lat = 41.1, lng = -75.6): GeoReading => ({ lat, lng, accuracy, timestamp: 1 });
const run = (events: GpsEvent[], from: GpsFlow = GPS_INITIAL) => events.reduce(gpsReducer, from);
const LIMIT = 12;
const weakTry = (acc: number): GpsEvent[] => [{ type: "start" }, { type: "result", reading: reading(acc), limitM: LIMIT }];

/** Yards north of a point (mean Earth radius, as the engine's haversine). */
const north = (p: { lat: number; lng: number }, yards: number) => ({ lat: p.lat + ((yards * 0.9144) / 6371008.8) * (180 / Math.PI), lng: p.lng });
const TEE = { lat: 41.0948, lng: -75.648 };

/** `by` defaults to the entrant (only the player's team, or the commissioner, may enter for them). */
function apply(state: TripState, input: OpInput, opts: { by?: string | null; minute?: number; commish?: boolean } = {}) {
  const by = opts.by !== undefined ? opts.by : ((input as { player_id?: string }).player_id ?? null);
  const op = { ...input, id: randomUUID(), at: at(opts.minute ?? 30), by } as Op;
  return applyOp(state, op, { now: at(opts.minute ?? 30), is_commissioner: opts.commish ?? false, side: "client" });
}

function mustApply(state: TripState, input: OpInput, opts: Parameters<typeof apply>[2] = {}): TripState {
  const r = apply(state, input, opts);
  if (!r.ok) throw new Error(`${input.type} rejected: ${r.reason}`);
  return r.state;
}

/** A valid photo path for the trip (the reducer only accepts trips/<trip_id>/<kind>/<uuid>.jpg). */
const photoFor = (state: TripState, kind: "ld" | "ctp") => `trips/${state.trip.id}/${kind}/${randomUUID()}.jpg`;

function withTee(state: TripState, hole: number, tee = TEE): TripState {
  return { ...state, holes: state.holes.map((h) => (h.number === hole ? { ...h, tee_lat: tee.lat, tee_lng: tee.lng } : h)) };
}

describe("GPS state machine", () => {
  it("measures: start -> good reading -> fixed", () => {
    const s = run([{ type: "start" }, { type: "progress", reading: reading(30) }, { type: "progress", reading: reading(9) }]);
    expect(s.phase).toBe("measuring");
    expect(s.attempts).toBe(1);
    expect(s.live?.accuracy).toBe(9);
    const done = gpsReducer(s, { type: "result", reading: reading(4), limitM: LIMIT });
    expect(done.phase).toBe("fixed");
    expect(done.fix?.accuracy).toBe(4);
    expect(done.lowAccuracy).toBe(false);
    expect(done.failures).toBe(0);
  });

  it("counts the accuracy limit as good (<= limit), worse as weak", () => {
    expect(isAccurate({ accuracy: 12 }, 12)).toBe(true);
    expect(isAccurate({ accuracy: 12.1 }, 12)).toBe(false);
    expect(isAccurate({ accuracy: Number.POSITIVE_INFINITY }, 12)).toBe(false);
    expect(run(weakTry(12)).phase).toBe("fixed");
    expect(run(weakTry(13)).phase).toBe("weak");
  });

  it("weak -> retry; the review fallback unlocks after 3 failed tries with the latest reading", () => {
    let s = run(weakTry(30));
    expect(s.phase).toBe("weak");
    expect(s.failures).toBe(1);
    expect(triesLeft(s)).toBe(2);
    expect(canAcceptWeak(s)).toBe(false);
    // accept_weak is ignored until it's allowed.
    expect(gpsReducer(s, { type: "accept_weak" })).toBe(s);
    s = run([...weakTry(18), ...weakTry(25)], s);
    expect(s.failures).toBe(MAX_GPS_TRIES);
    expect(s.attempts).toBe(3);
    expect(triesLeft(s)).toBe(0);
    expect(canAcceptWeak(s)).toBe(true);
    const fixed = gpsReducer(s, { type: "accept_weak" });
    expect(fixed.phase).toBe("fixed");
    expect(fixed.lowAccuracy).toBe(true);
    expect(fixed.fix?.accuracy).toBe(25); // the latest try's reading: the player may have moved since the ±18 m one
  });

  it("after 'Measure again', the weak fallback never reuses a reading from the earlier spot (finding: GPS fallback stale best)", () => {
    // A good ±4 m fix at spot A (not at the ball yet), then three weak tries at the ball.
    let s = run([{ type: "start" }, { type: "result", reading: reading(4, 41.0), limitM: LIMIT }]);
    expect(s.phase).toBe("fixed");
    s = run([{ type: "start" }, { type: "result", reading: reading(25, 41.2), limitM: LIMIT }], s);
    // Tries start over at the new spot.
    expect(s.failures).toBe(1);
    expect(canAcceptWeak(s)).toBe(false);
    s = run([{ type: "start" }, { type: "result", reading: reading(20, 41.21), limitM: LIMIT }, { type: "start" }, { type: "result", reading: reading(30, 41.22), limitM: LIMIT }], s);
    expect(canAcceptWeak(s)).toBe(true);
    const fixed = gpsReducer(s, { type: "accept_weak" });
    expect(fixed).toMatchObject({ phase: "fixed", lowAccuracy: true });
    expect(fixed.fix).toMatchObject({ lat: 41.22, accuracy: 30 }); // the latest try at the ball, not spot A's ±4 m
    // A later try with no reading at all still sends the latest reading there is.
    const timedOut = run([{ type: "start" }, { type: "error", code: "timeout" }], s);
    expect(gpsReducer(timedOut, { type: "accept_weak" }).fix).toMatchObject({ lat: 41.22 });
  });

  it("a good reading on a retry clears the weak path", () => {
    const s = run([...weakTry(30), ...weakTry(40), { type: "start" }, { type: "result", reading: reading(6), limitM: LIMIT }]);
    expect(s.phase).toBe("fixed");
    expect(s.lowAccuracy).toBe(false);
    expect(s.fix?.accuracy).toBe(6);
  });

  it("timeouts count as failures but need a reading to submit; permission denied never unlocks review", () => {
    let s = run([
      { type: "start" },
      { type: "error", code: "timeout" },
      { type: "start" },
      { type: "error", code: "unavailable" },
      { type: "start" },
      { type: "error", code: "timeout" },
    ]);
    expect(s.phase).toBe("error");
    expect(s.failures).toBe(3);
    expect(canAcceptWeak(s)).toBe(false); // nothing to submit
    s = run(weakTry(50), s);
    expect(canAcceptWeak(s)).toBe(true);

    const denied = run([...weakTry(30), ...weakTry(30), { type: "start" }, { type: "error", code: "permission_denied" }]);
    expect(denied.phase).toBe("error");
    expect(denied.error).toBe("permission_denied");
    expect(denied.failures).toBe(2);
    expect(canAcceptWeak(denied)).toBe(false);
  });

  it("ignores stray events outside a measurement, and double starts", () => {
    const idle = GPS_INITIAL;
    expect(gpsReducer(idle, { type: "result", reading: reading(3), limitM: LIMIT })).toBe(idle);
    expect(gpsReducer(idle, { type: "progress", reading: reading(3) })).toBe(idle);
    expect(gpsReducer(idle, { type: "error", code: "timeout" })).toBe(idle);
    const measuring = gpsReducer(idle, { type: "start" });
    expect(gpsReducer(measuring, { type: "start" })).toBe(measuring);
    const fixed = gpsReducer(measuring, { type: "result", reading: reading(3), limitM: LIMIT });
    expect(gpsReducer(fixed, { type: "result", reading: reading(50), limitM: LIMIT })).toBe(fixed);
  });

  it("re-measuring after a fix starts a fresh attempt; reset clears everything", () => {
    const fixed = run(weakTry(3));
    const again = gpsReducer(fixed, { type: "start" });
    expect(again.phase).toBe("measuring");
    expect(again.fix).toBeNull();
    expect(again.attempts).toBe(2);
    expect(gpsReducer(again, { type: "reset" })).toEqual(GPS_INITIAL);
  });
});

describe("long drive", () => {
  it("measures yards from the hole's tee point", () => {
    const hole = { tee_lat: TEE.lat, tee_lng: TEE.lng };
    expect(teePoint(hole)).toEqual(TEE);
    expect(ldDistanceYards(hole, north(TEE, 280))).toBe(280);
    expect(ldDistanceYards(hole, north(TEE, 312.4))).toBe(312);
    expect(ldDistanceYards(hole, TEE)).toBe(0);
  });

  it("can't measure without a tee point (or a ball)", () => {
    expect(teePoint({ tee_lat: null, tee_lng: -75 })).toBeNull();
    expect(teePoint({ tee_lat: Number.NaN, tee_lng: -75 })).toBeNull();
    expect(ldDistanceYards({ tee_lat: null, tee_lng: null }, TEE)).toBeNull();
    expect(ldDistanceYards({ tee_lat: TEE.lat, tee_lng: TEE.lng }, null)).toBeNull();
  });

  it("sends out-of-range and weak-GPS drives to the commissioner, blocks absurd ones", () => {
    const settings = { ld_min_yd: 100, ld_max_yd: 400 };
    expect(ldRange(100, settings)).toBe("ok");
    expect(ldRange(400, settings)).toBe("ok");
    expect(ldRange(99, settings)).toBe("short");
    expect(ldRange(401, settings)).toBe("long");
    expect(ldVerdict(280, false, settings)).toEqual({ blocked: false, review: false, reason: null });
    expect(ldVerdict(280, true, settings)).toMatchObject({ review: true, blocked: false });
    expect(ldVerdict(95, false, settings).reason).toMatch(/Under 100 yd/);
    expect(ldVerdict(420, false, settings).reason).toMatch(/Over 400 yd/);
    expect(ldVerdict(701, false, settings)).toMatchObject({ blocked: true });
    expect(ldVerdict(Number.NaN, false, settings)).toMatchObject({ blocked: true });
  });

  it("previews the rank against every group, ignoring my own entry", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.entry({ hole: 4, player_id: f.player.B1, type: "ld", distance_value: 300 });
    f.entry({ hole: 4, player_id: f.player.C1, type: "ld", distance_value: 250 });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 310 });
    f.entry({ hole: 4, player_id: f.player.A2, type: "ld", distance_value: 420 }); // out of range: not ranked
    const summary = derive(f.state).contests.find((c) => c.hole === 4);
    const p = previewRank(summary, f.player.A1, 280);
    expect(p?.rank).toBe(2);
    expect(p?.label).toBe("2nd");
    expect(p?.leader?.player_id).toBe(f.player.B1);
    expect(previewRank(summary, f.player.A1, 300)?.label).toBe("T1st");
    expect(previewRank(summary, f.player.A3, 350)?.label).toBe("1st");
    expect(previewRank(undefined, f.player.A1, 280)).toBeNull();
    expect(previewRank(summary, null, 280)).toBeNull();
  });
});

describe("closest to pin wizard", () => {
  const draft = (p: Partial<CtpDraft>): CtpDraft => ({ step: "photo", hasPhoto: false, noPhoto: false, feet: 10, inches: 0, angle: 180, ...p });

  it("needs a photo or an explicit no-photo to leave step 1", () => {
    expect(ctpCanAdvance(draft({}))).toBe(false);
    expect(ctpCanAdvance(draft({ hasPhoto: true }))).toBe(true);
    expect(ctpCanAdvance(draft({ noPhoto: true }))).toBe(true);
    expect(ctpCanAdvance(draft({ step: "distance" }))).toBe(true);
    expect(ctpCanAdvance(draft({ step: "where" }))).toBe(true);
  });

  it("steps forward and back", () => {
    expect(ctpNextStep("photo")).toBe("distance");
    expect(ctpNextStep("distance")).toBe("where");
    expect(ctpNextStep("where")).toBeNull();
    expect(ctpPrevStep("where")).toBe("distance");
    expect(ctpPrevStep("photo")).toBeNull();
  });

  it("converts feet + inches (inches 0..11) to the submitted decimal feet", () => {
    expect(ctpDistance({ feet: 6, inches: 3 })).toBe(6.25);
    expect(ctpDistance({ feet: 0, inches: 0 })).toBe(0);
    expect(ctpDistance({ feet: 250, inches: 5 })).toBe(200 + 5 / 12);
    expect(clampInches(12)).toBe(11);
    expect(clampInches(-1)).toBe(0);
    expect(clampFeet(3.9)).toBe(3);
    expect(clampFeet(9999)).toBe(200);
  });
});

describe("who can enter", () => {
  it("offers my team (me first), or everyone on a team when I'm not on one", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const d = derive(f.state);
    const mine = entrantChoices(d, f.player.A3).map((p) => p.id);
    expect(mine).toEqual([f.player.A3, f.player.A1, f.player.A2, f.player.A4]);
    expect(defaultEntrant(entrantChoices(d, f.player.A3), f.player.A3)).toBe(f.player.A3);
    const everyone = entrantChoices(d, null);
    expect(everyone).toHaveLength(10);
    expect(everyone[0].id).toBe(f.player.A1);
    expect(defaultEntrant(everyone, null)).toBe(f.player.A1);
    expect(defaultEntrant([], null)).toBeNull();
  });

  it("knows which holes a team has reached", () => {
    expect(teamReachedHole(null, 3)).toBe(false);
    expect(teamReachedHole({ open_hole: null, started_holes: [], status: "not_started" }, 1)).toBe(false);
    expect(teamReachedHole({ open_hole: 3, started_holes: [1, 2, 3], status: "playing" }, 3)).toBe(true);
    expect(teamReachedHole({ open_hole: 5, started_holes: [5], status: "playing" }, 3)).toBe(true);
    expect(teamReachedHole({ open_hole: 2, started_holes: [2], status: "playing" }, 3)).toBe(false);
    expect(teamReachedHole({ open_hole: 1, started_holes: [1], status: "complete" }, 18)).toBe(true);
  });

  it("closest to pin: any reached hole; long drive: only the current hole while playing", () => {
    const playing4 = { open_hole: 4, started_holes: [1, 2, 3, 4], status: "playing" as const };
    // A hole the group already left: still allowed, offered as a late entry.
    expect(entryAccess({ type: "ctp", hole: 3, tripStatus: "live", rs: playing4, onTeam: true })).toEqual({ can: true, reason: null, late: true });
    // The hole you're standing on: the normal (primary) entry, no `late`.
    expect(entryAccess({ type: "ctp", hole: 4, tripStatus: "live", rs: playing4, onTeam: true })).toEqual({ can: true, reason: null });
    expect(entryAccess({ type: "ctp", hole: 8, tripStatus: "live", rs: playing4, onTeam: true }).reason).toMatch(/tees off hole 8/);
    expect(entryAccess({ type: "ld", hole: 4, tripStatus: "live", rs: playing4, onTeam: true })).toEqual({ can: true, reason: null });
    expect(entryAccess({ type: "ld", hole: 9, tripStatus: "live", rs: playing4, onTeam: true })).toMatchObject({ can: false });
    const playing5 = { ...playing4, open_hole: 5, started_holes: [1, 2, 3, 4, 5] };
    expect(entryAccess({ type: "ld", hole: 4, tripStatus: "live", rs: playing5, onTeam: true }).reason).toMatch(/past this hole/);
    const done = { open_hole: 18, started_holes: [], status: "complete" as const };
    expect(entryAccess({ type: "ld", hole: 18, tripStatus: "live", rs: done, onTeam: true }).can).toBe(false);
    expect(entryAccess({ type: "ctp", hole: 16, tripStatus: "live", rs: done, onTeam: true })).toEqual({ can: true, reason: null, late: true });
    // Round complete: even the last open hole is a late entry now.
    expect(entryAccess({ type: "ctp", hole: 18, tripStatus: "live", rs: done, onTeam: true })).toEqual({ can: true, reason: null, late: true });
    // Never late when it's locked or when it's long drive.
    expect(entryAccess({ type: "ctp", hole: 8, tripStatus: "live", rs: playing4, onTeam: true })).not.toHaveProperty("late");
    expect(entryAccess({ type: "ld", hole: 4, tripStatus: "live", rs: playing5, onTeam: true })).not.toHaveProperty("late");
  });

  it("hides or explains the button outside a live round", () => {
    const rs = { open_hole: 3, started_holes: [3], status: "playing" as const };
    expect(entryAccess({ type: "ctp", hole: 3, tripStatus: "setup", rs, onTeam: true })).toEqual({ can: false, reason: "Opens when the round starts." });
    expect(entryAccess({ type: "ctp", hole: 3, tripStatus: "final", rs, onTeam: true })).toEqual({ can: false, reason: null });
    expect(entryAccess({ type: "ctp", hole: 3, tripStatus: "live", rs, onTeam: false })).toEqual({ can: false, reason: null });
  });
});

describe("submitting through the real reducer", () => {
  it("a long drive lands on the board, measured from the tee", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.teeOff("A", 4);
    const state = withTee(f.state, 4);
    const ball = north(TEE, 281);
    const photo = photoFor(state, "ld");
    const input = ldSubmitInput({
      entryId: randomUUID(),
      hole: 4,
      playerId: f.player.A2,
      yards: 281,
      fix: { ...ball, accuracy: 4.26 },
      lowAccuracy: false,
      photoPath: photo,
    });
    expect(input).toMatchObject({ type: "contest.submit", contest_type: "ld", angle_deg: null, gps_accuracy_m: 4.3, low_accuracy: false });
    expect(input).not.toHaveProperty("simulated");
    const next = mustApply(state, input, { by: f.player.A1 });
    const c = derive(next).contests.find((x) => x.hole === 4)!;
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]).toMatchObject({ player_id: f.player.A2, distance: 281, valid: true, rank: 1 });
    expect(c.entries[0].entry.photo_path).toBe(photo);
  });

  it("a weak-GPS drive is flagged for the commissioner", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const state = withTee(f.state, 4);
    const input = ldSubmitInput({
      entryId: randomUUID(),
      hole: 4,
      playerId: f.player.A1,
      yards: 250,
      fix: { ...north(TEE, 250), accuracy: 31 },
      lowAccuracy: true,
      photoPath: photoFor(state, "ld"),
    });
    const c = derive(mustApply(state, input)).contests.find((x) => x.hole === 4)!;
    expect(c.entries[0].valid).toBe(false);
    expect(c.entries[0].entry.status).toBe("flagged");
    expect(entryBadges(c.entries[0]).map((b) => b.key)).toEqual(["review", "gps"]);
    expect(entryNote(c.entries[0])).toMatch(/GPS was weak/);
  });

  it("a drive measured from the GPS simulator says so on the op, and goes to the commissioner", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.teeOff("A", 4);
    const state = withTee(f.state, 4);
    const input = ldSubmitInput({
      entryId: randomUUID(),
      hole: 4,
      playerId: f.player.A1,
      yards: 330,
      fix: { ...north(TEE, 330), accuracy: 3, simulated: true },
      lowAccuracy: false,
      photoPath: photoFor(state, "ld"),
    });
    expect(input).toMatchObject({ simulated: true, low_accuracy: false });
    // The sheet says so before submitting.
    expect(ldVerdict(330, false, { ld_min_yd: 150, ld_max_yd: 400 }, true)).toMatchObject({ review: true, blocked: false, reason: expect.stringMatching(/Simulated GPS/) });
    const c = derive(mustApply(state, input)).contests.find((x) => x.hole === 4)!;
    expect(c.entries[0]).toMatchObject({ valid: false });
    expect(c.entries[0].entry).toMatchObject({ status: "flagged", flag_reason: "Simulated GPS" });
  });

  it("editing a closest-to-pin entry keeps its photo, so the AI judge's flag survives (finding: ctp edit sheds AI flag)", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.teeOff("A", 3);
    let s = f.state;
    const photo = photoFor(s, "ctp");
    const first = randomUUID();
    s = mustApply(s, ctpSubmitInput({ entryId: first, hole: 3, playerId: f.player.A1, feet: 2, inches: 0, angle: 90, photoPath: photo }));
    // The judge thinks it's 20 ft with high confidence: suspicious.
    s = {
      ...s,
      contest_entries: s.contest_entries.map((e) =>
        e.id === first ? { ...e, ai_estimate_ft: 20, ai_confidence: "high" as const, ai_suspicious: true, ai_roast: "That's not 2 feet." } : e,
      ),
    };
    const previous = entryOf(derive(s).contests.find((c) => c.hole === 3), f.player.A1)!.entry;
    // Edit without retaking the photo (the sheet uploads nothing, so the new path is null).
    expect(ctpPhotoPath(null, previous)).toBe(photo);
    expect(ctpPhotoPath("trips/t/ctp/new.jpg", previous)).toBe("trips/t/ctp/new.jpg");
    expect(ctpPhotoPath(null, null)).toBeNull();
    s = mustApply(s, ctpSubmitInput({ entryId: randomUUID(), hole: 3, playerId: f.player.A1, feet: 2, inches: 6, angle: 90, photoPath: ctpPhotoPath(null, previous) }));
    const v = entryOf(derive(s).contests.find((c) => c.hole === 3), f.player.A1)!;
    expect(v.entry.photo_path).toBe(photo);
    expect(v.entry).toMatchObject({ ai_estimate_ft: 20, ai_suspicious: true });
    expect(v.suspicious).toBe(true);
  });

  it("closest to pin: feet + inches + angle, and a re-entry replaces the old one", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    let s = f.state;
    s = mustApply(s, ctpSubmitInput({ entryId: randomUUID(), hole: 3, playerId: f.player.B1, feet: 8, inches: 0, angle: 90, photoPath: null }));
    s = mustApply(s, ctpSubmitInput({ entryId: randomUUID(), hole: 3, playerId: f.player.A1, feet: 6, inches: 4, angle: 212.6, photoPath: photoFor(s, "ctp") }));
    let c = derive(s).contests.find((x) => x.hole === 3)!;
    expect(c.leader_ids).toEqual([f.player.A1]);
    expect(c.entries[0].entry.distance_value).toBeCloseTo(6 + 4 / 12, 10);
    expect(c.entries[0].entry.angle_deg).toBe(213);
    expect(formatContestDistance("ctp", c.entries[0].distance)).toBe(`6' 4"`);
    // Edit: worse distance replaces it.
    s = mustApply(s, ctpSubmitInput({ entryId: randomUUID(), hole: 3, playerId: f.player.A1, feet: 9, inches: 0, angle: 0, photoPath: null }), { minute: 31 });
    c = derive(s).contests.find((x) => x.hole === 3)!;
    expect(c.entries.filter((v) => v.player_id === f.player.A1)).toHaveLength(1);
    expect(c.leader_ids).toEqual([f.player.B1]);
  });

  it("rejects a closest-to-pin entry on a long drive hole", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const r = apply(f.state, ctpSubmitInput({ entryId: randomUUID(), hole: 4, playerId: f.player.A1, feet: 3, inches: 0, angle: 0, photoPath: null }));
    expect(r.ok).toBe(false);
  });

  it("undo after sync deletes the new entry and restores the one it replaced", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    let s = f.state;
    const firstId = randomUUID();
    const photo = photoFor(s, "ctp");
    s = mustApply(s, ctpSubmitInput({ entryId: firstId, hole: 3, playerId: f.player.A1, feet: 5, inches: 6, angle: 45, photoPath: photo }));
    const previous = s.contest_entries.find((e) => e.id === firstId) as ContestEntry;
    const secondId = randomUUID();
    s = mustApply(s, ctpSubmitInput({ entryId: secondId, hole: 3, playerId: f.player.A1, feet: 12, inches: 0, angle: 0, photoPath: null }), { minute: 31 });
    const restoreId = randomUUID();
    const ops = undoInputs(secondId, previous, restoreId);
    expect(ops.map((o) => o.type)).toEqual(["contest.delete", "contest.submit"]);
    for (const [i, o] of ops.entries()) s = mustApply(s, o, { minute: 32 + i, by: f.player.A1 });
    const c = derive(s).contests.find((x) => x.hole === 3)!;
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0].entry.id).toBe(restoreId);
    expect(c.entries[0].entry).toMatchObject({ distance_value: 5.5, angle_deg: 45, photo_path: photo });
    // A first entry's undo is just the delete.
    expect(undoInputs(secondId, null, restoreId)).toEqual([{ type: "contest.delete", entry_id: secondId }]);
  });
});

describe("Contests tab view-model", () => {
  function scene() {
    const f = makeTrip({ teams: [4, 3, 3], settings: { contest_ante_cents: 500 } });
    f.teeOff("A", 3).teeOff("B", 3);
    f.entry({ hole: 3, player_id: f.player.B2, type: "ctp", distance_value: 4.5, angle_deg: 30, ai_estimate_ft: 12, ai_confidence: "high", ai_suspicious: true, ai_roast: "Four feet? In what, dog years?" });
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 9, angle_deg: 200 });
    f.entry({ hole: 3, player_id: f.player.A3, type: "ctp", distance_value: 4.5, angle_deg: 300, status: "overridden", distance_override: 4.5 });
    f.entry({ hole: 4, player_id: f.player.C1, type: "ld", distance_value: 450, status: "flagged", flag_reason: "Out of range: 450 yd" });
    return { f, d: derive(f.state) };
  }

  it("labels statuses and the AI verdict", () => {
    const { f, d } = scene();
    const ctp = d.contests.find((c) => c.hole === 3)!;
    const sus = entryOf(ctp, f.player.B2)!;
    expect(entryBadges(sus).map((b) => b.key)).toEqual(["sus"]);
    expect(aiVerdict(sus.entry)).toEqual({ estimate: `~12' 0" · high confidence`, roast: "Four feet? In what, dog years?", suspicious: true });
    expect(aiVerdict(entryOf(ctp, f.player.A1)!.entry)).toBeNull();
    const approved = entryOf(ctp, f.player.A3)!;
    expect(entryBadges(approved).map((b) => b.key)).toEqual(["approved"]);
    expect(entryNote(approved)).toBeNull();
    const ld = entryOf(d.contests.find((c) => c.hole === 4), f.player.C1)!;
    expect(entryBadges(ld).map((b) => b.key)).toEqual(["review"]);
    expect(entryNote(ld)).toBe("Needs commissioner review: Out of range: 450 yd");
  });

  it("flags an ok long drive that fails the range re-check", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 90 });
    const v = derive(f.state).contests.find((c) => c.hole === 4)!.entries[0];
    expect(entryBadges(v).map((b) => b.key)).toEqual(["range"]);
    expect(entryNote(v)).toBe("Out of range: 90 yd");
  });

  it("explains an override that changed the distance", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 450, status: "overridden", distance_override: 301 });
    const v = derive(f.state).contests.find((c) => c.hole === 4)!.entries[0];
    expect(v.distance).toBe(301);
    expect(entryNote(v)).toBe("Official distance set by the commish (entered 450 yd).");
  });

  it("leader line, ties, and plot points with the leaders first", () => {
    const { f, d } = scene();
    const ctp = d.contests.find((c) => c.hole === 3)!;
    expect(leaderLine(ctp, d)).toBe(`Player B2 & Player A3 at 4' 6"`);
    const pts = plotEntries(ctp, d, { meId: f.player.A1 });
    expect(pts.map((p) => p.playerId)).toEqual([f.player.B2, f.player.A3, f.player.A1]);
    expect(pts.map((p) => p.leader)).toEqual([true, true, false]);
    expect(pts[0]).toMatchObject({ suspicious: true, angle: 30, teamSortOrder: 1 });
    expect(pts[2].mine).toBe(true);
    expect(plotEntries(ctp, d, { excludePlayerId: f.player.A1 }).map((p) => p.playerId)).not.toContain(f.player.A1);
    expect(plotEntries(d.contests.find((c) => c.hole === 4), d)).toEqual([]);
    expect(leaderLine(d.contests.find((c) => c.hole === 8)!, d)).toBeNull();
  });

  it("shows the hole's pot and its rollovers", () => {
    const { d } = scene();
    const info = potInfo(d.money.pots, 3);
    expect(info.amount).toBe("$50");
    expect(info.note).toBeNull();
    expect(potInfo(d.money.pots, 99)).toEqual({ amount: null, note: null, status: null });
    expect(potInfo([], 3).amount).toBeNull();
    const rolled = potInfo(
      [
        {
          key: "contest:3",
          type: "contest",
          hole: 3,
          contest_type: "ctp",
          label: "",
          ante_cents: 500,
          participants: [],
          base_cents: 5000,
          rollover_in_cents: 0,
          rolled_from: [],
          total_cents: 5000,
          status: "rolled",
          rolled_to: "contest:8",
          winners: [],
          payouts: {},
        },
      ],
      3,
    );
    expect(rolled.note).toBe("Rolled to #8");
  });

  it("counts entries needing review and AI flags", () => {
    const { d } = scene();
    expect(contestCounts(d.contests)).toEqual({ entries: 4, review: 1, sus: 1 });
  });
});
