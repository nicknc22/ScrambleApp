// The dev GPS simulator fakes long drives: only the commissioner (README dry run on the real URL),
// demo trips and non-production builds get it; a simulation the viewer isn't allowed is cleared;
// while one is active the header shows a loud strip.
// Findings: security/gps-simulator-enabled-in-production, speccheck/gps-sim-in-prod.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GPS_SIM_KEY, getGpsSimulation } from "@/lib/client/geo";
import type { StorageLike } from "@/lib/client/identity";
import { GpsSimStrip, enforceGpsSimulation, gpsSimAllowed, writeGpsSimulation } from "@/components/shell/GpsSimulator";

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("GPS simulator gate", () => {
  it("is off for a plain player on a real trip in production; on for the commissioner, demo trips and dev builds", () => {
    expect(gpsSimAllowed({ isCommissioner: false, isDemo: false, production: true })).toBe(false);
    expect(gpsSimAllowed({ isCommissioner: true, isDemo: false, production: true })).toBe(true);
    expect(gpsSimAllowed({ isCommissioner: false, isDemo: true, production: true })).toBe(true);
    expect(gpsSimAllowed({ isCommissioner: false, isDemo: false, production: false })).toBe(true);
  });

  it("clears a stored simulation the viewer isn't allowed (a leftover from the demo), keeps an allowed one", () => {
    const storage = memoryStorage();
    writeGpsSimulation({ lat: 41.1, lng: -75.65, accuracy: 3 }, storage);
    expect(getGpsSimulation(storage)).toEqual({ lat: 41.1, lng: -75.65, accuracy: 3 });

    expect(enforceGpsSimulation(true, storage)).toEqual({ lat: 41.1, lng: -75.65, accuracy: 3 });
    expect(storage.map.has(GPS_SIM_KEY)).toBe(true);

    expect(enforceGpsSimulation(false, storage)).toBeNull();
    expect(storage.map.has(GPS_SIM_KEY)).toBe(false);
    expect(getGpsSimulation(storage)).toBeNull();
  });

  it("shouts while a simulation is active", () => {
    const html = renderToStaticMarkup(<GpsSimStrip onOff={() => {}} />);
    expect(html).toContain('data-testid="gps-sim-banner"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Simulated GPS");
    expect(html).toContain("Turn off");
  });
});
