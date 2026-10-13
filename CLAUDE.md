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
- **Offline:** service worker (`public/sw.js`, hand-written) caches the app shell + static assets; the last snapshot and the outbox live in IndexedDB, so every screen loads with no signal. Photos queue as blobs in IndexedDB and upload in their own lane; ops that reference them sync right away (deterministic paths), so a slow photo never holds up scores. Server rejections are kept per trip and listed under the header's ⚠️ chip.
- **Home Screen:** each trip page links its own manifest (`/t/<code>/manifest.webmanifest`, `start_url` = the trip) because iOS gives installed apps separate storage from Safari.
- **Database:** `DATABASE_URL` (Supabase Postgres via the Supavisor transaction pooler, `postgres` driver with `prepare: false`) or, when unset, PGlite (embedded Postgres, `PGLITE_DIR`, default `.data/pglite`; `memory://` in tests). Same SQL either way: `db/migrations/*.sql`, applied automatically on first use.
- **Photos:** Supabase Storage bucket `photos` (public, unguessable paths `trips/<trip_id>/<kind>/<uuid>.jpg`) when `SUPABASE_SERVICE_ROLE_KEY` is set; else local files under `UPLOADS_DIR` (default `.data/uploads`) served by `/api/photos/[...path]`. Uploads go through `POST /api/t/<code>/upload`.

## Environment variables

