"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cx } from "./cx";

export type FanfareTone = "ghost" | "groom" | "hype" | "alert";

export interface FanfareOptions {
  emoji: string;
  title: string;
  subtitle?: string;
  tone: FanfareTone;
  /** ms before auto-dismiss (default 3.5 s, 4.5 s for the groom). */
  duration?: number;
  /** Dedupe key: a fanfare with a key that was already shown is ignored (e.g. the feed event id). */
  key?: string;
}

export interface FanfareApi {
  show: (opts: FanfareOptions) => void;
  dismiss: () => void;
}

interface FanfareItem extends FanfareOptions {
  seq: number;
}

const MAX_QUEUE = 4;

const FanfareContext = createContext<FanfareApi | null>(null);

/** Hosts the full-screen fanfare overlay. Fanfares queue; tap to skip to the next one. */
export function FanfareProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<FanfareItem[]>([]);
  const seen = useRef(new Set<string>());
  const seq = useRef(0);

  const show = useCallback((opts: FanfareOptions) => {
    if (opts.key) {
      if (seen.current.has(opts.key)) return;
      seen.current.add(opts.key);
    }
    const item: FanfareItem = { ...opts, seq: ++seq.current };
    // Keep the showing one plus the newest few; a reconnect flood must not trap people in fanfares.
    setQueue((q) => (q.length >= MAX_QUEUE ? [q[0], ...q.slice(-(MAX_QUEUE - 2)), item] : [...q, item]));
    try {
      navigator.vibrate?.(opts.tone === "groom" ? [80, 60, 80, 60, 240] : opts.tone === "alert" ? [200] : [60, 40, 60]);
    } catch {
      /* vibration is a bonus */
    }
  }, []);

  const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const current = queue[0];

  return (
    <FanfareContext.Provider value={api}>
      {children}
      {current && <FanfareOverlay key={current.seq} item={current} onDone={dismiss} />}
    </FanfareContext.Provider>
  );
}

const noopFanfare: FanfareApi = { show: () => {}, dismiss: () => {} };

/** `useFanfare().show({ emoji: "👻", title: "Ghost beer", tone: "ghost" })`. No-op outside the provider. */
export function useFanfare(): FanfareApi {
  return useContext(FanfareContext) ?? noopFanfare;
}

// ---------- Overlay ----------

/** Small deterministic PRNG so confetti is pure per fanfare (no Math.random in render). */
function prng(seed: number) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

const STYLE: Record<FanfareTone, { bg: string; confetti: string[]; burst: string[]; pieces: number; bursts: number }> = {
  ghost: {
    bg: "radial-gradient(circle at 50% 40%, #a77bf7 0%, #7c3aed 38%, #2e0a6e 100%)",
    confetti: ["#ffffff", "#ffd60a", "#c4a5fb", "#f59e0b"],
    burst: ["👻", "🍺", "👻", "✨"],
    pieces: 36,
    bursts: 10,
  },
  groom: {
    bg: "radial-gradient(circle at 50% 42%, #4a3700 0%, #140f00 45%, #000000 100%)",
    confetti: ["#f5c518", "#ffffff", "#ffd60a", "#0a7d3e", "#e5262d"],
    burst: ["👑", "🍾", "⛳", "🍺", "🔥", "💥", "🏌️"],
    pieces: 80,
    bursts: 18,
  },
  hype: {
    bg: "radial-gradient(circle at 50% 40%, #22b062 0%, #0a7d3e 40%, #03371b 100%)",
    confetti: ["#ffffff", "#ffd60a", "#f59e0b", "#7dd3fc"],
    burst: ["🔥", "⛳", "🍺"],
    pieces: 40,
    bursts: 10,
  },
  alert: {
    bg: "radial-gradient(circle at 50% 40%, #ff6b6f 0%, #e5262d 40%, #6b0b0f 100%)",
    confetti: ["#ffffff", "#ffd60a", "#0b0f0c"],
    burst: ["🚨", "💀"],
    pieces: 28,
    bursts: 8,
  },
};

