// Post-commit side effects of a sync batch. The sync route schedules runPostCommit with
// next/server after(), so it runs once the response is on its way and the batch is committed:
//
//   1. broadcastTripChanged(trip.id): every phone refetches the snapshot. Always, even for a batch
//      of duplicates: it heals phones that missed an earlier broadcast, and the syncing phone itself
//      when a concurrent fetch raced its sync response.
//   2. Optional integrations (AI roasts, AI judge, web push, ...) that register themselves:
//
//        registerPostCommitHook("push", async ({ trip, events }) => { ... });
//
//      Hooks run concurrently, each isolated: a throw, a rejection or a hang (timeout) is logged
//      and never affects the batch, the response, the broadcast or the other hooks. A hook that
//      writes more rows (e.g. inserts a roast) must broadcastTripChanged again itself.
//
// Registration: the registry lives on globalThis, so a hook registered from any module instance
// (instrumentation.ts register(), another route bundle, after dev HMR) is seen by the sync route.
// The registering module must actually be imported somewhere at server start: an integration
// should register from src/instrumentation.ts (register() runs once per server process) rather
// than relying on being imported by a route.
//
// Safe to import from scripts (tsx): no next/server import here; the route does the after().
import type { DeriveEventsResult } from "@/lib/events/derive";
import type { Op, OpResult } from "@/lib/ops";
import type { Trip, TripState } from "@/lib/types";
import { broadcastTripChanged } from "./realtime";

export interface PostCommitContext {
  /** The trip after the batch (never includes the PIN hash). */
  trip: Trip;
  /** Feed rows the batch persisted (new events and updated drink batches) + roast/push triggers. */
  events: DeriveEventsResult;
  /** The ops that were applied, normalized, in order (duplicates and rejections excluded). */
  ops: Op[];
  /** One result per op of the request, in request order (applied, duplicate or rejected). */
  results: OpResult[];
  /** Full state after the batch, when the caller has it (the sync route always does). */
  state?: TripState;
  /** The request carried a valid commissioner cookie. */
  is_commissioner?: boolean;
}

/** Treat the context as read-only: every hook gets the same object. */
export type PostCommitHook = (ctx: PostCommitContext) => unknown;

export interface PostCommitHookOptions {
  /** Give up waiting (and log) after this long. Default 60 s. */
  timeoutMs?: number;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

interface Registered {
  fn: PostCommitHook;
  timeoutMs: number;
}

const G = globalThis as typeof globalThis & { __scramblePostCommitHooks?: Map<string, Registered> };
const registry: Map<string, Registered> = (G.__scramblePostCommitHooks ??= new Map());

/**
 * Register (or replace, by name: re-registering after a reload is harmless) a post-commit hook.
 * Returns a function that unregisters it.
 */
export function registerPostCommitHook(name: string, fn: PostCommitHook, opts: PostCommitHookOptions = {}): () => void {
  if (!name || typeof fn !== "function") throw new TypeError("registerPostCommitHook(name, fn): both are required");
  const timeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS;
  const entry: Registered = { fn, timeoutMs };
  registry.set(name, entry);
  return () => {
    // Only remove our own registration, not a later replacement under the same name.
    if (registry.get(name) === entry) registry.delete(name);
  };
}

export function unregisterPostCommitHook(name: string): boolean {
  return registry.delete(name);
}

/** Names of the registered hooks, in registration order. */
export function postCommitHookNames(): string[] {
  return [...registry.keys()];
}

export type HookOutcome = "ok" | "error" | "timeout";

export interface PostCommitReport {
  /** The realtime broadcast was accepted (false when Realtime isn't configured). */
  broadcast: boolean;
  hooks: Record<string, HookOutcome>;
}

export interface PostCommitDeps {
  broadcast?: (tripId: string) => Promise<boolean>;
}

const TIMED_OUT = Symbol("timeout");

async function runHook(name: string, entry: Registered, ctx: PostCommitContext): Promise<HookOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), entry.timeoutMs);
      // Don't keep a script's process alive just for this timer.
      (timer as { unref?: () => void }).unref?.();
    });
    // Promise.resolve().then(...) turns a synchronous throw into a rejection too.
    const work = Promise.resolve().then(() => entry.fn(ctx));
    const outcome = await Promise.race([work, timeout]);
    if (outcome === TIMED_OUT) {
      console.error(`[post-commit] hook "${name}" timed out after ${entry.timeoutMs} ms (trip ${ctx.trip.id})`);
      // It may still settle later; never let that surface as an unhandled rejection.
      work.catch((e) => console.error(`[post-commit] hook "${name}" failed after timing out`, e));
      return "timeout";
    }
    return "ok";
  } catch (e) {
    console.error(`[post-commit] hook "${name}" failed (trip ${ctx.trip.id})`, e);
    return "error";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Broadcast the change and run every registered hook. Never throws; resolves when the broadcast
 * and all hooks have settled (or timed out).
 */
export async function runPostCommit(ctx: PostCommitContext, deps: PostCommitDeps = {}): Promise<PostCommitReport> {
  const report: PostCommitReport = { broadcast: false, hooks: {} };
  try {
    const broadcast = deps.broadcast ?? broadcastTripChanged;
    const entries = [...registry.entries()];
    const [sent, ...outcomes] = await Promise.all([
      Promise.resolve()
        .then(() => broadcast(ctx.trip.id))
        .catch((e: unknown) => {
          console.error(`[post-commit] broadcast for trip ${ctx.trip.id} failed`, e);
          return false;
        }),
      ...entries.map(([name, entry]) => runHook(name, entry, ctx)),
    ]);
    report.broadcast = sent === true;
    entries.forEach(([name], i) => {
      report.hooks[name] = outcomes[i] as HookOutcome;
    });
  } catch (e) {
    console.error("[post-commit] unexpected failure", e);
  }
  return report;
}
