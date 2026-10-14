// The eight explainer cartoons. Each is a pure function of the scene clock `t` (ms) and the
// personalised art data, drawn in a 360 x 300 SVG. Decorative (aria-hidden): the captions under
// them are the real text.
import type { ReactNode } from "react";
import { TEAM_PALETTE } from "@/components/ui/teamColors";
import { countUp, easeIn, easeInOut, easeOut, fadeIn, lerp, pop, rand, seg, track, trackNum, wave, type Pt } from "./anim";
import { Ball, Burst, C, Can, Dude, Flag, Ghost, Key, Loud, SKIN, ShotGlass, Spark, Sticker, Tap } from "./art";
import { shortName } from "./personalize";
import type { ExplainerArt, SceneId } from "./script";

export interface SceneProps {
  t: number;
  art: ExplainerArt;
}

export const VIEW_W = 360;
export const VIEW_H = 300;

/** Rotating sun rays behind a scene (hype). */
function Rays({ x, y, t, color = C.hazard, opacity = 0.16, n = 14 }: { x: number; y: number; t: number; color?: string; opacity?: number; n?: number }) {
  const wedges: ReactNode[] = [];
  const r = 420;
  for (let i = 0; i < n; i++) {
    const a0 = ((i * 2) / (n * 2)) * Math.PI * 2;
    const a1 = ((i * 2 + 1) / (n * 2)) * Math.PI * 2;
    wedges.push(
      <path key={i} d={`M 0 0 L ${(Math.cos(a0) * r).toFixed(1)} ${(Math.sin(a0) * r).toFixed(1)} L ${(Math.cos(a1) * r).toFixed(1)} ${(Math.sin(a1) * r).toFixed(1)} Z`} />,
    );
  }
  return (
    <g transform={`translate(${x} ${y}) rotate(${(t / 60) % 360})`} fill={color} opacity={opacity}>
      {wedges}
    </g>
  );
}

const rot = (p: Pt, deg: number): Pt => {
  const a = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) };
};
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });

// ---------------------------------------------------------------- 1. Cold open: the shotgun

