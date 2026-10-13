"use client";
// Dev GPS simulator: fake a position anywhere on the course to test long drive. Only for the
// commissioner (the README dry run on the real URL), demo trips, and non-production builds: a
// player on a real trip must not be able to fake a money drive. A simulation the current viewer
// isn't allowed (say, a leftover from the demo) is cleared on sight, and while one is active the
// trip header shows a loud SIMULATED GPS strip (GpsSimBanner).
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Hole } from "@/lib/types";
import { GPS_SIM_KEY, getGpsSimulation, setGpsSimulation, type GpsSimulation } from "@/lib/client/geo";
import { readItem, type StorageLike } from "@/lib/client/identity";
import { useClientState } from "@/lib/client/react";
import { Button, TextField, useToast } from "@/components/ui";
import { pointFromTee } from "./geoMath";

const SIM_EVENT = "scramble:gps-sim-change";

/** Who may fake GPS: the commissioner, anyone on a demo trip, anyone on a non-production build. */
export function gpsSimAllowed({
  isCommissioner,
  isDemo,
  production = process.env.NODE_ENV === "production",
}: {
  isCommissioner: boolean;
  isDemo: boolean;
  production?: boolean;
}): boolean {
  return !production || isCommissioner || isDemo;
}

/** Store (or clear) the simulation and tell every banner on the page. */
export function writeGpsSimulation(sim: GpsSimulation | null, storage?: StorageLike | null): void {
  if (storage === undefined) setGpsSimulation(sim);
  else setGpsSimulation(sim, storage);
  try {
    window.dispatchEvent(new Event(SIM_EVENT));
  } catch {
    /* no window (tests) */
  }
}

/** The simulation in effect for this viewer: a stored one they aren't allowed is cleared. */
export function enforceGpsSimulation(allowed: boolean, storage?: StorageLike | null): GpsSimulation | null {
  const sim = storage === undefined ? getGpsSimulation() : getGpsSimulation(storage);
  if (sim && !allowed) {
    writeGpsSimulation(null, storage);
    return null;
  }
  return sim;
}

