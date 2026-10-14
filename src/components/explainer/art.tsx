// Cartoon parts for the explainer, in the app's sticker style: thick ink outlines, hard ink
// shadows, fairway green, hazard yellow. Plain SVG, positioned by the scenes (anim.ts timing).
import type { ReactNode } from "react";
import { elbowFor, type Pt } from "./anim";

export const C = {
  ink: "#0b0f0c",
  paper: "#ffffff",
  fairway: "#0a7d3e",
  fairwayDark: "#075c2d",
  fairwaySoft: "#e2f3e8",
  grass: "#22a35a",
  rough: "#157a42",
  hazard: "#ffd60a",
  flag: "#e5262d",
  ghost: "#7c3aed",
  ghostSoft: "#c4a5fb",
  ghostDark: "#5b21b6",
  beer: "#f59e0b",
  beerSoft: "#fef0d2",
  sky: "#0369a1",
  skySoft: "#def0fa",
  gold: "#f5c518",
  sand: "#f2dd9b",
  silver: "#c9d1d6",
  muted: "#3f4a43",
  line: "#c3ccc6",
  foam: "#fffdf2",
} as const;

export const SKIN = ["#f4c39b", "#e0a878", "#b9784f", "#f6d2b8"] as const;

const DISPLAY = "var(--font-display), system-ui, sans-serif";

/** Loud italic SVG text (decorative: the real caption is HTML). */
export function Loud({
  x,
  y,
  size,
  children,
  fill = C.ink,
  stroke,
  anchor = "middle",
  rotate = 0,
  opacity = 1,
  weight = 900,
  italic = true,
}: {
  x: number;
  y: number;
  size: number;
  children: ReactNode;
  fill?: string;
  stroke?: string;
  anchor?: "start" | "middle" | "end";
  rotate?: number;
  opacity?: number;
  weight?: number;
  italic?: boolean;
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      fontFamily={DISPLAY}
      fontWeight={weight}
      fontStyle={italic ? "italic" : "normal"}
      textAnchor={anchor}
      fill={fill}
      stroke={stroke}
      strokeWidth={stroke ? Math.max(3, size / 7) : undefined}
      strokeLinejoin="round"
      paintOrder="stroke"
      opacity={opacity}
      transform={rotate ? `rotate(${rotate} ${x} ${y})` : undefined}
      style={{ letterSpacing: "-0.01em" }}
    >
      {children}
    </text>
  );
}

/** A sticker card: ink hard shadow, ink outline. */
export function Sticker({
  x,
  y,
  w,
  h,
  r = 14,
  fill = C.paper,
  shadow = 4,
  stroke = 3,
  children,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
  fill?: string;
  shadow?: number;
  stroke?: number;
  children?: ReactNode;
}) {
  return (
    <g>
      {shadow > 0 && <rect x={x} y={y + shadow} width={w} height={h} rx={r} fill={C.ink} />}
      <rect x={x} y={y} width={w} height={h} rx={r} fill={fill} stroke={C.ink} strokeWidth={stroke} />
      {children}
    </g>
  );
}

