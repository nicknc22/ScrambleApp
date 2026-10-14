"use client";
// Commissioner Course section (rendered inside the Setup screen): 18-hole card (par, stroke index,
// yardage, contest), the OpenStreetMap import (the primary action while any tee or green is
// missing: "Fill tees & greens automatically"), and satellite tee/green placement by hand.
// Editable any time, including mid-round: long-drive distances re-measure from the tee point.
import { useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import type { OsmImportReport } from "@/lib/osm";
import type { Hole, TeeSet } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  IconPin,
  SectionHeader,
  SegmentedControl,
  cardClasses,
  cx,
  useConfirm,
  useToast,
} from "@/components/ui";
import {
  TEE_SETS,
  TEE_SET_SHORT,
  courseSummary,
  duplicateStrokeIndexes,
  firstHoleToPlace,
  greenOf,
  needsLdTee,
  teeOf,
} from "./courseModel";
import { HoleEditSheet } from "./HoleEditSheet";
import { MapSheet } from "./MapSheet";
import { OsmImportSheet } from "./OsmImportSheet";

const OSM_TIMEOUT_MS = 150_000;

export function CourseEditor() {
  const store = useTripStore();
  const view = useClientState((s) => s.view);
  const code = useClientState((s) => s.code);
  const online = useClientState((s) => s.online);
  const toast = useToast();
  const confirm = useConfirm();

  const [editHole, setEditHole] = useState<number | null>(null);
  const [mapHole, setMapHole] = useState<number | null>(null);
  const [osmBusy, setOsmBusy] = useState(false);
  const [report, setReport] = useState<OsmImportReport | null>(null);

  if (!view) return null;
  const holes = [...view.holes].sort((a, b) => a.number - b.number);
  const summary = courseSummary(holes);
  const teeSet = view.trip.settings.tee_set;
  const status = view.trip.status;
  const dupSi = duplicateStrokeIndexes(holes);
  const editing = editHole !== null ? (holes.find((h) => h.number === editHole) ?? null) : null;

  const setTeeSet = (t: TeeSet) => {
    if (t === teeSet) return;
    const r = store.dispatch({ type: "trip.update", patch: { settings: { tee_set: t } } });
    if (!r.ok) toast.error(r.reason);
  };

  const runImport = async (force: boolean) => {
    if (force) {
      const ok = await confirm({
        title: "Replace your pins with OpenStreetMap's?",
        body: "Every tee and green OpenStreetMap knows about overwrites what you placed by hand.",
        emoji: "🛰️",
        confirmLabel: "Replace them",
        tone: "hazard",
      });
      if (!ok) return;
    }
    setOsmBusy(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OSM_TIMEOUT_MS);
    try {
      // Push any pins still in the outbox first, so the server sees them as placed.
      await store.flush().catch(() => {});
      const res = await fetch(`/api/t/${encodeURIComponent(code)}/osm-import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
        credentials: "same-origin",
        signal: ctrl.signal,
      });
      const body = (await res.json().catch(() => null)) as (OsmImportReport & { error?: string }) | null;
      if (res.status === 403) {
        toast.error("Your commissioner unlock expired. Unlock again in Settings.");
      } else if (body && typeof body.message === "string" && Array.isArray(body.holes)) {
        setReport(body);
        if (body.applied > 0) await store.refresh();
      } else {
        toast.error(body?.error ?? `OpenStreetMap import failed (${res.status}).`);
      }
    } catch {
      toast.error(ctrl.signal.aborted ? "OpenStreetMap took forever. Try again later." : "No signal. The import needs the internet.");
    } finally {
      clearTimeout(timer);
      setOsmBusy(false);
    }
  };

  return (
    <section className="space-y-4" data-testid="course-editor" aria-label="Course">
      <SectionHeader
        title="Course"
        subtitle={`${view.trip.settings.course_name || "Jack Frost National"} · par ${summary.par} · ${summary.yards[teeSet].toLocaleString("en-US")} yd`}
      />

      {status !== "setup" && (
        <Card tone="sky" className="space-y-1" data-testid="course-live-note">
          <p className="text-lg leading-tight font-black">📡 The round is live. Edits hit everyone instantly.</p>
          <p className="text-[15px] font-semibold text-ink">
            Move a tee point and every long drive on that hole re-measures on its own. Each change posts a Commissioner override to
            the feed.
          </p>
        </Card>
      )}

      <PlacementStatus
        summary={summary}
        online={online}
        osmBusy={osmBusy}
        onImport={() => void runImport(false)}
        onPlace={() => setMapHole(firstHoleToPlace(holes))}
      />

      <div className="space-y-2">
        <h3 className="text-sm font-extrabold tracking-wider text-ink uppercase">Tees we play (yardage display)</h3>
        <SegmentedControl
          ariaLabel="Tees we play"
          value={teeSet}
          onChange={setTeeSet}
          options={TEE_SETS.map((t) => ({ value: t, label: `${TEE_SET_SHORT[t]} ${summary.yards[t].toLocaleString("en-US")}` }))}
        />
      </div>

      <ol className="space-y-2" aria-label="Holes">
        {holes.map((h) => (
          <HoleRow
            key={h.id}
            hole={h}
            teeSet={teeSet}
            dupSi={dupSi.has(h.stroke_index)}
            onEdit={() => setEditHole(h.number)}
            onMap={() => setMapHole(h.number)}
          />
        ))}
      </ol>

      {summary.incomplete.length === 0 && (
        // Everything's pinned: the import only matters for replacing pins (its report offers that).
        <Card tone="sand" className="space-y-3">
          <div>
            <p className="text-lg leading-tight font-black">OpenStreetMap</p>
            <p className="mt-1 text-[15px] font-semibold text-muted">
              Every hole is pinned, so a re-run only fills gaps. It never touches your pins unless you tell it to.
            </p>
          </div>
          <OsmImportButton variant="secondary" size="md" online={online} busy={osmBusy} onImport={() => void runImport(false)} />
        </Card>
      )}

      <HoleEditSheet
        hole={editing}
        onClose={() => setEditHole(null)}
        onPlaceOnMap={(n) => {
          setEditHole(null);
          setMapHole(n);
        }}
      />
      <MapSheet open={mapHole !== null} startHole={mapHole ?? 1} onClose={() => setMapHole(null)} />
      <OsmImportSheet
        report={report}
        busy={osmBusy}
        onClose={() => setReport(null)}
        onReview={() => {
          setReport(null);
          setMapHole(firstHoleToPlace(holes) || 1);
        }}
        onForce={() => {
          setReport(null);
          void runImport(true);
        }}
      />
    </section>
  );
}

function PlacementStatus({
  summary,
  online,
  osmBusy,
  onImport,
  onPlace,
}: {
  summary: ReturnType<typeof courseSummary>;
  online: boolean;
  osmBusy: boolean;
  onImport: () => void;
  onPlace: () => void;
}) {
  const allSet = summary.incomplete.length === 0;
  const ldOk = summary.ldMissing.length === 0;
  const n = summary.ldMissing.length;
  return (
    <div className={cardClasses({ tone: ldOk ? (allSet ? "fairway" : "default") : "hazard", className: "space-y-3" })} data-testid="course-status">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Count label="Tees" value={summary.tees} total={summary.holes} />
        <Count label="Greens" value={summary.greens} total={summary.holes} />
        <Count label="LD tees" value={summary.ldHoles.length - n} total={summary.ldHoles.length} hot={!ldOk} />
      </div>
      {!ldOk ? (
        <p className="text-[15px] leading-snug font-extrabold text-ink" data-testid="course-ld-needed">
          Needed for long drive on hole{n === 1 ? "" : "s"} {summary.ldMissing.join(", ")}. No tee point, no long drive.
        </p>
      ) : allSet ? (
        <p className="text-[15px] font-extrabold text-ink">Every tee and green is pinned. Drone pilot energy. 🛰️</p>
      ) : (
        <p className="text-[15px] font-bold text-ink">Long drive is covered. The other tees and greens are nice-to-have (hole maps).</p>
      )}
      {allSet ? (
        <Button variant="secondary" size="xl" full onClick={onPlace} leading={<IconPin size={24} strokeWidth={2.75} />} data-testid="course-place">
          Review the map
        </Button>
      ) : (
        <>
          <OsmImportButton variant="primary" size="xl" online={online} busy={osmBusy} onImport={onImport} />
          {!osmBusy && (
            <p className="text-center text-sm font-bold text-muted">
              Pulls Jack Frost&apos;s tee boxes and greens from OpenStreetMap. Your own pins are never touched. Eyeball the par 5s after.
            </p>
          )}
          <Button variant="secondary" size="lg" full onClick={onPlace} leading={<IconPin size={22} strokeWidth={2.75} />} data-testid="course-place">
            Pin by hand
          </Button>
        </>
      )}
    </div>
  );
}

/** The OpenStreetMap import: busy and offline states, plus the "crack a beer" line while it runs. */
function OsmImportButton({
  variant,
  size,
  online,
  busy,
  onImport,
}: {
  variant: "primary" | "secondary";
  size: "md" | "xl";
  online: boolean;
  busy: boolean;
  onImport: () => void;
}) {
  return (
    <>
      <Button
        variant={variant}
        size={size}
        full
        loading={busy}
        disabled={!online && !busy}
        onClick={onImport}
        leading={<span aria-hidden="true">🛰️</span>}
        data-testid="osm-import"
      >
        {busy ? "Asking OpenStreetMap…" : !online ? "OpenStreetMap needs signal" : variant === "primary" ? "Fill tees & greens automatically" : "Re-run OpenStreetMap import"}
      </Button>
      {busy && <p className="text-center text-sm font-bold text-muted">Their servers can take a minute. Crack a beer.</p>}
    </>
  );
}

function Count({ label, value, total, hot }: { label: string; value: number; total: number; hot?: boolean }) {
  return (
    <div className={cx("rounded-2xl border-2 px-1 py-2", hot ? "border-ink bg-hazard" : "border-line bg-paper")}>
      <div className="num text-[28px] leading-none font-black">
        {value}
        <span className="text-base font-extrabold text-muted">/{total}</span>
      </div>
      <div className="mt-1 text-[11px] font-extrabold tracking-wide text-ink uppercase">{label}</div>
    </div>
  );
}

function HoleRow({ hole, teeSet, dupSi, onEdit, onMap }: { hole: Hole; teeSet: TeeSet; dupSi: boolean; onEdit: () => void; onMap: () => void }) {
  const tee = teeOf(hole);
  const green = greenOf(hole);
  const required = needsLdTee(hole);
  return (
    <li
      className={cx(
        "flex items-stretch overflow-hidden rounded-2xl border-2",
        required ? "border-ink bg-hazard-soft" : "border-line bg-paper",
      )}
      data-testid={`course-hole-${hole.number}`}
      data-required={required || undefined}
    >
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit hole ${hole.number}: par ${hole.par}, ${hole.yardage[teeSet]} yards`}
        className="flex min-h-[76px] min-w-0 flex-1 items-center gap-3 py-2 pr-1 pl-2.5 text-left active:bg-sand"
      >
        <span
          className={cx(
            "num flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 text-2xl font-black",
            required ? "border-ink bg-hazard text-ink" : "border-ink bg-ink text-white",
          )}
          aria-hidden="true"
        >
          {hole.number}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-lg leading-tight font-black whitespace-nowrap">Par {hole.par}</span>
            <span className="num text-[15px] font-bold whitespace-nowrap text-muted">
              {hole.yardage[teeSet]} yd · SI {hole.stroke_index}
              {dupSi ? " ⚠️" : ""}
            </span>
            {hole.contest === "ctp" && <Badge tone="ghost">CTP</Badge>}
            {hole.contest === "ld" && <Badge tone="sky">Long drive</Badge>}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <PointBadge label="Tee" set={!!tee} required={required} />
            <PointBadge label="Green" set={!!green} />
          </span>
          {required && <span className="mt-1 block text-[13px] leading-tight font-extrabold text-ink">Needed for long drive</span>}
        </span>
      </button>
      <button
        type="button"
        onClick={onMap}
        aria-label={`Place hole ${hole.number} on the map`}
        data-testid={`course-map-${hole.number}`}
        className={cx(
          "flex w-[68px] shrink-0 flex-col items-center justify-center gap-0.5 border-l-2 text-xs font-black uppercase active:opacity-80",
          required ? "border-ink bg-ink text-white" : "border-line bg-sand text-ink",
        )}
      >
        <IconPin size={24} strokeWidth={2.75} />
        Map
      </button>
    </li>
  );
}

function PointBadge({ label, set, required }: { label: string; set: boolean; required?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border-2 px-2 py-0.5 text-xs leading-tight font-extrabold uppercase",
        set ? "border-fairway-dark bg-fairway text-white" : required ? "border-flag-dark bg-flag text-white" : "border-line-strong bg-paper text-muted",
      )}
    >
      {set ? "✓" : required ? "!" : "–"} {label}
    </span>
  );
}
