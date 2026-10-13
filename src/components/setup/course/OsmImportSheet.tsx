"use client";
// Results of "Try OpenStreetMap import": what was found and what got filled.
import type { OsmImportReport } from "@/lib/osm";
import { BottomSheet, Button, StatTile, cx } from "@/components/ui";

export interface OsmImportSheetProps {
  report: OsmImportReport | null;
  onClose: () => void;
  /** Open the map to check the imported points. */
  onReview: () => void;
  /** Re-run with force (replace hand-placed points). */
  onForce: () => void;
  busy: boolean;
}

function holes(ns: number[]): string {
  if (ns.length === 0) return "none";
  if (ns.length === 18) return "all 18";
  return ns.join(", ");
}

export function OsmImportSheet({ report, onClose, onReview, onForce, busy }: OsmImportSheetProps) {
  if (!report) return null;
  const nothing = report.ok && report.found.hole_lines + report.found.tees + report.found.greens === 0;
  const filled = report.filled_tees.length + report.filled_greens.length;
  const kept = report.kept_tees.length + report.kept_greens.length;
  const emoji = !report.ok ? "📵" : nothing ? "🦗" : filled > 0 ? "🛰️" : "🤷";
  const headline = !report.ok ? "OpenStreetMap ghosted us" : nothing ? "Nothing mapped" : filled > 0 ? "Points imported" : "Nothing new";

  return (
    <BottomSheet
      open
      onClose={onClose}
      title="OpenStreetMap import"
      footer={
        <div className="flex flex-col gap-2.5">
          {report.ok && filled > 0 && (
            <Button variant="primary" size="xl" full onClick={onReview}>
              Check them on the map
            </Button>
          )}
          {report.ok && kept > 0 && (
            <Button variant="hazard" size="lg" full loading={busy} onClick={onForce}>
              Replace my {kept} hand-placed point{kept === 1 ? "" : "s"} too
            </Button>
          )}
          <Button variant="secondary" size="lg" full onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <div className="space-y-4 pb-2" data-testid="osm-report">
        <div className="flex items-start gap-3">
          <div className="text-5xl leading-none" aria-hidden="true">
            {emoji}
          </div>
          <div className="min-w-0">
            <p className="loud text-3xl">{headline}</p>
            <p className="mt-1 text-base font-bold text-ink">{report.message}</p>
          </div>
        </div>

        {report.ok && !nothing && (
          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Holes" value={report.found.hole_lines} />
            <StatTile label="Tee boxes" value={report.found.tees} />
            <StatTile label="Greens" value={report.found.greens} />
          </div>
        )}

        {report.ok && !nothing && (
          <dl className="space-y-1.5 rounded-2xl bg-sand p-3 text-[15px] font-semibold">
            <Row label={report.dry_run ? "Would fill tees" : "Filled tees"} value={holes(report.filled_tees)} strong={report.filled_tees.length > 0} />
            <Row label={report.dry_run ? "Would fill greens" : "Filled greens"} value={holes(report.filled_greens)} strong={report.filled_greens.length > 0} />
            {kept > 0 && <Row label="Left alone (yours)" value={`tees ${holes(report.kept_tees)} · greens ${holes(report.kept_greens)}`} />}
            <Row
              label="Still missing"
              value={report.missing_tees.length + report.missing_greens.length === 0 ? "nothing 🎉" : `tees ${holes(report.missing_tees)} · greens ${holes(report.missing_greens)}`}
            />
          </dl>
        )}

        {report.ok && report.holes.length > 0 && (
          <p className="text-sm font-semibold text-muted">
            Tee boxes were picked to match the card yardage of the tees you play. Eyeball every par 5 on the map before the
            round: long drive measures from that point.
          </p>
        )}

        {(report.notes.length > 0 || report.errors.length > 0) && (
          <details className="rounded-2xl border-2 border-line p-3">
            <summary className="min-h-8 text-sm font-extrabold">Fine print ({report.notes.length + report.errors.length})</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm font-semibold text-muted">
              {report.notes.map((n, i) => (
                <li key={`n${i}`}>{n}</li>
              ))}
              {report.errors.map((e, i) => (
                <li key={`e${i}`} className="break-words">
                  {e}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </BottomSheet>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className={cx("min-w-0 text-right", strong ? "font-black text-ink" : "text-ink")}>{value}</dd>
    </div>
  );
}
