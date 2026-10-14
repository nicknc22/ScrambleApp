// The explainer's player logic, pure: Instagram-story timing and navigation (auto-advance, tap
// left/right, hold to pause), when it plays by itself, and the ?explainer= URL params used to open
// it directly (recording, screenshots). The component (Explainer.tsx) only wires events to these.

export interface PlayerConfig {
  /** Length of each scene, ms. */
  durations: number[];
  /** false under prefers-reduced-motion: scenes stay put until tapped. */
  autoAdvance: boolean;
}

export interface PlayerState {
  /** Current scene (0-based). */
  index: number;
  /** Time into the current scene, ms (drives the cartoon and the progress bar). */
  elapsed: number;
  /** Finger down on the stage (press-and-hold pauses). */
  held: boolean;
  /** Paused with the pause button. */
  paused: boolean;
  /** Tapped past the last scene: the component closes. */
  finished: boolean;
}

export type PlayerAction =
  | { type: "tick"; dt: number }
  | { type: "next" }
  | { type: "back" }
  | { type: "goto"; index: number; at?: number }
  | { type: "hold" }
  | { type: "release" }
  | { type: "toggle_pause" };

/** One animation frame never moves the clock more than this (a backgrounded tab coming back). */
export const MAX_TICK_MS = 250;
/** A press shorter than this is a tap (navigate); longer is a hold (pause, no navigation). */
export const HOLD_MS = 240;

const clampIndex = (i: number, cfg: PlayerConfig) => Math.max(0, Math.min(cfg.durations.length - 1, Math.trunc(i)));
const durationOf = (i: number, cfg: PlayerConfig) => Math.max(1, cfg.durations[i] ?? 1);

export function initPlayer(cfg: PlayerConfig, start: { index?: number | null; at?: number | null; paused?: boolean } = {}): PlayerState {
  const index = clampIndex(start.index ?? 0, cfg);
  const at = Math.max(0, Math.min(durationOf(index, cfg), start.at ?? 0));
  return { index, elapsed: Number.isFinite(at) ? at : 0, held: false, paused: !!start.paused, finished: false };
}

/** The clock runs: auto-advance on, no finger down, not paused, not done. */
export function isRunning(s: PlayerState, cfg: PlayerConfig): boolean {
  return cfg.autoAdvance && !s.held && !s.paused && !s.finished && cfg.durations.length > 0;
}

export function isLast(s: PlayerState, cfg: PlayerConfig): boolean {
  return s.index >= cfg.durations.length - 1;
}

export function stepPlayer(s: PlayerState, a: PlayerAction, cfg: PlayerConfig): PlayerState {
  if (cfg.durations.length === 0) return s;
  switch (a.type) {
    case "tick": {
      if (!isRunning(s, cfg) || !(a.dt > 0)) return s;
      const dur = durationOf(s.index, cfg);
      if (s.elapsed >= dur) return s; // the last scene holds its final frame
      const elapsed = s.elapsed + Math.min(a.dt, MAX_TICK_MS);
      if (elapsed < dur) return { ...s, elapsed };
      if (isLast(s, cfg)) return { ...s, elapsed: dur };
      return { ...s, index: s.index + 1, elapsed: 0 };
    }
    case "next":
      if (isLast(s, cfg)) return { ...s, finished: true, held: false };
      return { ...s, index: s.index + 1, elapsed: 0, held: false };
    case "back":
      // Like a story: back on the first scene restarts it.
      return { ...s, index: Math.max(0, s.index - 1), elapsed: 0, held: false };
    case "goto": {
      const index = clampIndex(a.index, cfg);
      return { ...s, index, elapsed: Math.max(0, Math.min(durationOf(index, cfg), a.at ?? 0)), held: false, finished: false };
    }
    case "hold":
      return s.held ? s : { ...s, held: true };
    case "release":
      return s.held ? { ...s, held: false } : s;
    case "toggle_pause":
      return { ...s, paused: !s.paused };
    default:
      return s;
  }
}

/** Fill of progress segment `i`, 0..1. Without auto-advance the current segment shows full. */
export function segmentFill(s: PlayerState, cfg: PlayerConfig, i: number): number {
  if (i < s.index) return 1;
  if (i > s.index) return 0;
  if (!cfg.autoAdvance) return 1;
  return Math.max(0, Math.min(1, s.elapsed / durationOf(i, cfg)));
}

/** The cartoon's clock for the current scene: the live time, or the hero frame when motion is reduced. */
export function sceneTime(s: PlayerState, cfg: PlayerConfig, heroMs: number): number {
  return cfg.autoAdvance ? s.elapsed : heroMs;
}

/** Left half of the stage goes back, right half goes forward. */
export function tapZone(x: number, width: number): "back" | "next" {
  return width > 0 && x < width / 2 ? "back" : "next";
}

// ---------- When it plays by itself ----------

/**
 * Plays by itself once per device per trip, right after somebody taps his name on "Who are you?"
 * (never for a Home Screen app adopting its player, never for the commissioner's create flow),
 * and not once the round is final (nothing left to explain).
 */
export function shouldAutoPlay(opts: { seen: boolean; status: "setup" | "live" | "final" }): boolean {
  return !opts.seen && opts.status !== "final";
}

// ---------- ?explainer=1 (open directly: recording, screenshots) ----------

export interface ExplainerParams {
  open: boolean;
  /** 0-based start scene (?scene= is 1-based). */
  scene: number | null;
  /** Start this many ms into the scene (?at=). */
  at: number | null;
  /** Start paused (?paused=1): a still frame for screenshots. */
  paused: boolean;
  /** Recording the group-chat MP4 (?rec=1): no phone-only controls line, frame-steppable. */
  rec: boolean;
}

export const EXPLAINER_PARAMS = ["explainer", "scene", "at", "paused", "rec"] as const;

const ON = new Set(["1", "true", "yes", "on"]);

export function parseExplainerParams(search: string): ExplainerParams {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search);
  } catch {
    return { open: false, scene: null, at: null, paused: false, rec: false };
  }
  const open = ON.has((q.get("explainer") ?? "").trim().toLowerCase());
  const int = (k: string) => {
    const raw = q.get(k);
    if (raw === null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  const scene = int("scene");
  return {
    open,
    scene: open && scene !== null && scene >= 1 ? scene - 1 : null,
    at: open ? int("at") : null,
    paused: open && ON.has((q.get("paused") ?? "").trim().toLowerCase()),
    rec: open && ON.has((q.get("rec") ?? "").trim().toLowerCase()),
  };
}

/** `path?search#hash` without the explainer params, or null when there were none (no URL write needed). */
export function withoutExplainerParams(href: string): string | null {
  const [beforeHash, ...hashParts] = href.split("#");
  const hash = hashParts.length > 0 ? `#${hashParts.join("#")}` : "";
  const qi = beforeHash.indexOf("?");
  if (qi < 0) return null;
  const path = beforeHash.slice(0, qi);
  const q = new URLSearchParams(beforeHash.slice(qi + 1));
  if (!q.has("explainer")) return null;
  for (const k of EXPLAINER_PARAMS) q.delete(k);
  const rest = q.toString();
  return `${path}${rest ? `?${rest}` : ""}${hash}`;
}
