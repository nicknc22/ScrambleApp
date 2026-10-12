"use client";
// Live updates. The server broadcasts an invalidation ("changed") on topic trip:<trip_id> after
// every commit; we refetch the snapshot (debounced). Polling is the safety net: every 20 s when
// Realtime is configured, every 3 s when it isn't. Also refetch on focus / online / visible.
// Polls are skipped while the page is hidden (iOS freezes it anyway; saves battery and data).
import type { SnapshotMeta } from "../types";
import { realTimers, type DocumentLike, type EventTargetLike, type Timers } from "./sync";

export type RealtimeConfig = NonNullable<SnapshotMeta["realtime"]>;

/** Connects to the broadcast channel; returns a disconnect function. */
export type RealtimeConnector = (
  cfg: RealtimeConfig,
  onChanged: () => void,
  onStatus?: (status: string) => void,
) => Promise<() => void>;

export interface LiveOptions {
  /** Refetch GET /api/t/<code>/state (after a broadcast, focus, online, visible). */
  refresh: () => unknown;
  /**
   * Interval poll. Defaults to refresh. The store passes a variant that skips while a request is
   * already in flight, so a weak signal isn't saturated with back-to-back snapshot downloads.
   */
  poll?: () => unknown;
  timers?: Timers;
  win?: EventTargetLike | null;
  doc?: DocumentLike | null;
  connect?: RealtimeConnector;
  /** Poll interval with Realtime configured. Default 20000. */
  pollMs?: number;
  /** Poll interval without Realtime. Default 3000. */
  fallbackPollMs?: number;
  /** Debounce for "changed" broadcasts. Default 400. */
  debounceMs?: number;
}

export interface LiveController {
  /** Call with each adopted snapshot's meta.realtime (null = poll only). */
  setConfig(cfg: SnapshotMeta["realtime"] | undefined): void;
  /** Debounced refresh (e.g. after a broadcast). */
  poke(delayMs?: number): void;
  readonly connected: boolean;
  stop(): void;
}

/** Default connector: supabase-js (loaded lazily so it never blocks the first paint offline). */
export const supabaseConnector: RealtimeConnector = async (cfg, onChanged, onStatus) => {
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(cfg.url, cfg.anon_key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const channel = client
    .channel(cfg.topic, { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "changed" }, () => onChanged())
    .subscribe((status) => onStatus?.(String(status)));
  return () => {
    try {
      void client.removeChannel(channel);
    } catch {
      /* ignore */
    }
    try {
      client.realtime.disconnect();
    } catch {
      /* ignore */
    }
  };
};

function sameConfig(a: RealtimeConfig | null, b: RealtimeConfig | null): boolean {
  if (!a || !b) return a === b;
  return a.url === b.url && a.anon_key === b.anon_key && a.topic === b.topic;
}

export function startLiveUpdates(opts: LiveOptions): LiveController {
  const timers = opts.timers ?? realTimers;
  const win = opts.win === undefined ? (typeof window !== "undefined" ? window : null) : opts.win;
  const doc = opts.doc === undefined ? (typeof document !== "undefined" ? document : null) : opts.doc;
  const connect = opts.connect ?? supabaseConnector;
  const pollMs = opts.pollMs ?? 20_000;
  const fallbackPollMs = opts.fallbackPollMs ?? 3_000;
  const debounceMs = opts.debounceMs ?? 400;

  let stopped = false;
  let cfg: RealtimeConfig | null = null;
  let configKnown = false;
  let disconnect: (() => void) | null = null;
  let connecting = 0; // generation counter to drop stale connects
  let connected = false;
  let pollTimer: unknown = null;
  let pokeTimer: unknown = null;

  const hidden = () => doc?.visibilityState === "hidden";
  const call = (fn: () => unknown) => {
    if (stopped) return;
    try {
      const r = fn() as Promise<unknown> | undefined;
      if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => undefined);
    } catch {
      /* ignore */
    }
  };
  const refresh = () => call(opts.refresh);
  const poll = () => call(opts.poll ?? opts.refresh);

  const poke = (delayMs: number = debounceMs) => {
    if (stopped || pokeTimer !== null) return;
    pokeTimer = timers.setTimeout(() => {
      pokeTimer = null;
      refresh();
    }, delayMs);
  };

  const interval = () => (cfg ? pollMs : fallbackPollMs);
  const armPoll = () => {
    if (stopped) return;
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      if (!hidden()) poll();
      armPoll();
    }, interval());
  };

  const teardown = () => {
    connected = false;
    if (disconnect) {
      try {
        disconnect();
      } catch {
        /* ignore */
      }
      disconnect = null;
    }
  };

  const reconnect = () => {
    teardown();
    const gen = ++connecting;
    if (!cfg || stopped) return;
    const target = cfg;
    connect(
      target,
      () => {
        if (!stopped && gen === connecting) poke(debounceMs);
      },
      (status) => {
        if (stopped || gen !== connecting) return;
        if (status === "SUBSCRIBED") {
          connected = true;
          // Catch up on anything broadcast while we weren't listening.
          poke(0);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          connected = false;
        }
      },
    ).then(
      (fn) => {
        if (stopped || gen !== connecting) {
          try {
            fn();
          } catch {
            /* ignore */
          }
          return;
        }
        disconnect = fn;
      },
      () => {
        // supabase-js chunk unavailable (offline first load) or bad config: polling covers it.
        if (gen === connecting) connected = false;
      },
    );
  };

  const onWake = () => poke(50);
  const onVisibility = () => {
    if (!hidden()) poke(50);
  };
  win?.addEventListener("focus", onWake);
  win?.addEventListener("online", onWake);
  doc?.addEventListener("visibilitychange", onVisibility);
  armPoll();

  return {
    setConfig(next) {
      if (stopped) return;
      const n = next ?? null;
      const changed = !configKnown || !sameConfig(cfg, n);
      const intervalChanged = !configKnown || !!cfg !== !!n;
      configKnown = true;
      if (!changed) return;
      cfg = n;
      if (intervalChanged) armPoll();
      reconnect();
    },
    poke,
    get connected() {
      return connected;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      connecting++;
      teardown();
      if (pollTimer !== null) timers.clearTimeout(pollTimer);
      if (pokeTimer !== null) timers.clearTimeout(pokeTimer);
      pollTimer = null;
      pokeTimer = null;
      win?.removeEventListener("focus", onWake);
      win?.removeEventListener("online", onWake);
      doc?.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
