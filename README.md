# Scramble

A phone-first web app for one gloriously stupid 18-hole team scramble: Saturday, October 24, 2026, Jack Frost National, about 10 players in teams of 3 and 4. Everyone opens one link, taps their name, and is scoring in under a minute: no App Store, no accounts. Drinks are strokes, threesomes get ghost beers so they can keep up with the foursomes, the groom gets one divine do-over, the money pots settle themselves, and a fully unhinged live feed roasts everyone. It keeps working with no cell signal and catches up when it finds a bar.

**What it does**

- **Join in seconds:** the trip link shows the roster, you tap your name, and you're in: no PIN, no account, no setup wizard. The phone remembers you, and so does the Home Screen app if you add it (a pre-round **Get set up** card offers that and notifications, both optional).
- **How it works in 40 seconds:** the first time you tap your name on a phone, a story-style cartoon (it opens with a guy shotgunning a beer) walks through scoring, drinks = strokes, ghost beers, mulligans, contests and money, greeting you by name. **Skip** (top right) any time; replay it from **☰ → How it works**, the pre-round **How it works (40 sec)** button, or **☰ → Rules & lingo → Watch**. Rather read? The pre-round screen lists the rules in seven lines, and **☰ → Rules & lingo** has them plus what "to par", "thru" and "banked" mean.
- **Play screen:** one-thumb score stepper with a live net preview, whose drive you used (with drive-minimum warnings), Drink / Shotgun / Shot buttons per teammate with an optional photo of the empty, a 10-second undo on everything, and mulligans (earned from shotguns and shots, plus the Groom's Mulligan with full-screen fanfare).
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

Open http://localhost:3000 and tap **Try the demo**. With no configuration the app uses an embedded Postgres (PGlite) in `.data/pglite` and stores photos in `.data/uploads`, so it runs with zero setup. AI and Realtime are simply off until you add their keys; push notifications need no keys (the server makes its own).

The demo is a fake trip: you are its commissioner (PIN `0000`), and **Menu → Settings → Demo mode** can reset it, replay it as a finished round, or put it back in setup. From a terminal: `npm run demo` (round in progress), `npm run demo -- --mode full` (finished and finalized), `npm run demo -- --mode setup`.

## How it works

Read [CLAUDE.md](CLAUDE.md) for the architecture, conventions and every rule the reducer enforces, and [docs/SPEC.md](docs/SPEC.md) for the product spec (it's the source of truth for game rules). The short version: every change is an op that the phone applies instantly and queues in IndexedDB; the server applies the same reducer under a per-trip lock and writes Postgres; a Realtime broadcast tells every other phone to refetch. All scores, nets, pots and awards are derived from raw rows by one pure engine shared by the phone and the server.

## Deploy (Supabase + Vercel)

Budget about 30 minutes. Both free tiers are plenty.

### 1. Supabase (database, photos, live updates)

1. Create a project at [supabase.com](https://supabase.com). Pick the region closest to you (for example US East) and save the database password.
2. **Database URL:** click **Connect** and copy the **Transaction pooler** connection string (host `*.pooler.supabase.com`, port **6543**). Put your password in it. If the password has special characters, URL-encode them (or pick a password without any). This is `DATABASE_URL`. Don't use the direct connection (port 5432): serverless functions need the pooler.
3. **Keys:** in **Project Settings → API Keys**, copy the project URL, a public key and a secret key. Either format works: the new **publishable** (`sb_publishable_...`) and **secret** (`sb_secret_...`) keys, or the legacy `anon` and `service_role` JWT keys (they start with `eyJ`; Supabase is retiring them). These are `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable / anon) and `SUPABASE_SERVICE_ROLE_KEY` (secret / service_role). Take both keys from the same project.
4. That's it for Supabase. You don't run any SQL: the tables are created automatically on the first request. The public `photos` storage bucket is created automatically on the first upload. Realtime needs no table setup because the app uses broadcast messages, not database change feeds. (Row-level security is on with no public policies: browsers never touch the database directly.)

### 2. Secrets you generate on your laptop

```bash
openssl rand -base64 32         # optional APP_SECRET (signs the commissioner cookie)
```

**Commissioner PIN:** nothing to run. Pick 4 to 12 digits and type them into Vercel as `COMMISSIONER_PIN` (step 3), digits only. Use at least 6: wrong PINs are throttled (8 per phone per 10 minutes and 30 a day; everyone together gets 30 per 10 minutes, then one try every 10 minutes after 100 in a day), but someone rotating phones can keep guessing for days, and a 4-digit PIN only has 10,000 options. The same PIN is the starting PIN of every trip you create (the trip keeps only a one-way hash of it, and you can change a trip's PIN in Setup → Settings), and trip creation (which needs no link) is throttled the same way. Whatever you pick, the unlock pad takes up to 12 digits.

Rather not keep the PIN itself in Vercel? `npm run hash-pin -- <pin>` prints one line like `scrypt:<salt>:<hash>`: set that as `COMMISSIONER_PIN_HASH` instead of `COMMISSIONER_PIN`. Paste it as is (it has no `$`, so nothing needs escaping). If both are set, the hash wins.

**Push notifications:** nothing to run either. Leave the VAPID keys out and the app makes its own the first time it needs them, saves them in your database and reuses them forever.

For AI roasts, team names and the closest-to-pin judge, create an API key at [console.anthropic.com](https://console.anthropic.com) (`ANTHROPIC_API_KEY`). Expect a few dollars for the round: the judge is capped at 60 photo checks per trip (3 per player per hole) and never looks at the same photo twice, and roasts have their own cap in Settings. Everything works without it.

### 3. Vercel (hosting)

1. Push this repo to GitHub, then in Vercel: **Add New → Project → Import** the repo. The framework preset is Next.js. Leave the build settings alone.
2. Add the environment variables below (all environments), then **Deploy**.
3. **Settings → Functions → Function Region:** pick the region next to your Supabase project (Washington, D.C. `iad1` for Supabase `us-east-1`). Every sync is a few database round trips, so this matters. Redeploy after changing it.
4. Vercel only applies environment variable changes on the next deploy. After editing any of them, redeploy.

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Supabase transaction pooler URL (port 6543). Unset = local PGlite, which only works on a laptop: on Vercel every request fails with "Server misconfigured: DATABASE_URL is not set". |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | `https://<project>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase publishable key (`sb_publishable_...`) or legacy anon key. Phones use it only to listen for "something changed" broadcasts. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase secret key (`sb_secret_...`) or legacy service_role key. Server only: photo uploads and Realtime broadcasts. Without it, photo uploads on Vercel fail with "Server misconfigured: photo storage needs ..." (scores and drinks still sync), and phones poll every few seconds instead of getting live pushes. |
| `COMMISSIONER_PIN` | yes (or the hash below) | Your commissioner PIN, 4 to 12 digits (use 6+), typed as is. Required to create a trip in production; also the starting PIN of each new trip. Anything but 4-12 digits blocks trip creation until you fix it. |
| `COMMISSIONER_PIN_HASH` | no | Instead of `COMMISSIONER_PIN`, if you'd rather not store the PIN itself: the `scrypt:...` line from `npm run hash-pin -- <pin>`. Wins when both are set. |
| `ANTHROPIC_API_KEY` | no | AI judge, roasts and team names. Unset = AI silently off. |
| `AI_JUDGE_MODEL` | no | Model for the closest-to-pin judge (needs image input). Default `claude-sonnet-5-5`. |
| `AI_FAST_MODEL` | no | Model for roasts and team names. Default `claude-haiku-5-5`. |
| `DEMO_AI` | no | `1` lets demo trips use the AI. Off by default, so "Try the demo" (open to anyone with the URL) can't spend your API credit; that's why the demo never shows AI roasts or judge posts. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | no | Web Push keys. Leave them out and the app makes its own (generated once, stored in the database, reused forever). Only to bring your own pair: set both, from `npm run vapid-keys`. Adding or changing them after phones turned notifications on means everyone has to turn them on again. |
| `PUSH_DISABLED` | no | `1` turns push notifications off entirely. |
| `VAPID_SUBJECT` | no | A `mailto:you@yourdomain.com` contact for push services. Set a real address: the `example.com` default can get pushes rejected. |
| `APP_SECRET` | no | Cookie-signing secret. Falls back to a hash of the service key. |
| `NEXT_PUBLIC_APP_VERSION` | no | Version shown in Settings (default `0.1.0`). Vercel's commit SHA is shown next to it automatically. |
| `PGLITE_DIR`, `UPLOADS_DIR` | no | Local dev only: where PGlite and photos live (default `.data/pglite`, `.data/uploads`). |

### 4. Create the real trip

1. Open your Vercel URL on your phone → **Commissioner → Create the trip**. Name it. **Who's playing** is already filled in with the boys (Caster, Joe, Greg, Rich, Reitman, Drew, Will, Ross, Conner, Mark), one per line: edit it if the list changes. The first name is you, and **The groom** is set to Caster. Enter your PIN (the `COMMISSIONER_PIN` you set in Vercel) and tap **Create trip**. You land in **Setup** with everyone on the roster, and this phone is already Caster.
2. **Setup → Teams → Make 3 random teams** (one tap, Undo if you hate them; drag or tap players to tweak), set tee times and set the pots. The **Next:** strip under the Setup tabs always points at what's left. Tap a player to add a nickname or Venmo handle. (Trip created before the roster was pre-filled? **Setup → Roster → Load the boys** adds all 10 in one tap and makes this phone Caster. If the roster is half there, **Add several at once → Fill in the crew** adds whoever's missing.)
3. **Course:** Jack Frost National is mapped in OpenStreetMap, so in **Setup → Course** tap **Fill tees & greens automatically** (OpenStreetMap): it fills in the tee and green points for you. Then check the four par 5 tee points on the satellite map (holes 4, 9, 12 and 18): long drive measures from them, so drag any that sit off the actual tee box. (From a terminal, `DATABASE_URL=... npm run osm-import -- --code <code>` does the same import.)
4. **Setup → Roster → Send the link** (or **Menu → Send the trip link**) opens your phone's share sheet with the clean `https://<your-app>/t/<code>` link (on a laptop it's copied): drop it in the group chat. Each guy opens it and taps his name, and the app says "You're in, Joe" with a **Not you?** in case of a fat thumb. That's it: no PIN, no wizard (the first time on each phone, the 40-second **How it works** cartoon plays; **Skip** is top right). Rather post it as a video? `node scripts/record-explainer.mjs https://<your-app> <code> --out explainer.mp4` records it (it needs Playwright's Chromium and ffmpeg on your laptop). A **Get set up** card offers **Add to Home Screen** and notifications (both optional; on iPhone, notifications only work from the Home Screen app); anyone who first opens the link after the round starts gets it as one row on the Play screen. The Home Screen icon opens the trip already knowing who you are. The commissioner unlocks with the PIN once more there, because the icon has its own storage on iPhone.
5. On Saturday, **Setup → Round → Start round** when the first group is on the tee. It's one-way (no going back to setup), so before Oct 24 the confirm shows the date and makes you tap a red **Start anyway**. Every player's phone flips to Play with a "We're live!".

