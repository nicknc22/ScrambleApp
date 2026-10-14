#!/usr/bin/env node
// Records the "How it works" explainer to an iPhone-friendly MP4 (for the group chat).
//
//   node scripts/record-explainer.mjs <base-url> <trip-code> [--out explainer.mp4] [--as Joe]
//        [--no-audio] [--keep-controls] [--fps 30] [--tail 3000]
//
// Deterministic, frame by frame: opens <base-url>/t/<code>?explainer=1&paused=1&rec=1 at 390x844
// (2x) in headless Chromium, then for every video frame seeks the explainer's own clock
// (window.__xpRec.seek, rec mode only) and screenshots it, piping the PNGs straight into the system
// ffmpeg (H.264 High, yuv420p, +faststart, 30 fps). The cut can't drift from the page (the old
// real-time capture lagged ~5 s and stopped mid-board), the outro and its last frame are always
// in, and the synthesized sound bed (lavfi aevalsrc: can pssht/crack, glugs, crunch, whooshes, a
// soft beat) is placed on the same timeline, so every effect lands on its frame. Rec mode also
// drops the phone-only "Tap right / Hold: pause" line. Nothing is written to the trip.
//   --as <name>       greet a player by name ("Joe, welcome to ..."); default: nobody picked ("Boys").
//   --keep-controls   keep the Skip / pause buttons in the shot (hidden by default).
//   --tail <ms>       hold the outro's last frame this long (default 3000).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const FFMPEG = existsSync("/usr/bin/ffmpeg") ? "/usr/bin/ffmpeg" : "ffmpeg";
const VIEWPORT = { width: 390, height: 844 };
const SCALE = 2;
const USAGE =
  "usage: node scripts/record-explainer.mjs <base-url> <trip-code> [--out explainer.mp4] [--as <player name>] [--no-audio] [--keep-controls] [--fps 30] [--tail 3000]";

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (["out", "as", "fps", "tail"].includes(a.slice(2)) && i + 1 < argv.length) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { pos, flags };
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------- sound (lavfi aevalsrc)

// Where things happen inside each scene, in seconds from the scene's start (mirrors the cartoon
// timings in src/components/explainer/scenes.tsx). Scene starts and lengths come from the page.
export const SCENE_SFX = {
  "cold-open": [
    ["pssht", 0.62],
    ["crack", 2.24],
    ["glug", 2.55],
    ["glug", 3.0],
    ["glug", 3.45],
    ["crunch", 4.25],
    ["pop", 5.3],
  ],
  scramble: [
    ["whoosh", 0.15],
    ["whoosh", 0.41],
    ["whoosh", 0.67],
    ["whoosh", 0.93],
    ["pop", 1.7],
    ["blip", 3.38],
    ["pop", 3.5],
    ["blip", 4.28],
  ],
  drinks: [
    ["blip", 1.52],
    ["whoosh", 1.65],
    ["pop", 2.7],
    ["pop", 3.2],
  ],
  ghost: [
    ["pop", 0.3],
    ["pop", 0.82],
    ["ghost", 1.34],
    ["pop", 1.86],
    ["pop", 2.38],
    ["ghost", 2.9],
  ],
  mulligans: [
    ["coin", 0.95],
    ["coin", 1.65],
    ["whoosh", 1.9],
    ["blip", 3.3],
    ["blip", 3.68],
    ["blip", 4.06],
    ["blip", 4.44],
  ],
  contests: [
    ["shutter", 2.05],
    ["shutter", 3.15],
    ["robot", 3.8],
    ["robot", 4.15],
  ],
  board: [
    ["whoosh", 1.0],
    ["pop", 1.9],
    ["blip", 3.9],
  ],
  outro: [
    ["whoosh", 0.2],
    ["whoosh", 0.8],
    ["whack", 1.0],
    ["cheer", 2.2],
    ["pop", 2.3],
  ],
};

const f = (n) => n.toFixed(3);
/** Envelope: on for [T, T+dur], exponential decay at rate k (max() keeps exp finite before T: 0 * inf = NaN). */
const env = (T, dur, k) => `between(t,${f(T)},${f(T + dur)})*exp(-max(t-${f(T)},0)*${k})`;

