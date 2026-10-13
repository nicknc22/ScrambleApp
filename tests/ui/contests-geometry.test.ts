// Green plot geometry: polar placement, pointer -> angle, ring scale/clamp, feet/inches, labels.
import { describe, expect, it } from "vitest";
import {
  MAX_PLOT_RADIUS,
  PLOT_CENTER,
  PLOT_SIZE,
  RING_FT,
  angleFromPoint,
  clientToViewBox,
  dotBox,
  estimateTextWidth,
  feetInchesToFeet,
  feetToFeetInches,
  layoutLabels,
  normalizeAngle,
  plotPosition,
  pointerToAngle,
  polarToPoint,
  radiusForFeet,
  sideOfPin,
  snapAngle,
} from "@/components/contests/geometry";

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("normalizeAngle", () => {
  it("wraps into [0, 360)", () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(-0)).toBe(0);
    expect(Object.is(normalizeAngle(-0), -0)).toBe(false);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(725)).toBe(5);
    expect(normalizeAngle(-725)).toBe(355);
    expect(normalizeAngle(359.5)).toBe(359.5);
  });
  it("defaults garbage to 180 (short of the pin)", () => {
    expect(normalizeAngle(Number.NaN)).toBe(180);
    expect(normalizeAngle(Number.POSITIVE_INFINITY)).toBe(180);
  });
});

describe("ring scale", () => {
  it("puts 30 ft at 44% of the plot, linearly", () => {
    expect(MAX_PLOT_RADIUS).toBeCloseTo(0.44 * PLOT_SIZE, 10);
    expect(radiusForFeet(30)).toEqual({ r: MAX_PLOT_RADIUS, clamped: false });
    close(radiusForFeet(15).r, MAX_PLOT_RADIUS / 2);
    close(radiusForFeet(5).r, MAX_PLOT_RADIUS / 6);
    expect(radiusForFeet(0)).toEqual({ r: 0, clamped: false });
    expect(RING_FT).toEqual([5, 10, 20, 30]);
  });
  it("clamps beyond 30 ft to the edge ring and says so", () => {
    expect(radiusForFeet(30.01)).toEqual({ r: MAX_PLOT_RADIUS, clamped: true });
    expect(radiusForFeet(150)).toEqual({ r: MAX_PLOT_RADIUS, clamped: true });
  });
  it("treats negative / non-finite distances as 0", () => {
    expect(radiusForFeet(-4)).toEqual({ r: 0, clamped: false });
    expect(radiusForFeet(Number.NaN)).toEqual({ r: 0, clamped: false });
  });
  it("keeps every ring and clamped entry inside the plot", () => {
    for (const a of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const p = plotPosition(500, a);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(PLOT_SIZE);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(PLOT_SIZE);
    }
  });
});

describe("polar placement (0 = up toward the back of the green, clockwise)", () => {
  it("places the cardinal directions", () => {
    const r = 10;
    const up = polarToPoint(r, 0);
    close(up.x, PLOT_CENTER);
    close(up.y, PLOT_CENTER - r);
    const right = polarToPoint(r, 90);
    close(right.x, PLOT_CENTER + r);
    close(right.y, PLOT_CENTER);
    const down = polarToPoint(r, 180);
    close(down.x, PLOT_CENTER);
    close(down.y, PLOT_CENTER + r);
    const left = polarToPoint(r, 270);
    close(left.x, PLOT_CENTER - r);
    close(left.y, PLOT_CENTER);
  });
  it("plots an entry at its distance and angle; a missing angle sits short of the pin", () => {
    const p = plotPosition(15, 90);
    close(p.x, PLOT_CENTER + MAX_PLOT_RADIUS / 2);
    close(p.y, PLOT_CENTER);
    expect(p.clamped).toBe(false);
    const q = plotPosition(15, null);
    close(q.x, PLOT_CENTER);
    close(q.y, PLOT_CENTER + MAX_PLOT_RADIUS / 2);
    const far = plotPosition(42, 270);
    close(far.x, PLOT_CENTER - MAX_PLOT_RADIUS);
    expect(far.clamped).toBe(true);
  });
  it("a 0 ft ace sits on the pin", () => {
    const p = plotPosition(0, 123);
    close(p.x, PLOT_CENTER);
    close(p.y, PLOT_CENTER);
  });
});