function ColdOpen({ t, art }: SceneProps) {
  const X = 176;
  const Y = 288;
  const S = 1.22;
  const toWorld = (p: Pt): Pt => ({ x: X + p.x * S, y: Y + p.y * S });

  // The can (dude coordinates): chest, mouth, wind up, forehead, victory.
  const shake = t > 2400 && t < 3950 ? wave(t, 160) * 1.4 : 0;
  const canPos = track(t, [
    { at: 0, x: 2, y: -102 },
    { at: 1300, x: 2, y: -102 },
    { at: 1900, x: -12, y: -150 },
    { at: 3950, x: -12, y: -150 },
    { at: 4150, x: -34, y: -176 },
    { at: 4260, x: 4, y: -186 },
    { at: 4600, x: 4, y: -186 },
    { at: 5000, x: -48, y: -190 },
  ]);
  const canRot = trackNum(t, [
    { at: 0, v: -90 },
    { at: 1300, v: -90 },
    { at: 1900, v: -50 },
    { at: 3950, v: -50 },
    { at: 4150, v: -100 },
    { at: 4260, v: -90 },
    { at: 4600, v: -90 },
    { at: 5000, v: -20 },
  ]);
  const can = { x: canPos.x + shake, y: canPos.y };
  const crush = easeOut(seg(t, 4250, 4330));
  const holeOn = t >= 620;
  const opened = t >= 2250;
  const handR = add(can, rot({ x: 0, y: -7 }, canRot));
  const hole = add(can, rot({ x: 0, y: 13 }, -90)); // where the key goes in (can still at the chest)

  // The key (left hand): hover, stab, pull out; then the left hand cracks the tab, hits the hip, pumps.
  const tip = track(t, [
    { at: 0, x: hole.x + 22, y: hole.y - 22 },
    { at: 420, x: hole.x + 18, y: hole.y - 18 },
    { at: 560, x: hole.x - 2, y: hole.y + 2 },
    { at: 900, x: hole.x - 2, y: hole.y + 2 },
    { at: 1150, x: hole.x + 30, y: hole.y - 14 },
  ]);
  const keyHand = add(tip, { x: 24, y: -22 });
  const tabAt = add(can, rot({ x: 2, y: -24 }, -50));
  let handL: Pt;
  if (t < 1150) handL = keyHand;
  else if (t < 1500) handL = track(t, [{ at: 1150, ...keyHand }, { at: 1500, x: 34, y: -74 }]);
  else if (t < 2000) handL = { x: 34, y: -74 };
  else if (t < 2600) handL = track(t, [{ at: 2000, x: 34, y: -74 }, { at: 2200, x: tabAt.x + 6, y: tabAt.y - 2 }, { at: 2350, x: tabAt.x + 6, y: tabAt.y - 2 }, { at: 2600, x: 32, y: -84 }]);
  else if (t < 4500) handL = { x: 32, y: -84 };
  else {
    const p = track(t, [{ at: 4500, x: 32, y: -84 }, { at: 4800, x: 50, y: -176 }]);
    handL = { x: p.x, y: p.y + (t > 4800 ? wave(t - 4800, 520) * 7 : 0) };
  }

  const face =
    t < 600
      ? { eyes: "open" as const, mouth: "grin" as const, look: 0.8 }
      : t < 1300
        ? { eyes: "wide" as const, mouth: "o" as const, look: 0.6 }
        : t < 2300
          ? { eyes: "up" as const, mouth: "open" as const, look: -0.4 }
          : t < 3950
            ? { eyes: "squeeze" as const, mouth: "open" as const }
            : t < 4250
              ? { eyes: "wide" as const, mouth: "grin" as const, look: -0.6 }
              : { eyes: "squeeze" as const, mouth: "grin" as const };
  const tilt = trackNum(t, [
    { at: 1300, v: 0 },
    { at: 1900, v: -9 },
    { at: 3950, v: -9 },
    { at: 4150, v: 0 },
    { at: 4260, v: 4 },
    { at: 4400, v: 0 },
  ]);

  // Foam out of the hole (world coordinates), then dribbles at the mouth while chugging.
  const holeW = toWorld(hole);
  const foam: ReactNode[] = [];
  for (let i = 0; i < 22; i++) {
    const born = 600 + rand(i * 7 + 1) * 380;
    const tau = (t - born) / 1000;
    if (tau <= 0 || tau > 0.85) continue;
    const vx = 30 + rand(i * 7 + 2) * 120;
    const vy = -(110 + rand(i * 7 + 3) * 150);
    const px = holeW.x + vx * tau;
    const py = holeW.y + vy * tau + 0.5 * 420 * tau * tau;
    foam.push(<circle key={i} cx={px} cy={py} r={3 + rand(i * 7 + 4) * 4} fill={C.foam} stroke={C.ink} strokeWidth={1.5} opacity={1 - Math.max(0, tau - 0.6) / 0.25} />);
  }
  const dribble: ReactNode[] = [];
  if (t > 2400 && t < 4100) {
    for (let i = 0; i < 3; i++) {
      const ph = ((t - 2400 + i * 330) % 1000) / 1000;
      const m = toWorld({ x: 8 + i * 2, y: -133 });
      dribble.push(<ellipse key={i} cx={m.x + i} cy={m.y + ph * 40} rx={2.6} ry={3.4} fill={C.beer} stroke={C.ink} strokeWidth={1.2} opacity={1 - ph} />);
    }
  }

  // Stars circling his head after the crunch.
  const stars: ReactNode[] = [];
  if (t > 4300) {
    const head = toWorld({ x: 0, y: -206 });
    for (let i = 0; i < 3; i++) {
      const a = (t - 4300) / 300 + (i * Math.PI * 2) / 3;
      stars.push(<Spark key={i} x={head.x + Math.cos(a) * 44} y={head.y + Math.sin(a) * 10} r={9} rot={(t / 6) % 360} />);
    }
  }

  const mustache = t > 2500 ? (
    <path d="M -15 -147 Q -8 -153 0 -148 Q 8 -153 15 -147 Q 8 -142 0 -146 Q -8 -142 -15 -147 Z" fill={C.foam} stroke={C.ink} strokeWidth={2} />
  ) : null;

  const glug = (start: number, dx: number, dy: number, rotate: number) => {
    const s = pop(t, start, 260) * (1 - seg(t, start + 650, start + 850));
    const pos = toWorld({ x: 62 + dx, y: -190 + dy });
    return <Burst x={pos.x} y={pos.y - seg(t, start, start + 850) * 14} r={30} text="GLUG" scale={s} rotate={rotate} fill={C.paper} spikes={9} size={15} />;
  };

  return (
    <g>
      <Rays x={X} y={130} t={t} />
      <ellipse cx={X} cy={292} rx={150} ry={18} fill={C.fairwayDark} stroke={C.ink} strokeWidth={3} />
      <Dude
        x={X}
        y={Y}
        s={S}
        shirt={C.flag}
        cap={C.hazard}
        handR={handR}
        handL={handL}
        face={face}
        tilt={tilt}
        over={mustache}
        items={
          <g>
            <Can x={can.x} y={can.y} rot={canRot} crush={crush} hole={holeOn && t < 1700} open={opened} />
            {t < 1250 && <Key x={tip.x} y={tip.y} rot={135} />}
          </g>
        }
      />
      {foam}
      {dribble}
      {stars}
      <Burst x={holeW.x + 74} y={holeW.y - 70} r={42} text="PSSHHT!" scale={pop(t, 640) * (1 - seg(t, 1500, 1650))} rotate={-8} size={15} />
      {(() => {
        const p = toWorld(add(tabAt, { x: -40, y: -36 }));
        return <Burst x={p.x} y={p.y} r={40} text="CRACK!" scale={pop(t, 2240) * (1 - seg(t, 2900, 3050))} rotate={10} fill={C.paper} size={15} />;
      })()}
      {glug(2550, 0, 0, -6)}
      {glug(3000, 18, -26, 8)}
      {glug(3450, -4, -52, -4)}
      <Burst x={X + 112} y={64} r={50} text="CRUNCH!" scale={pop(t, 4250, 280) * (1 - seg(t, 5300, 5500))} rotate={-10} fill={C.hazard} size={16} />
      {t > 5000 && (
        <g opacity={fadeIn(t, 5000, 260)}>
          <Spark x={70} y={70} r={12} rot={(t / 5) % 360} />
          <Spark x={300} y={120} r={9} rot={(-t / 6) % 360} />
          <Spark x={58} y={170} r={7} rot={(t / 7) % 360} />
        </g>
      )}
      {t >= 5300 && (
        <g transform={`translate(${X + 104} 64) rotate(-8) scale(${pop(t, 5300)})`}>
          <rect x={-58} y={-20} width={116} height={40} rx={10} fill={C.ink} transform="translate(0 4)" />
          <rect x={-58} y={-20} width={116} height={40} rx={10} fill={C.paper} stroke={C.ink} strokeWidth={3} />
          <Loud x={0} y={8} size={20}>
            {shortName(art.hello.toUpperCase(), 9)}!
          </Loud>
        </g>
      )}
    </g>
  );
}

// ---------------------------------------------------------------- 2. Scramble basics

