// Schema migrations. The SQL lives in db/migrations/*.sql (readable, pasteable into the Supabase
// SQL editor) AND is embedded below as string constants, because a serverless bundle (Vercel)
// doesn't necessarily ship the db/ folder. tests/server/db.test.ts asserts the two are identical,
// so when you add db/migrations/002_x.sql, add a matching constant to embeddedMigrations().
//
// Migrations run once per process before the first query (see getDb in db.ts), inside one
// transaction holding a global advisory lock, so concurrent cold starts can't double-apply.
// Applied versions are tracked in schema_migrations.
import fs from "node:fs";
import path from "node:path";
import type { SqlDb } from "./db";

export interface Migration {
  /** File name without ".sql", e.g. "001_init". Applied in lexicographic order. */
  version: string;
  sql: string;
}

/** Arbitrary constant key for pg_advisory_xact_lock while migrating. */
const MIGRATION_LOCK_KEY = 727274001;

const SCHEMA_MIGRATIONS_DDL = `create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
)`;

/** The migrations compiled into the bundle. Keep in sync with db/migrations (a test checks). */
export function embeddedMigrations(): Migration[] {
  return [
    { version: "001_init", sql: INIT_SQL },
    { version: "002_abuse_limits", sql: ABUSE_LIMITS_SQL },
    { version: "003_photo_sha256", sql: PHOTO_SHA256_SQL },
    { version: "004_feed_event_types", sql: FEED_EVENT_TYPES_SQL },
  ];
}

/** db/migrations relative to the project root (process.cwd() in dev, tests, scripts and next start). */
export function migrationsDir(): string {
  return path.join(process.cwd(), "db", "migrations");
}

/**
 * Migrations read from db/migrations/*.sql when that folder is present, else the embedded copies.
 * An embedded migration whose file is missing still runs (a partial deploy never skips one).
 */
