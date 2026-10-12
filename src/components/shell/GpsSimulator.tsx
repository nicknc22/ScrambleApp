"use client";
// Dev-only GPS simulator: fake a position anywhere on the course to test long drive.
import { useState } from "react";
import type { Hole } from "@/lib/types";
import { getGpsSimulation, setGpsSimulation, type GpsSimulation } from "@/lib/client/geo";
import { Button, TextField, useToast } from "@/components/ui";
import { pointFromTee } from "./geoMath";

export function GpsSimulator({ holes }: { holes: Hole[] }) {
  const toast = useToast();
  const [sim, setSim] = useState<GpsSimulation | null>(() => getGpsSimulation());
  const [lat, setLat] = useState(() => (sim ? String(sim.lat) : ""));
  const [lng, setLng] = useState(() => (sim ? String(sim.lng) : ""));
  const [hole, setHole] = useState(() => holes.find((h) => h.contest === "ld")?.number ?? 1);
  const [yards, setYards] = useState("260");

  const apply = (p: { lat: number; lng: number }) => {
    const next: GpsSimulation = { lat: p.lat, lng: p.lng, accuracy: 3 };
    setGpsSimulation(next);
    setSim(getGpsSimulation());
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
    setGpsSimulation(null);
    setSim(null);
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