/** Comic "POW" starburst with a word in it. */
export function Burst({
  x,
  y,
  r,
  text,
  scale = 1,
  rotate = 0,
  fill = C.hazard,
  textFill = C.ink,
  spikes = 12,
  size,
}: {
  x: number;
  y: number;
  r: number;
  text: string;
  scale?: number;
  rotate?: number;
  fill?: string;
  textFill?: string;
  spikes?: number;
  size?: number;
}) {
  if (scale <= 0.001) return null;
  const pts: string[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.68;
    pts.push(`${(Math.cos(a) * rr).toFixed(1)},${(Math.sin(a) * rr).toFixed(1)}`);
  }
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`}>
      <polygon points={pts.join(" ")} transform="translate(3 4)" fill={C.ink} />
      <polygon points={pts.join(" ")} fill={fill} stroke={C.ink} strokeWidth={3.5} strokeLinejoin="round" />
      <Loud x={0} y={(size ?? r * 0.42) * 0.36} size={size ?? r * 0.42} fill={textFill}>
        {text}
      </Loud>
    </g>
  );
}

/** A beer can centred on (0,0), 22 x 40. `crush` 0..1 squashes it; `hole` shows the shotgun hole. */
export function Can({
  x,
  y,
  rot = 0,
  crush = 0,
  hole = false,
  open = false,
  scale = 1,
  color = C.flag,
}: {
  x: number;
  y: number;
  rot?: number;
  crush?: number;
  hole?: boolean;
  open?: boolean;
  scale?: number;
  color?: string;
}) {
  const sy = 1 - 0.55 * crush;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot}) scale(${scale * (1 + crush * 0.18)} ${scale * sy})`}>
      <rect x={-11} y={-20} width={22} height={40} rx={4} fill={color} stroke={C.ink} strokeWidth={3} />
      <rect x={-11} y={-6} width={22} height={12} fill={C.paper} stroke={C.ink} strokeWidth={2} />
      <text x={0} y={3.6} fontSize={8.5} fontFamily={DISPLAY} fontWeight={900} fontStyle="italic" textAnchor="middle" fill={C.ink}>
        BEER
      </text>
      <rect x={-10} y={-20} width={20} height={5} rx={2} fill={C.silver} stroke={C.ink} strokeWidth={2} />
      {open && <ellipse cx={3} cy={-18} rx={4} ry={2.2} fill={C.ink} />}
      {hole && <ellipse cx={0} cy={13} rx={4.2} ry={3.2} fill={C.ink} />}
      {crush > 0.05 && (
        <polyline
          points="-11,-12 -5,-8 -9,-2 -3,2 -9,8 -4,12"
          fill="none"
          stroke={C.ink}
          strokeWidth={2.2}
          strokeLinejoin="round"
          opacity={Math.min(1, crush * 1.6)}
        />
      )}
    </g>
  );
}