/** Builds the two aevalsrc expressions (noise-based and tonal) for a list of [kind, seconds]. */
function sfxExpressions(events, durationS) {
  const noise = [];
  const tone = [];
  for (const [kind, T] of events) {
    if (T < 0 || T > durationS) continue;
    const u = `(t-${f(T)})`;
    switch (kind) {
      case "pssht":
        noise.push(`${env(T, 0.7, 4.5)}*0.55`);
        break;
      case "crack":
        noise.push(`${env(T, 0.06, 70)}*1.0`);
        tone.push(`${env(T, 0.05, 60)}*sin(2*PI*1900*${u})*0.25`);
        break;
      case "glug":
        tone.push(`${env(T, 0.2, 12)}*sin(2*PI*(240*${u}-500*${u}^2))*0.6`);
        break;
      case "crunch":
        noise.push(`${env(T, 0.35, 9)}*0.8`);
        tone.push(`${env(T, 0.2, 18)}*sin(2*PI*90*${u})*0.5`);
        break;
      case "whoosh":
        noise.push(`between(t,${f(T)},${f(T + 0.32)})*sin(PI*${u}/0.32)^2*0.22`);
        break;
      case "pop":
        tone.push(`${env(T, 0.09, 40)}*sin(2*PI*(520*${u}+2600*${u}^2))*0.35`);
        break;
      case "blip":
        tone.push(`${env(T, 0.06, 55)}*sin(2*PI*1050*${u})*0.25`);
        break;
      case "coin":
        tone.push(`${env(T, 0.35, 9)}*(sin(2*PI*1320*${u})+0.5*sin(2*PI*1980*${u}))*0.16`);
        break;
      case "ghost":
        tone.push(`between(t,${f(T)},${f(T + 0.6)})*sin(PI*${u}/0.6)*sin(2*PI*(520*${u}+260*${u}^2+3*sin(2*PI*7*${u})))*0.22`);
        break;
      case "shutter":
        noise.push(`${env(T, 0.03, 120)}*0.9`);
        noise.push(`${env(T + 0.07, 0.04, 90)}*0.7`);
        break;
      case "robot":
        tone.push(`between(t,${f(T)},${f(T + 0.08)})*sgn(sin(2*PI*660*${u}))*0.08`);
        tone.push(`between(t,${f(T + 0.1)},${f(T + 0.18)})*sgn(sin(2*PI*880*${u}))*0.08`);
        break;
      case "whack":
        noise.push(`${env(T, 0.12, 35)}*1.0`);
        tone.push(`${env(T, 0.15, 25)}*sin(2*PI*180*${u})*0.6`);
        break;
      case "cheer":
        noise.push(`between(t,${f(T)},${f(T + 1.6)})*sin(PI*${u}/1.6)*0.12`);
        break;
      default:
        break;
    }
  }
  // A soft beat under everything (~100 bpm): kick on the beat, a hat on the off-beat. Quiet.
  const beat = 0.6;
  tone.push(`exp(-mod(t,${beat})*16)*sin(2*PI*52*mod(t,${beat}))*0.22`);
  noise.push(`exp(-mod(t+${beat / 2},${beat})*70)*0.05`);
  return {
    noise: `(${noise.join("+") || "0"})*(2*random(0)-1)`,
    tone: tone.join("+") || "0",
  };
}

// ---------------------------------------------------------------- main

/** Which scene and how far into it, for a time on the video's timeline (ms). Past the end: the last frame. */
export function frameAt(scenes, ms) {
  let start = 0;
  for (let i = 0; i < scenes.length; i++) {
    const d = scenes[i].durationMs;
    if (ms < start + d || i === scenes.length - 1) return { index: i, at: Math.min(d, Math.max(0, ms - start)) };
    start += d;
  }
  return { index: 0, at: 0 };
}