export function loadMigrations(dir: string = migrationsDir()): Migration[] {
  const byVersion = new Map<string, Migration>();
  for (const m of embeddedMigrations()) byVersion.set(m.version, m);
  let files: string[] = [];
  try {
    // The folder is optional at runtime (embedded fallback), so the magic comments tell
    // Turbopack not to trace these dynamic reads (which would bundle the whole project).
    files = fs.readdirSync(/*turbopackIgnore: true*/ dir).filter((f) => /^\d+_[\w-]+\.sql$/.test(f));
  } catch {
    files = []; // no folder in this bundle: embedded copies only
  }
  for (const f of files) {
    try {
      const file = path.join(/*turbopackIgnore: true*/ dir, f);
      byVersion.set(f.slice(0, -4), { version: f.slice(0, -4), sql: fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8") });
    } catch {
      /* unreadable file: fall back to the embedded copy if there is one */
    }
  }
  return [...byVersion.values()].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

/**
 * Apply every migration not yet recorded in schema_migrations. Returns the versions applied now.
 * All-or-nothing: one transaction, serialized across processes by an advisory lock.
 */
export async function runMigrations(db: SqlDb, migrations: Migration[] = loadMigrations()): Promise<string[]> {
  return db.tx(async (t) => {
    await t.query(`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
    await t.exec(SCHEMA_MIGRATIONS_DDL);
    const rows = await t.query<{ version: string }>("select version from schema_migrations");
    const done = new Set(rows.map((r) => r.version));
    const applied: string[] = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await t.exec(m.sql);
      await t.query("insert into schema_migrations (version) values ($1) on conflict (version) do nothing", [m.version]);
      applied.push(m.version);
    }
    return applied;
  });
}

// ---------------------------------------------------------------------------
// Embedded SQL. Must be byte-identical to db/migrations/<version>.sql.
// ---------------------------------------------------------------------------

/** db/migrations/001_init.sql */
export const INIT_SQL = `-- 001_init: the whole Scramble schema.
--
-- Columns match src/lib/types.ts exactly (snake_case, same nullability). Runs unchanged on
-- Supabase Postgres, plain Postgres 16+ and PGlite. Idempotent (IF NOT EXISTS everywhere), so
-- pasting it into the Supabase SQL editor before the app's own migrator runs is harmless.
--
-- Security: the browser never talks to Postgres. Every table has row level security enabled and
-- NO policies, so Supabase's anon/authenticated roles see nothing; the server connects as the
-- table owner, which bypasses RLS.
--
-- Child tables only reference trips(id) (on delete cascade). No other foreign keys: offline
-- phones deliver writes in any order and the reducer owns referential rules.

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists trips (
  id uuid primary key,
  code text not null unique,
  name text not null,
  app_name text not null,
  status text not null default 'setup' check (status in ('setup', 'live', 'final')),
  base_team_size integer not null default 4,
  settings jsonb not null default '{}'::jsonb,
  is_demo boolean not null default false,
  commissioner_pin_hash text not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finalized_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists players (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  name text not null,
  nickname text,
  venmo_handle text,
  is_groom boolean not null default false,
  muted_push boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists players_trip_id_idx on players (trip_id);

create table if not exists teams (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  name text not null,
  tee_time text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists teams_trip_id_idx on teams (trip_id);

-- One team per player: memberships are hard-deleted when a player moves.
create table if not exists team_members (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  team_id uuid not null,
  player_id uuid not null unique,
  created_at timestamptz not null default now()
);
create index if not exists team_members_trip_id_idx on team_members (trip_id);

create table if not exists holes (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  number integer not null,
  par integer not null,
  stroke_index integer not null,
  yardage jsonb not null default '{}'::jsonb,
  tee_lat double precision,
  tee_lng double precision,
  green_lat double precision,
  green_lng double precision,
  contest text not null default 'none' check (contest in ('ctp', 'ld', 'none')),
  updated_at timestamptz not null default now(),
  unique (trip_id, number)
);
create index if not exists holes_trip_id_idx on holes (trip_id);

create table if not exists team_round_state (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  team_id uuid not null unique,
  open_hole integer,
  started_holes integer[] not null default '{}',
  hole_opened_at jsonb not null default '{}'::jsonb,
  status text not null default 'not_started' check (status in ('not_started', 'playing', 'complete')),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists team_round_state_trip_id_idx on team_round_state (trip_id);

create table if not exists hole_scores (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  team_id uuid not null,
  hole integer not null,
  strokes integer,
  tee_shot_player_id uuid,
  strokes_at timestamptz,
  tee_shot_at timestamptz,
  edit_count integer not null default 0,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (team_id, hole)
);
create index if not exists hole_scores_trip_id_idx on hole_scores (trip_id);

create table if not exists drinks (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  team_id uuid not null,
  player_id uuid not null,
  hole integer not null,
  type text not null check (type in ('drink', 'shotgun', 'shot')),
  photo_path text,
  logged_by uuid,
  logged_at timestamptz not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  moved_from_hole integer
);
create index if not exists drinks_trip_id_idx on drinks (trip_id);

create table if not exists mulligans (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  team_id uuid not null,
  source text not null check (source in ('earned', 'groom')),
  used_on_hole integer not null,
  used_by uuid,
  used_at timestamptz not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists mulligans_trip_id_idx on mulligans (trip_id);

create table if not exists contest_entries (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  hole integer not null,
  player_id uuid not null,
  team_id uuid not null,
  type text not null check (type in ('ctp', 'ld')),
  distance_value double precision not null,
  unit text not null check (unit in ('ft', 'yd')),
  distance_override double precision,
  angle_deg double precision,
  lat double precision,
  lng double precision,
  gps_accuracy_m double precision,
  low_accuracy boolean not null default false,
  photo_path text,
  ai_estimate_ft double precision,
  ai_confidence text check (ai_confidence in ('low', 'medium', 'high')),
  ai_suspicious boolean,
  ai_roast text,
  status text not null default 'ok' check (status in ('ok', 'flagged', 'overridden')),
  flag_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists contest_entries_trip_id_idx on contest_entries (trip_id);

-- A row with deleted_at = null means the player is OUT of that pot (default is all in).
create table if not exists pot_optouts (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  pot_key text not null,
  player_id uuid not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (trip_id, pot_key, player_id)
);
create index if not exists pot_optouts_trip_id_idx on pot_optouts (trip_id);

create table if not exists feed_events (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  type text not null check (type in (
    'post', 'round_started', 'tee_off', 'score_notable', 'score_edit', 'drinks', 'shotgun', 'shot',
    'ghost_beer', 'mulligan_used', 'groom_mulligan', 'lead_change', 'contest_entry', 'contest_lead',
    'ai_judge', 'drive_warning', 'drive_miss', 'commissioner_override', 'round_complete',
    'final_results', 'roast'
  )),
  team_id uuid,
  player_id uuid,
  actor_id uuid,
  payload jsonb not null default '{}'::jsonb,
  photo_path text,
  text text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists feed_events_trip_id_idx on feed_events (trip_id);
create unique index if not exists feed_events_trip_dedupe_key_idx
  on feed_events (trip_id, dedupe_key) where dedupe_key is not null;

create table if not exists reactions (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  feed_event_id uuid not null,
  player_id uuid not null,
  kind text not null check (kind in ('fire', 'lol', 'beer', 'dead', 'goat', 'clown')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (feed_event_id, player_id, kind)
);
create index if not exists reactions_trip_id_idx on reactions (trip_id);

-- Server-only tables below (never shipped to clients).

create table if not exists push_subscriptions (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  player_id uuid not null,
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_trip_id_idx on push_subscriptions (trip_id);

-- Push throttle bookkeeping (1 push per player per settings.push_throttle_sec).
create table if not exists push_log (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  player_id uuid not null,
  collapse_key text,
  sent_at timestamptz not null default now()
);
create index if not exists push_log_trip_id_idx on push_log (trip_id);
create index if not exists push_log_player_sent_idx on push_log (player_id, sent_at);

-- AI call bookkeeping (roast caps, judge usage).
create table if not exists ai_log (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);
create index if not exists ai_log_trip_id_idx on ai_log (trip_id);

-- Exactly-once op application: one row per op id the server has processed.
create table if not exists applied_ops (
  id uuid primary key,
  trip_id uuid not null references trips(id) on delete cascade,
  op_type text not null,
  status text not null check (status in ('applied', 'duplicate', 'rejected')),
  code text,
  reason text,
  applied_at timestamptz not null default now()
);
create index if not exists applied_ops_trip_id_idx on applied_ops (trip_id);

alter table schema_migrations enable row level security;
alter table trips enable row level security;
alter table players enable row level security;
alter table teams enable row level security;
alter table team_members enable row level security;
alter table holes enable row level security;
alter table team_round_state enable row level security;
alter table hole_scores enable row level security;
alter table drinks enable row level security;
alter table mulligans enable row level security;
alter table contest_entries enable row level security;
alter table pot_optouts enable row level security;
alter table feed_events enable row level security;
alter table reactions enable row level security;
alter table push_subscriptions enable row level security;
alter table push_log enable row level security;
alter table ai_log enable row level security;
alter table applied_ops enable row level security;
`;

/** db/migrations/002_abuse_limits.sql */
export const ABUSE_LIMITS_SQL = `-- 002_abuse_limits: server-only bookkeeping that keeps strangers and bored groomsmen from locking
-- the commissioner out or running up the storage bill. Lives in the database (not in process
-- memory) so it survives cold starts and every serverless instance sees the same numbers.
--
--   pin_failures    one row per wrong commissioner PIN; trip_id null = trip creation with the
--                   server's COMMISSIONER_PIN_HASH. The throttle counts recent rows.
--   photo_uploads   one row per stored photo path: the per-trip photo count and byte quota.
--   demo_creations  one row per public demo create/reset: a global hourly cap.
--
-- Idempotent, RLS on with no policies, never shipped to clients (same rules as 001).

create table if not exists pin_failures (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id) on delete cascade,
  client text not null,
  created_at timestamptz not null default now()
);
create index if not exists pin_failures_trip_id_idx on pin_failures (trip_id);
create index if not exists pin_failures_created_at_idx on pin_failures (created_at);

create table if not exists photo_uploads (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  path text not null unique,
  bytes integer not null,
  created_at timestamptz not null default now()
);
create index if not exists photo_uploads_trip_id_idx on photo_uploads (trip_id);

create table if not exists demo_creations (
  id uuid primary key default gen_random_uuid(),
  client text not null,
  created_at timestamptz not null default now()
);
create index if not exists demo_creations_created_at_idx on demo_creations (created_at);

alter table pin_failures enable row level security;
alter table photo_uploads enable row level security;
alter table demo_creations enable row level security;
`;

/** db/migrations/003_photo_sha256.sql */
export const PHOTO_SHA256_SQL = `-- 003_photo_sha256: the sha256 of every photo uploaded through the API. A re-upload of a stored
-- path is accepted only with identical bytes (the phone's outbox retrying), so nobody holding the
-- trip link can replace a closest-to-pin photo or any other evidence after the fact.
-- Rows from before this migration have null (those are checked by size instead).
--
-- Idempotent, never shipped to clients (same rules as 001).

alter table photo_uploads add column if not exists sha256 text;
`;

/** db/migrations/004_feed_event_types.sql */
export const FEED_EVENT_TYPES_SQL = `-- 004_feed_event_types: two new automatic feed event types.
--
--   results_changed  a batch applied to a FINAL trip (a phone syncing plays from the course after
--                    the finalize, or a commissioner fix) changed the champion, the standings or
--                    the settle-up. Loud on purpose: people may already have paid.
--   removed          a drink, contest entry or mulligan was removed by someone other than whoever
--                    logged it, or long after the 10-second undo (transparency).
--
-- Re-creates the type CHECK constraint from 001 with the full list. Idempotent.

alter table feed_events drop constraint if exists feed_events_type_check;
alter table feed_events add constraint feed_events_type_check check (type in (
  'post', 'round_started', 'tee_off', 'score_notable', 'score_edit', 'drinks', 'shotgun', 'shot',
  'ghost_beer', 'mulligan_used', 'groom_mulligan', 'lead_change', 'contest_entry', 'contest_lead',
  'ai_judge', 'drive_warning', 'drive_miss', 'commissioner_override', 'round_complete',
  'final_results', 'results_changed', 'removed', 'roast'
));
`;
