-- 002_abuse_limits: server-only bookkeeping that keeps strangers and bored groomsmen from locking
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
