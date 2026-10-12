# Scramble App

Mobile-first PWA for one 18-hole team scramble (Sat Oct 24, 2026, Jack Frost National). The full product spec is `docs/SPEC.md` — read the sections relevant to your task; it is the source of truth for game rules. This file records the architecture, conventions and decisions that refine or deviate from the spec.

@AGENTS.md

## Commands

- `npm run dev` — local dev. With no `DATABASE_URL` it uses an embedded PGlite database in `.data/pglite` and stores photos in `.data/uploads`, so the app runs with zero setup.
- `npm test` — vitest (unit + server integration tests against in-memory PGlite). `npx vitest run tests/engine` to run a subset.
- `npm run typecheck`, `npm run lint`, `npm run build`
- `npm run test:e2e` — Playwright (Chromium, iPhone 13 viewport) against `next start` with a throwaway PGlite DB.
- `npm run hash-pin -- 1234` — prints a `COMMISSIONER_PIN_HASH`.

## Architecture

```
phone ──dispatch(op)──> reducer (optimistic) ──> IndexedDB outbox (Dexie)
                                                   │ sync worker (online, backoff)
                                                   ▼
                     POST /api/t/<code>/sync  ──>  server: per-trip lock → same reducer → Postgres
                                                   → feed events → broadcast "changed" (Supabase Realtime)
phones <── GET /api/t/<code>/state (full snapshot) <── on broadcast / poll / focus / online
```

