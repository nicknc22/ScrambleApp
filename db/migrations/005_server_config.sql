-- 005_server_config: settings the server makes for itself, one jsonb value per key.
--
--   vapid   the Web Push key pair {publicKey, privateKey}, generated on first use when the
--           VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars are unset (src/lib/server/vapid.ts).
--           Never replace it: every phone's push subscription is tied to that public key.
--
-- Holds secrets (the VAPID private key). Idempotent, RLS on with no policies, never shipped to
-- clients (same rules as 001).

create table if not exists server_config (
  key text primary key,
  value jsonb not null,
  created_at timestamptz not null default now()
);

alter table server_config enable row level security;