function Scramble({ t }: SceneProps) {
  const tee = { x: 44, y: 132 };
  const lands = [
    { x: 92, y: 40, label: "TREES" },
    { x: 196, y: 122, label: "SAND" },
    { x: 140, y: 76, label: "ROUGH" },
    { x: 262, y: 84, label: "" },
  ];
  const best = lands[3];
  const balls = lands.map((l, i) => {
    const start = 150 + i * 260;
    const p = easeOut(seg(t, start, start + 650));
    const regroup = easeInOut(seg(t, 2500 + i * 90, 3000 + i * 90));
    const flying = { x: lerp(tee.x, l.x, p), y: lerp(tee.y, l.y, p) - Math.sin(Math.PI * p) * 70 };
    const pos = i === 3 ? flying : { x: lerp(flying.x, best.x - 16 + i * 10, regroup), y: lerp(flying.y, best.y + 14, regroup) };
    return { pos, visible: t >= start, landed: p >= 1, regroup };
  });
  const minus = Tap({ x: 82, y: 199, p: seg(t, 3350, 3800) });
  const score = t >= 3420 ? 3 : 4;
  const saveTap = Tap({ x: 180, y: 272, p: seg(t, 4250, 4700) });
  const saved = t >= 4350;
  return (
    <g>
      <Sticker x={12} y={8} w={336} h={146} r={18} fill={C.rough}>
        <path d="M 12 120 Q 120 140 200 96 Q 260 64 348 74 L 348 104 Q 270 96 214 126 Q 130 166 12 150 Z" fill={C.grass} />
        <ellipse cx={196} cy={124} rx={30} ry={11} fill={C.sand} stroke={C.ink} strokeWidth={2.5} />
        {[54, 84, 116].map((x, i) => (
          <g key={x}>
            <circle cx={x} cy={34 + (i % 2) * 8} r={17} fill={C.fairwayDark} stroke={C.ink} strokeWidth={2.5} />
          </g>
        ))}
        <ellipse cx={296} cy={70} rx={36} ry={17} fill="#5ccf86" stroke={C.ink} strokeWidth={2.5} />
        <Flag x={300} y={70} h={46} wave={wave(t, 900)} />
        <rect x={tee.x - 9} y={tee.y + 2} width={18} height={6} rx={2} fill={C.paper} stroke={C.ink} strokeWidth={2} />
      </Sticker>
      {balls.map((b, i) =>
        b.visible ? (
          <g key={i}>
            <Ball x={b.pos.x} y={b.pos.y} r={6.5} ring={i === 3 && t > 1700} />
            {i < 3 && b.landed && t > 1750 + i * 120 && b.regroup < 0.05 && (
              <g opacity={fadeIn(t, 1750 + i * 120)}>
                <path d={`M ${b.pos.x - 7} ${b.pos.y - 7} L ${b.pos.x + 7} ${b.pos.y + 7} M ${b.pos.x + 7} ${b.pos.y - 7} L ${b.pos.x - 7} ${b.pos.y + 7}`} stroke={C.flag} strokeWidth={4} strokeLinecap="round" />
              </g>
            )}
          </g>
        ) : null,
      )}
      {t > 2400 && t < 3100 &&
        balls.slice(0, 3).map((b, i) => (
          <path key={i} d={`M ${lands[i].x} ${lands[i].y} L ${best.x - 16 + i * 10} ${best.y + 14}`} stroke={C.paper} strokeWidth={2.5} strokeDasharray="5 5" opacity={1 - seg(t, 2900, 3100)} />
        ))}
      <g transform={`translate(${best.x + 6} ${best.y - 30}) scale(${pop(t, 1700)})`}>
        <rect x={-30} y={-13} width={60} height={26} rx={8} fill={C.ink} transform="translate(0 3)" />
        <rect x={-30} y={-13} width={60} height={26} rx={8} fill={C.hazard} stroke={C.ink} strokeWidth={2.5} />
        <Loud x={0} y={6} size={16}>
          BEST
        </Loud>
      </g>
      <g transform={`translate(180 18) scale(${pop(t, 2600)})`}>
        <Loud x={0} y={14} size={17} fill={C.paper} stroke={C.ink}>
          EVERYBODY HITS FROM HERE
        </Loud>
      </g>
      {/* Score stepper */}
      <Sticker x={30} y={166} w={300} h={70} r={18}>
        <circle cx={82} cy={201} r={25} fill={C.paper} stroke={C.ink} strokeWidth={3.5} />
        <path d="M 70 201 L 94 201" stroke={C.ink} strokeWidth={5} strokeLinecap="round" />
        <circle cx={278} cy={204} r={25} fill={C.ink} />
        <circle cx={278} cy={201} r={25} fill={C.fairway} stroke={C.ink} strokeWidth={3.5} />
        <path d="M 266 201 L 290 201 M 278 189 L 278 213" stroke={C.paper} strokeWidth={5} strokeLinecap="round" />
        <g transform={`translate(180 220) scale(${score === 3 ? 0.7 + 0.3 * pop(t, 3420, 300) : 1})`}>
          <Loud x={0} y={0} size={52} italic={false}>
            {score}
          </Loud>
        </g>
      </Sticker>
      {minus}
      <g transform={`translate(246 174) rotate(8) scale(${pop(t, 3500)})`}>
        <rect x={-34} y={-12} width={68} height={24} rx={8} fill={C.flag} stroke={C.ink} strokeWidth={2.5} />
        <Loud x={0} y={6} size={14} fill={C.paper}>
          BIRDIE
        </Loud>
      </g>
      <Sticker x={70} y={250} w={220} h={42} r={14} fill={saved ? C.fairway : C.hazard}>
        <Loud x={180} y={279} size={21} fill={saved ? C.paper : C.ink} italic={false}>
          {saved ? "✓ SAVED" : `SAVE ${score}`}
        </Loud>
      </Sticker>
      {saveTap}
    </g>
  );
}

// ---------------------------------------------------------------- 3. Drinks = strokes