function subscribeSim(onChange: () => void): () => void {
  window.addEventListener(SIM_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(SIM_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The stored simulation, live (this tab's writes and other tabs'). */
export function useGpsSimulation(): GpsSimulation | null {
  const raw = useSyncExternalStore(subscribeSim, () => readItem(GPS_SIM_KEY), () => null);
  return useMemo(() => (raw ? getGpsSimulation() : null), [raw]);
}

/** May this viewer use the simulator on this trip? null until the trip has loaded. */
export function useGpsSimAllowed(): boolean | null {
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const isDemo = useClientState((s) => (s.view ? s.view.trip.is_demo === true : null));
  return isDemo === null ? null : gpsSimAllowed({ isCommissioner, isDemo });
}

/** Loud strip for the trip header while a simulated position is active. Clears one this viewer isn't allowed. */
export function GpsSimBanner() {
  const allowed = useGpsSimAllowed();
  const sim = useGpsSimulation();
  useEffect(() => {
    if (allowed === false && sim) enforceGpsSimulation(false);
  }, [allowed, sim]);
  if (!allowed || !sim) return null;
  return <GpsSimStrip onOff={() => writeGpsSimulation(null)} />;
}

export function GpsSimStrip({ onOff }: { onOff: () => void }) {
  return (
    <div
      role="alert"
      data-testid="gps-sim-banner"
      className="flex items-center gap-2 border-t-2 border-ink bg-flag py-1 pr-1 pl-[max(12px,env(safe-area-inset-left))] text-white"
    >
      <span className="text-2xl leading-none" aria-hidden="true">
        🛰️
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block text-[15px] font-black tracking-wide uppercase">Simulated GPS</span>
        <span className="block text-xs font-bold">Long drives on this phone use a fake position.</span>
      </span>
      <button type="button" onClick={onOff} className="btn shrink-0 border-ink bg-paper px-3 text-[15px] text-ink active:bg-sand">
        Turn off
      </button>
    </div>
  );
}

export function GpsSimulator({ holes }: { holes: Hole[] }) {
  const toast = useToast();
  // Live: the header strip's Turn off (or another tab) can change it underneath us.
  const sim = useGpsSimulation();
  const [lat, setLat] = useState(() => String(getGpsSimulation()?.lat ?? ""));
  const [lng, setLng] = useState(() => String(getGpsSimulation()?.lng ?? ""));
  const [hole, setHole] = useState(() => holes.find((h) => h.contest === "ld")?.number ?? 1);
  const [yards, setYards] = useState("260");

  const apply = (p: { lat: number; lng: number }) => {
    const next: GpsSimulation = { lat: p.lat, lng: p.lng, accuracy: 3 };
    writeGpsSimulation(next);
    setLat(p.lat.toFixed(6));
    setLng(p.lng.toFixed(6));
    toast.info(`GPS faked at ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, { emoji: "🛰️" });
  };

  const applyTyped = () => {
    const a = Number(lat);
    const b = Number(lng);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180 || lat.trim() === "" || lng.trim() === "") {
      toast.error("That's not a coordinate. That's a cry for help.");
      return;
    }
    apply({ lat: a, lng: b });
  };

  const applyFromTee = () => {
    const h = holes.find((x) => x.number === hole);
    const y = Number(yards);
    if (!h || h.tee_lat === null || h.tee_lng === null) {
      toast.error(`Hole ${hole} has no tee point yet. Set it in Setup → Course.`);
      return;
    }
    if (!Number.isFinite(y) || y < 0 || y > 800) {
      toast.error("Yards should be 0–800. Nobody's driving it 900.");
      return;
    }
    const green = h.green_lat !== null && h.green_lng !== null ? { lat: h.green_lat, lng: h.green_lng } : null;
    apply(pointFromTee({ lat: h.tee_lat, lng: h.tee_lng }, green, y));
  };

  const clear = () => {
    writeGpsSimulation(null);
    toast.info("GPS simulator off. Back to real satellites.", { emoji: "🛰️" });
  };

  return (
    <div className="space-y-3" data-testid="gps-simulator">
      <p className="text-sm font-bold text-ink">
        {sim ? (
          <>
            Simulating{" "}
            <span className="num rounded bg-hazard px-1">
              {sim.lat.toFixed(5)}, {sim.lng.toFixed(5)}
            </span>{" "}
            (±{sim.accuracy} m)
          </>
        ) : (
          "Off: using real GPS."
        )}
      </p>
      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-extrabold tracking-wider uppercase">Hole</span>
          <select
            value={hole}
            onChange={(e) => setHole(Number(e.target.value))}
            className="h-14 w-full rounded-xl border-2 border-ink bg-paper px-3 text-lg font-bold"
          >
            {Array.from({ length: 18 }, (_, i) => i + 1).map((n) => {
              const h = holes.find((x) => x.number === n);
              return (
                <option key={n} value={n}>
                  {n}
                  {h?.contest === "ld" ? " · LD" : h?.contest === "ctp" ? " · CTP" : ""}
                  {h && h.tee_lat === null ? " (no tee)" : ""}
                </option>
              );
            })}
          </select>
        </label>
        <TextField label="Yards" inputMode="numeric" value={yards} onChange={(e) => setYards(e.target.value)} />
      </div>
      <Button variant="secondary" size="lg" full onClick={applyFromTee}>
        Use hole {hole} tee + {yards || 0} yd
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Lat" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="41.0954" />
        <TextField label="Lng" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-75.6716" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" full onClick={applyTyped}>
          Set position
        </Button>
        <Button variant="danger" full onClick={clear} disabled={!sim}>
          Turn off
        </Button>
      </div>
    </div>
  );
}