/** A shot glass centred on (0,0). */
export function ShotGlass({ x, y, scale = 1, rot = 0 }: { x: number; y: number; scale?: number; rot?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot}) scale(${scale})`}>
      <path d="M -11 -14 L 11 -14 L 8 14 L -8 14 Z" fill={C.paper} stroke={C.ink} strokeWidth={3} strokeLinejoin="round" />
      <path d="M -9.5 -4 L 9.5 -4 L 8 12 L -8 12 Z" fill={C.beer} />
      <rect x={-8} y={10} width={16} height={4} fill={C.silver} />
    </g>
  );
}

export function Ball({ x, y, r = 7, ring = false }: { x: number; y: number; r?: number; ring?: boolean }) {
  return (
    <g>
      {ring && <circle cx={x} cy={y} r={r + 7} fill="none" stroke={C.hazard} strokeWidth={4} />}
      <circle cx={x} cy={y} r={r} fill={C.paper} stroke={C.ink} strokeWidth={2.5} />
      <circle cx={x - r * 0.3} cy={y - r * 0.25} r={r * 0.14} fill={C.line} />
      <circle cx={x + r * 0.25} cy={y + r * 0.2} r={r * 0.14} fill={C.line} />
    </g>
  );
}

/** Pin flag standing in a cup at (x, y). */
export function Flag({ x, y, h = 70, wave = 0, color = C.flag }: { x: number; y: number; h?: number; wave?: number; color?: string }) {
  const w = h * 0.42;
  return (
    <g>
      <ellipse cx={x} cy={y} rx={9} ry={3.5} fill={C.ink} />
      <line x1={x} y1={y} x2={x} y2={y - h} stroke={C.ink} strokeWidth={3.5} strokeLinecap="round" />
      <path
        d={`M ${x + 1.5} ${y - h} Q ${x + w * 0.5} ${y - h + 3 + wave * 4} ${x + w} ${y - h + h * 0.16} Q ${x + w * 0.5} ${y - h + h * 0.26 - wave * 3} ${x + 1.5} ${y - h + h * 0.3} Z`}
        fill={color}
        stroke={C.ink}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
    </g>
  );
}

/** A tap: finger-tip ripple at (x, y), `p` 0..1 through the tap. */
export function Tap({ x, y, p }: { x: number; y: number; p: number }) {
  if (p <= 0 || p >= 1) return null;
  return (
    <g pointerEvents="none">
      <circle cx={x} cy={y} r={10 + p * 26} fill="none" stroke={C.ink} strokeWidth={3} opacity={1 - p} />
      <circle cx={x} cy={y} r={11} fill={C.ink} opacity={0.22 * (1 - p)} />
    </g>
  );
}

export interface DudeFace {
  eyes?: "open" | "squeeze" | "wide" | "up";
  mouth?: "smile" | "grin" | "o" | "open" | "flat";
  /** Pupils look this way (-1..1). */
  look?: number;
}

export interface DudeProps {
  x: number;
  y: number;
  s?: number;
  shirt?: string;
  cap?: string;
  skin?: string;
  /** Hands in the dude's own coordinates (feet at 0,0; head centre at 0,-166). Default: at his sides. */
  handR?: Pt;
  handL?: Pt;
  face?: DudeFace;
  /** Head tilt in degrees (around the neck). */
  tilt?: number;
  crown?: boolean;
  /** Translucent purple ghost version. */
  ghost?: boolean;
  /** Drawn after the arms and before the hands (held cans, phones, clubs), dude coordinates. */
  items?: ReactNode;
  /** Drawn over the face (foam mustache, stars), dude coordinates. */
  over?: ReactNode;
  flip?: boolean;
}

export const SHOULDER_R: Pt = { x: -27, y: -124 };
export const SHOULDER_L: Pt = { x: 27, y: -124 };
export const HEAD: Pt = { x: 0, y: -166 };
const ARM = 31;

/** Pick the elbow that sticks out away from the body (and down when it's a toss-up). */
function arm(shoulder: Pt, hand: Pt, side: -1 | 1) {
  const a = elbowFor(shoulder, hand, ARM, ARM, 1);
  const b = elbowFor(shoulder, hand, ARM, ARM, -1);
  const score = (e: Pt) => e.x * side + e.y * 0.35;
  return score(a.elbow) >= score(b.elbow) ? a : b;
}

/** The cartoon golfer. Feet at (x, y). */
export function Dude({
  x,
  y,
  s = 1,
  shirt = C.fairway,
  cap = C.hazard,
  skin = SKIN[0],
  handR = { x: -36, y: -66 },
  handL = { x: 36, y: -66 },
  face = {},
  tilt = 0,
  crown = false,
  ghost = false,
  items,
  over,
  flip = false,
}: DudeProps) {
  const ink = ghost ? C.ghost : C.ink;
  const skinC = ghost ? "#efe6fe" : skin;
  const shirtC = ghost ? C.ghostSoft : shirt;
  const capC = ghost ? C.ghostSoft : cap;
  const r = arm(SHOULDER_R, handR, -1);
  const l = arm(SHOULDER_L, handL, 1);
  const eyes = face.eyes ?? "open";
  const mouth = face.mouth ?? "smile";
  const look = (face.look ?? 0) * 2.5;
  const limb = (pts: Pt[], key: string) => {
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    return (
      <g key={key}>
        <path d={d} fill="none" stroke={ink} strokeWidth={15} strokeLinecap="round" strokeLinejoin="round" />
        <path d={d} fill="none" stroke={skinC} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
      </g>
    );
  };
  const sleeve = (sh: Pt, el: Pt, key: string) => {
    const e = { x: sh.x + (el.x - sh.x) * 0.5, y: sh.y + (el.y - sh.y) * 0.5 };
    const d = `M ${sh.x} ${sh.y} L ${e.x.toFixed(1)} ${e.y.toFixed(1)}`;
    return (
      <g key={key}>
        <path d={d} stroke={ink} strokeWidth={21} strokeLinecap="round" />
        <path d={d} stroke={shirtC} strokeWidth={15} strokeLinecap="round" />
      </g>
    );
  };
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -s : s} ${s})`} opacity={ghost ? 0.85 : 1}>
      {/* legs + shoes */}
      {limb(
        [
          { x: -11, y: -62 },
          { x: -14, y: -9 },
        ],
        "legR",
      )}
      {limb(
        [
          { x: 11, y: -62 },
          { x: 14, y: -9 },
        ],
        "legL",
      )}
      <ellipse cx={-17} cy={-5} rx={13} ry={6.5} fill={ink} />
      <ellipse cx={17} cy={-5} rx={13} ry={6.5} fill={ink} />
      {/* shorts */}
      <path d="M -29 -82 L 29 -82 L 31 -50 L 3 -50 L 0 -60 L -3 -50 L -31 -50 Z" fill={ghost ? C.ghostSoft : "#d8c391"} stroke={ink} strokeWidth={3.5} strokeLinejoin="round" />
      {/* torso */}
      <rect x={-31} y={-134} width={62} height={58} rx={16} fill={shirtC} stroke={ink} strokeWidth={3.5} />
      <rect x={-29} y={-82} width={58} height={6} fill={ink} />
      <path d="M -10 -134 L 0 -122 L 10 -134 Z" fill={C.paper} stroke={ink} strokeWidth={2.5} strokeLinejoin="round" />
      {/* arms (sleeve over the upper arm) */}
      {limb([SHOULDER_R, r.elbow, r.hand], "armR")}
      {limb([SHOULDER_L, l.elbow, l.hand], "armL")}
      {sleeve(SHOULDER_R, r.elbow, "slR")}
      {sleeve(SHOULDER_L, l.elbow, "slL")}
      {/* head */}
      <g transform={`rotate(${tilt} 0 -138)`}>
        <rect x={-7} y={-146} width={14} height={14} fill={skinC} stroke={ink} strokeWidth={3} />
        <circle cx={-30} cy={-164} r={7} fill={skinC} stroke={ink} strokeWidth={3} />
        <circle cx={30} cy={-164} r={7} fill={skinC} stroke={ink} strokeWidth={3} />
        <circle cx={HEAD.x} cy={HEAD.y} r={31} fill={skinC} stroke={ink} strokeWidth={3.5} />
        {/* cap */}
        <path d="M -30 -172 A 30.5 30.5 0 0 1 30 -172 Z" fill={capC} stroke={ink} strokeWidth={3.5} strokeLinejoin="round" />
        <path d="M -33 -172 Q 0 -164 33 -172 L 33 -176 Q 0 -168 -33 -176 Z" fill={capC} stroke={ink} strokeWidth={3} strokeLinejoin="round" />
        <circle cx={0} cy={-197} r={3.5} fill={capC} stroke={ink} strokeWidth={2.5} />
        {crown && (
          <path
            d="M -20 -194 L -20 -214 L -10 -204 L 0 -220 L 10 -204 L 20 -214 L 20 -194 Z"
            fill={C.gold}
            stroke={ink}
            strokeWidth={3}
            strokeLinejoin="round"
          />
        )}
        {/* eyes */}
        {eyes === "squeeze" ? (
          <g stroke={ink} strokeWidth={3.5} strokeLinecap="round" fill="none">
            <path d="M -17 -164 L -9 -160 L -17 -156" />
            <path d="M 17 -164 L 9 -160 L 17 -156" />
          </g>
        ) : (
          <g>
            {(() => {
              const big = eyes === "wide";
              const rx = big ? 8.5 : 6.5;
              const ry = big ? 10 : 7.5;
              const py = eyes === "up" ? -4 : 0;
              return (
                <>
                  <ellipse cx={-11} cy={-160} rx={rx} ry={ry} fill={C.paper} stroke={ink} strokeWidth={2.5} />
                  <ellipse cx={11} cy={-160} rx={rx} ry={ry} fill={C.paper} stroke={ink} strokeWidth={2.5} />
                  <circle cx={-11 + look} cy={-159 + py} r={big ? 2.6 : 3.2} fill={ink} />
                  <circle cx={11 + look} cy={-159 + py} r={big ? 2.6 : 3.2} fill={ink} />
                </>
              );
            })()}
          </g>
        )}
        {/* nose */}
        <path d="M -2 -153 Q 4 -149 -1 -146" fill="none" stroke={ink} strokeWidth={2.5} strokeLinecap="round" />
        {/* mouth */}
        {mouth === "smile" && <path d="M -10 -142 Q 0 -134 10 -142" fill="none" stroke={ink} strokeWidth={3} strokeLinecap="round" />}
        {mouth === "flat" && <path d="M -8 -140 L 8 -140" fill="none" stroke={ink} strokeWidth={3} strokeLinecap="round" />}
        {mouth === "grin" && (
          <path d="M -13 -144 Q 0 -146 13 -144 Q 11 -131 0 -131 Q -11 -131 -13 -144 Z" fill={C.paper} stroke={ink} strokeWidth={3} strokeLinejoin="round" />
        )}
        {(mouth === "o" || mouth === "open") && (
          <g>
            <ellipse cx={0} cy={-139} rx={mouth === "o" ? 5.5 : 8} ry={mouth === "o" ? 6.5 : 7.5} fill={ink} />
            <ellipse cx={0} cy={-135.5} rx={mouth === "o" ? 3 : 5} ry={2.4} fill={C.flag} />
          </g>
        )}
        {over}
      </g>
      {items}
      {/* hands */}
      <circle cx={r.hand.x} cy={r.hand.y} r={8} fill={skinC} stroke={ink} strokeWidth={3} />
      <circle cx={l.hand.x} cy={l.hand.y} r={8} fill={skinC} stroke={ink} strokeWidth={3} />
    </g>
  );
}

