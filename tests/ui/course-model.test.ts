// Course editor view-model: placement status, patches, map views and card sanity checks.
import { describe, expect, it } from "vitest";
import { makeTrip } from "../fixtures";
import type { Hole } from "@/lib/types";
import { JACK_FROST_CENTER } from "@/lib/course";
import { applyOp } from "@/lib/reducer";
import {
  cardCheck,
  contestLabel,
  courseSummary,
  draftErrors,
  draftOf,
  draftedPoint,
  duplicateStrokeIndexes,
  firstHoleToPlace,
  formatPoint,
  holeDraftPatch,
  initialMode,
  needsLdTee,
  pointsPatch,
  teeToGreenYards,
  viewForHole,
} from "@/components/setup/course/courseModel";

const holesOf = () => makeTrip({ teams: [2], status: "setup" }).state.holes;
const withPoints = (h: Hole, tee: [number, number] | null, green: [number, number] | null): Hole => ({
  ...h,
  tee_lat: tee ? tee[0] : null,
  tee_lng: tee ? tee[1] : null,
  green_lat: green ? green[0] : null,
  green_lng: green ? green[1] : null,
});

describe("courseSummary", () => {
  it("counts the seeded Jack Frost card and flags every par 5 tee as required", () => {
    const s = courseSummary(holesOf());
    expect(s.holes).toBe(18);
    expect(s.par).toBe(72);
    expect(s.yards).toEqual({ advanced: 6741, membership: 6297, forward: 5729 });
    expect(s.tees).toBe(0);
    expect(s.ldHoles).toEqual([4, 9, 12, 18]);
    expect(s.ldMissing).toEqual([4, 9, 12, 18]);
    expect(s.incomplete).toHaveLength(18);
  });

  it("par 5 tee points clear the requirement; greens are nice to have", () => {
    const holes = holesOf().map((h) => (h.par === 5 ? withPoints(h, [41.09, -75.65], null) : h));
    const s = courseSummary(holes);
    expect(s.ldMissing).toEqual([]);
    expect(s.tees).toBe(4);
    expect(s.greens).toBe(0);
    expect(needsLdTee(holes[3])).toBe(false);
    expect(needsLdTee(holesOf()[3])).toBe(true);
    expect(needsLdTee(holesOf()[0])).toBe(false);
  });

  it("firstHoleToPlace: required long-drive tees first, then incomplete holes, else 1", () => {
    let holes = holesOf();
    expect(firstHoleToPlace(holes)).toBe(4);
    holes = holes.map((h) => (h.par === 5 ? withPoints(h, [41.09, -75.65], null) : h));
    expect(firstHoleToPlace(holes)).toBe(1);
    holes = holes.map((h) => withPoints(h, [41.09, -75.65], [41.1, -75.65]));
    expect(firstHoleToPlace(holes)).toBe(1);
    holes[6] = withPoints(holes[6], [41.09, -75.65], null);
    expect(firstHoleToPlace(holes)).toBe(7);
  });
});

