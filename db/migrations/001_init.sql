-- 001_init: the whole Scramble schema.
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