## The "How it works" explainer

A 44-second story-format cartoon (8 scenes: the shotgun cold open, the scramble format, drinks = strokes, ghost beers, mulligans and the drive minimum, contests, board and money, "Tee it up"). It's drawn in code (no video file in the app), greets each guy by name and uses your trip's groom, team sizes and antes.

- **When it plays:** by itself once per phone per trip, right after someone taps his name on **Who are you?** (before or during the round; not once it's final). **Skip** is top right; tap the right side to go forward, the left to go back, hold (or ❚❚) to pause.
- **Replay:** **☰ → How it works**, the pre-round **How it works (40 sec)** button, or **☰ → Rules & lingo → Watch the 40-sec cartoon**.
- **Open it directly** (screenshots, recording): `https://<your-app>/t/<code>?explainer=1` (add `&scene=3&at=2000&paused=1` for a still frame). It only opens the cartoon; it changes nothing. Back closes it.
- **Re-record the MP4** (for the group chat), on a laptop with Playwright's Chromium (`npx playwright install chromium`) and ffmpeg:

  ```bash
  node scripts/record-explainer.mjs https://<your-app> <code> --out how-it-works.mp4            # greets "Boys"
  node scripts/record-explainer.mjs https://<your-app> <code> --out joe.mp4 --as Joe             # personalised
  ```

  It steps the cartoon frame by frame in headless Chromium (390x844 at 2x, a screenshot per frame, so nothing drifts and it always ends on "That's it. Tee it up."), hides Skip, pause and the phone-only "tap / hold" line, adds a quiet synthesized sound bed (`--no-audio` to skip it) and encodes an iPhone-friendly H.264 MP4 (about 47 s, under 5 MB; it takes several minutes to render, one screenshot per frame). Record from the deployed app with `ANTHROPIC_API_KEY` set if you want the contests scene to say the AI judges (without it, it says "Honor system"). Scene lengths come from the app; if you retime a cartoon (`scenes.tsx`), move its sound effects in `SCENE_SFX` in the script too.

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
- [ ] **Roster + teams (2 min).** The crew is pre-filled with you (Caster) first and crowned: cut it to 5 names for the dry run. Tap yourself to add your real Venmo handle. Make a threesome (with you) and a twosome by dragging players between teams. Tap **Generate names**, re-roll, pick one. Set tee times.
- [ ] **Pots (30 s).** $20 team match with a 70/30 split, $5 per contest hole. Opt one fake out of one pot.
- [ ] **Course (2 min).** On the satellite map, place the tee and green for holes 1, 3 and 4 (hole 4 is a par 5: its tee is what long drive measures from).
- [ ] **Join like a player (2 min).** **Setup → Roster → Send the link** and send it to yourself, then open it in a Safari private tab: **Who are you?** lists the roster; tap a name: the 40-second **How it works** plays once (try Skip, tap left/right, hold to pause), then you're in (no PIN, no wizard). Back in your normal Safari you're already Caster: **Menu → Not you? Switch player** and back. On the pre-round **Get set up** card, tap **Put it on your Home Screen** and follow it (Share → **Add to Home Screen**), then open the app from the icon: it should open as you without asking. Unlock commissioner powers with your PIN once more there, and turn on notifications from the card. Location is asked the first time you **Measure my drive**.
- [ ] **Start (10 s).** **Setup → Start round.** The feed says so.
- [ ] **Play three holes (3 min).** Tap **On the tee**, log a Drink, a Shotgun with a photo of the empty, and a drink for a teammate; undo one within 10 seconds. Enter scores and whose drive you used. Tap **Use a mulligan**, then the **Groom's Mulligan** (fanfare). On hole 3, edit hole 1 from the scorecard strip and watch the feed post the edit. A threesome's 3rd drink should post a 👻 ghost beer.
- [ ] **Airplane mode (2 min).** Turn on airplane mode. Log a score, two drinks and a post. Force-quit the app and reopen it: everything is still there and the badge says "Offline, N changes waiting". Turn airplane mode off: the badge clears and a second phone or laptop shows it all within seconds.
- [ ] **Contests (2 min).** **Settings →** tap the version line 7 times (dev mode) → **GPS simulator**: drop yourself about 280 yards down hole 4 → Play → **Measure my drive** (or the 💣 badge on the hole) → photo. On a real trip a simulated drive never counts on its own: it goes to your review queue ("Simulated GPS"), so there's no rank preview. Approve it in **Setup → Commissioner tools → Contests** and watch it take the lead. (On a demo trip simulated drives count straight away.) On hole 3, **Enter my distance** (or the 🎯 badge): photo, 8 ft 6 in, drag the marker around the pin.
- [ ] **Commissioner fixes (1 min).** **Setup → Commissioner tools:** override a score and move a drink to another hole. The feed shows a Commissioner override and the leaderboard recomputes.
- [ ] **Money (1 min).** The Money tab shows live projections. On a settle-up payment to your own Venmo handle, tap **Pay with Venmo**: Venmo should open with the amount and note filled in. Back out without paying.
- [ ] **Finalize + awards (1 min).** **Setup → Finalize round.** Check the Awards, open the gallery, download one photo and the zip, share the recap card.
- [ ] **Reset.** Don't reuse the dry run for Saturday: create the real trip fresh (section 4 above). The dry-run Home Screen icon always opens the dry-run trip (each trip's icon is its own app), so long-press it and delete it, then open the real trip's link in Safari (Chrome on Android) and **Add to Home Screen** again from that page. Tap the new icon: it must open the real trip, already as you (unlock with your PIN there once). Then make sure the GPS simulator is off in the new icon so Saturday uses real GPS: if a **SIMULATED GPS** strip shows under the header, tap its **Turn off** (or **Settings → GPS simulator → Turn off**). Check it whatever your phone: the simulator setting belongs to the site, not to one trip or one icon, so on Android a new icon keeps it from the dry run (and so does Safari itself if you used the simulator there).