function Drinks({ t, art }: SceneProps) {
  const { strokes, credit, net } = art.drinkMath;
  // Dude finishing a beer at the left, then a thumbs-up.
  const drinking = t < 1100;
  const canD = drinking ? { x: -6, y: -152 } : track(t, [{ at: 1100, x: -6, y: -152 }, { at: 1400, x: -40, y: -96 }]);
  const canDRot = drinking ? -55 + wave(t, 300) * 3 : trackNum(t, [{ at: 1100, v: -55 }, { at: 1400, v: 0 }]);
  const handR = add(canD, rot({ x: 0, y: -6 }, canDRot));
  const tap = seg(t, 1500, 1950);
  const pressed = t >= 1500 && t < 1700;
  const count = t >= 1580 ? 1 : 0;
  const flyP = easeInOut(seg(t, 1650, 2250));
  const from = { x: 68, y: 250 };
  const to = { x: 236, y: 84 };
  const fly = { x: lerp(from.x, to.x, flyP), y: lerp(from.y, to.y, flyP) - Math.sin(Math.PI * flyP) * 60 };
  const stamp = pop(t, 2700, 340);
  const name = shortName(art.hello.toUpperCase(), 9);
  const btn = (x: number, label: string, emoji: string, fill: string, fg: string, down: boolean) => (
    <g transform={`translate(0 ${down ? 3 : 0})`}>
      {!down && <rect x={x} y={238} width={100} height={48} rx={12} fill={C.ink} />}
      <rect x={x} y={234} width={100} height={48} rx={12} fill={fill} stroke={C.ink} strokeWidth={3} />
      <text x={x + 50} y={256} fontSize={17} textAnchor="middle">
        {emoji}
      </text>
      <Loud x={x + 50} y={275} size={13} fill={fg} italic={false}>
        {label}
      </Loud>
    </g>
  );
  return (
    <g>
      <Dude
        x={66}
        y={166}
        s={0.6}
        shirt={C.sky}
        cap={C.flag}
        skin={SKIN[1]}
        handR={handR}
        handL={drinking ? { x: 34, y: -80 } : track(t, [{ at: 1100, x: 34, y: -80 }, { at: 1400, x: 46, y: -150 }])}
        face={drinking ? { eyes: "squeeze", mouth: "open" } : { eyes: "open", mouth: "grin", look: 1 }}
        tilt={drinking ? -8 : 0}
        items={<Can x={canD.x} y={canD.y} rot={canDRot} crush={easeOut(seg(t, 1150, 1300))} open />}
      />
      {/* The math */}
      <Sticker x={136} y={10} w={212} h={132} r={18}>
        <Loud x={242} y={34} size={13} italic={false} fill={C.muted}>
          HOLE 7 · PAR 4 · TEAM OF 4
        </Loud>
        <Loud x={162} y={98} size={50} italic={false}>
          {strokes}
        </Loud>
        <g opacity={t >= 2250 ? 1 : 0}>
          <Loud x={194} y={96} size={40} italic={false}>
            −
          </Loud>
          <Can x={224} y={82} scale={0.62} rot={wave(t, 700) * 4} />
          <Loud x={248} y={98} size={30} italic={false}>
            {credit}
          </Loud>
        </g>
        <g opacity={t >= 2650 ? 1 : 0}>
          <Loud x={274} y={96} size={36} italic={false}>
            =
          </Loud>
        </g>
        <g transform={`translate(312 86) scale(${stamp})`}>
          <circle r={26} fill={C.fairway} stroke={C.ink} strokeWidth={3} />
          <Loud x={0} y={10} size={32} fill={C.paper} italic={false}>
            {net}
          </Loud>
        </g>
        <g opacity={fadeIn(t, 2900)}>
          <Loud x={242} y={130} size={15} fill={C.fairwayDark}>
            {`${strokes} − ${credit} BEER = ${net} NET`}
          </Loud>
        </g>
      </Sticker>
      {/* The drinks row, like the Play screen */}
      <Sticker x={10} y={176} w={340} h={118} r={18}>
        <circle cx={38} cy={208} r={16} fill={TEAM_PALETTE[0].bg} stroke={C.ink} strokeWidth={2.5} />
        <Loud x={38} y={213} size={12} fill={C.paper} italic={false}>
          {name.slice(0, 2)}
        </Loud>
        <Loud x={62} y={215} size={20} anchor="start" italic={false}>
          {name}
        </Loud>
        <g transform={`translate(296 210) scale(${count ? 0.7 + 0.3 * pop(t, 1580, 260) : 1})`}>
          <Loud x={0} y={4} size={28} italic={false}>
            {count}
          </Loud>
        </g>
        <Loud x={296} y={226} size={9} italic={false} fill={C.muted}>
          HOLE 7
        </Loud>
        {btn(18, "DRINK", "🍺", C.beer, C.ink, pressed)}
        {btn(130, "SHOTGUN", "🔫", C.flag, C.paper, false)}
        {btn(242, "SHOT", "🥃", C.sky, C.paper, false)}
      </Sticker>
      <Tap x={68} y={258} p={tap} />
      {flyP > 0 && flyP < 1 && <Can x={fly.x} y={fly.y} scale={0.7} rot={flyP * 360} />}
      {t > 3200 && (
        <g transform={`translate(74 16) rotate(-6) scale(${pop(t, 3200)})`}>
          <rect x={-62} y={-14} width={124} height={28} rx={9} fill={C.ink} transform="translate(0 3)" />
          <rect x={-62} y={-14} width={124} height={28} rx={9} fill={C.hazard} stroke={C.ink} strokeWidth={2.5} />
          <Loud x={0} y={6} size={15}>
            CHUG = BIRDIE
          </Loud>
        </g>
      )}
    </g>
  );
}

// ---------------------------------------------------------------- 4. Ghost beers