/** Sound effects on the video's timeline (seconds): a whoosh into every scene, then its own. */
export function sfxEvents(scenes) {
  const events = [];
  let start = 0;
  for (const s of scenes) {
    const at = start / 1000;
    if (start > 0) events.push(["whoosh", Math.max(0, at - 0.12)]);
    for (const [kind, t] of SCENE_SFX[s.id] ?? []) if (t * 1000 <= s.durationMs) events.push([kind, at + t]);
    start += s.durationMs;
  }
  return events;
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (pos.length < 2 || flags.help) die(USAGE);
  const base = pos[0].replace(/\/+$/, "");
  const code = pos[1].trim().toLowerCase();
  const out = resolve(typeof flags.out === "string" ? flags.out : "explainer.mp4");
  const audio = !flags["no-audio"];
  const fps = Math.max(10, Math.min(60, Number(flags.fps) || 30));
  const tailMs = Math.max(0, Number(flags.tail ?? 3000) || 0);

  // --as <name>: be that player (read-only: the id goes into this throwaway browser's storage).
  let meId = null;
  if (typeof flags.as === "string") {
    const res = await fetch(`${base}/api/t/${encodeURIComponent(code)}/state`);
    if (!res.ok) die(`Couldn't load trip ${code}: HTTP ${res.status}`);
    const { state } = await res.json();
    const want = flags.as.trim().toLowerCase();
    const p = state.players.find((x) => !x.deleted_at && (x.name.trim().toLowerCase() === want || (x.nickname ?? "").trim().toLowerCase() === want));
    if (!p) die(`No player called "${flags.as}" on trip ${code}.`);
    meId = p.id;
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "no-preference",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  await context.addInitScript(
    ({ code, meId, keepControls }) => {
      try {
        if (meId) localStorage.setItem(`scramble:me:${code}`, meId);
      } catch {
        /* ignore */
      }
      document.addEventListener("DOMContentLoaded", () => {
        const css = document.createElement("style");
        // The Next.js dev badge (next dev only) and, unless asked, the Skip / pause buttons stay out of the shot.
        css.textContent = `nextjs-portal{display:none!important}${keepControls ? "" : '[data-testid="explainer-skip"],[data-testid="explainer-pause"]{visibility:hidden!important}'}`;
        document.head.appendChild(css);
      });
    },
    { code, meId, keepControls: !!flags["keep-controls"] },
  );

  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[page error]", e.message));
  console.log(`Recording ${base}/t/${code}?explainer=1&rec=1 frame by frame at ${fps} fps ...`);
  await page.goto(`${base}/t/${encodeURIComponent(code)}?explainer=1&paused=1&rec=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="explainer"][data-rec="true"] [data-testid="explainer-art"]', { state: "attached", timeout: 90_000 });
  await page.waitForFunction(() => !!window.__xpRec, null, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const scenes = await page.evaluate(() => window.__xpRec.scenes);
  if (!Array.isArray(scenes) || scenes.length === 0) die("The explainer didn't expose its scenes (is this build older than rec mode?).");
  const playMs = scenes.reduce((s, x) => s + x.durationMs, 0);
  const totalMs = playMs + tailMs;
  const frames = Math.ceil((totalMs / 1000) * fps);
  const duration = frames / fps;
  console.log(`${scenes.length} scenes, ${(playMs / 1000).toFixed(1)} s + ${(tailMs / 1000).toFixed(1)} s on the last frame = ${frames} frames.`);

  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-"];
  if (audio) {
    const { noise, tone } = sfxExpressions(sfxEvents(scenes), duration);
    const d = duration.toFixed(3);
    args.push(
      "-f", "lavfi", "-i", `aevalsrc=exprs='${noise}':s=44100:d=${d}`,
      "-f", "lavfi", "-i", `aevalsrc=exprs='${tone}':s=44100:d=${d}`,
      "-filter_complex",
      [
        "[1:a]highpass=f=350,lowpass=f=7500[n]",
        "[2:a]lowpass=f=4000[s]",
        `[n][s]amix=inputs=2:normalize=0,volume=0.9,afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, duration - 0.8).toFixed(2)}:d=0.8,alimiter=limit=0.5:level=false,aformat=channel_layouts=stereo[a]`,
      ].join(";"),
      "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-b:a", "128k",
    );
  } else {
    args.push("-map", "0:v", "-an");
  }
  args.push(
    "-t", duration.toFixed(3),
    "-vf", "format=yuv420p",
    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-movflags", "+faststart",
    out,
  );
  const ff = spawn(FFMPEG, args, { stdio: ["pipe", "inherit", "inherit"] });
  const ffDone = new Promise((res) => ff.on("close", (code) => res(code)));
  const write = (buf) => new Promise((res, rej) => ff.stdin.write(buf, (e) => (e ? rej(e) : res())));

  const started = Date.now();
  let last = "";
  for (let k = 0; k < frames; k++) {
    const { index, at } = frameAt(scenes, (k * 1000) / fps);
    // Seek, then wait until the page has painted exactly that moment.
    const shown = await page.evaluate(
      async ([i, ms]) => {
        window.__xpRec.seek(i, ms);
        const el = () => document.querySelector('[data-testid="explainer"]');
        for (let n = 0; n < 10; n++) {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const e = el();
          if (e && Number(e.getAttribute("data-index")) === i && Number(e.getAttribute("data-t")) === Math.round(ms)) return `${i}:${Math.round(ms)}`;
        }
        return null;
      },
      [index, at],
    );
    if (shown === null) die(`Frame ${k}: the explainer never showed scene ${index + 1} at ${Math.round(at)} ms.`);
    const png = await page.screenshot({ type: "png", scale: "device" });
    await write(png);
    if (shown.split(":")[0] !== last) {
      last = shown.split(":")[0];
      console.log(`  scene ${index + 1}/${scenes.length} (${scenes[index].id}) from frame ${k}`);
    }
  }
  ff.stdin.end();
  await context.close();
  await browser.close();
  const status = await ffDone;
  if (status !== 0) die(`ffmpeg failed (exit ${status}).`);
  console.log(`Wrote ${out} (${duration.toFixed(2)} s, ${frames} frames, ${((Date.now() - started) / 1000).toFixed(0)} s to render).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => die(e?.stack ?? String(e)));