Short on time? **Try the demo** gives you a round already in progress; **Settings → Demo mode → Replay as full round** jumps straight to awards and settle-up. Demo trips never call the AI (unless the server sets `DEMO_AI=1`), so check the AI judge and roasts on your dry-run trip, not the demo.

## Day-of fallback

- **Each cart keeps a paper scorecard.** If a phone dies, any teammate's phone can score for the team. If the app or the server goes down, keep playing on paper and enter it afterward.
- **The commissioner can fix anything** in **Setup → Commissioner tools**: any score, drink (delete or move to another hole), contest entry (approve, flag or set the official distance), or a team's current hole. Every number (nets, ghost beers, standings, pots, awards, settle-up) recomputes from the raw data, and every fix posts to the feed.
- A drink counts on the hole that was open when it was logged, even if the phone only syncs later. A drink logged more than 2 minutes after the team tapped **Round complete** doesn't count. Move a drink to another hole in Commissioner tools if it matters (a moved drink stays where you put it).
- Deleting someone else's drink or contest entry (or your own after a minute) posts to the feed, so nothing disappears quietly.
- **After you finalize,** phones that were offline during the round can still sync what happened on the course for 12 hours. If that changes the winner, the standings or who pays whom, the feed posts a big **Results changed** card (everyone gets a push) that says what moved. A wrong score after the finalize: fix it right in **Setup → Final → Scores** (everyone gets the same Results changed alert); **Reopen round** only if a team still has holes to play.
- **No signal is normal:** everything queues on the phone and syncs exactly once later. Keep the app open for a few seconds once you're back in signal.
- Weak GPS on a long drive: after 3 tries the entry can be submitted for commissioner review. A wrong tee point can be fixed on the Course screen mid-round and every drive on that hole re-measures.

