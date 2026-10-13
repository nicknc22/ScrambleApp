// Typed, lazy access to server environment variables (see the table in CLAUDE.md).
// Values are read from process.env on every call (never cached), so tests can flip them and
// Vercel's runtime env is always what counts. Blank values ("" or whitespace) count as unset.

function read(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Supabase Postgres connection string (transaction pooler). Unset → local PGlite. */
export function databaseUrl(): string | undefined {
  return read("DATABASE_URL");
}

/** PGlite data directory when DATABASE_URL is unset. "memory://" keeps everything in memory. */
export function pgliteDir(): string {
  return read("PGLITE_DIR") ?? ".data/pglite";
}

/** Local photo directory when Supabase Storage isn't configured. */
export function uploadsDir(): string {
  return read("UPLOADS_DIR") ?? ".data/uploads";
}

/** Supabase project URL without a trailing slash. */
export function supabaseUrl(): string | undefined {
  const v = read("NEXT_PUBLIC_SUPABASE_URL");
  return v ? v.replace(/\/+$/, "") : undefined;
}

export function supabaseAnonKey(): string | undefined {
  return read("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

export function supabaseServiceRoleKey(): string | undefined {
  return read("SUPABASE_SERVICE_ROLE_KEY");
}

export function anthropicApiKey(): string | undefined {
  return read("ANTHROPIC_API_KEY");
}

export function vapidPublicKey(): string | undefined {
  return read("VAPID_PUBLIC_KEY");
}

export function vapidPrivateKey(): string | undefined {
  return read("VAPID_PRIVATE_KEY");
}

/** web-push needs a mailto: or https: subject. */
export function vapidSubject(): string {
  return read("VAPID_SUBJECT") ?? "mailto:scramble@example.com";
}

/**
 * Default commissioner PIN hash (scrypt:...). This or COMMISSIONER_PIN is required to create trips
 * in production; it wins when both are set. Use auth.serverPin(), which validates both.
 */
export function commissionerPinHash(): string | undefined {
  return read("COMMISSIONER_PIN_HASH");
}

/** Plain default commissioner PIN (4-12 digits), the type-it-into-Vercel alternative to the hash. */
export function commissionerPin(): string | undefined {
  return read("COMMISSIONER_PIN");
}

/** Optional explicit cookie-signing secret. */
export function appSecret(): string | undefined {
  return read("APP_SECRET");
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Running on Vercel (the platform sets VERCEL=1): no writable disk, so no local fallbacks. */
export function isVercel(): boolean {
  return !!read("VERCEL");
}

/**
 * A required piece of server configuration is missing. Route handlers turn it into a 500 with
 * code "not_configured" and this message (it names the variable), instead of a generic error.
 */
export class ConfigError extends Error {
  /** Keep answering with this error for this long before trying again (ms; 0 = retry next request). */
  readonly holdMs: number;
  constructor(message: string, opts: { holdMs?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ConfigError";
    this.holdMs = opts.holdMs ?? 0;
  }
}

/** Server-side Supabase (Storage uploads + Realtime broadcast) is usable. */
export function supabaseConfigured(): boolean {
  return !!supabaseUrl() && !!supabaseServiceRoleKey();
}

/**
 * Live updates via Realtime broadcast: the server needs the service key to broadcast and the
 * clients need the anon key to subscribe. With only one of them, clients would sit on the slow
 * 20 s poll waiting for broadcasts that never come, so we require all three.
 */
export function realtimeConfigured(): boolean {
  return supabaseConfigured() && !!supabaseAnonKey();
}

export function aiEnabled(): boolean {
  return !!anthropicApiKey();
}

/**
 * Web Push is on unless PUSH_DISABLED=1. The VAPID keys come from VAPID_PUBLIC_KEY +
 * VAPID_PRIVATE_KEY when both are set, else the server makes and keeps its own (vapid.ts).
 */
export function pushEnabled(): boolean {
  return !/^(1|true|yes)$/i.test(read("PUSH_DISABLED") ?? "");
}

/** AI features on public demo trips ("Try the demo" is open to anyone): off unless DEMO_AI=1. */
export function demoAiEnabled(): boolean {
  return read("DEMO_AI") === "1";
}

/** Whether AI may run for this trip (key configured; demo trips only with DEMO_AI=1). */
export function aiAllowedForTrip(trip: { is_demo: boolean }): boolean {
  return aiEnabled() && (!trip.is_demo || demoAiEnabled());
}
