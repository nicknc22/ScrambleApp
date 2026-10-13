// Post-commit integrations: AI judge, AI roasts and Web Push. Imported for its side effect by the
// sync route (src/app/api/t/[code]/sync/route.ts), so the hooks are registered in every server
// process that applies ops. Registration is by name (re-importing, e.g. after dev HMR, replaces
// the previous registration instead of adding a second one).
//
// Each hook bails out immediately when its feature is off (no ANTHROPIC_API_KEY / no VAPID keys)
// or the batch has nothing for it, never throws, and runs after the sync response was sent.
import { registerPostCommitHook } from "./hooks";
import { judgeHook } from "./judge";
import { pushHook } from "./push";
import { roastHook } from "./roasts";

export const INTEGRATION_HOOKS = ["ai-judge", "ai-roasts", "push"] as const;

/** Register (or re-register) every integration hook. Idempotent. */
export function registerIntegrations(): void {
  // judge: photo download + one 8 s vision call, then maybe a roast (8 s) and pushes.
  registerPostCommitHook("ai-judge", (ctx) => judgeHook(ctx), { timeoutMs: 45_000 });
  // roasts: up to MAX_ROASTS_PER_BATCH sequential 8 s calls + pushes.
  registerPostCommitHook("ai-roasts", (ctx) => roastHook(ctx), { timeoutMs: 50_000 });
  registerPostCommitHook("push", (ctx) => pushHook(ctx), { timeoutMs: 30_000 });
}

registerIntegrations();