function FanfareOverlay({ item, onDone }: { item: FanfareItem; onDone: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  const isGroom = item.tone === "groom";
  const duration = item.duration ?? (isGroom ? 4500 : 3500);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const t = setTimeout(() => onDoneRef.current(), duration);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDoneRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [duration]);

  const style = STYLE[item.tone];
  const { confetti, bursts } = useMemo(() => {
    const rnd = prng(item.seq * 7919 + item.title.length);
    const confetti = Array.from({ length: style.pieces }, (_, i) => {
      const s: CSSProperties & Record<string, string> = {
        left: `${(rnd() * 100).toFixed(1)}%`,
        backgroundColor: style.confetti[i % style.confetti.length],
        width: `${6 + Math.round(rnd() * 8)}px`,
        height: `${10 + Math.round(rnd() * 10)}px`,
        "--fall-delay": `${(rnd() * (isGroom ? 1.6 : 0.9)).toFixed(2)}s`,
        "--fall-dur": `${(2 + rnd() * 1.8).toFixed(2)}s`,
        "--drift": `${Math.round((rnd() - 0.5) * 160)}px`,
        "--spin": `${Math.round(360 + rnd() * 1080)}deg`,
      };
      return s;
    });
    const emojis = [item.emoji, ...style.burst];
    const bursts = Array.from({ length: style.bursts }, (_, i) => {
      const angle = (i / style.bursts) * Math.PI * 2 + rnd() * 0.5;
      const dist = 130 + rnd() * (isGroom ? 220 : 140);
      const s: CSSProperties & Record<string, string> = {
        "--dx": `${Math.round(Math.cos(angle) * dist)}px`,
        "--dy": `${Math.round(Math.sin(angle) * dist)}px`,
        "--rot": `${Math.round((rnd() - 0.5) * 540)}deg`,
        "--delay": `${(0.1 + rnd() * 0.35).toFixed(2)}s`,
        "--size": `${Math.round(30 + rnd() * (isGroom ? 34 : 22))}px`,
      };
      return { s, e: emojis[i % emojis.length] };
    });
    return { confetti, bursts };
  }, [item.seq, item.title.length, item.emoji, style, isGroom]);

  return (
    <div className="fixed inset-0 z-[100]" data-testid="fanfare" data-tone={item.tone}>
      <button
        ref={ref}
        type="button"
        onClick={() => onDoneRef.current()}
        aria-label={`${item.title}. ${item.subtitle ?? ""} Tap to dismiss.`}
        className="absolute inset-0 flex animate-fade-in flex-col items-center justify-center overflow-hidden px-6 text-center outline-none"
        style={{ background: style.bg }}
      >
        {isGroom && <span className="fanfare-rays" aria-hidden="true" />}
        {isGroom && <span className="groom-lights" aria-hidden="true" />}
        {isGroom && (
          <>
            <span
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-5"
              style={{ backgroundImage: "repeating-linear-gradient(45deg, #ffd60a 0 14px, #0b0f0c 14px 28px)", top: "env(safe-area-inset-top, 0px)" }}
            />
            <span
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 h-5"
              style={{ backgroundImage: "repeating-linear-gradient(-45deg, #ffd60a 0 14px, #0b0f0c 14px 28px)", bottom: "env(safe-area-inset-bottom, 0px)" }}
            />
          </>
        )}
        <span aria-hidden="true" className="pointer-events-none absolute inset-0">
          {confetti.map((s, i) => (
            <span key={i} className="confetti-piece" style={s} />
          ))}
        </span>
        <span aria-hidden="true" className="pointer-events-none absolute inset-0">
          {bursts.map((b, i) => (
            <span key={i} className="burst-piece" style={b.s}>
              {b.e}
            </span>
          ))}
        </span>

        <span className={cx("relative flex max-w-full flex-col items-center", isGroom && "fanfare-quake")}>
          {isGroom && (
            <span className="mb-5 block -rotate-3 rounded-md border-4 border-ink bg-hazard px-4 py-1.5 text-base font-black uppercase tracking-[0.25em] text-ink shadow-[0_5px_0_#000]">
              ⚠️ Royal decree ⚠️
            </span>
          )}
          <span
            className={cx("block animate-bounce-in leading-none", isGroom ? "text-[10rem]" : "text-[8.5rem]")}
            style={{ filter: "drop-shadow(0 8px 0 rgba(0,0,0,0.35))" }}
            aria-hidden="true"
          >
            <span className="inline-block animate-wiggle">{item.emoji}</span>
          </span>
          <span
            className={cx(
              "loud mt-5 block max-w-full break-words",
              // Sized so an 8-letter word ("MULLIGAN") fits a 360px phone without breaking.
              isGroom ? "groom-text text-[clamp(2.5rem,13.5vw,6rem)]" : "text-[clamp(2.4rem,12.5vw,5rem)] text-white",
            )}
            style={isGroom ? undefined : { textShadow: "0 4px 0 rgba(0,0,0,0.35)" }}
          >
            {item.title}
          </span>
          {item.subtitle && (
            <span
              className={cx(
                "mt-4 block max-w-md text-xl font-extrabold leading-snug text-white",
                isGroom && "rounded-xl bg-black/60 px-3 py-2 text-2xl",
              )}
            >
              {item.subtitle}
            </span>
          )}
        </span>
        <span
          className="absolute inset-x-0 text-sm font-extrabold uppercase tracking-[0.2em] text-white/90"
          style={{ bottom: `calc(${isGroom ? 40 : 24}px + env(safe-area-inset-bottom, 0px))` }}
        >
          {isGroom ? "Tap to bow down" : "Tap anywhere"}
        </span>
      </button>
    </div>
  );
}