function GhostBeers({ t, art }: SceneProps) {
  const { teamSize, base, values } = art.ghost;
  const shown = values.map((_, i) => 300 + i * 520);
  const total = values.reduce((s, v, i) => s + (t >= shown[i] ? v : 0), 0);
  const firstGhost = values.findIndex((v) => v > 1);
  const ghostBurst = firstGhost >= 0 ? pop(t, shown[firstGhost] + 80) * (1 - seg(t, shown[firstGhost] + 1300, shown[firstGhost] + 1450)) : 0;
  const people = Math.max(1, Math.min(teamSize, 3));
  const xs = people === 1 ? [140] : people === 2 ? [100, 180] : [64, 136, 208];
  return (
    <g>
      <Sticker x={12} y={8} w={336} h={124} r={18}>
        <Loud x={180} y={30} size={14} italic={false} fill={C.muted}>
          {`TEAM OF ${teamSize} · EACH DRINK IS WORTH`}
        </Loud>
        {values.map((v, i) => {
          const x = 44 + i * 54.5;
          const s = pop(t, shown[i]);
          const ghost = v > 1;
          return (
            <g key={i} transform={`translate(${x} 70) scale(${s})`}>
              {ghost && <circle r={27} fill={C.ghostSoft} opacity={0.6 + 0.4 * wave(t, 500)} />}
              <Can x={0} y={-2} scale={0.8} color={ghost ? C.ghost : C.flag} />
              <g transform="translate(0 36)">
                <rect x={-20} y={-11} width={40} height={22} rx={8} fill={ghost ? C.ghost : C.paper} stroke={C.ink} strokeWidth={2.5} />
                <Loud x={0} y={6} size={15} fill={ghost ? C.paper : C.ink} italic={false}>
                  {`+${v}`}
                </Loud>
              </g>
              {ghost && t > shown[i] + 150 && <Ghost x={17 + seg(t, shown[i], shown[i] + 700) * 4} y={-14 - seg(t, shown[i], shown[i] + 700) * 6} s={0.62} rot={12 + wave(t, 600) * 8} />}
            </g>
          );
        })}
      </Sticker>
      {/* The short-handed crew + their ghost */}
      <ellipse cx={180} cy={292} rx={170} ry={12} fill={C.ghostDark} opacity={0.5} />
      {xs.map((x, i) => (
        <Dude
          key={i}
          x={x}
          y={294}
          s={0.52}
          shirt={[C.flag, C.sky, C.fairway][i]}
          cap={[C.hazard, C.paper, C.beer][i]}
          skin={SKIN[i % SKIN.length]}
          handR={{ x: -38, y: -170 + wave(t + i * 200, 900) * 6 }}
          handL={{ x: 36, y: -78 }}
          face={{ eyes: i === 1 ? "squeeze" : "open", mouth: "grin", look: 0.7 }}
          items={<Can x={-40} y={-184 + wave(t + i * 200, 900) * 6} scale={0.9} />}
        />
      ))}
      <g transform={`translate(0 ${wave(t, 1600) * 6})`}>
        <Dude
          x={292}
          y={290}
          s={0.52}
          ghost
          handR={{ x: -38, y: -170 }}
          handL={{ x: 36, y: -80 }}
          face={{ eyes: "wide", mouth: "o", look: -0.6 }}
          items={<Can x={-40} y={-184} scale={0.9} color={C.ghost} />}
        />
        {/* The burst stands in for the label while it pops, so neither covers the other. */}
        <g opacity={1 - Math.min(1, ghostBurst)}>
          <Loud x={292} y={176} size={14} fill={C.paper} stroke={C.ink}>
            {`DRINKER #${base}`}
          </Loud>
        </g>
      </g>
      {firstGhost >= 0 && <Burst x={288} y={166} r={44} text="GHOST BEER!" size={11} scale={ghostBurst} rotate={-8} fill={C.paper} />}
      <g transform={`translate(104 154) rotate(-4) scale(${pop(t, 600)})`}>
        <rect x={-74} y={-17} width={148} height={34} rx={10} fill={C.ink} transform="translate(0 4)" />
        <rect x={-74} y={-17} width={148} height={34} rx={10} fill={C.hazard} stroke={C.ink} strokeWidth={3} />
        <Loud x={0} y={7} size={18}>
          {`−${total} STROKES`}
        </Loud>
      </g>
    </g>
  );
}

// ---------------------------------------------------------------- 5. Mulligans + Groom's Mulligan + drives

function Mulligans({ t, art }: SceneProps) {
  const tokens = [
    { at: 350, from: { x: 48, y: 52 } },
    { at: 1050, from: { x: 104, y: 56 } },
  ];
  const banked = tokens.filter((k) => t >= k.at + 600).length;
  const names = (art.driveNames.length > 0 ? art.driveNames : ["You", "Him", "That guy", "Groom"]).slice(0, 4);
  const ticks = names.map((_, i) => 3300 + i * 380);
  const groom = shortName(art.groomName.toUpperCase(), 10);
  return (
    <g>
      {t >= 1900 && <Rays x={262} y={80} t={t * 2} color={C.gold} opacity={0.3 * pop(t, 1900, 380)} n={12} />}
      {/* The bank */}
      <Sticker x={10} y={10} w={156} h={140} r={18}>
        <Can x={48} y={52} scale={0.85} hole open color={C.flag} />
        <ShotGlass x={104} y={56} scale={0.95} />
        <path d="M 42 98 Q 42 142 88 142 Q 134 142 134 98 Z" fill={C.skySoft} stroke={C.ink} strokeWidth={3} strokeLinejoin="round" />
        <rect x={36} y={90} width={104} height={12} rx={6} fill={C.silver} stroke={C.ink} strokeWidth={2.5} />
        <Loud x={88} y={130} size={22} italic={false}>
          {`×${banked}`}
        </Loud>
        <Loud x={88} y={28} size={11} italic={false} fill={C.muted}>
          MULLIGAN BANK
        </Loud>
      </Sticker>
      {tokens.map((k, i) => {
        const p = easeIn(seg(t, k.at, k.at + 600));
        if (p <= 0 || p >= 1) return null;
        const x = lerp(k.from.x, 88, p);
        const y = lerp(k.from.y, 112, p) - Math.sin(Math.PI * p) * 26;
        return (
          <g key={i} transform={`translate(${x} ${y})`}>
            <circle r={12} fill={C.gold} stroke={C.ink} strokeWidth={2.5} />
            <Loud x={0} y={5} size={13} italic={false}>
              M
            </Loud>
          </g>
        );
      })}
      {/* The Groom's Mulligan ticket */}
      <g transform={`translate(262 80) rotate(${lerp(-14, 4, easeOut(seg(t, 1900, 2300)))}) scale(${pop(t, 1900, 380)})`}>
        <rect x={-80} y={-50} width={160} height={104} rx={14} fill={C.ink} transform="translate(0 5)" />
        <rect x={-80} y={-50} width={160} height={104} rx={14} fill={C.gold} stroke={C.ink} strokeWidth={3.5} />
        <rect x={-72} y={-42} width={144} height={88} rx={10} fill="none" stroke={C.ink} strokeWidth={2} strokeDasharray="6 4" />
        <path d="M -18 -14 L -18 -34 L -9 -25 L 0 -39 L 9 -25 L 18 -34 L 18 -14 Z" fill={C.paper} stroke={C.ink} strokeWidth={3} strokeLinejoin="round" />
        <Loud x={0} y={6} size={17}>
          {"GROOM'S"}
        </Loud>
        <Loud x={0} y={24} size={17}>
          MULLIGAN
        </Loud>
        <Loud x={0} y={39} size={11} italic={false}>
          {`${groom} · ONE SHOT`}
        </Loud>
      </g>
      {/* Whose drive did you use? (the Play screen's chips) */}
      <Sticker x={10} y={162} w={340} h={132} r={18}>
        <Loud x={24} y={186} size={15} anchor="start" italic={false}>
          WHOSE DRIVE?
        </Loud>
        <Loud x={336} y={186} size={11} anchor="end" italic={false} fill={C.muted}>
          DRIVES USED · FRONT 9
        </Loud>
        {names.map((n, i) => {
          const col = i % 2;
          const row = Math.floor(i / 2);
          const x = 22 + col * 162;
          const y = 198 + row * 46;
          const done = t >= ticks[i];
          const s = done ? 0.8 + 0.2 * pop(t, ticks[i], 260) : 1;
          return (
            <g key={i}>
              <rect x={x} y={y} width={154} height={38} rx={19} fill={done && t < ticks[i] + 300 ? C.fairwaySoft : C.paper} stroke={C.ink} strokeWidth={2.5} />
              <g transform={`translate(${x + 20} ${y + 19}) scale(${s})`}>
                <circle r={13} fill={done ? C.fairway : C.flag} />
                <Loud x={0} y={5} size={13} fill={C.paper} italic={false}>
                  {done ? "1" : "0"}
                </Loud>
              </g>
              <Loud x={x + 40} y={y + 25} size={16} anchor="start" italic={false}>
                {shortName(n, 9)}
              </Loud>
              {done && (
                <Loud x={x + 140} y={y + 25} size={15} anchor="end" fill={C.fairway} italic={false}>
                  ✓
                </Loud>
              )}
            </g>
          );
        })}
      </Sticker>
      <Tap x={22 + (names.length > 0 ? 80 : 0)} y={217} p={seg(t, 3300, 3700)} />
    </g>
  );
}