| Var | Used for |
| --- | --- |
| `DATABASE_URL` | Supabase Postgres (pooler, transaction mode, port 6543). Unset → local PGlite. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Realtime broadcast subscription; storage public URLs. Unset → polling. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server: storage uploads, realtime broadcast. Unset → local uploads, no broadcast. |
| `ANTHROPIC_API_KEY` | AI judge (`claude-sonnet-5-5`), roasts and team names (`claude-haiku-5-5`). Unset → AI silently off. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push. Optional: without both keys the server generates a pair once, stores it in `server_config` (migration 005) and reuses it forever (`src/lib/server/vapid.ts`; changing keys breaks every phone's subscription). Only the public key reaches clients (snapshot meta). `VAPID_SUBJECT` defaults to `mailto:scramble@example.com`. |
| `PUSH_DISABLED` | `1` turns Web Push off entirely (snapshot `push_enabled: false`, nothing sent). |
| `COMMISSIONER_PIN` | Plain 4-12 digit PIN, typed straight into Vercel (the recommended simple option). This or `COMMISSIONER_PIN_HASH` is required to create a real trip; it's the default PIN for new trips (each trip stores its own scrypt hash, never the PIN; changeable in Settings). Set but not 4-12 digits → trip creation refuses with `not_configured`. Read via `auth.serverPin()`. |
| `COMMISSIONER_PIN_HASH` | Optional alternative that keeps the PIN out of the env; wins when both are set. Format `scrypt:<salt>:<hash>` from `npm run hash-pin -- <pin>` (no `$`, so `.env` files don't mangle it). |
| `APP_SECRET` | Optional cookie-signing secret (falls back to a hash of the service key / PIN hash / plain PIN). |
| `AI_JUDGE_MODEL`, `AI_FAST_MODEL` | Optional model overrides (defaults `claude-sonnet-5-5`, `claude-haiku-5-5`). |
| `DEMO_AI` | `1` lets public demo trips use the AI (off by default so "Try the demo" can't spend API credit). |

## Conventions

- TypeScript strict, `@/` → `src/`. Rows/DB columns are snake_case; local variables camelCase.
- Money is integer cents everywhere. Display with `formatCents`.
- Engine and reducer are pure: no `Date.now()`, no randomness, no I/O. Time comes from `op.at` / `ctx.now`; ids come from ops or `deriveId(...)`.
- Reducer returns new arrays only for tables it changed (memoization relies on identity).
- Client-only modules start with `"use client"` or live under `src/lib/client`/`src/components`. Server-only modules live under `src/lib/server` and `import "server-only"` is NOT used (scripts import them via tsx); never import `src/lib/server/*` from client code.
- Server code that catches a failing query inside `db.tx` must use a nested `tx` (savepoint); on postgres.js the nested tx uses the driver's scoped `savepoint()` (a hand-rolled ROLLBACK TO SAVEPOINT can't recover there).
- Post-commit integrations (AI judge, roasts, push) register via `registerPostCommitHook` in `src/lib/server/integrations.ts`, which the sync route imports for its side effect; hooks run in `after()` and must never throw.
- Tests: vitest files under `tests/` mirroring `src/lib` (`tests/engine/*.test.ts`, `tests/reducer.test.ts`, `tests/server/*.test.ts`). Fixtures: `tests/fixtures.ts` builds TripStates.
- Feed copy is fully unhinged; profanity OK. Roast golf, drinking and on-course decisions only — never partners/fiancées, families, jobs or appearance.

## Reducer semantics (`applyOp`)

General rules, checked in this order:
1. Commissioner-only ops (`COMMISSIONER_ONLY_OPS`) and any op with `as_commissioner: true` require `ctx.is_commissioner` → else `forbidden`.
2. Play ops (`tee.open`, `round.complete`, `score.set`, `teeshot.set`, `drink.log`, `drink.delete`, `mulligan.use`, `mulligan.undo`, `contest.submit`, `contest.delete`) require `trip.status === "live"`; a commissioner op (`as_commissioner`) may also edit while `final`. On the server a late sync is also accepted while `final` when `op.at ≤ finalized_at + 2 min` and it arrives within 12 h of the finalize (it happened during the round). Otherwise `not_live`.
3. `post.create`, `reaction.set`, `feed.delete`, `player.mute` work in any status. `pot.optout` by a player only while `setup`; the commissioner any time.
4. Creating a row whose id already exists (`drink.log`, `mulligan.use`, `contest.submit`, `post.create`) is an idempotent no-op (`ok`, no writes).
5. Timestamps: `created_at`/`updated_at`/`deleted_at` = `ctx.now`; client-time fields (`logged_at`, `used_at`, `strokes_at`, `tee_shot_at`, `hole_opened_at`, `completed_at`) = `op.at`.
6. New row ids: the id carried by the op (`drink_id`, `entry_id`, ...), else `op.id`, else `deriveId(op.id, <discriminator>)` when one op creates several rows.

Per op:
- `tee.open {team_id, hole}`: team active, hole 1..18. Creates the team's `team_round_state` if missing. `complete` → `conflict` (unless commissioner). If `open_hole !== null && hole <= open_hole` → no-op (window only moves forward; repeated taps are harmless). Else `open_hole = hole`, add to `started_holes` (sorted, unique), `hole_opened_at[hole] = op.at` (keep first), `status = "playing"`.
- `round.complete {team_id}`: sets `status = "complete"`, `completed_at = op.at` (already complete → no-op). Leaves `open_hole`.
- `score.set {team_id, hole, strokes, if_empty?}`: strokes integer 1..20. Upsert the `(team_id, hole)` row (reuse its id; new row id = `deriveId(team_id, String(hole))`). `if_empty` (an untouched par default) only fills an empty hole — already scored → silent no-op. LWW: if the row's `strokes_at` is later than `op.at` → `conflict` when the stored value differs (the losing phone gets a toast; the feed posts an "overruled" edit), no-op when equal. Otherwise set strokes, `strokes_at = op.at`, `updated_by = op.by`; `edit_count += 1` when it changes an existing non-null value. **Implicit window:** if `hole === (open_hole ?? 0) + 1` and the round isn't complete, also open that hole exactly like `tee.open` ("entering any data for hole N+1 closes N").
- `teeshot.set {team_id, hole, player_id}`: player must be a current member of the team (or null). Same upsert, LWW on `tee_shot_at` (stale + different → `conflict`), same implicit window rule.
- `drink.log {drink_id, team_id, player_id, hole, drink_type, photo_path}`: player must be a member of the team. On the **client** (`ctx.side === "client"`) reject `no_window` when the team has no open window (not teed off on hole 1, or round complete). The server stores the client-stamped hole (1..18) so offline phones can't lose drinks; the engine then credits the drink to its *effective* hole (see decisions) and ignores drinks logged > 2 min after the team's Round complete; the server also refuses (`no_window`) a drink whose `op.at` is > 2 min after a `completed_at` it already knows. The client store re-applies already-queued ops with side `"server"` (the window check happens once, at dispatch). `settings.drink_cap` (null = none) is **per player** → `conflict` when reached (commissioner overrides skip it). Row: `logged_at = op.at`, `logged_by = op.by`.
- `drink.delete {drink_id}`: soft delete (`deleted_at`, `deleted_by`); already deleted → no-op; missing → `not_found`; `op.by` must be on the drink's team unless commissioner (`forbidden`). Anything but a quick self-undo posts a "removed" feed event.
- `drink.move {drink_id, hole}` (commissioner): set `hole`; set `moved_from_hole` to the original hole the first time. Moving a drink to its own stamped hole pins it there (stops the engine re-homing it). A commissioner back-fill (`drink.log` with `as_commissioner` onto a hole that isn't the open window) is stored pinned the same way.
- `mulligan.use {mulligan_id, team_id, hole, source}`: `earned` needs `available > 0` (active shotgun+shot drinks minus active earned uses) else `conflict`. `groom` needs the groom on this team and no active groom use in the trip, else `conflict`. Refused after the team's round is complete (2 min grace) unless commissioner.
- `mulligan.undo {mulligan_id}`: soft delete; `op.by` must be on the team unless commissioner.
- `contest.submit`: hole must have `contest === contest_type`. Player must be on a team (entry.team_id = player's team); a non-commissioner can only enter for themselves or a teammate. Soft-delete the player's other active entries on that hole ("re-measure replaces"). ctp: unit `ft`, distance 0..200, status `ok`; a re-entry on the SAME photo carries the AI verdict (suspicious recomputed for the new claim). ld: unit `yd`, distance 0..700; `low_accuracy` → `flagged` ("GPS was weak"); `simulated` → `flagged` ("Simulated GPS") unless commissioner/demo; the 100–400 yd range is NOT stored — the engine checks it against the current tee point. Commissioner-entered entries are `overridden` (official). `photo_path` must be a path of this trip.
- `contest.delete`: soft delete (the entry's player or a teammate, or the commissioner). `contest.review` (commissioner): set `status` and, if present, `distance_override`.
- `post.create {event_id, text, photo_path}`: needs text (≤ 1000 chars, trimmed) or a photo of this trip; capped at 1500 posts per trip (150 on demo trips). Inserts a `post` feed event (`player_id = actor_id = op.by`, `team_id` = their team).
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

## Decisions from the review round (Oct 13)

- **Round net = sum of hole nets over SCORED holes** (spec "Round net = sum of hole nets"). Standings `drinks`/`credit`/`net`/`net_to_par` count scored holes only; drinks on not-yet-scored holes are `pending_drinks`/`pending_credit` ("banked") and join the net when the hole is scored. Feed `lead_change` posts only when the SOLE leader changes (ties don't post).
- **Effective drink hole:** the engine credits a drink to the hole whose window was open at `logged_at` per the team's `hole_opened_at` times (never earlier than the stamped hole; commissioner-moved drinks keep their stored hole). Fixes stale/dead-zone phones stamping the previous hole. The server rejects (`no_window`) a drink whose `op.at` is more than 2 min after the team's `completed_at` (unless commissioner).
- **Late sync after finalize:** play ops whose `op.at` ≤ `finalized_at` + 2 min are still applied to a final trip (they happened during the round). Fresh play ops after that get `not_live`.
- **Stale LWW edits are rejected** (`conflict`, "Hole 6 already got a newer edit: 4") when the stored value differs, so the losing phone gets a toast instead of silent success. Same value → no-op. The server answers a resend of a previously rejected op with the recorded rejection (not "duplicate").
- **Photos never block ops:** ops referencing a photo sync immediately (the path is deterministic); the blob uploads independently. Upload failures don't mark the phone offline. A ctp photo arriving after its entry triggers the AI judge from the upload route.
- **Cross-team deletes are forbidden** for non-commissioners: `drink.delete`/`mulligan.undo` need `op.by` on the row's team; `contest.delete` needs `op.by` = the entry's player or a teammate.
- `photo_path` must match `trips/<trip_id>/<drinks|ld|ctp|posts>/<uuid>.jpg` (shared `src/lib/photos.ts`).
- Long-drive range is derived (engine re-checks `ok` entries against the CURRENT tee point and range); the reducer only stores `flagged` for weak GPS or simulated GPS.
- Mulligans can't be used after the team's round is complete (unless commissioner).
- The GPS simulator (dev tool) is only offered to the commissioner, on demo trips, or outside production; long drives measured with it are sent with `simulated: true` and stored flagged ("Simulated GPS") unless commissioner/demo.
- Abuse limits (migration `002_abuse_limits`): DB-backed PIN-failure throttle with a trusted-device cookie for the commissioner's own phone; commissioner cookies are bound to the current PIN hash (changing the PIN revokes them); 4 MB JPEG uploads with per-trip photo quotas; hourly demo-creation cap and cleanup of demo trips older than 48 h; AI judge capped per trip and per player per hole.
- **After finalize** (round 3): late syncs are accepted only within 12 h (server time) of the finalize; while final, lead changes, contest leads and roasts don't post (the AI judge doesn't roast either); any change to champions, standings or settle-up posts one loud `results_changed` card + push to everyone, and the commissioner can Reopen to review.
- **Removals are visible:** deleting someone else's drink/entry/mulligan, or your own after 60 s, posts a `removed` feed event.
- **Drink undo is inline** (a chip on the newest drink's row for 10 s, per hole burst) — never a toast, so nothing can cover Save / On the tee. The untouched par default on "tee off next hole" is sent with `if_empty` so it can't overwrite a teammate's real score.
- **Clock correction:** each fresh `GET /state` teaches the phone its offset from the server clock (`src/lib/client/clock.ts`, median of samples, only offsets > 30 s); ops are stamped with server-corrected time. The engine also re-homes a drink to a later hole only when it was logged > 2 min after that hole opened.
- **Weak par defaults (round 4):** `score.set` with `if_empty` that fills an empty hole stores `strokes_at = null`; any real `score.set` replaces it regardless of client times, and replacing a default is not an edit (no edit_count, no score_edit/overruled post). Demo trips stop accepting ops after 3000 applied ops. `results_changed` posts only when champions, a position label or settle-up payments change; its push bypasses the throttle. Photo compression runs without any third-party CDN (no web worker) under a timeout, and photo actions stamp hole and time at tap.
- Tied team-match places split per MEMBER across the tied teams (each player antes the same) — documented choice; spec wording "tied teams split" is ambiguous. Flagged to the user.

## Onboarding (Oct 13, round 5)

Deviates from the spec's first-run wizard (SPEC "Onboarding", location asked at join). The user's ask: send the link, the boys just use it; no player PIN.

- **Default roster** (`src/lib/roster.ts`, pure): `DEFAULT_ROSTER` = Caster (groom, `is_groom: true`), Joe, Greg, Rich, Reitman, Drew, Will, Ross, Conner, Mark. The FIRST name is the commissioner. The home page create form pre-fills "Who's playing" with it (one name per line, plus a groom picker defaulting to Caster). Clearing the box creates an empty trip, as before.
- **`POST /api/trips` `roster`** (optional): names or `{name, is_groom?}`, at most 40, unique case-insensitively, names ≤ 80 chars, at most one groom (`validateRosterInput`). A bad roster gets a 400 `invalid` BEFORE the PIN check, so it never counts as a wrong PIN. `createTripWithRoster` builds the players with the reducer's `player.upsert` (commissioner, server side; same rows as Setup, `sort_order` 0..n-1) and writes them in the trip's transaction. No feed events and no `applied_ops`. The response adds `players: [{id, name}]` in roster order, and the creating phone `saveMe`s `players[0]`, so it lands in Setup already as the commissioner's player. `createTrip` (trip only) still exists for scripts and tests.
- **Create form groom picker:** a pick follows its line when the name is respelled (`carryGroomChoice`); a picked name that's gone is "No groom yet" + "pick the groom again", never a silent fallback to Caster (`resolveGroomIndex`).
- **Setup → Roster:** an empty roster shows **Load the boys**: one `player.upsert` per default player, Caster crowned, one 10 s Undo for the batch. The phone becomes the first name, since the roster was empty and it couldn't be anybody yet. **Add several at once** takes a pasted list and adds only names not already on the roster (case-insensitive), with a "Fill in the crew" shortcut; with no groom on the roster, Caster comes back crowned (`bulkAddEntries`). With players, the roster leads with **Send the link** (also Menu → Send the trip link): `navigator.share` of the clean `<origin>/t/<code>` (never `?tab=`/`?me=`), else copied (`src/components/shell/shareLink.ts`). The roster marks this phone's player "(you)".
- **No blocking wizard:** tapping your name on "Who are you?" goes straight into the app (no PIN). `Onboarding.tsx` and the `scramble:onboarded` pref are gone.
  - With no PIN the name is the only check, so the phone always says who it is: a "You're in, Joe." toast with a **Not you?** action on pick (and once when the Home Screen app adopts its player), and a "You're Joe · Not you?" line at the top of `WaitingForStart`.
  - Pre-round, `WaitingForStart` leads with an optional **Get set up** card (`src/components/join/GetSetUp.tsx`, rules in `getSetUp.ts`) with two rows: Add to Home Screen (opens `InstallGuide`) and turn on notifications. Notifications are hidden when push is off; on iPhone Safari the row is greyed out ("add it to your Home Screen first") and the intro counts only what can be done now.
  - While live (later groups open the link after Start and land on Play), Play shows the same thing as ONE compact row (the next thing to do + Hide), below the scorecard so the chips and stepper keep the first screen.
  - Hide is remembered per trip on this device (`scramble:get-set-up-hidden:<code>`), so hiding it on the dry run doesn't hide it on Saturday. It also hides once everything is done.
  - Location isn't asked up front: the first **Measure drive** (and the commissioner's "use my location" on the course map) asks via `measurePosition`, which waits for the "Allow location?" answer with a one-shot request BEFORE the sampling window starts, so reading the prompt never costs a GPS try. The long-drive idle card says why first.
- **Carrying who you are into the Home Screen app** (iOS gives it separate storage). **iPhone/iPad only** (`carriesIdentityInUrl(detectPlatform())`): Android/desktop installs share the browser's storage, and an installed Android app opens tapped in-scope links standalone, so there a `?me=` must never be adopted.
  - Once the trip has loaded, `TripShell` runs `syncHomeScreenIdentity`. On iOS it points `<link rel="manifest">` at `/t/<code>/manifest.webmanifest?me=<player id>` and adds `me=<id>` to the address bar via `replaceState`; with no player, or off iOS, it drops both.
  - Before the trip loads (Splash, LoadError), `TripShell` drops any `me` that isn't this phone's own stored player (`dropForeignMe`; off iOS, any `me`), deferred one task so Next.js has hooked `history.replaceState`. So a shared link carrying the sender's `me` is never what Add to Home Screen saves.
  - The manifest route echoes a single well-formed uuid `me` into `start_url` (`/t/<code>?source=homescreen&me=<id>`); `id` stays `/t/<code>`. The server-rendered link never carries `me`.
  - `TripApp` adopts `?me=` (`adoptMeFromLaunch`) ONLY on iOS, running standalone, AND with no player stored for this trip. A normal browser tab never changes who you are; it strips a foreign `me` and asks. An unknown id falls back to "Who are you?".
  - The service worker answers an uncached `?me=` manifest variant offline from any cached copy, with `start_url`'s `me` rewritten.
  - The commissioner cookie is still per storage: unlock with the PIN once in the Home Screen app.

## Derived rules worth restating

- Ghost beer: `credit(d) = floor(base_team_size * d / n)` over the team's COUNTED drinks (active, not logged after Round complete + 2 min) ordered by `(logged_at, id)`; value = credit(d) − credit(d−1); value > 1 is a ghost beer. Deleting/moving recomputes everything.
- Hole net = strokes − credit on that hole (can be ≤ 0). Round net = gross − total credit. Leaderboard sorts by net to par (= net once all are thru 18); ties share a position ("T2").
- Mulligans never change score math.
- Drive minimum per nine: soft (yellow) when someone needs a drive and ≤ 3 holes remain; hard (red) when remaining = players needing; a nine that closes with a player at 0 posts a callout (no automatic penalty).
- Hole scores LWW is by **client** timestamp (`op.at`), not server arrival (deviation: an offline phone syncing late must not clobber a newer correction made on another phone). Every effective change still posts a "changed hole X from A to B" feed event.
- Pots are virtual: `team_match` plus `contest:<hole>` per contest hole, antes from settings. Tied team-match places split per member across the tied teams. Contest pots with no eligible valid entry once every team has passed the hole roll to the next contest hole of the same type, then into the team match. Unplayed contest holes are `pending` in projections and excluded from the ledger.

## UI guidelines

Single client-rendered page per trip: `/t/[code]` with tabs Play · Leaderboard · Feed · Contests · Money (+ Setup for the commissioner, Awards when final). Tap targets ≥ 48px, light high-contrast theme (readable in sunlight), one-handed (primary actions in the bottom half), 16px side gutters, no horizontal scroll at 360px wide. Groom badge 👑 next to the groom's name everywhere. Big fanfare overlays for ghost beers and the Groom's Mulligan. Every log has a 10-second undo.