describe("pointer -> angle", () => {
  it("reads angles relative to the pin", () => {
    expect(angleFromPoint({ x: 50, y: 40 })).toBe(0);
    expect(angleFromPoint({ x: 60, y: 50 })).toBe(90);
    expect(angleFromPoint({ x: 50, y: 60 })).toBe(180);
    expect(angleFromPoint({ x: 40, y: 50 })).toBe(270);
    close(angleFromPoint({ x: 60, y: 40 }), 45);
    close(angleFromPoint({ x: 40, y: 40 }), 315);
    expect(angleFromPoint({ x: 50, y: 50 })).toBe(180);
  });
  it("round-trips polar placement", () => {
    for (let a = 0; a < 360; a += 7) close(angleFromPoint(polarToPoint(20, a)), a, 1e-7);
  });
  it("maps client pixels through the element's rect (any size, any offset)", () => {
    const rect = { left: 10, top: 20, width: 200, height: 200 };
    expect(clientToViewBox(110, 120, rect)).toEqual({ x: 50, y: 50 });
    expect(pointerToAngle(110, 20, rect)).toBe(0); // top center
    expect(pointerToAngle(210, 120, rect)).toBe(90); // right middle
    expect(pointerToAngle(110, 220, rect)).toBe(180); // bottom center
    expect(pointerToAngle(10, 120, rect)).toBe(270); // left middle
    close(pointerToAngle(180, 50, rect), 45);
    // Dragging outside the plot still gives a direction.
    expect(pointerToAngle(500, 120, rect)).toBe(90);
    // Degenerate rect doesn't divide by zero.
    expect(Number.isFinite(pointerToAngle(5, 5, { left: 0, top: 0, width: 0, height: 0 }))).toBe(true);
  });
  it("snaps", () => {
    expect(snapAngle(359.6)).toBe(0);
    expect(snapAngle(44, 15)).toBe(45);
    expect(snapAngle(-8, 15)).toBe(345);
    expect(snapAngle(12.3, 0)).toBe(12.3);
  });
  it("speaks golfer", () => {
    expect(sideOfPin(0)).toBe("Long");
    expect(sideOfPin(350)).toBe("Long");
    expect(sideOfPin(45)).toBe("Long right");
    expect(sideOfPin(90)).toBe("Right");
    expect(sideOfPin(135)).toBe("Short right");
    expect(sideOfPin(180)).toBe("Short");
    expect(sideOfPin(225)).toBe("Short left");
    expect(sideOfPin(270)).toBe("Left");
    expect(sideOfPin(-45)).toBe("Long left");
  });
});

describe("feet + inches", () => {
  it("converts to decimal feet", () => {
    expect(feetInchesToFeet(6, 6)).toBe(6.5);
    expect(feetInchesToFeet(0, 9)).toBe(0.75);
    expect(feetInchesToFeet(12, 0)).toBe(12);
    expect(feetInchesToFeet(3, 14)).toBe(3 + 11 / 12);
    expect(feetInchesToFeet(-2, -3)).toBe(0);
    expect(feetInchesToFeet(4.9, 2.7)).toBe(4 + 2 / 12);
    expect(feetInchesToFeet(Number.NaN, 3)).toBe(0.25);
  });
  it("splits decimal feet to the nearest inch with carry", () => {
    expect(feetToFeetInches(6.5)).toEqual({ feet: 6, inches: 6 });
    expect(feetToFeetInches(6.99)).toEqual({ feet: 7, inches: 0 });
    expect(feetToFeetInches(0.04)).toEqual({ feet: 0, inches: 0 });
    expect(feetToFeetInches(-3)).toEqual({ feet: 0, inches: 0 });
    expect(feetToFeetInches(Number.NaN)).toEqual({ feet: 0, inches: 0 });
  });
  it("round-trips every feet/inches combination", () => {
    for (let ft = 0; ft <= 60; ft++) {
      for (let inch = 0; inch < 12; inch++) expect(feetToFeetInches(feetInchesToFeet(ft, inch))).toEqual({ feet: ft, inches: inch });
    }
  });
});

describe("label layout", () => {
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it("puts labels on the side away from the pin, flips near an edge, and stays inside the plot", () => {
    const [a, b, c, d] = layoutLabels([
      { id: "a", x: 60, y: 50, text: "Dave" },
      { id: "b", x: 30, y: 30, text: "Mike" },
      { id: "c", x: 92, y: 20, text: "Big Nick" },
      { id: "d", x: 4, y: 70, text: "Alexander" },
    ]);
    expect(a.side).toBe("right");
    expect(a.x).toBeGreaterThan(60);
    expect(b.side).toBe("left");
    expect(b.x + b.w).toBeLessThan(30);
    expect(c.side).toBe("left"); // no room on the right
    expect(d.side).toBe("right"); // no room on the left
    for (const l of [a, b, c, d]) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.y).toBeGreaterThanOrEqual(0);
      expect(l.x + l.w).toBeLessThanOrEqual(PLOT_SIZE);
      expect(l.y + l.h).toBeLessThanOrEqual(PLOT_SIZE);
    }
  });

  it("keeps labels off other balls and the pin", () => {
    const pts = [
      { id: "lead", x: 53, y: 47, text: "Tom" },
      { id: "gaz", x: 45, y: 49, text: "Gaz" },
      { id: "nick", x: 55, y: 49, text: "Big Nick" },
    ];
    const obstacles = [{ x: 48.4, y: 44.6, w: 5.4, h: 7 }, ...pts.map((p) => dotBox(p.x, p.y, 2.7))];
    const boxes = layoutLabels(pts, { obstacles });
    for (const b of boxes) for (const o of obstacles) expect(overlap(b, o)).toBe(false);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
  });

  it("de-overlaps a cluster of entries at nearly the same spot", () => {
    const pts = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, x: 55 + (i % 2) * 0.5, y: 60 + i * 0.4, text: `Player ${i}` }));
    const boxes = layoutLabels(pts);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
  });

  it("is deterministic and keeps the first (leader) label at its natural spot", () => {
    const pts = [
      { id: "lead", x: 50, y: 55, text: "Leader" },
      { id: "two", x: 50.5, y: 55.2, text: "Second" },
    ];
    expect(layoutLabels(pts)).toEqual(layoutLabels(pts));
    const [lead] = layoutLabels(pts);
    close(lead.anchorY, 55);
  });

  it("estimates wider text for wider strings", () => {
    expect(estimateTextWidth("WWWW", 4)).toBeGreaterThan(estimateTextWidth("iiii", 4));
    expect(estimateTextWidth("", 4)).toBe(0);
  });
});