## Verify on a real iPhone before Saturday

Nothing below can be tested from a laptop or a simulator. Do it on your own iPhone against the deployed URL.

- **Venmo deep link:** Pay with Venmo should open the Venmo app with recipient, amount and note prefilled. If it doesn't, the Money tab still shows the handle and amount with a copy button.
- **Push notifications** only work in the Home Screen app on iOS 16.4 or later, after you allow them from a tap inside the app. Check that a lead change actually pings another phone.
- **AI (if you set `ANTHROPIC_API_KEY`):** on the dry-run trip (not the demo), a closest-to-pin entry with a photo should get an "AI JUDGE" feed post within about 10 seconds, and a double bogey or worse should eventually draw a roast. Nothing showing up usually means the key is wrong or out of credit.
- **Camera:** taking a photo from the drink, contest and post buttons works, and iPhone HEIC photos arrive as JPEGs (they're converted on the phone).
- **GPS accuracy:** stand in an open area and Measure drive; it wants 12 m or better. Under trees or next to buildings it may need the 3-try weak-GPS fallback.
- **Offline launch:** with airplane mode on, open the Home Screen app from cold. It should show the last state, not a Safari error page.
- **The Home Screen icon remembers who you are:** tap your name in Safari first, then **Add to Home Screen** from that page. The icon should open as you, with no **Who are you?**. If it does ask, tap your name once and it sticks; that's the built-in fallback. It depends on which address iOS saves for the icon, and both carry your player.

## Open items (from the spec)

- [ ] App name
- [ ] Which tees the group plays (Membership is the default; yardage is display only)
- [ ] Ante amounts and team match payout (winner take all or 1st/2nd split)
- [ ] Penalty, if any, when a player's drive isn't used on a nine (the app only flags it)
- [ ] Venmo handles for each player
- [ ] Supabase, Vercel and Anthropic accounts and keys ready

All of the game settings live in the trip's Setup and change without a redeploy.

## Troubleshooting

- **"Trip creation is locked: the server has no COMMISSIONER_PIN set."** Add `COMMISSIONER_PIN` (your PIN, digits only) in Vercel and redeploy.
- **"The server's COMMISSIONER_PIN must be 4 to 12 digits."** The value in Vercel has something besides 4 to 12 digits (a space in the middle, quotes, letters). Fix it and redeploy. Until then nobody can create a trip, not even with the right PIN.
- **"The server's COMMISSIONER_PIN_HASH is mangled."** An old `scrypt$...` hash got eaten by a `.env` file. Run `npm run hash-pin -- <pin>` again and paste the new `scrypt:...` value, or delete `COMMISSIONER_PIN_HASH` and set `COMMISSIONER_PIN` instead (the hash wins while it's set).
- **The right PIN is refused, or "Easy, tiger. Try again in N minutes."** Too many wrong PINs: 8 from one phone in 10 minutes (30 a day), or 30 in 10 minutes from everyone on the trip together (after 100 in a day, one try every 10 minutes). Other people's guesses only ever cost you a few minutes. The phone you created the trip on, and any phone where you've unlocked before (Lock keeps it), is a trusted device: other people's wrong guesses never slow it down. The Home Screen app counts as a new device until you unlock there once. You can change a trip's PIN in Setup → Settings; that also signs out every other phone that had commissioner powers.
- **"Server misconfigured: DATABASE_URL is not set."** Add `DATABASE_URL` in Vercel and redeploy. (The local PGlite fallback can't run on Vercel.)
- **"DATABASE_URL still has the [YOUR-PASSWORD] placeholder"** or **"Supabase rejected the database password"**: put your database password where `[YOUR-PASSWORD]` was, without the brackets. Lost it? Supabase → Project Settings → Database → Reset database password (letters and numbers only), update `DATABASE_URL` in Vercel and redeploy. After a wrong password the server waits 30 seconds before trying again, so Supabase doesn't lock the project out for too many failed logins. If it did ("temporarily refusing database logins"), fix the password and give it a few minutes. Right after a reset Supabase refuses the new password once; the app retries by itself ("still picking up your new database password" means try again in a few seconds).
- **"DATABASE_URL isn't a valid connection string"** (a password with `/ ? # %` breaks it; reset it to letters and numbers), **"doesn't recognize the user name or host"** (copy the Transaction pooler string again from Supabase → Connect: the user is `postgres.<project-ref>` and the host, `aws-0` vs `aws-1` included, must match exactly), **"uses Supabase's direct connection"** (use the Transaction pooler string, port 6543, not `db.<ref>.supabase.co`), **"Network Restrictions are blocking"** (allow all IPs in Supabase → Project Settings → Database). Each one says what to change; then redeploy. Details are in the Vercel function logs (`CONFIG ERROR: ...`).
- **"Supabase can't reach your database right now: the project is probably paused"**: free Supabase projects pause after about a week without use. Open the Supabase dashboard, press **Restore project**, and give it a couple of minutes. To prevent it, `vercel.json` runs a daily cron (`/api/cron/keepalive`, one cheap read), which Supabase says is typically enough; still open the app a day or two before the round.
- **"Server misconfigured: photo storage needs ..."** Add `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel and redeploy.
- **"This trip is out of photo space."** Each trip takes up to 800 photos (4 MB each at most; phones send about 300 KB). Demo trips take 80, and all demo trips together 200 MB (old demos are pruned after 48 hours). Photos are write-once: a re-upload of a stored photo with different bytes is refused (409), so nobody can swap out closest-to-pin evidence. A phone whose photo is refused for good (409, too big, not a JPEG, out of space) drops that one photo, lists it under the header's ⚠️ sync issues, and keeps uploading the rest; the drink or entry itself was saved.
- **Server errors on every request / can't connect to the database.** The error message names the problem (see the entries above). If it's still the generic "The server shanked it", look for `API error:` in the Vercel function logs.
- **Live updates take ~20 seconds.** Phones are connected to Realtime but the server's broadcasts fail. Check that `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_URL` belong to the same project (a key from another project, or a rotated key, is the usual cause) and look for `realtime: broadcast ... failed` in the Vercel function logs. If Realtime can't connect at all (public channels disallowed in **Project Settings → Realtime**, wrong publishable/anon key), phones poll every 3 seconds instead, so it feels live but costs more requests. Scores sync either way.
- **Photos show as broken.** Check that `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are both set (without them Vercel refuses uploads, see above) and that the `photos` bucket in Supabase Storage is public. Redeploy after fixing; photos still queued on the phones upload on their next try.
- **No push notifications.** The phone must use the Home Screen app (iOS 16.4+), have notifications allowed in iOS Settings, and not be muted in the app's Settings. `PUSH_DISABLED` must not be set, and if you set your own VAPID keys, set both.
- **No roasts or AI judge.** `ANTHROPIC_API_KEY` is missing, roasts are off in Setup → Settings, or the 40-roast cap is used up. AI failures are silent by design: check the Vercel function logs.
- **The app looks out of date after a deploy.** The service worker serves the cached shell first. Close the app completely and reopen it.
- **Local scripts hang or say the database is busy.** PGlite can only be opened by one process: stop `npm run dev` before `npm run demo`, `create-trip` or `osm-import`.
- **"Easy, tiger. That's a lot of fake golf."** The demo endpoint is rate limited. Wait a minute.
- **A new post is refused.** Each trip holds up to 1,500 posts (150 on a demo trip), so a script can't fill the database. Drinks, scores and contest entries don't count toward it.
- **e2e can't start.** Something else is on port 3100: stop it, or run with `E2E_PORT=3200 npm run test:e2e`.
