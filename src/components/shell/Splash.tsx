"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, Spinner, buttonClasses } from "@/components/ui";

/** The Scramble wordmark: pin flag + heavy italic name. */
export function Wordmark({ name = "Scramble", light = false, size = "lg" }: { name?: string; light?: boolean; size?: "md" | "lg" | "xl" }) {
  // Fluid sizes: "SCRAMBLE" in heavy italic is ~6.2em wide, so it must shrink on 360px phones.
  const text = size === "xl" ? "text-[clamp(2.25rem,11.5vw,3.75rem)]" : size === "lg" ? "text-[clamp(2rem,10vw,3rem)]" : "text-3xl";
  const flag = size === "xl" ? 50 : size === "lg" ? 42 : 30;
  return (
    <span className={`inline-flex items-center gap-2 ${light ? "text-white" : "text-ink"}`}>
      <svg width={flag} height={flag} viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
        <ellipse cx="20" cy="42" rx="16" ry="4" fill={light ? "rgba(255,255,255,0.35)" : "#0a7d3e"} />
        <path d="M17 42V5" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        <path d="M19 6l22 8-22 8z" fill="#ffd60a" stroke="#0b0f0c" strokeWidth="2.5" strokeLinejoin="round" />
      </svg>
      <span className={`loud ${text} min-w-0 [overflow-wrap:anywhere]`}>{name}</span>
    </span>
  );
}

const SLOW_MS = 8000;

/** Loading splash: big logo, "Warming up the cart…". Offers a retry if it takes forever. */
export function Splash({ appName, onRetry }: { appName?: string; onRetry?: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center text-white"
      style={{ background: "radial-gradient(circle at 50% 35%, #15a356 0%, #0a7d3e 45%, #053d1f 100%)" }}
      data-testid="splash"
    >
      <div className="animate-float">
        <Wordmark name={appName || "Scramble"} light size="xl" />
      </div>
      <div className="flex items-center gap-3 text-xl font-extrabold">
        <Spinner size={26} label="Loading the trip" />
        <span>Warming up the cart…</span>
      </div>
      {slow && (
        <div className="max-w-xs animate-fade-in space-y-3">
          <p className="text-base font-bold">
            Still loading. Bad signal? If this phone has opened the trip before, it&apos;ll show up as soon as the cache does.
          </p>
          <Button variant="hazard" size="lg" full onClick={onRetry ?? (() => window.location.reload())}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

export type LoadErrorKind = "not_found" | "offline" | "server";

/** Classify the store's loadError text (and connectivity) into a screen variant. */
export function loadErrorKind(message: string | null, online: boolean): LoadErrorKind {
  // The message wins: the store also reports "offline" after a 500, which is a server problem.
  if (message && /no trip|not found|unknown trip/i.test(message)) return "not_found";
  if (message && /no signal|offline|network/i.test(message)) return "offline";
  if (message && /server|retrying|\(\d{3}\)/i.test(message)) return "server";
  return online ? "server" : "offline";
}

const LOAD_ERROR_COPY: Record<LoadErrorKind, { emoji: string; title: string }> = {
  not_found: { emoji: "🕳️", title: "Trip's in the water" },
  offline: { emoji: "📵", title: "No signal, no trip" },
  server: { emoji: "🔧", title: "Server's taking a drop" },
};

/** Unknown trip / nothing cached / server trouble: funny message + retry + a way home. */
export function LoadError({ code, message, onRetry, online = true }: { code: string; message: string | null; onRetry?: () => void; online?: boolean }) {
  const kind = loadErrorKind(message, online && (typeof navigator === "undefined" || navigator.onLine !== false));
  const copy = LOAD_ERROR_COPY[kind];
  return (
    <div className="flex min-h-dvh flex-col justify-between bg-paper px-gutter pt-[calc(24px+env(safe-area-inset-top))] pb-[calc(24px+env(safe-area-inset-bottom))]">
      <div className="pt-10 text-center" data-testid="load-error" data-kind={kind}>
        <div className="text-8xl leading-none" aria-hidden="true">
          {copy.emoji}
        </div>
        <h1 className="loud mt-6 text-[clamp(2.4rem,12vw,3rem)]">{copy.title}</h1>
        <p className="mx-auto mt-4 max-w-sm text-lg font-bold text-ink">
          {kind === "offline" ? (
            <>This phone has never loaded this trip and there&apos;s no signal. Find one bar and try again.</>
          ) : kind === "not_found" ? (
            <>
              We can&apos;t find a trip with the code <span className="rounded bg-hazard px-1.5 font-mono font-black">{code}</span>. Check the
              link from the group chat. Typos are a two-stroke penalty.
            </>
          ) : (
            <>The server is having a moment. The app keeps retrying on its own, or you can poke it.</>
          )}
        </p>
        {kind === "server" && message && <p className="mx-auto mt-3 max-w-sm text-sm font-semibold text-muted">({message})</p>}
      </div>
      <div className="mx-auto flex w-full max-w-sm flex-col gap-3">
        <Button variant="primary" size="xl" full onClick={onRetry ?? (() => window.location.reload())}>
          Try again
        </Button>
        <Link href="/?home=1" className={buttonClasses({ variant: "secondary", size: "lg", full: true })}>
          Go home
        </Link>
      </div>
    </div>
  );
}
