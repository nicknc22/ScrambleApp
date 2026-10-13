# Scramble

A phone-first web app for one gloriously stupid 18-hole team scramble: Saturday, October 24, 2026, Jack Frost National, about 10 players in teams of 3 and 4. Everyone opens one link, taps their name, and is scoring in under a minute: no App Store, no accounts. Drinks are strokes, threesomes get ghost beers so they can keep up with the foursomes, the groom gets one divine do-over, the money pots settle themselves, and a fully unhinged live feed roasts everyone. It keeps working with no cell signal and catches up when it finds a bar.

**What it does**

- **Join in seconds:** the trip link shows the roster, you tap your name, and the phone remembers it. It installs to the Home Screen as an app.
- **Play screen:** one-thumb score stepper with a live net preview, whose tee shot was used (with drive-minimum warnings), Drink / Shotgun / Shot buttons per teammate with an optional photo of the empty, a 10-second undo on everything, and mulligans (earned from shotguns and shots, plus the Groom's Mulligan with full-screen fanfare).
- **Drink math:** every drink is -1 on the team's open hole. Threesomes earn credit as if they had four drinkers (every third drink is a 👻 ghost beer worth 2).
- **Live leaderboard:** gross, drinks, credit, net and net to par, plus Drinkers, Contests and Drives boards. Tap a team for its hole-by-hole card.
- **The feed:** birdies, blow-ups, ghost beers, shotguns, lead changes, score edits ("changed hole 6 from a 5 to a 4"), commissioner overrides, photos, posts and reactions. Optional AI roasts.
- **Contests:** long drive on every par 5, measured by GPS from the hole's tee point. Closest to pin on every par 3, with a shared green plot and an optional AI judge that roasts but never decides.
- **Money:** a team match pot and one pot per contest hole, live projections, settle-up in the fewest payments, and Pay with Venmo buttons. The app never moves money.
- **After the round:** awards, a photo gallery with a download-all zip, and a shareable recap card.
- **Commissioner:** PIN-unlocked setup (roster, drag-and-drop teams, satellite-map tee points, pots, settings) and the power to fix any score, drink or contest entry. Every fix posts to the feed as a Commissioner override.
- **Offline-first:** every tap is saved on the phone first and synced exactly once when the signal comes back.
- **Demo mode:** a fake trip with 10 fake degenerates and a simulated round, one tap from the home page.

## Quick start

You need Node 20.9 or newer (22 is what we use).

```bash
npm install
npm run dev
```

Open http://localhost:3000 and tap **Try the demo**. With no configuration the app uses an embedded Postgres (PGlite) in `.data/pglite` and stores photos in `.data/uploads`, so it runs with zero setup. AI, push and Realtime are simply off until you add their keys.

The demo is a fake trip: you are its commissioner (PIN `0000`), and **Menu → Settings → Demo mode** can reset it, replay it as a finished round, or put it back in setup. From a terminal: `npm run demo` (round in progress), `npm run demo -- --mode full` (finished and finalized), `npm run demo -- --mode setup`.

## How it works

Read [CLAUDE.md](CLAUDE.md) for the architecture, conventions and every rule the reducer enforces, and [docs/SPEC.md](docs/SPEC.md) for the product spec (it's the source of truth for game rules). The short version: every change is an op that the phone applies instantly and queues in IndexedDB; the server applies the same reducer under a per-trip lock and writes Postgres; a Realtime broadcast tells every other phone to refetch. All scores, nets, pots and awards are derived from raw rows by one pure engine shared by the phone and the server.

## Deploy (Supabase + Vercel)

Budget about 30 minutes. Both free tiers are plenty.

### 1. Supabase (database, photos, live updates)

1. Create a project at [supabase.com](https://supabase.com). Pick the region closest to you (for example US East) and save the database password.
2. **Database URL:** click **Connect** and copy the **Transaction pooler** connection string (host `*.pooler.supabase.com`, port **6543**). Put your password in it. If the password has special characters, URL-encode them (or pick a password without any). This is `DATABASE_URL`. Don't use the direct connection (port 5432): serverless functions need the pooler.
3. **Keys:** in **Project Settings → API Keys**, copy the project URL, the `anon` key and the `service_role` key. Use the legacy JWT keys (they start with `eyJ`). These are `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
4. That's it for Supabase. You don't run any SQL: the tables are created automatically on the first request. The public `photos` storage bucket is created automatically on the first upload. Realtime needs no table setup because the app uses broadcast messages, not database change feeds. (Row-level security is on with no public policies: browsers never touch the database directly.)

### 2. Secrets you generate on your laptop

```bash
npm run hash-pin -- 2468        # your commissioner PIN (4-12 digits) -> COMMISSIONER_PIN_HASH
npm run vapid-keys              # Web Push keys -> VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
openssl rand -base64 32         # optional APP_SECRET (signs the commissioner cookie)
```

`hash-pin` prints one line like `scrypt:<salt>:<hash>`. Paste it as is (it has no `$`, so nothing needs escaping).

For AI roasts, team names and the closest-to-pin judge, create an API key at [console.anthropic.com](https://console.anthropic.com) (`ANTHROPIC_API_KEY`). Expect a few dollars for the round. Everything works without it.

### 3. Vercel (hosting)

1. Push this repo to GitHub, then in Vercel: **Add New → Project → Import** the repo. The framework preset is Next.js. Leave the build settings alone.
2. Add the environment variables below (all environments), then **Deploy**.
3. **Settings → Functions → Function Region:** pick the region next to your Supabase project (Washington, D.C. `iad1` for Supabase `us-east-1`). Every sync is a few database round trips, so this matters. Redeploy after changing it.
4. Vercel only applies environment variable changes on the next deploy. After editing any of them, redeploy.

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Supabase transaction pooler URL (port 6543). Unset = local PGlite (dev only). |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | `https://<project>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon key. Phones use it only to listen for "something changed" broadcasts. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server only: photo uploads and Realtime broadcasts. Without it photos land on the function's disk, which Vercel throws away. |
| `COMMISSIONER_PIN_HASH` | yes | From `npm run hash-pin -- <pin>`. Required to create a trip in production; also the starting PIN of each new trip. |
| `ANTHROPIC_API_KEY` | no | AI judge, roasts and team names. Unset = AI silently off. `AI_JUDGE_MODEL` / `AI_FAST_MODEL` override the defaults (`claude-sonnet-5-5`, `claude-haiku-5-5`). |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | no | From `npm run vapid-keys`. Unset = push notifications off. |
| `VAPID_SUBJECT` | no | A `mailto:you@example.com` contact for push services. |
| `APP_SECRET` | no | Cookie-signing secret. Falls back to a hash of the service key. |
| `PGLITE_DIR`, `UPLOADS_DIR` | no | Local dev only: where PGlite and photos live (default `.data/pglite`, `.data/uploads`). |

### 4. Create the real trip

1. Open your Vercel URL on your phone → **Commissioner → Create the trip**. Name it, enter your PIN. You land in **Setup**.
2. Fill in the roster (nickname, Venmo handle, groom flag), drag players into teams, set tee times, set the pots, and place the tee and green points on the satellite map (at minimum the four par 5 tees, or long drive can't measure). Optional: `DATABASE_URL=... npm run osm-import -- --code <code>` tries to prefill points from OpenStreetMap.
3. Send `https://<your-app>/t/<code>` to the group chat. Everyone taps their name and adds it to their Home Screen.
4. On Saturday, **Setup → Start round** when the first group is on the tee.

## Testing

```bash
npm test              # vitest: engine, reducer, server and API against in-memory PGlite
npm run typecheck
npm run lint
npm run test:e2e      # Playwright (Chromium, iPhone 13 viewport) against a production build on port 3100
```

`test:e2e` builds the app and runs `next start` with a throwaway PGlite database. If Chromium isn't installed yet: `npx playwright install chromium`. Set `E2E_PORT` to use another port (an already-running server on that port is reused).

## The commissioner's 15-minute dry run (do this before Saturday, on your own iPhone)

Use a throwaway trip so you exercise exactly what Saturday uses. Check each box:

- [ ] **Create (1 min).** On your iPhone, open the deployed URL → **Commissioner → Create the trip** "Dry Run" with your real PIN.
- [ ] **Roster + teams (2 min).** Add yourself (groom, your real Venmo handle) and 4 fakes. Make a threesome (with you) and a twosome by dragging players between teams. Tap **Generate names**, re-roll, pick one. Set tee times.
- [ ] **Pots (30 s).** $20 team match with a 70/30 split, $5 per contest hole. Opt one fake out of one pot.
- [ ] **Course (2 min).** On the satellite map, place the tee and green for holes 1, 3 and 4 (hole 4 is a par 5: its tee is what long drive measures from).
- [ ] **Join like a player (2 min).** Copy the `/t/<code>` link, open it in Safari, tap your name, try **Not you?** and back. Follow the onboarding: Share → **Add to Home Screen**, open the app from the icon, allow location and notifications (both one-line asks).
- [ ] **Start (10 s).** **Setup → Start round.** The feed says so.
- [ ] **Play three holes (3 min).** Tap **On the tee**, log a Drink, a Shotgun with a photo of the empty, and a drink for a teammate; undo one within 10 seconds. Enter scores and whose tee shot. Use an earned mulligan, then the **Groom's Mulligan** (fanfare). On hole 3, edit hole 1 from the scorecard strip and watch the feed post the edit. A threesome's 3rd drink should post a 👻 ghost beer.
- [ ] **Airplane mode (2 min).** Turn on airplane mode. Log a score, two drinks and a post. Force-quit the app and reopen it: everything is still there and the badge says "Offline, N changes waiting". Turn airplane mode off: the badge clears and a second phone or laptop shows it all within seconds.
- [ ] **Contests (2 min).** **Settings →** tap the version line 7 times (dev mode) → **GPS simulator**: drop yourself about 280 yards down hole 4 → Play → **Measure drive** → photo → see where it ranks. On hole 3, **Closest to pin**: photo, 8 ft 6 in, drag the marker around the pin.
- [ ] **Commissioner fixes (1 min).** **Setup → Commissioner tools:** override a score and move a drink to another hole. The feed shows a Commissioner override and the leaderboard recomputes.
- [ ] **Money (1 min).** The Money tab shows live projections. On a settle-up payment to your own Venmo handle, tap **Pay with Venmo**: Venmo should open with the amount and note filled in. Back out without paying.
- [ ] **Finalize + awards (1 min).** **Setup → Finalize round.** Check the Awards, open the gallery, download one photo and the zip, share the recap card.
- [ ] **Reset.** Don't reuse the dry run for Saturday: create the real trip fresh (section 4 above) and open its link once so the Home Screen icon goes there. In **Settings → GPS simulator**, tap **Turn off** so your phone uses real GPS on Saturday.

Short on time? **Try the demo** gives you a round already in progress; **Settings → Demo mode → Replay as full round** jumps straight to awards and settle-up.

## Day-of fallback

- **Each cart keeps a paper scorecard.** If a phone dies, any teammate's phone can score for the team. If the app or the server goes down, keep playing on paper and enter it afterward.
- **The commissioner can fix anything** in **Setup → Commissioner tools**: any score, drink (delete or move to another hole), contest entry (approve, flag or set the official distance), or a team's current hole. Every number (nets, ghost beers, standings, pots, awards, settle-up) recomputes from the raw data, and every fix posts to the feed.
- Drinks logged late land on the team's open hole; move them to the right hole if it matters.
- **No signal is normal:** everything queues on the phone and syncs exactly once later. Keep the app open for a few seconds once you're back in signal.
- Weak GPS on a long drive: after 3 tries the entry can be submitted for commissioner review. A wrong tee point can be fixed on the Course screen mid-round and every drive on that hole re-measures.

## Verify on a real iPhone before Saturday

- **Venmo deep link:** Pay with Venmo should open the Venmo app with recipient, amount and note prefilled. If it doesn't, the Money tab still shows the handle and amount with a copy button.
- **Push notifications** only work in the Home Screen app on iOS 16.4 or later, after you allow them from a tap inside the app. Check that a lead change actually pings another phone.
- **Camera:** taking a photo from the drink, contest and post buttons works, and iPhone HEIC photos arrive as JPEGs (they're converted on the phone).
- **GPS accuracy:** stand in an open area and Measure drive; it wants 12 m or better. Under trees or next to buildings it may need the 3-try weak-GPS fallback.
- **Offline launch:** with airplane mode on, open the Home Screen app from cold. It should show the last state, not a Safari error page.

## Open items (from the spec)

- [ ] App name
- [ ] Which tees the group plays (Membership is the default; yardage is display only)
- [ ] Ante amounts and team match payout (winner take all or 1st/2nd split)
- [ ] Penalty, if any, when a player's drive isn't used on a nine (the app only flags it)
- [ ] Venmo handles for each player
- [ ] Supabase, Vercel and Anthropic accounts and keys ready

All of the game settings live in the trip's Setup and change without a redeploy.

## Troubleshooting

- **"Trip creation is locked: the server has no COMMISSIONER_PIN_HASH set."** Add `COMMISSIONER_PIN_HASH` in Vercel and redeploy.
- **"The server's COMMISSIONER_PIN_HASH is mangled."** An old `scrypt$...` hash got eaten by a `.env` file. Run `npm run hash-pin -- <pin>` again and paste the new `scrypt:...` value.
- **Wrong PIN, now "Easy, tiger."** Too many wrong PINs from one phone. Wait 10 minutes. You can change a trip's PIN in Setup → Settings.
- **Server errors on every request / can't connect to the database.** Use the transaction pooler URL on port 6543, check the password (URL-encode special characters), and make sure the Supabase project isn't paused (free projects pause after a week of no use: open the dashboard to wake it).
- **Live updates take ~20 seconds.** Realtime isn't connected, so phones are polling. Check all three Supabase variables, redeploy, and in Supabase **Project Settings → Realtime** make sure public channels are allowed. Scores still sync either way.
- **Photos disappear or show as broken.** `SUPABASE_SERVICE_ROLE_KEY` is missing, so photos were saved on Vercel's temporary disk. Set it and redeploy (new photos will go to the `photos` bucket).
- **No push notifications.** The phone must use the Home Screen app (iOS 16.4+), have notifications allowed in iOS Settings, and not be muted in the app's Settings. Both VAPID keys must be set.
- **No roasts or AI judge.** `ANTHROPIC_API_KEY` is missing, roasts are off in Setup → Settings, or the 40-roast cap is used up. AI failures are silent by design: check the Vercel function logs.
- **The app looks out of date after a deploy.** The service worker serves the cached shell first. Close the app completely and reopen it.
- **Local scripts hang or say the database is busy.** PGlite can only be opened by one process: stop `npm run dev` before `npm run demo`, `create-trip` or `osm-import`.
- **"Easy, tiger. That's a lot of fake golf."** The demo endpoint is rate limited. Wait a minute.
- **e2e can't start.** Something else is on port 3100: stop it, or run with `E2E_PORT=3200 npm run test:e2e`.
