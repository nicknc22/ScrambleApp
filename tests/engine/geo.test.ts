import { describe, expect, it } from "vitest";
import { haversineMeters, haversineYards, metersToYards, type LatLng } from "@/lib/engine/geo";

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Independent check: spherical law of cosines (different formula, same sphere). */
function lawOfCosinesMeters(a: LatLng, b: LatLng): number {
  const p1 = rad(a.lat);
  const p2 = rad(b.lat);
  const cos = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(rad(b.lng - a.lng));
  return Math.acos(Math.min(1, cos)) * R;
}

/** Independent check: equirectangular projection (exact to millimeters at golf scale). */
function equirectangularMeters(a: LatLng, b: LatLng): number {
  const x = rad(b.lng - a.lng) * Math.cos(rad((a.lat + b.lat) / 2));
  const y = rad(b.lat - a.lat);
  return Math.hypot(x, y) * R;
}

describe("geo", () => {
  it("Haversine matches a known distance within 1 yard", () => {
    // One degree of latitude on the mean-radius sphere: R * pi / 180 = 111,195.08 m = 121,604.42 yd.
    const oneDegLat = haversineYards({ lat: 41, lng: -75.648 }, { lat: 42, lng: -75.648 });
    expect(Math.abs(oneDegLat - 121604.42)).toBeLessThanOrEqual(1);
    expect(haversineMeters({ lat: 41, lng: -75.648 }, { lat: 42, lng: -75.648 })).toBeCloseTo(111195.08, 1);

    // One degree of longitude on the equator is the same arc length.
    expect(Math.abs(haversineYards({ lat: 0, lng: 10 }, { lat: 0, lng: 11 }) - 121604.42)).toBeLessThanOrEqual(1);

    // Golf scale at Jack Frost: a ~294 yd drive. Reference values computed offline with the
    // spherical law of cosines (293.873 yd) and an equirectangular projection (293.873 yd).
    const tee = { lat: 41.0948, lng: -75.648 };
    const ball = { lat: 41.0968, lng: -75.6462 };
    expect(Math.abs(metersToYards(haversineMeters(tee, ball)) - 293.8727)).toBeLessThan(0.01);
    expect(haversineYards(tee, ball)).toBe(294);
    expect(Math.abs(haversineYards(tee, ball) - metersToYards(lawOfCosinesMeters(tee, ball)))).toBeLessThanOrEqual(1);
    expect(Math.abs(haversineYards(tee, ball) - metersToYards(equirectangularMeters(tee, ball)))).toBeLessThanOrEqual(1);

    // Due east, 0.0036 degrees of longitude at 41.09 N = 329.918 yd.
    const east = { lat: 41.0948, lng: -75.648 + 0.0036 };
    expect(haversineYards(tee, east)).toBe(330);
  });

  it("agrees with independent formulas across many golf-scale pairs", () => {
    // Deterministic pseudo-random pairs around the course (no Math.random in tests).
    let seed = 12345;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 200; i++) {
      const a = { lat: 41.09 + next() * 0.01, lng: -75.65 + next() * 0.01 };
      const b = { lat: a.lat + (next() - 0.5) * 0.008, lng: a.lng + (next() - 0.5) * 0.008 };
      const m = haversineMeters(a, b);
      expect(Math.abs(m - equirectangularMeters(a, b))).toBeLessThan(0.05);
      expect(Math.abs(haversineYards(a, b) - metersToYards(m))).toBeLessThanOrEqual(0.5);
    }
  });

  it("is symmetric, zero for identical points, and rounds to whole yards", () => {
    const a = { lat: 41.0948, lng: -75.648 };
    const b = { lat: 41.0952, lng: -75.6475 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 9);
    expect(haversineMeters(a, a)).toBe(0);
    expect(haversineYards(a, a)).toBe(0);
    expect(Number.isInteger(haversineYards(a, b))).toBe(true);
  });

  it("converts meters to yards exactly (1 yd = 0.9144 m)", () => {
    expect(metersToYards(0.9144)).toBeCloseTo(1, 12);
    expect(metersToYards(91.44)).toBeCloseTo(100, 10);
    expect(metersToYards(0)).toBe(0);
  });

  it("handles antipodal points without NaN", () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 });
    expect(d).toBeCloseTo(Math.PI * R, 3);
  });
});