/** A key (for stabbing the can), tip at (0,0) pointing right. */
export function Key({ x, y, rot = 0 }: { x: number; y: number; rot?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <path d="M -26 -3 L 0 -3 L 0 3 L -26 3 Z M -8 3 L -8 7 L -4 7 L -4 3" fill={C.gold} stroke={C.ink} strokeWidth={2} strokeLinejoin="round" />
      <circle cx={-32} cy={0} r={8} fill={C.gold} stroke={C.ink} strokeWidth={2.5} />
      <circle cx={-32} cy={0} r={3} fill={C.ink} />
    </g>
  );
}

/** Sparkle / star, centred. */
export function Spark({ x, y, r = 8, fill = C.hazard, rot = 0 }: { x: number; y: number; r?: number; fill?: string; rot?: number }) {
  const k = r * 0.32;
  return (
    <path
      transform={`translate(${x} ${y}) rotate(${rot})`}
      d={`M 0 ${-r} L ${k} ${-k} L ${r} 0 L ${k} ${k} L 0 ${r} L ${-k} ${k} L ${-r} 0 L ${-k} ${-k} Z`}
      fill={fill}
      stroke={C.ink}
      strokeWidth={2}
      strokeLinejoin="round"
    />
  );
}

/** A little cartoon ghost (ghost beers), centred. */
export function Ghost({ x, y, s = 1, rot = 0 }: { x: number; y: number; s?: number; rot?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot}) scale(${s})`}>
      <path
        d="M -16 14 L -16 -4 A 16 16 0 0 1 16 -4 L 16 14 L 10 9 L 5 14 L 0 9 L -5 14 L -10 9 Z"
        fill={C.paper}
        stroke={C.ink}
        strokeWidth={3}
        strokeLinejoin="round"
      />
      <ellipse cx={-5.5} cy={-3} rx={2.6} ry={3.6} fill={C.ink} />
      <ellipse cx={5.5} cy={-3} rx={2.6} ry={3.6} fill={C.ink} />
      <ellipse cx={0} cy={5} rx={3} ry={2.4} fill={C.ink} />
    </g>
  );
}