// ---------------------------------------------------------------- 6. Contests

function Robot({ x, y, s, talk }: { x: number; y: number; s: number; talk: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <line x1={0} y1={-34} x2={0} y2={-48} stroke={C.ink} strokeWidth={3} />
      <circle cx={0} cy={-50} r={5} fill={C.flag} stroke={C.ink} strokeWidth={2.5} />
      <rect x={-30} y={-34} width={60} height={50} rx={12} fill={C.silver} stroke={C.ink} strokeWidth={3.5} />
      <rect x={-22} y={-24} width={44} height={22} rx={6} fill={C.ink} />
      <rect x={-16} y={-18} width={10} height={9} rx={2} fill={C.hazard} />
      <rect x={6} y={-18} width={10} height={9 * (1 - 0.7 * talk)} rx={2} fill={C.hazard} />
      <rect x={-12} y={4} width={24} height={4 + talk * 5} rx={2} fill={C.ink} />
      <rect x={-22} y={18} width={44} height={22} rx={8} fill={C.silver} stroke={C.ink} strokeWidth={3} />
    </g>
  );
}

function Contests({ t, art }: SceneProps) {
  const yards = countUp(t, 700, 1900, 0, 287);
  const lineP = easeOut(seg(t, 300, 1500));
  const flash1 = 1 - seg(t, 2050, 2350);
  const flash2 = 1 - seg(t, 3150, 3450);
  const judge = art.aiJudge;
  return (
    <g>
      {/* Long drive */}
      <Sticker x={10} y={8} w={340} h={140} r={18} fill={C.rough}>
        <path d="M 10 92 L 350 80 L 350 128 L 10 140 Z" fill={C.grass} />
        <rect x={34} y={112} width={14} height={14} rx={3} fill={C.paper} stroke={C.ink} strokeWidth={2.5} />
        <line x1={41} y1={118} x2={lerp(41, 280, lineP)} y2={lerp(118, 108, lineP)} stroke={C.paper} strokeWidth={3.5} strokeDasharray="7 6" />
        <Ball x={282} y={110} r={6} />
        <Dude
          x={296}
          y={112}
          s={0.4}
          shirt={C.hazard}
          cap={C.ink}
          skin={SKIN[2]}
          handR={{ x: -24, y: -150 }}
          handL={{ x: 30, y: -84 }}
          face={{ eyes: "open", mouth: t > 1900 ? "grin" : "flat", look: -1 }}
          items={<rect x={-36} y={-172} width={20} height={34} rx={4} fill={C.ink} />}
        />
        {[0, 1, 2].map((i) => {
          const ph = ((t + i * 400) % 1200) / 1200;
          return t < 1900 ? <circle key={i} cx={286} cy={44} r={6 + ph * 24} fill="none" stroke={C.paper} strokeWidth={2.5} opacity={1 - ph} /> : null;
        })}
        <g transform={`translate(160 72) scale(${pop(t, 600)})`}>
          <rect x={-66} y={-26} width={132} height={52} rx={12} fill={C.ink} transform="translate(0 4)" />
          <rect x={-66} y={-26} width={132} height={52} rx={12} fill={C.hazard} stroke={C.ink} strokeWidth={3} />
          <Loud x={-6} y={14} size={36} italic={false}>
            {yards}
          </Loud>
          <Loud x={48} y={14} size={14} italic={false}>
            YD
          </Loud>
        </g>
        <Loud x={22} y={30} size={14} anchor="start" fill={C.paper} stroke={C.ink}>
          LONG DRIVE · PAR 5
        </Loud>
        {t > 2050 && <rect x={10} y={8} width={340} height={140} rx={18} fill={C.paper} opacity={flash1 * 0.85} />}
      </Sticker>
      {/* Closest to pin */}
      <Sticker x={10} y={156} w={340} h={138} r={18} fill={C.rough}>
        <ellipse cx={128} cy={236} rx={108} ry={46} fill="#5ccf86" stroke={C.ink} strokeWidth={3} />
        <Flag x={118} y={238} h={62} wave={wave(t, 800)} />
        <Ball x={164} y={256} r={6} />
        <g opacity={fadeIn(t, 3350)}>
          <line x1={120} y1={240} x2={160} y2={254} stroke={C.ink} strokeWidth={2.5} strokeDasharray="4 4" />
          <g transform={`translate(178 230) scale(${pop(t, 3350)})`}>
            <rect x={-34} y={-13} width={68} height={26} rx={8} fill={C.paper} stroke={C.ink} strokeWidth={2.5} />
            <Loud x={0} y={6} size={15} italic={false}>
              {`6' 4"`}
            </Loud>
          </g>
        </g>
        {/* camera frame */}
        <g opacity={fadeIn(t, 2700) * (1 - seg(t, 3300, 3500))} stroke={C.paper} strokeWidth={4} fill="none" strokeLinecap="round">
          <path d="M 70 172 L 70 162 L 82 162 M 198 162 L 210 162 L 210 172 M 210 266 L 210 276 L 198 276 M 82 276 L 70 276 L 70 266" />
        </g>
        <Loud x={22} y={180} size={14} anchor="start" fill={C.paper} stroke={C.ink}>
          CLOSEST TO PIN · PAR 3
        </Loud>
        {judge ? (
          <g>
            <Robot x={290} y={246} s={pop(t, 3800) * 0.95} talk={t > 4100 ? Math.abs(wave(t, 260)) : 0} />
            <g transform={`translate(272 196) scale(${pop(t, 4150)})`}>
              <rect x={-64} y={-20} width={128} height={40} rx={12} fill={C.paper} stroke={C.ink} strokeWidth={2.5} />
              <path d="M 6 20 L 18 32 L 20 20 Z" fill={C.paper} stroke={C.ink} strokeWidth={2.5} strokeLinejoin="round" />
              <rect x={-1} y={17} width={26} height={5} fill={C.paper} />
              <Loud x={0} y={-3} size={11} italic={false}>
                AI JUDGE: THAT&apos;S
              </Loud>
              <Loud x={0} y={12} size={11} italic={false}>
                9 FEET, LIAR 🤨
              </Loud>
            </g>
          </g>
        ) : (
          <g transform={`translate(286 236) rotate(6) scale(${pop(t, 3800)})`}>
            <rect x={-62} y={-18} width={124} height={36} rx={10} fill={C.hazard} stroke={C.ink} strokeWidth={3} />
            <Loud x={-2} y={6} size={14}>
              HONOR SYSTEM
            </Loud>
          </g>
        )}
        {t > 3150 && <rect x={10} y={156} width={340} height={138} rx={18} fill={C.paper} opacity={flash2 * 0.85} />}
      </Sticker>
    </g>
  );
}

