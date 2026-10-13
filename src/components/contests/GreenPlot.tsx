"use client";
// Stylized top-down green: pin in the center, labeled rings at 5/10/20/30 ft, every entry for the
// hole plotted at (distance, angle) with the player's name. The leader gets a gold ring, everyone
// else is dimmed, AI-suspicious entries get a red flag. Entries beyond 30 ft clamp to the edge
// and show their distance.
//
// With `marker`, the plot becomes the closest-to-pin input: drag (or tap, or arrow keys) to move
// your ball around the pin. Its radius is fixed by the entered distance.
import { useId, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { formatFeetInches } from "@/lib/engine/format";
import { cx, teamColor } from "@/components/ui";
import {
  MAX_PLOT_FT,
  PLOT_CENTER,
  PLOT_SIZE,
  RING_FT,
  dotBox,
  layoutLabels,
  plotPosition,
  pointerToAngle,
  polarToPoint,
  radiusForFeet,
  sideOfPin,
  snapAngle,
  type LabelInput,
} from "./geometry";
import type { PlotEntry } from "./model";

export interface GreenPlotMarker {
  feet: number;
  angle: number;
  label: string;
  teamSortOrder?: number | null;
  onAngleChange: (deg: number) => void;
}

export interface GreenPlotProps {
  entries: readonly PlotEntry[];
  marker?: GreenPlotMarker;
  className?: string;
  /** Hole number, for the accessible description. */
  hole?: number;
  /** Also cap the size by the viewport height (inside a sheet with other controls). */
  fitHeight?: boolean;
}

const FONT = 3.7;
const DOT_R = 2.3;
const MARKER_R = 3.1;
const MARKER_ID = "__marker__";
/** Cup + flagstick + flag (labels stay off it). */
const PIN_BOX = { x: PLOT_CENTER - 1.6, y: PLOT_CENTER - 5.4, w: 5.4, h: 7 };
/** Ring labels sit just right of 12 o'clock. */
const RING_LABEL_ANGLE = 22;
const RING_LABEL_BOXES = RING_FT.map((ft) => {
  const p = polarToPoint(radiusForFeet(ft).r, RING_LABEL_ANGLE);
  return { x: p.x - 2.6, y: p.y - 1.7, w: 5.2, h: 3.4 };
});

function describe(entries: readonly PlotEntry[], hole: number | undefined): string {
  const head = `Green${hole ? ` for hole ${hole}` : ""}`;
  if (entries.length === 0) return `${head}: no balls on it yet.`;
  const parts = entries.map((e) => `${e.name} ${formatFeetInches(e.feet)}${e.leader ? " (leader)" : ""}${e.suspicious ? " (AI flagged)" : ""}`);
  return `${head}: ${parts.join(", ")}.`;
}

export function GreenPlot({ entries, marker, className, hole, fitHeight = false }: GreenPlotProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<number | null>(null);

  const points = entries.map((e) => ({ e, p: plotPosition(e.feet, e.angle) }));
  const markerPos = marker ? plotPosition(marker.feet, marker.angle) : null;

  const labelText = (e: PlotEntry, clamped: boolean) => (clamped ? `${e.name} ${formatFeetInches(e.feet)}` : e.name);
  const labelInputs: LabelInput[] = [];
  if (marker && markerPos) {
    labelInputs.push({
      id: MARKER_ID,
      x: markerPos.x,
      y: markerPos.y,
      text: markerPos.clamped ? `${marker.label} ${formatFeetInches(marker.feet)}` : marker.label,
    });
  }
  for (const { e, p } of points) labelInputs.push({ id: e.id, x: p.x, y: p.y, text: labelText(e, p.clamped) });
  // Labels never cover a ball or the pin.
  const obstacles = [PIN_BOX, ...RING_LABEL_BOXES, ...points.map(({ p }) => dotBox(p.x, p.y, DOT_R + 0.4)), ...(markerPos ? [dotBox(markerPos.x, markerPos.y, MARKER_R + 0.4)] : [])];
  const labels = new Map(layoutLabels(labelInputs, { fontSize: FONT, obstacles }).map((l) => [l.id, l]));

  const setFromPointer = (ev: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || !marker) return;
    const rect = svg.getBoundingClientRect();
    marker.onAngleChange(snapAngle(pointerToAngle(ev.clientX, ev.clientY, rect), 1));
  };

  const onPointerDown = (ev: PointerEvent<SVGSVGElement>) => {
    if (!marker) return;
    ev.preventDefault();
    dragging.current = ev.pointerId;
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      /* synthetic pointers can't be captured */
    }
    setFromPointer(ev);
  };
  const onPointerMove = (ev: PointerEvent<SVGSVGElement>) => {
    if (dragging.current !== ev.pointerId) return;
    setFromPointer(ev);
  };
  const endDrag = (ev: PointerEvent<SVGSVGElement>) => {
    if (dragging.current === ev.pointerId) dragging.current = null;
  };

  const onKeyDown = (ev: KeyboardEvent<SVGGElement>) => {
    if (!marker) return;
    const step = ev.shiftKey ? 45 : 15;
    let next: number | null = null;
    if (ev.key === "ArrowRight" || ev.key === "ArrowUp") next = marker.angle + step;
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") next = marker.angle - step;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = 180;
    if (next === null) return;
    ev.preventDefault();
    marker.onAngleChange(snapAngle(next, 1));
  };

  const greenGrad = `green-${uid}`;
  const stripes = `stripes-${uid}`;
  const clipId = `clip-${uid}`;

  return (
    <div className={cx("relative mx-auto w-full", fitHeight ? "max-w-[min(420px,40dvh)]" : "max-w-[420px]", className)} data-testid="green-plot">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${PLOT_SIZE} ${PLOT_SIZE}`}
        className={cx("block aspect-square w-full select-none rounded-[22px] border-2 border-ink", marker && "touch-none cursor-grab")}
        role={marker ? "group" : "img"}
        aria-label={describe(entries, hole)}
        onPointerDown={marker ? onPointerDown : undefined}
        onPointerMove={marker ? onPointerMove : undefined}
        onPointerUp={marker ? endDrag : undefined}
        onPointerCancel={marker ? endDrag : undefined}
      >
        <defs>
          <radialGradient id={greenGrad} cx="50%" cy="46%" r="60%">
            <stop offset="0%" stopColor="#6fd47f" />
            <stop offset="100%" stopColor="#3fae57" />
          </radialGradient>
          <pattern id={stripes} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(-28)">
            <rect width="6" height="12" fill="#ffffff" fillOpacity="0.09" />
          </pattern>
          <clipPath id={clipId}>
            <rect x="0" y="0" width={PLOT_SIZE} height={PLOT_SIZE} rx="6" />
          </clipPath>
        </defs>

        <g clipPath={`url(#${clipId})`}>
          {/* Rough, fringe, putting surface. */}
          <rect x="0" y="0" width={PLOT_SIZE} height={PLOT_SIZE} fill="#1d5e33" />
          <path
            d="M50 2.5 C75 2 97 16 97.5 44 C98 72 80 97.5 52 97.5 C24 98 2.5 80 2.5 52 C2 26 24 3 50 2.5 Z"
            fill="#2f8a47"
          />
          <path
            d="M50 5.5 C73 5 94.5 18 94.5 45 C95 70 78 94.5 52 94.5 C26 95 5.5 78 5.5 52 C5 27 26 6 50 5.5 Z"
            fill={`url(#${greenGrad})`}
          />
          <path
            d="M50 5.5 C73 5 94.5 18 94.5 45 C95 70 78 94.5 52 94.5 C26 95 5.5 78 5.5 52 C5 27 26 6 50 5.5 Z"
            fill={`url(#${stripes})`}
          />
        </g>

        {/* Distance rings with labels at 12 o'clock (well, a bit right of it). */}
        {RING_FT.map((ft) => {
          const r = radiusForFeet(ft).r;
          const lp = polarToPoint(r, RING_LABEL_ANGLE);
          return (
            <g key={ft} aria-hidden="true">
              <circle
                cx={PLOT_CENTER}
                cy={PLOT_CENTER}
                r={r}
                fill="none"
                stroke="#ffffff"
                strokeOpacity={ft === MAX_PLOT_FT ? 0.95 : 0.75}
                strokeWidth={ft === MAX_PLOT_FT ? 0.55 : 0.4}
                strokeDasharray={ft === MAX_PLOT_FT ? undefined : "1.4 1.2"}
              />
              <text
                x={lp.x}
                y={lp.y}
                fontSize={2.9}
                fontWeight={900}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#ffffff"
                stroke="#0b3d1d"
                strokeWidth={0.7}
                paintOrder="stroke"
              >
                {ft}&apos;
              </text>
            </g>
          );
        })}

        {/* The marker's track: it only moves around the pin. */}
        {marker && markerPos && marker.feet > 0 && (
          <circle
            cx={PLOT_CENTER}
            cy={PLOT_CENTER}
            r={radiusForFeet(marker.feet).r}
            fill="none"
            stroke="#ffd60a"
            strokeWidth={0.8}
            strokeDasharray="0.1 2"
            strokeLinecap="round"
            aria-hidden="true"
          />
        )}

        {/* Pin: cup, stick and a red flag. */}
        <g aria-hidden="true">
          <circle cx={PLOT_CENTER} cy={PLOT_CENTER} r={1.2} fill="#0b0f0c" stroke="#ffffff" strokeWidth={0.35} />
          <line x1={PLOT_CENTER} y1={PLOT_CENTER} x2={PLOT_CENTER} y2={PLOT_CENTER - 5} stroke="#f2f4f1" strokeWidth={0.6} strokeLinecap="round" />
          <path d={`M${PLOT_CENTER + 0.25} ${PLOT_CENTER - 5.1} l3.4 1.1 l-3.4 1.1 Z`} fill="#e5262d" stroke="#0b0f0c" strokeWidth={0.22} />
        </g>

        {/* Leader lines under everything else. */}
        {[...points.map(({ e, p }) => ({ id: e.id, x: p.x, y: p.y, dim: !e.leader })), ...(markerPos ? [{ id: MARKER_ID, x: markerPos.x, y: markerPos.y, dim: false }] : [])].map(
          (d) => {
            const l = labels.get(d.id);
            if (!l) return null;
            return (
              <line
                key={`ll-${d.id}`}
                x1={d.x}
                y1={d.y}
                x2={l.anchorX}
                y2={l.anchorY}
                stroke="#ffffff"
                strokeOpacity={d.dim ? 0.5 : 0.95}
                strokeWidth={0.35}
                aria-hidden="true"
              />
            );
          },
        )}

        {/* Entries: dimmed unless leading. */}
        {points
          .slice()
          .reverse()
          .map(({ e, p }) => {
            const c = teamColor(e.teamSortOrder);
            const l = labels.get(e.id);
            const dotOpacity = e.leader ? 1 : e.valid ? 0.6 : 0.4;
            const labelOpacity = e.leader ? 1 : e.valid ? 0.88 : 0.6;
            return (
              <g key={e.id} data-testid="plot-entry" data-leader={e.leader || undefined} data-sus={e.suspicious || undefined} aria-hidden="true">
                {e.leader && (
                  <circle cx={p.x} cy={p.y} r={4.2} fill="none" stroke="#f5c518" strokeWidth={1.3}>
                    <animate attributeName="r" values="3.8;4.8;3.8" dur="1.8s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={DOT_R}
                  fill={c.bg}
                  stroke={e.leader ? "#0b0f0c" : "#ffffff"}
                  strokeWidth={0.6}
                  opacity={dotOpacity}
                />
                {e.suspicious && (
                  <g transform={`translate(${p.x + 1.4} ${p.y - 1.6})`} data-testid="plot-sus">
                    <line x1={0} y1={0} x2={0} y2={-4.6} stroke="#0b0f0c" strokeWidth={0.45} />
                    <path d="M0 -4.6 l3.4 1.15 l-3.4 1.15 Z" fill="#e5262d" stroke="#0b0f0c" strokeWidth={0.25} />
                  </g>
                )}
                {l && (
                  <g opacity={labelOpacity}>
                    <rect
                      x={l.x}
                      y={l.y}
                      width={l.w}
                      height={l.h}
                      rx={1.2}
                      fill={e.leader ? "#f5c518" : "#ffffff"}
                      stroke="#0b0f0c"
                      strokeWidth={e.leader ? 0.35 : 0.2}
                    />
                    <text
                      x={l.x + l.w / 2}
                      y={l.y + l.h / 2}
                      fontSize={FONT}
                      fontWeight={800}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="#0b0f0c"
                    >
                      {labelText(e, p.clamped)}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

        {/* Your ball (interactive). */}
        {marker && markerPos && (
          <g
            role="slider"
            tabIndex={0}
            aria-label={`Your ball: drag around the pin. ${sideOfPin(marker.angle)} of the pin, ${formatFeetInches(marker.feet)}.`}
            aria-valuemin={0}
            aria-valuemax={359}
            aria-valuenow={Math.round(marker.angle)}
            aria-valuetext={`${sideOfPin(marker.angle)} of the pin`}
            onKeyDown={onKeyDown}
            className="outline-none focus-visible:[&>circle:first-child]:stroke-sky"
            data-testid="plot-marker"
            data-angle={Math.round(marker.angle)}
          >
            <circle cx={markerPos.x} cy={markerPos.y} r={7} fill="#ffd60a" fillOpacity={0.22} stroke="#ffd60a" strokeWidth={0.5} />
            {marker.feet > 0 && (
              <line
                x1={PLOT_CENTER}
                y1={PLOT_CENTER}
                x2={markerPos.x}
                y2={markerPos.y}
                stroke="#ffd60a"
                strokeWidth={0.6}
                strokeDasharray="1 0.8"
              />
            )}
            <circle cx={markerPos.x} cy={markerPos.y} r={MARKER_R} fill="#ffffff" stroke="#0b0f0c" strokeWidth={0.9} />
            <circle cx={markerPos.x - 0.8} cy={markerPos.y - 0.8} r={0.45} fill="#c3ccc6" />
            <circle cx={markerPos.x + 0.7} cy={markerPos.y + 0.3} r={0.45} fill="#c3ccc6" />
            <circle cx={markerPos.x - 0.1} cy={markerPos.y + 1.2} r={0.45} fill="#c3ccc6" />
            {(() => {
              const l = labels.get(MARKER_ID);
              if (!l) return null;
              return (
                <g>
                  <rect x={l.x} y={l.y} width={l.w} height={l.h} rx={1.2} fill="#ffd60a" stroke="#0b0f0c" strokeWidth={0.4} />
                  <text
                    x={l.x + l.w / 2}
                    y={l.y + l.h / 2}
                    fontSize={FONT}
                    fontWeight={900}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="#0b0f0c"
                  >
                    {markerPos.clamped ? `${marker.label} ${formatFeetInches(marker.feet)}` : marker.label}
                  </text>
                </g>
              );
            })()}
          </g>
        )}
      </svg>
    </div>
  );
}