- **Raw rows are the source of truth** (`src/lib/types.ts`, snake_case = DB columns). Everything derived (drink values, ghost beers, nets, standings, drive minimum, contests, pots, settle-up, awards) comes from `derive(state)` in `src/lib/engine`, a pure module shared by client and server. Never store derived values.
- **Every change is an Op** (`src/lib/ops.ts`) with a client uuid and client timestamp. `applyOp` in `src/lib/reducer.ts` is the only place op semantics live; the client runs it optimistically and the server runs it authoritatively. Ops are idempotent by id (server keeps an `applied_ops` table → exactly-once).
- **The server is the only writer.** Browsers never talk to Postgres. RLS is enabled with no anon policies. Route handlers validate the trip code and the commissioner cookie. (Deviation from spec, which had anon RLS writes + postgres_changes: RLS can't scope anonymous Realtime by trip code, so we broadcast an invalidation on topic `trip:<trip_id>` and clients refetch the snapshot. Strictly more secure, same live behavior.)
- **Live updates:** server POSTs `{SUPABASE_URL}/realtime/v1/api/broadcast` after each commit; clients subscribe with supabase-js (anon key) and refetch (debounced). Fallback: poll every 20s (every 3s when Realtime isn't configured), plus refetch on focus/online.
- **Offline:** service worker (`public/sw.js`, hand-written) caches the app shell + static assets; the last snapshot and the outbox live in IndexedDB, so every screen loads with no signal. Photos queue as blobs in IndexedDB and upload before the ops that reference them.
- **Database:** `DATABASE_URL` (Supabase Postgres via the Supavisor transaction pooler, `postgres` driver with `prepare: false`) or, when unset, PGlite (embedded Postgres, `PGLITE_DIR`, default `.data/pglite`; `memory://` in tests). Same SQL either way: `db/migrations/*.sql`, applied automatically on first use.
- **Photos:** Supabase Storage bucket `photos` (public, unguessable paths `trips/<trip_id>/<kind>/<uuid>.jpg`) when `SUPABASE_SERVICE_ROLE_KEY` is set; else local files under `UPLOADS_DIR` (default `.data/uploads`) served by `/api/photos/[...path]`. Uploads go through `POST /api/t/<code>/upload`.

## Environment variables

| Var | Used for |
| --- | --- |
| `DATABASE_URL` | Supabase Postgres (pooler, transaction mode, port 6543). Unset → local PGlite. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Realtime broadcast subscription; storage public URLs. Unset → polling. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server: storage uploads, realtime broadcast. Unset → local uploads, no broadcast. |
| `ANTHROPIC_API_KEY` | AI judge (`claude-sonnet-5-5`), roasts and team names (`claude-haiku-5-5`). Unset → AI silently off. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push. Unset → push off. |
| `COMMISSIONER_PIN_HASH` | Required to create a real trip; default PIN for new trips (each trip stores its own hash, changeable in Settings). |
| `APP_SECRET` | Optional cookie-signing secret (falls back to a hash of the service key / PIN hash). |

## Conventions

- TypeScript strict, `@/` → `src/`. Rows/DB columns are snake_case; local variables camelCase.
- Money is integer cents everywhere. Display with `formatCents`.
- Engine and reducer are pure: no `Date.now()`, no randomness, no I/O. Time comes from `op.at` / `ctx.now`; ids come from ops or `deriveId(...)`.
- Reducer returns new arrays only for tables it changed (memoization relies on identity).
- Client-only modules start with `"use client"` or live under `src/lib/client`/`src/components`. Server-only modules live under `src/lib/server` and `import "server-only"` is NOT used (scripts import them via tsx); never import `src/lib/server/*` from client code.
- Tests: vitest files under `tests/` mirroring `src/lib` (`tests/engine/*.test.ts`, `tests/reducer.test.ts`, `tests/server/*.test.ts`). Fixtures: `tests/fixtures.ts` builds TripStates.
- Feed copy is fully unhinged; profanity OK. Roast golf, drinking and on-course decisions only — never partners/fiancées, families, jobs or appearance.

## Reducer semantics (`applyOp`)

General rules, checked in this order:
1. Commissioner-only ops (`COMMISSIONER_ONLY_OPS`) and any op with `as_commissioner: true` require `ctx.is_commissioner` → else `forbidden`.
2. Play ops (`tee.open`, `round.complete`, `score.set`, `teeshot.set`, `drink.log`, `drink.delete`, `mulligan.use`, `mulligan.undo`, `contest.submit`, `contest.delete`) require `trip.status === "live"`; a commissioner op (`as_commissioner`) may also edit while `final`. Otherwise `not_live`.
3. `post.create`, `reaction.set`, `feed.delete`, `player.mute` work in any status. `pot.optout` by a player only while `setup`; the commissioner any time.
4. Creating a row whose id already exists (`drink.log`, `mulligan.use`, `contest.submit`, `post.create`) is an idempotent no-op (`ok`, no writes).
5. Timestamps: `created_at`/`updated_at`/`deleted_at` = `ctx.now`; client-time fields (`logged_at`, `used_at`, `strokes_at`, `tee_shot_at`, `hole_opened_at`, `completed_at`) = `op.at`.
6. New row ids: the id carried by the op (`drink_id`, `entry_id`, ...), else `op.id`, else `deriveId(op.id, <discriminator>)` when one op creates several rows.

Per op:
- `tee.open {team_id, hole}`: team active, hole 1..18. Creates the team's `team_round_state` if missing. `complete` → `conflict` (unless commissioner). If `open_hole !== null && hole <= open_hole` → no-op (window only moves forward; repeated taps are harmless). Else `open_hole = hole`, add to `started_holes` (sorted, unique), `hole_opened_at[hole] = op.at` (keep first), `status = "playing"`.
- `round.complete {team_id}`: sets `status = "complete"`, `completed_at = op.at` (already complete → no-op). Leaves `open_hole`.
- `score.set {team_id, hole, strokes}`: strokes integer 1..20. Upsert the `(team_id, hole)` row (reuse its id; new row id = `deriveId(team_id, String(hole))`). LWW: if the row's `strokes_at` is later than `op.at` → no-op (stale offline edit loses). Otherwise set strokes, `strokes_at = op.at`, `updated_by = op.by`; `edit_count += 1` when it changes an existing non-null value. **Implicit window:** if `hole === (open_hole ?? 0) + 1` and the round isn't complete, also open that hole exactly like `tee.open` ("entering any data for hole N+1 closes N").
- `teeshot.set {team_id, hole, player_id}`: player must be a current member of the team (or null). Same upsert, LWW on `tee_shot_at`, same implicit window rule.
- `drink.log {drink_id, team_id, player_id, hole, drink_type, photo_path}`: player must be a member of the team. On the **client** (`ctx.side === "client"`) reject `no_window` when the team has no open window (not teed off on hole 1, or round complete). The **server trusts the client-stamped hole** (1..18) so offline phones can't lose drinks. `settings.drink_cap` (null = none) → `conflict` when reached. Row: `logged_at = op.at`, `logged_by = op.by`.
- `drink.delete {drink_id}`: soft delete (`deleted_at`, `deleted_by`); already deleted → no-op; missing → `not_found`.
- `drink.move {drink_id, hole}` (commissioner): set `hole`; set `moved_from_hole` to the original hole the first time.
- `mulligan.use {mulligan_id, team_id, hole, source}`: `earned` needs `available > 0` (active shotgun+shot drinks minus active earned uses) else `conflict`. `groom` needs the groom on this team and no active groom use in the trip, else `conflict`.
- `mulligan.undo {mulligan_id}`: soft delete.
- `contest.submit`: hole must have `contest === contest_type`. Player must be on a team (entry.team_id = player's team). Soft-delete the player's other active entries on that hole ("re-measure replaces"). ctp: unit `ft`, distance 0..200, status `ok`. ld: unit `yd`, distance 0..700; `low_accuracy` → `flagged` ("GPS was weak"); outside `settings.ld_min_yd..ld_max_yd` → `flagged` ("Out of range: N yd"); else `ok`. AI fields null.
- `contest.delete`: soft delete. `contest.review` (commissioner): set `status` and, if present, `distance_override`.
- `post.create {event_id, text, photo_path}`: needs text (≤ 1000 chars, trimmed) or a photo. Inserts a `post` feed event (`player_id = actor_id = op.by`, `team_id` = their team).
- `feed.delete`: the commissioner, or the author of a `post`. Soft delete.
- `reaction.set {feed_event_id, player_id, kind, on}`: upsert by (feed_event_id, player_id, kind) — on: insert or un-delete; off: soft delete.
- `pot.optout {pot_key, player_id, out}`: pot_key must be `team_match` or `contest:<n>` for a contest hole. Upsert by (pot_key, player_id) like reactions (out = active row).
- `player.mute`: sets `muted_push`.
- `player.upsert`: create (name required) or patch. `is_groom: true` clears every other player's groom flag. `player.delete`: soft delete + remove membership.
- `team.upsert` / `team.delete` (soft delete + remove memberships; `conflict` while live if the team has scores or drinks). `team.assign {player_id, team_id|null}`: remove the player's membership, add the new one (id `op.id`); a 5th member → `conflict`.
- `hole.update {hole, patch}`: par 3..6; changing par re-derives `contest` (3 → ctp, 5 → ld, else none) unless the patch sets `contest`. Lat/lng editable any time (long-drive distances recompute from the tee point).
- `trip.update`: merge `settings`; `base_team_size` 2..4; `team_match_payout` must sum to 100.
- `trip.start`: setup → live, `started_at`. Requires ≥ 1 team, every active team 2..4 members, every active player on a team (else `conflict` with a reason naming who). Creates `not_started` round state rows (`deriveId(op.id, team_id)`).
- `trip.finalize`: live → final, `finalized_at`. `trip.reopen`: final → live.
- `round.set_state` (commissioner): set `open_hole`/`status` directly.

## Derived rules worth restating

- Ghost beer: `credit(d) = floor(base_team_size * d / n)` over the team's active drinks ordered by `(logged_at, id)`; value = credit(d) − credit(d−1); value > 1 is a ghost beer. Deleting/moving recomputes everything.
- Hole net = strokes − credit on that hole (can be ≤ 0). Round net = gross − total credit. Leaderboard sorts by net to par (= net once all are thru 18); ties share a position ("T2").
- Mulligans never change score math.
- Drive minimum per nine: soft (yellow) when someone needs a drive and ≤ 3 holes remain; hard (red) when remaining = players needing; a nine that closes with a player at 0 posts a callout (no automatic penalty).
- Hole scores LWW is by **client** timestamp (`op.at`), not server arrival (deviation: an offline phone syncing late must not clobber a newer correction made on another phone). Every effective change still posts a "changed hole X from A to B" feed event.
- Pots are virtual: `team_match` plus `contest:<hole>` per contest hole, antes from settings. Tied team-match places split per member across the tied teams. Contest pots with no eligible valid entry once every team has passed the hole roll to the next contest hole of the same type, then into the team match. Unplayed contest holes are `pending` in projections and excluded from the ledger.

## UI guidelines

Single client-rendered page per trip: `/t/[code]` with tabs Play · Leaderboard · Feed · Contests · Money (+ Setup for the commissioner, Awards when final). Tap targets ≥ 48px, light high-contrast theme (readable in sunlight), one-handed (primary actions in the bottom half), 16px side gutters, no horizontal scroll at 360px wide. Groom badge 👑 next to the groom's name everywhere. Big fanfare overlays for ghost beers and the Groom's Mulligan. Every log has a 10-second undo.