describe("hole draft", () => {
  it("only changed fields go in the patch, and the reducer accepts it", () => {
    const f = makeTrip({ teams: [2], status: "setup" });
    const h = f.state.holes[3];
    const d = draftOf(h);
    expect(holeDraftPatch(h, d)).toEqual({});
    d.par = 4;
    d.yardage = { ...d.yardage, membership: 480 };
    const patch = holeDraftPatch(h, d);
    expect(patch).toEqual({ par: 4, yardage: { membership: 480 } });
    const r = applyOp(f.state, { id: "op1", at: "2026-10-22T12:00:00.000Z", by: null, type: "hole.update", hole: 4, patch }, {
      now: "2026-10-22T12:00:00.000Z",
      is_commissioner: true,
      side: "client",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const after = r.state.holes.find((x) => x.number === 4)!;
      expect(after.par).toBe(4);
      expect(after.contest).toBe("none"); // par change re-derives the contest
      expect(after.yardage).toEqual({ advanced: 527, membership: 480, forward: 463 });
    }
  });

  it("validates like the reducer", () => {
    const d = draftOf(holesOf()[0]);
    expect(draftErrors(d)).toEqual({});
    expect(draftErrors({ ...d, par: 7 })).toHaveProperty("par");
    expect(draftErrors({ ...d, stroke_index: 0 })).toHaveProperty("stroke_index");
    expect(draftErrors({ ...d, yardage: { ...d.yardage, forward: NaN } })).toHaveProperty("forward");
    expect(draftErrors({ ...d, yardage: { ...d.yardage, advanced: 1001 } })).toHaveProperty("advanced");
  });

  it("duplicate stroke indexes", () => {
    const holes = holesOf();
    expect(duplicateStrokeIndexes(holes).size).toBe(0);
    holes[1] = { ...holes[1], stroke_index: holes[0].stroke_index };
    expect([...duplicateStrokeIndexes(holes).values()]).toEqual([[1, 2]]);
  });
});

describe("points", () => {
  it("pointsPatch writes only changed points, rounded, and null clears", () => {
    const h = withPoints(holesOf()[3], [41.1, -75.66], null);
    expect(pointsPatch(h, {})).toEqual({});
    expect(pointsPatch(h, { tee: { lat: 41.1, lng: -75.66 } })).toEqual({});
    expect(pointsPatch(h, { green: { lat: 41.100302512345, lng: -75.660165249 } })).toEqual({ green_lat: 41.1003025, green_lng: -75.6601652 });
    expect(pointsPatch(h, { tee: null })).toEqual({ tee_lat: null, tee_lng: null });
    expect(draftedPoint(h, { tee: null }, "tee")).toBeNull();
    expect(draftedPoint(h, {}, "tee")).toEqual({ lat: 41.1, lng: -75.66 });
  });

  it("initialMode: tee first, green once the tee is set", () => {
    const h = holesOf()[0];
    expect(initialMode(h)).toBe("tee");
    expect(initialMode(withPoints(h, [41, -75], null))).toBe("green");
    expect(initialMode(withPoints(h, [41, -75], [41.001, -75]))).toBe("tee");
  });

  it("tee to green yards and the card sanity check", () => {
    const tee = { lat: 41.0964244, lng: -75.6596474 };
    const green = { lat: 41.1003025, lng: -75.6601652 };
    const yd = teeToGreenYards(tee, green)!;
    expect(yd).toBeGreaterThan(470);
    expect(yd).toBeLessThan(490);
    expect(teeToGreenYards(tee, null)).toBeNull();
    expect(cardCheck(yd, 492)).toBe("ok");
    expect(cardCheck(400, 492)).toBe("ok"); // doglegs read short: tolerated
    expect(cardCheck(350, 492)).toBe("short");
    expect(cardCheck(600, 492)).toBe("long");
    expect(cardCheck(null, 492)).toBeNull();
    expect(cardCheck(300, 0)).toBeNull();
  });

  it("viewForHole: its own points, else the previous green, else the course", () => {
    const holes = holesOf();
    expect(viewForHole(holes[0], holes)).toEqual({ center: JACK_FROST_CENTER, zoom: 16, fit: null });
    holes[0] = withPoints(holes[0], [41.0935, -75.6483], [41.0962, -75.6502]);
    const v1 = viewForHole(holes[0], holes);
    expect(v1.fit).toHaveLength(2);
    expect(v1.center.lat).toBeCloseTo((41.0935 + 41.0962) / 2, 6);
    const v2 = viewForHole(holes[1], holes);
    expect(v2).toEqual({ center: { lat: 41.0962, lng: -75.6502 }, zoom: 17, fit: null });
  });

  it("labels", () => {
    expect(contestLabel("ctp")).toBe("Closest to pin");
    expect(contestLabel("ld")).toBe("Long drive");
    expect(contestLabel("none")).toBeNull();
    expect(formatPoint(null)).toBe("Not set");
    expect(formatPoint({ lat: 41.0947914, lng: -75.6479826 })).toBe("41.09479, -75.64798");
  });
});
