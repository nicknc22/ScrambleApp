"use client";
// Full-height satellite sheet: place one hole's tee and green, then ◀ ▶ through all 18.
// The Leaflet map is loaded client-only (next/dynamic, ssr: false) and lives behind an error
// boundary: no signal means no tiles (and maybe no map chunk), never a crashed Setup screen.
import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { GeoError, measurePosition } from "@/lib/client/geo";
import type { Hole } from "@/lib/types";
import {
  BottomSheet,
  Button,
  IconButton,
  IconChevronLeft,
  IconChevronRight,
  IconMinus,
  IconPin,
  IconPlus,
  Spinner,
  cx,
  useConfirm,
  useToast,
} from "@/components/ui";
import { ErrorBoundary } from "@/components/shell/ErrorBoundary";
import {
  TEE_SET_SHORT,
  cardCheck,
  contestLabel,
  draftedPoint,
  initialMode,
  pointsPatch,
  teeToGreenYards,
  viewForHole,
  type LatLng,
  type PointKind,
  type PointsDraft,
} from "./courseModel";
import type { MapApi, OtherHolePoints } from "./SatelliteMap";

const SatelliteMap = dynamic(() => import("./SatelliteMap").then((m) => m.SatelliteMap), {
  ssr: false,
  loading: () => <MapMessage spinner title="Loading the satellite…" />,
});

function MapMessage({ title, body, spinner }: { title: string; body?: string; spinner?: boolean }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#26332b] p-6 text-center text-white">
      {spinner ? <Spinner size={32} label={title} /> : <div className="text-5xl leading-none" aria-hidden="true">🛰️</div>}
      <p className="text-lg font-black">{title}</p>
      {body && <p className="max-w-xs text-sm font-semibold text-white/85">{body}</p>}
    </div>
  );
}

export interface MapSheetProps {
  open: boolean;
  /** Hole to start on. */
  startHole: number;
  onClose: () => void;
}

/** Remount per open so the hole/drafts reset each time it opens. */
export function MapSheet({ open, startHole, onClose }: MapSheetProps) {
  if (!open) return null;
  return <MapSheetBody startHole={startHole} onClose={onClose} />;
}

