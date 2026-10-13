// Server-clock correction for op timestamps. Drink windows, last-write-wins and ghost-beer order
// all compare client clocks across phones, so a phone whose clock is minutes off (manual time,
// dead battery reset) would misfile its drinks and lose or win edits it shouldn't. Every fresh
// GET /state carries meta.server_time; we estimate this phone's offset from it and stamp ops with
// server-corrected time. Small offsets (normal NTP-synced phones) are left alone.
import type { StorageLike } from "./identity";

export const CLOCK_KEY = "scramble:clock-offset";
/** Offsets smaller than this are noise (latency, NTP jitter): no correction. */
export const MIN_CORRECTION_MS = 30_000;
/** Samples from slower round trips are too imprecise to use. */
export const MAX_RTT_MS = 10_000;
const MAX_SAMPLES = 7;

export class ServerClock {
  private samples: number[] = [];
  /** Correction added to the local clock (0 unless the phone is clearly off). */
  offsetMs = 0;

  constructor(private readonly storage: StorageLike | null) {
    try {
      const stored = Number(storage?.getItem(CLOCK_KEY) ?? "");
      if (Number.isFinite(stored) && Math.abs(stored) >= MIN_CORRECTION_MS) this.offsetMs = stored;
    } catch {
      /* no storage: start uncorrected */
    }
  }

  /** Record one server response: its server_time, and when this phone sent and received it. */
  observe(serverTimeIso: string, sentMs: number, receivedMs: number): void {
    const server = Date.parse(serverTimeIso);
    const rtt = receivedMs - sentMs;
    if (!Number.isFinite(server) || rtt < 0 || rtt > MAX_RTT_MS) return;
    // server_time is stamped while handling the request: compare with the round trip's midpoint.
    this.samples = [...this.samples, server - (sentMs + receivedMs) / 2].slice(-MAX_SAMPLES);
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const next = Math.abs(median) >= MIN_CORRECTION_MS ? Math.round(median) : 0;
    if (next === this.offsetMs) return;
    this.offsetMs = next;
    try {
      if (next === 0) this.storage?.removeItem(CLOCK_KEY);
      else this.storage?.setItem(CLOCK_KEY, String(next));
    } catch {
      /* best effort */
    }
  }

  /** Server-corrected time for a local clock reading. */
  now(localMs: number): number {
    return localMs + this.offsetMs;
  }
}