// ---------------------------------------------------------------- 7. Board, feed, money

function Board({ t, art }: SceneProps) {
  const teams = (art.teamNames.length >= 2 ? art.teamNames : ["Sand Baggers", "Ghost Riders", "Shank Redemption"]).slice(0, 3);
  // Team 2 logs a ghost beer and jumps to the top.
  const swap = easeInOut(seg(t, 1000, 1500));
  const nets = teams.map((_, i) => (i === 0 ? -3 : i === 1 ? (t >= 1000 ? -5 : -2) : 0));
  const slot = (i: number) => (i === 1 ? lerp(1, 0, swap) : i === 0 ? lerp(0, 1, swap) : i);
  const fmt = (n: number) => (n === 0 ? "E" : n > 0 ? `+${n}` : String(n));
  const feedIn = easeOut(seg(t, 1900, 2300));
  return (
    <g>
      <Sticker x={10} y={8} w={340} h={120} r={18}>
        <Loud x={24} y={30} size={13} anchor="start" italic={false} fill={C.muted}>
          BOARD · NET TO PAR
        </Loud>
        {teams.map((name, i) => {
          const y = 40 + slot(i) * 28;
          const pos = Math.round(slot(i)) + 1;
          const c = TEAM_PALETTE[i % TEAM_PALETTE.length];
          return (
            <g key={i} transform={`translate(0 ${y})`}>
              <Loud x={34} y={20} size={16} italic={false}>
                {String(pos)}
              </Loud>
              <rect x={52} y={3} width={190} height={24} rx={12} fill={c.bg} stroke={C.ink} strokeWidth={2} />
              <Loud x={147} y={20} size={13} fill={c.fg} italic={false}>
                {shortName(name, 18)}
              </Loud>
              <Loud x={322} y={21} size={19} anchor="end" italic={false} fill={nets[i] < 0 ? C.fairway : C.ink}>
                {fmt(nets[i])}
              </Loud>
              {i === 1 && t > 1000 && t < 2600 && (
                <Loud x={262} y={20} size={15} fill={C.fairway} italic={false}>
                  ▲
                </Loud>
              )}
            </g>
          );
        })}
      </Sticker>
      <g transform={`translate(${lerp(360, 0, feedIn)} 0)`} opacity={feedIn}>
        <Sticker x={10} y={138} w={340} h={74} r={18}>
          <circle cx={36} cy={164} r={15} fill={C.ghost} stroke={C.ink} strokeWidth={2.5} />
          <text x={36} y={170} fontSize={16} textAnchor="middle">
            👻
          </text>
          <Loud x={60} y={162} size={14} anchor="start" italic={false}>
            {`GHOST BEER! ${shortName(teams[1].toUpperCase(), 14)}`}
          </Loud>
          <Loud x={60} y={180} size={12} anchor="start" italic={false} fill={C.muted}>
            jumped to 1st on a phantom pint.
          </Loud>
          <rect x={60} y={188} width={50} height={18} rx={9} fill={C.sand} stroke={C.ink} strokeWidth={1.5} />
          <text x={70} y={201} fontSize={11}>
            😂
          </text>
          <Loud x={96} y={201} size={11} italic={false}>
            {String(countUp(t, 2400, 3200, 0, 6))}
          </Loud>
          <rect x={116} y={188} width={50} height={18} rx={9} fill={C.sand} stroke={C.ink} strokeWidth={1.5} />
          <text x={126} y={201} fontSize={11}>
            🍺
          </text>
          <Loud x={152} y={201} size={11} italic={false}>
            {String(countUp(t, 2500, 3300, 0, 4))}
          </Loud>
        </Sticker>
      </g>
      <g opacity={fadeIn(t, 3000)} transform={`translate(0 ${lerp(20, 0, easeOut(seg(t, 3000, 3400)))})`}>
        <Sticker x={10} y={222} w={340} h={72} r={18}>
          <Loud x={24} y={244} size={12} anchor="start" italic={false} fill={C.muted}>
            SETTLE UP
          </Loud>
          <Loud x={24} y={274} size={17} anchor="start" italic={false}>
            {`${shortName(art.payer, 9)} → ${shortName(art.payee, 9)}`}
          </Loud>
          <Loud x={218} y={274} size={20} anchor="end" italic={false} fill={C.fairwayDark}>
            {art.amount}
          </Loud>
          <rect x={232} y={250} width={104} height={34} rx={11} fill={C.sky} stroke={C.ink} strokeWidth={2.5} />
          <Loud x={284} y={273} size={14} fill={C.paper} italic={false}>
            Venmo it
          </Loud>
        </Sticker>
        <Tap x={284} y={267} p={seg(t, 3900, 4400)} />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------- 8. Outro: tee it up

function Outro({ t, art }: SceneProps) {
  const X = 110;
  const Y = 290;
  const S = 0.95;
  const C0 = { x: 0, y: -124 };
  // Swing: angle of arms + club around the shoulders (90 = straight down at address).
  const a = trackNum(t, [
    { at: 0, v: 90 },
    { at: 150, v: 90 },
    { at: 650, v: 232 },
    { at: 800, v: 232 },
  ]);
  // After contact the arms stop at shoulder height and the club wraps over the shoulder (the finish).
  const down = t < 800 ? a : t < 1000 ? lerp(232, 90, easeIn(seg(t, 800, 1000))) : lerp(90, -12, easeOut(seg(t, 1000, 1350)));
  const clubDeg = t < 1000 ? down : lerp(90, -128, easeOut(seg(t, 1000, 1450)));
  const ang = (down * Math.PI) / 180;
  const cang = (clubDeg * Math.PI) / 180;
  const hands = { x: C0.x + Math.cos(ang) * 50, y: C0.y + Math.sin(ang) * 50 };
  const head = { x: hands.x + Math.cos(cang) * 74, y: hands.y + Math.sin(cang) * 74 };
  const hit = t >= 1000;
  const flight = easeOut(seg(t, 1000, 2300));
  const ballStart = { x: X + 6 * S, y: Y - 4 };
  const ballEnd = { x: 312, y: 214 };
  const ball = hit
    ? { x: lerp(ballStart.x, ballEnd.x, flight), y: lerp(ballStart.y, ballEnd.y, flight) - Math.sin(Math.PI * flight) * 190 }
    : ballStart;
  const confetti: ReactNode[] = [];
  if (t > 2200) {
    for (let i = 0; i < 36; i++) {
      const delay = rand(i * 3 + 11) * 600;
      const tau = (t - 2200 - delay) / 1000;
      if (tau < 0) continue;
      const x0 = rand(i * 3 + 12) * 360;
      const y = -10 + tau * (120 + rand(i * 3 + 13) * 80);
      if (y > 310) continue;
      const x = x0 + Math.sin(tau * 4 + i) * 12;
      const colors = [C.hazard, C.paper, C.flag, C.sky, C.gold];
      confetti.push(<rect key={i} x={x} y={y} width={7} height={11} rx={1.5} fill={colors[i % colors.length]} stroke={C.ink} strokeWidth={1} transform={`rotate(${(tau * 300 + i * 40) % 360} ${x + 3.5} ${y + 5.5})`} />);
    }
  }
  const trail: ReactNode[] = [];
  if (hit && flight < 1) {
    for (let k = 1; k <= 5; k++) {
      const p = Math.max(0, flight - k * 0.035);
      trail.push(
        <circle key={k} cx={lerp(ballStart.x, ballEnd.x, p)} cy={lerp(ballStart.y, ballEnd.y, p) - Math.sin(Math.PI * p) * 190} r={4 - k * 0.5} fill={C.paper} opacity={0.6 - k * 0.1} />,
      );
    }
  }
  return (
    <g>
      <Rays x={312} y={200} t={t} opacity={0.14} />
      <ellipse cx={180} cy={296} rx={190} ry={22} fill={C.fairwayDark} stroke={C.ink} strokeWidth={3} />
      <ellipse cx={312} cy={216} rx={40} ry={12} fill="#5ccf86" stroke={C.ink} strokeWidth={3} />
      <Flag x={312} y={216} h={64} wave={wave(t, 700)} />
      <Dude
        x={X}
        y={Y}
        s={S}
        shirt={C.fairway}
        cap={C.paper}
        crown={false}
        handR={hands}
        handL={{ x: hands.x + 4, y: hands.y + 2 }}
        face={t < 1000 ? { eyes: "open", mouth: "flat", look: 0.2 } : { eyes: "up", mouth: "grin", look: 1 }}
        items={
          <g>
            <line x1={hands.x} y1={hands.y} x2={head.x} y2={head.y} stroke={C.ink} strokeWidth={4.5} strokeLinecap="round" />
            <rect x={head.x - 9} y={head.y - 5} width={18} height={10} rx={4} fill={C.ink} transform={`rotate(${clubDeg - 90} ${head.x} ${head.y})`} />
          </g>
        }
      />
      {trail}
      <Ball x={ball.x} y={ball.y} r={6.5} />
      <Burst x={X + 70} y={232} r={40} text="WHACK!" scale={pop(t, 1000, 220) * (1 - seg(t, 1700, 1850))} rotate={-6} size={15} />
      {confetti}
      <g transform={`translate(246 52) rotate(-6) scale(${pop(t, 2300, 380)})`}>
        <rect x={-74} y={-30} width={148} height={60} rx={14} fill={C.ink} transform="translate(0 5)" />
        <rect x={-74} y={-30} width={148} height={60} rx={14} fill={C.hazard} stroke={C.ink} strokeWidth={3.5} />
        <Loud x={0} y={13} size={36}>
          FORE!
        </Loud>
      </g>
      {t > 2400 && (
        <Loud x={246} y={112} size={16} fill={C.paper} stroke={C.ink} opacity={fadeIn(t, 2600)}>
          {`${shortName(art.hello.toUpperCase(), 10)}, YOU'RE UP`}
        </Loud>
      )}
    </g>
  );
}

const SCENES: Record<SceneId, (p: SceneProps) => ReactNode> = {
  "cold-open": ColdOpen,
  scramble: Scramble,
  drinks: Drinks,
  ghost: GhostBeers,
  mulligans: Mulligans,
  contests: Contests,
  board: Board,
  outro: Outro,
};

/** The cartoon for one scene at time `t`. */
export function SceneArt({ id, t, art }: { id: SceneId; t: number; art: ExplainerArt }) {
  const Scene = SCENES[id];
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="block h-full max-h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
      data-testid="explainer-art"
    >
      <Scene t={Math.max(0, t)} art={art} />
    </svg>
  );
}

