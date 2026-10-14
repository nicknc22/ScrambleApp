"use client";
// "How it works": a ~40 s story-style explainer (segmented progress bars, auto-advance, tap right
// = next, tap left = back, press and hold = pause, Skip, "Let's go"). Loaded lazily by
// LazyExplainer, so none of this is in the trip page's first load. The cartoons are pure functions
// of the scene clock (scenes.tsx); the timing/navigation rules live in model.ts.
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { buttonClasses, cx } from "@/components/ui";
import {
  HOLD_MS,
  initPlayer,
  isLast,
  isRunning,
  sceneTime,
  segmentFill,
  stepPlayer,
  type PlayerAction,
  type PlayerConfig,
  type PlayerState,
} from "./model";
import { SceneArt } from "./scenes";
import { buildExplainer, type ExplainerInput, type SceneTone } from "./script";

export interface ExplainerProps {
  input: ExplainerInput;
  onClose: (how: "skip" | "done") => void;
  /** Start here (?explainer=1&scene=&at=&paused=). */
  start?: { index?: number | null; at?: number | null; paused?: boolean };
  /** It's actually on screen (the "seen" pref is set here, not when it was asked for). */
  onShown?: () => void;
  /**
   * The group-chat MP4 (?explainer=1&rec=1): no phone-only "tap / hold" line, captions fade on the
   * scene clock (not CSS time), and window.__xpRec lets scripts/record-explainer.mjs step it frame
   * by frame.
   */
  recording?: boolean;
}

/** What the recorder drives (rec mode only). */
export interface ExplainerRecorderHook {
  scenes: { id: string; durationMs: number }[];
  seek: (index: number, at: number) => void;
}

/** The caption's entrance on the scene clock (rec mode): same 260 ms rise and fade as the CSS. */
export function captionEntrance(t: number): { opacity: number; translateY: number } {
  const p = Math.max(0, Math.min(1, t / 260));
  const eased = 1 - (1 - p) ** 3;
  return { opacity: eased, translateY: Math.round((1 - eased) * 10 * 10) / 10 };
}

const TONE: Record<SceneTone, { bg: string; fg: string; bar: string; kicker: string }> = {
  fairway: { bg: "radial-gradient(circle at 80% 0%, #15a356 0%, #0a7d3e 45%, #064d27 100%)", fg: "#ffffff", bar: "255 255 255", kicker: "#ffd60a" },
  sky: { bg: "radial-gradient(circle at 80% 0%, #2f95d6 0%, #0369a1 45%, #053a5c 100%)", fg: "#ffffff", bar: "255 255 255", kicker: "#ffd60a" },
  beer: { bg: "radial-gradient(circle at 80% 0%, #ffd77a 0%, #fbbf24 40%, #f59e0b 100%)", fg: "#0b0f0c", bar: "11 15 12", kicker: "#7a2e05" },
  ghost: { bg: "radial-gradient(circle at 50% 20%, #a77bf7 0%, #7c3aed 40%, #2e0a6e 100%)", fg: "#ffffff", bar: "255 255 255", kicker: "#ffd60a" },
  groom: { bg: "radial-gradient(circle at 50% 20%, #5a4300 0%, #1c1500 50%, #000000 100%)", fg: "#ffffff", bar: "245 197 24", kicker: "#f5c518" },
  ink: { bg: "radial-gradient(circle at 80% 0%, #2b332e 0%, #0b0f0c 60%)", fg: "#ffffff", bar: "255 255 255", kicker: "#ffd60a" },
};

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(cb: () => void) {
  try {
    const m = window.matchMedia(REDUCE_QUERY);
    m.addEventListener("change", cb);
    return () => m.removeEventListener("change", cb);
  } catch {
    return () => {};
  }
}
function getReduced(): boolean {
  try {
    return window.matchMedia(REDUCE_QUERY).matches;
  } catch {
    return false;
  }
}