function MapSheetBody({ startHole, onClose }: { startHole: number; onClose: () => void }) {
  const store = useTripStore();
  const view = useClientState((s) => s.view);
  const toast = useToast();
  const confirm = useConfirm();

  const holes = useMemo(() => [...(view?.holes ?? [])].sort((a, b) => a.number - b.number), [view?.holes]);
  const [holeNo, setHoleNo] = useState(startHole);
  const hole = holes.find((h) => h.number === holeNo) ?? holes[0];
  const [mode, setMode] = useState<PointKind>(() => (hole ? initialMode(hole) : "tee"));
  const [drafts, setDrafts] = useState<Record<number, PointsDraft>>({});
  const [tileTrouble, setTileTrouble] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsAcc, setGpsAcc] = useState<number | null>(null);
  const apiRef = useRef<MapApi | null>(null);
  const onReady = useCallback((api: MapApi | null) => {
    apiRef.current = api;
  }, []);

  const status = view?.trip.status ?? "setup";
  const teeSet = view?.trip.settings.tee_set ?? "membership";
  const draft = (hole && drafts[hole.number]) ?? {};
  const tee = hole ? draftedPoint(hole, draft, "tee") : null;
  const green = hole ? draftedPoint(hole, draft, "green") : null;
  const patch = hole ? pointsPatch(hole, draft) : {};
  const dirty = Object.keys(patch).length > 0;
  const dirtyHoles = holes.filter((h) => Object.keys(pointsPatch(h, drafts[h.number] ?? {})).length > 0).map((h) => h.number);

  const mapView = useMemo(() => (hole ? viewForHole(hole, holes) : null), [hole, holes]);
  const others = useMemo<OtherHolePoints[]>(
    () =>
      holes
        .filter((h) => h.number !== holeNo)
        .map((h) => {
          const d = drafts[h.number] ?? {};
          return { hole: h.number, tee: draftedPoint(h, d, "tee"), green: draftedPoint(h, d, "green") };
        })
        .filter((o) => o.tee || o.green),
    [holes, holeNo, drafts],
  );

  const place = useCallback(
    (kind: PointKind, p: LatLng) => {
      setDrafts((all) => ({ ...all, [holeNo]: { ...all[holeNo], [kind]: { lat: p.lat, lng: p.lng } } }));
      // Tee first, then straight on to the green.
      if (kind === "tee" && hole && !draftedPoint(hole, drafts[holeNo] ?? {}, "green")) setMode("green");
    },
    [holeNo, hole, drafts],
  );

  if (!view || !hole || !mapView) return null;

  const save = (target: Hole = hole): boolean => {
    const p = pointsPatch(target, drafts[target.number] ?? {});
    if (Object.keys(p).length === 0) return true;
    const r = store.dispatch({ type: "hole.update", hole: target.number, patch: p });
    if (!r.ok) {
      toast.error(r.reason, { title: `Hole ${target.number} didn't save` });
      return false;
    }
    setDrafts((all) => {
      const next = { ...all };
      delete next[target.number];
      return next;
    });
    toast.success(status === "setup" ? "Pinned." : "Pinned. Long drives re-measured.", { title: `Hole ${target.number} saved`, emoji: "📍", id: "course-save" });
    return true;
  };

  const go = (n: number) => {
    if (n < 1 || n > 18) return;
    if (!save()) return;
    const next = holes.find((h) => h.number === n);
    if (!next) return;
    setHoleNo(n);
    setMode(initialMode(next));
    setGpsAcc(null);
  };

  const requestClose = async () => {
    if (dirtyHoles.length > 0) {
      const ok = await confirm({
        title: "Toss unsaved pins?",
        body: `Hole${dirtyHoles.length === 1 ? "" : "s"} ${dirtyHoles.join(", ")} ha${dirtyHoles.length === 1 ? "s" : "ve"} pins you didn't save.`,
        emoji: "🗑️",
        confirmLabel: "Toss them",
        cancelLabel: "Keep placing",
        tone: "danger",
      });
      if (!ok) return;
    }
    onClose();
  };

  const locateMe = async () => {
    setGpsBusy(true);
    setGpsAcc(null);
    try {
      // measurePosition: a first-time "Allow location?" prompt is answered before the 6 s window starts.
      const r = await measurePosition({ durationMs: 6000, goodEnoughM: 4, onProgress: (b) => setGpsAcc(b.accuracy) });
      place(mode, { lat: r.lat, lng: r.lng });
      apiRef.current?.panTo({ lat: r.lat, lng: r.lng });
      setGpsAcc(r.accuracy);
      if (r.accuracy > 15) toast.roast(`GPS is mush (±${Math.round(r.accuracy)} m). Drag the pin onto the ${mode} if it's off.`);
      else toast.success(`${mode === "tee" ? "Tee" : "Green"} dropped where you stand (±${Math.round(r.accuracy)} m).`, { emoji: "📡" });
    } catch (e) {
      toast.error(e instanceof GeoError ? e.message : "Couldn't get your location.");
    } finally {
      setGpsBusy(false);
    }
  };

  const straight = teeToGreenYards(tee, green);
  const card = Number(hole.yardage?.[teeSet]) || null;
  const check = cardCheck(straight, card);
  const contest = contestLabel(hole.contest);
  const ldMissingTee = hole.contest === "ld" && !tee;

  return (
    <BottomSheet
      open
      onClose={() => void requestClose()}
      size="tall"
      title={
        <span className="flex flex-wrap items-baseline gap-x-2" data-testid="map-sheet-title">
          <span>Hole {hole.number}</span>
          <span className="text-base font-extrabold text-muted">
            Par {hole.par}
            {contest ? ` · ${contest}` : ""}
          </span>
        </span>
      }
      footer={
        <div className="space-y-2.5" data-testid="map-sheet-footer">
          <div className="flex min-h-12 items-center justify-between gap-2 rounded-xl bg-sand px-3 py-1.5">
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold tracking-wide whitespace-nowrap text-muted uppercase">Tee→green</div>
              <div className="num text-2xl leading-none font-black" data-testid="map-distance">
                {straight === null ? "—" : `${straight} yd`}
              </div>
            </div>
            <div className="min-w-0 text-right">
              <div className="text-[11px] font-extrabold tracking-wide whitespace-nowrap text-muted uppercase">Card · {TEE_SET_SHORT[teeSet]}</div>
              <div className="num text-2xl leading-none font-black">{card ? `${card} yd` : "—"}</div>
            </div>
            <div
              className={cx(
                "shrink-0 rounded-full border-2 px-2 py-1 text-xs font-black uppercase",
                check === "ok" && "border-fairway-dark bg-fairway text-white",
                (check === "long" || check === "short") && "border-ink bg-hazard text-ink",
                check === null && "border-line bg-paper text-muted",
              )}
            >
              {check === "ok" ? "Legit" : check === "long" ? "Long?" : check === "short" ? "Short?" : "Pin both"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <IconButton label={`Previous hole (${hole.number - 1})`} variant="secondary" size={56} disabled={hole.number <= 1} onClick={() => go(hole.number - 1)}>
              <IconChevronLeft size={28} strokeWidth={3} />
            </IconButton>
            <Button variant="primary" size="lg" full className="flex-1" disabled={!dirty} onClick={() => save()} data-testid="map-save">
              {dirty ? `Save hole ${hole.number}` : tee || green ? "Saved ✓" : "Tap the map"}
            </Button>
            <IconButton label={`Next hole (${hole.number + 1})`} variant={dirty ? "primary" : "secondary"} size={56} disabled={hole.number >= 18} onClick={() => go(hole.number + 1)}>
              <IconChevronRight size={28} strokeWidth={3} />
            </IconButton>
          </div>
        </div>
      }
    >
      <div className="flex h-full min-h-[420px] flex-col gap-2.5 pb-1">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="What a tap places">
          {(["tee", "green"] as const).map((k) => {
            const set = !!(k === "tee" ? tee : green);
            const active = mode === k;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={active}
                onClick={() => setMode(k)}
                data-testid={`map-mode-${k}`}
                className={cx(
                  "flex min-h-14 items-center justify-center gap-2 rounded-2xl border-2 px-2 text-lg font-black uppercase transition-transform active:scale-[0.97]",
                  active ? (k === "tee" ? "border-ink bg-ink text-white shadow-hard-sm" : "border-flag-dark bg-flag text-white shadow-hard-sm") : "border-ink bg-paper text-ink",
                )}
              >
                <span aria-hidden="true">{k === "tee" ? "⛳" : "🚩"}</span>
                <span>{k === "tee" ? "Tee" : "Green"}</span>
                <span
                  className={cx(
                    "rounded-full px-1.5 py-0.5 text-[11px] leading-none",
                    set ? "bg-fairway text-white" : active ? "bg-white/25 text-white" : "bg-sand text-muted",
                  )}
                >
                  {set ? "SET" : "TAP MAP"}
                </span>
              </button>
            );
          })}
        </div>

        {ldMissingTee && (
          <p className="rounded-xl border-2 border-ink bg-hazard px-3 py-2 text-sm leading-snug font-extrabold text-ink" data-testid="map-ld-required">
            ⚠️ REQUIRED: long drive measures every bomb from this tee point. No tee, no long drive.
          </p>
        )}
        {status !== "setup" && (
          <p className="rounded-xl border-2 border-sky bg-sky-soft px-3 py-2 text-sm leading-snug font-bold text-ink">
            📡 Round is live. Saving re-measures this hole&apos;s long drives on the spot.
          </p>
        )}

        <div className="relative min-h-[260px] flex-1 overflow-hidden rounded-2xl border-2 border-ink" data-testid="course-map" aria-label={`Satellite map for hole ${hole.number}. Tap to place the ${mode}.`}>
          <div className="absolute inset-0 isolate">
            <ErrorBoundary
              where="map"
              fallback={(_e, reset) => (
                <div className="h-full w-full">
                  <MapMessage title="The map didn't load" body="Probably no signal. Find a bar and try again." />
                  <div className="absolute inset-x-0 bottom-4 flex justify-center">
                    <Button variant="hazard" onClick={reset}>
                      Try again
                    </Button>
                  </div>
                </div>
              )}
            >
              <SatelliteMap
                hole={hole.number}
                tee={tee}
                green={green}
                mode={mode}
                others={others}
                view={mapView}
                viewKey={hole.number}
                onPlace={place}
                onReady={onReady}
                onTileTrouble={setTileTrouble}
              />
            </ErrorBoundary>
          </div>
          <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex items-start justify-between gap-2">
            <Button
              variant="ink"
              className="pointer-events-auto shadow-hard-sm"
              loading={gpsBusy}
              leading={<IconPin size={20} strokeWidth={2.75} />}
              onClick={() => void locateMe()}
              aria-label={`Use my location for the ${mode}`}
            >
              {gpsBusy && gpsAcc !== null ? `±${Math.round(gpsAcc)} m` : `I'm on the ${mode}`}
            </Button>
            <div className="pointer-events-auto flex flex-col gap-2">
              <IconButton label="Zoom in" variant="secondary" round onClick={() => apiRef.current?.zoomIn()} className="bg-paper">
                <IconPlus size={24} strokeWidth={3} />
              </IconButton>
              <IconButton label="Zoom out" variant="secondary" round onClick={() => apiRef.current?.zoomOut()} className="bg-paper">
                <IconMinus size={24} strokeWidth={3} />
              </IconButton>
            </div>
          </div>
          {tileTrouble && (
            <p className="pointer-events-none absolute top-[68px] right-16 left-2 z-10 rounded-xl border-2 border-ink bg-hazard px-3 py-2 text-sm font-extrabold text-ink" role="status">
              No satellite tiles (no signal?). Pins still work; check them once you&apos;re back online.
            </p>
          )}
        </div>
        <p className="text-center text-sm font-bold text-muted">
          Tap the map to drop the <span className="font-black text-ink">{mode === "tee" ? "⛳ tee" : "🚩 green"}</span>. Drag a pin to nudge it.
        </p>
      </div>
    </BottomSheet>
  );
}