/** prefers-reduced-motion: no motion, no auto-advance. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, getReduced, () => false);
}

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function Explainer({ input, onClose, start, onShown, recording = false }: ExplainerProps) {
  const reduced = useReducedMotion();
  const script = useMemo(() => buildExplainer(input, { reducedMotion: reduced, recording }), [input, reduced, recording]);
  const cfg: PlayerConfig = useMemo(() => ({ durations: script.scenes.map((s) => s.durationMs), autoAdvance: !reduced }), [script, reduced]);
  const cfgRef = useRef(cfg);
  useEffect(() => {
    cfgRef.current = cfg;
  });
  const [state, send] = useReducer(
    (s: PlayerState, m: { a: PlayerAction; cfg: PlayerConfig }) => stepPlayer(s, m.a, m.cfg),
    cfg,
    (c) => initPlayer(c, start ?? {}),
  );
  /** Events carry the current config (reduced motion can flip while it plays). */
  const dispatch = useCallback((a: PlayerAction) => send({ a, cfg: cfgRef.current }), []);
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const scene = script.scenes[state.index];
  const tone = TONE[scene.tone];
  const last = isLast(state, cfg);
  const running = isRunning(state, cfg);
  const atEnd = last && state.elapsed >= scene.durationMs;

  // The clock: one tick per animation frame while running.
  useEffect(() => {
    if (!running || atEnd) return;
    let raf = 0;
    let prev: number | null = null;
    const frame = (now: number) => {
      if (prev !== null) dispatch({ type: "tick", dt: now - prev });
      prev = now;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running, atEnd, dispatch]);

  // Tapped past the last scene.
  useEffect(() => {
    if (state.finished) onCloseRef.current("done");
  }, [state.finished]);

  // On screen now: only from here does it count as seen (a chunk that never loaded, or a reload
  // before this, leaves the auto-play for next time).
  const onShownRef = useRef(onShown);
  useEffect(() => {
    onShownRef.current?.();
  }, []);

  // Rec mode: the recorder steps the clock itself (deterministic frames, sound locked to picture).
  useEffect(() => {
    if (!recording) return;
    const w = window as Window & { __xpRec?: ExplainerRecorderHook };
    w.__xpRec = { scenes: script.scenes.map((x) => ({ id: x.id, durationMs: x.durationMs })), seek: (index, at) => dispatch({ type: "goto", index, at }) };
    return () => {
      delete w.__xpRec;
    };
  }, [recording, script, dispatch]);

  // Modal: focus in, Escape / arrows, Tab trapped, page scroll locked; focus restored on close.
  useEffect(() => {
    const root = rootRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (!root) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current("skip");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        dispatch({ type: "next" });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        dispatch({ type: "back" });
      } else if (e.key === "Tab") {
        const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return;
        const first = items[0];
        const lastItem = items[items.length - 1];
        const active = document.activeElement;
        if (!root.contains(active) || (e.shiftKey && (active === first || active === root))) {
          e.preventDefault();
          (e.shiftKey ? lastItem : first).focus();
        } else if (!e.shiftKey && active === lastItem) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [dispatch]);

  // Press and hold pauses; a quick tap navigates (the click after a hold is swallowed).
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasHold = useRef(false);
  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  const onPointerDown = () => {
    wasHold.current = false;
    clearHold();
    holdTimer.current = setTimeout(() => {
      wasHold.current = true;
      dispatch({ type: "hold" });
    }, HOLD_MS);
  };
  const onPointerEnd = () => {
    clearHold();
    dispatch({ type: "release" });
  };
  useEffect(() => clearHold, []);
  const zoneClick = useCallback((dir: "back" | "next") => {
    if (wasHold.current) {
      wasHold.current = false;
      return;
    }
    dispatch({ type: dir });
  }, [dispatch]);

  const t = sceneTime(state, cfg, scene.heroMs);
  const paused = state.paused || state.held;
  const barTrack: CSSProperties = { backgroundColor: `rgb(${tone.bar} / 0.32)` };
  const barFill: CSSProperties = { backgroundColor: `rgb(${tone.bar})` };

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-0 z-[90] flex flex-col overflow-hidden outline-none select-none"
      style={{ background: tone.bg, color: tone.fg, touchAction: "manipulation", WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
      data-testid="explainer"
      data-scene={scene.id}
      data-index={state.index}
      data-t={Math.round(t)}
      data-paused={paused ? "true" : "false"}
      data-motion={reduced ? "reduce" : "full"}
      data-rec={recording ? "true" : undefined}
      onContextMenu={(e) => e.preventDefault()}
    >
      <h2 id={titleId} className="sr-only">
        How it works
      </h2>

      {/* Top: progress segments, kicker, pause, Skip */}
      <div className="relative z-20 mx-auto w-full max-w-xl px-3 pt-[calc(10px+env(safe-area-inset-top))]">
        <div className="flex gap-1" aria-hidden="true">
          {script.scenes.map((s, i) => (
            <div key={s.id} className="h-[5px] flex-1 overflow-hidden rounded-full" style={barTrack}>
              <div className="h-full w-full origin-left rounded-full" style={{ ...barFill, transform: `scaleX(${segmentFill(state, cfg, i)})` }} />
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2 pl-1">
          <p className="min-w-0 flex-1 truncate text-sm font-black tracking-[0.12em] uppercase" style={{ color: tone.kicker }} data-testid="explainer-kicker">
            {scene.kicker}
          </p>
          {!reduced && (
            <button
              type="button"
              onClick={() => dispatch({ type: "toggle_pause" })}
              aria-label={state.paused ? "Play" : "Pause"}
              aria-pressed={state.paused}
              className="btn h-12 w-12 shrink-0 rounded-full border-2 p-0! text-lg font-black"
              style={{ borderColor: `rgb(${tone.bar} / 0.6)`, color: tone.fg }}
              data-testid="explainer-pause"
            >
              <span aria-hidden="true">{state.paused ? "▶" : "❚❚"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onCloseRef.current("skip")}
            className="btn min-h-12 shrink-0 rounded-full border-2 border-ink bg-paper px-5 text-base font-black tracking-wide text-ink uppercase shadow-hard-sm"
            data-testid="explainer-skip"
          >
            Skip
          </button>
        </div>
      </div>

      {/* Stage: the cartoon + captions. Left half = back, right half = next, hold = pause. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex min-h-0 w-full max-w-xl flex-1 items-center justify-center px-2 pt-1">
          <SceneArt id={scene.id} t={t} art={script.art} />
        </div>
        {/* A stable live region (screen readers announce changes INSIDE an existing one); the
            caption in it is keyed per scene so its entrance animation replays. */}
        <div className="mx-auto w-full max-w-xl px-gutter pt-2 pb-3" aria-live="polite" data-testid="explainer-caption">
          <div key={scene.id} className="xp-caption" style={recording ? captionStyle(t) : undefined} data-testid="explainer-caption-scene">
            <p className="loud text-[clamp(1.9rem,9.2vw,2.6rem)] break-words [text-wrap:balance]" data-testid="explainer-title">
              {scene.title}
            </p>
            {scene.lines.map((line) => (
              <p key={line} className="mt-2 text-[17px] leading-snug font-bold">
                {line}
              </p>
            ))}
          </div>
        </div>
        {state.held && (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center" aria-hidden="true">
            <span className="rounded-full border-2 border-ink bg-paper px-3 py-1 text-sm font-black tracking-wider text-ink uppercase shadow-hard-sm">❚❚ Paused</span>
          </div>
        )}
        <div className="absolute inset-0 z-0 flex" onPointerDown={onPointerDown} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onPointerLeave={onPointerEnd}>
          <button
            type="button"
            className="h-full w-1/2 bg-transparent outline-offset-[-6px]"
            aria-label={state.index === 0 ? "Start over" : "Previous"}
            onClick={() => zoneClick("back")}
            data-testid="explainer-back"
          />
          <button
            type="button"
            className="h-full w-1/2 bg-transparent outline-offset-[-6px]"
            aria-label={last ? "Close" : "Next"}
            onClick={() => zoneClick("next")}
            data-testid="explainer-next"
          />
        </div>
      </div>

      {/* Bottom: the last scene's big button (thumb zone) */}
      <div className="relative z-20 mx-auto w-full max-w-xl px-gutter pb-[calc(14px+env(safe-area-inset-bottom))]">
        {last ? (
          <button
            type="button"
            onClick={() => onCloseRef.current("done")}
            className={cx(buttonClasses({ variant: "hazard", size: "xl", full: true }), "xp-go")}
            data-testid="explainer-go"
          >
            Let&apos;s go ⛳
          </button>
        ) : (
          <div className="h-1" />
        )}
      </div>
      <style>{CSS}</style>
    </div>,
    document.body,
  );
}

export default Explainer;

function captionStyle(t: number): CSSProperties {
  const e = captionEntrance(t);
  return { opacity: e.opacity, transform: e.translateY ? `translateY(${e.translateY}px)` : undefined };
}

const CSS = `
.xp-caption { animation: xp-caption-in 260ms cubic-bezier(0.2, 0.9, 0.3, 1.2) both; }
@keyframes xp-caption-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.xp-go { animation: xp-go-in 420ms cubic-bezier(0.2, 0.9, 0.3, 1.4) both; }
@keyframes xp-go-in { from { opacity: 0; transform: translateY(18px) scale(0.92); } to { opacity: 1; transform: none; } }
[data-testid="explainer"][data-motion="reduce"] .xp-caption, [data-testid="explainer"][data-motion="reduce"] .xp-go { animation: none; }
[data-testid="explainer"][data-rec] .xp-caption, [data-testid="explainer"][data-rec] .xp-go { animation: none; }
`;
