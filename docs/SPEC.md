# Scramble App Build Spec

Oct 12, 2026 · @Nick

## Overview

Build a mobile web app for one 18-hole team scramble on Saturday, October 24, 2026, at Jack Frost National in the Poconos, with first tee times around 12:50 pm. About 10 players split into teams of 3 or 4, and each team plays as its own group. For this round it replaces The Grint with scramble-native scoring, a drinks-for-strokes rule, photo contests, money pots, and a fully unhinged live feed.

The round counts as a success if:

- Every player opens a link, taps their name, and is ready to score in under a minute. No App Store, no accounts.
- Any player on a team can enter a hole score in under 10 seconds, one-handed, in sunlight.
- The leaderboard updates live on every phone, and nothing is lost when cell signal drops on the course.
- After the round, everyone sees net results, contest winners, who owes whom, awards, and a photo gallery.
- The tone is fully unhinged throughout: roasts, fanfare, and trash talk.

Out of scope: multiple rounds or a weekend leaderboard, handicaps, individual stroke play, user accounts, and App Store distribution. Course data stays editable so the app could be reused for another round, but Saturday is the only target.

## Game rules the app enforces

The format is an 18-hole scramble, scored as straight gross with no handicaps. The commissioner sets the teams before the round and balances them during the pick.

### Threesomes

On every shot, one threesome player hits an extra ball, rotating, so a threesome always has four balls to choose from. The app shows this as a rule reminder on threesome screens. It does not track shot-level detail.

### Drive minimum

Each player's tee shot must be used at least once per nine (holes 1 to 9 and 10 to 18). Par 3 tee shots count.

- On every hole, the team taps whose tee shot they used.
- The app shows each player's drive count for the current nine.
- Soft warning (yellow) when a player still needs a drive and 3 or fewer holes remain on that nine.
- Hard warning (red banner) when holes remaining on the nine equal the number of players still needing a drive.
- If a nine ends with a player at zero, the app posts a feed callout and flags it for the commissioner. There is no automatic penalty (see open items).

### Drinks

- Any drink counts once it is finished. Drinks are logged per player.
- Every drink is worth -1 stroke on the team's open hole (see drink windows).
- Drink types are Drink, Shotgun, and Shot. A Shotgun or a Shot also counts -1 and earns the team one mulligan.
- A photo of the empty is optional on every drink log and posts to the feed.
- No cap on drinks.
- Any teammate can log a drink for another teammate. The feed shows who logged it.

### Ghost beer (evening out team sizes)

Teams of 3 earn strokes as if they had 4 drinkers. Credit is computed from the team's cumulative drinks for the round, where d is the cumulative drink count and n is team size:

```latex
\text{credit}(d) = \left\lfloor \frac{4d}{n} \right\rfloor
```

Each drink's value is credit(d) minus credit(d - 1). For a foursome, every drink is worth 1. For a threesome, the sequence is 1, 1, 2, 1, 1, 2, so every third drink is a ghost beer worth 2. A twosome gets 2 per drink. Any drink worth more than 1 posts a GHOST BEER event to the feed.

Credit is assigned to the hole whose window was open when the drink was logged. If a drink is deleted or moved, recompute every drink's value in logged order.

### Hole and round scoring

- Hole net = strokes minus drink credit assigned to that hole. Zero and negative hole scores are allowed.
- Round net = sum of hole nets. Lowest net wins.
- The leaderboard shows gross, drinks, credit, net, and net to par.

### Drink windows

Each team has one open hole for drinks at a time.

1. The window for hole N opens when the team taps "On the tee" for hole N.
2. It closes when the team taps "On the tee" for hole N+1, or enters any data for hole N+1, whichever comes first.
3. Drinks finished before the first tee shot of the round do not count. A drink logged before hole 1 opens is rejected with a roast.
4. Hole 18's window closes when the team taps "Round complete."
5. The commissioner can move a drink to another hole.

### Mulligans

- Each Shotgun or Shot earns one mulligan for the team bank.
- The groom gets one Groom's Mulligan for the round, usable on any team shot.
- To use one, tap "Use mulligan" on the current hole and pick earned or Groom's. It posts to the feed, and the Groom's Mulligan gets big fanfare.
- Mulligans never change the score math. They are a tracked resource only.
- No per-hole limit. Unused mulligans expire at the end of the round.

### Contest holes

Every par 3 is a closest-to-pin contest and every par 5 is a long drive contest. Contest rules are in the Contests section.

## Users, roles and login

There are no accounts. Everyone joins from one trip link and taps their name, and one PIN unlocks commissioner powers.

- **Join:** the trip link (for example `/t/<tripcode>`) shows the roster. Tap your name and the choice is stored on the device. A "Not you?" link switches players.
- **Trust model:** anyone with the link can view everything and act as any player. That is acceptable for 10 friends. Keep the trip code unguessable (8+ random characters).
- **Player:** enters team scores, logs drinks for self or teammates, uses mulligans, submits contest entries, posts and reacts in the feed, and opts in or out of pots.
- **Commissioner (Nick only):** unlocked by PIN in settings. Can edit the roster and teams, edit any score, drink, or contest entry, move drinks between holes, set pot amounts, finalize the round, and delete feed items.
- **Transparency:** every commissioner edit posts to the feed as a "Commissioner override," because the commissioner is also the groom and is playing.
- **Groom flag:** one player is marked as groom. The groom gets the Groom's Mulligan and a groom badge on every screen.

## Screens and flows

The app has a bottom tab bar with Play, Leaderboard, Feed, Contests, and Money, plus a commissioner Setup area. Design every screen mobile-first: tap targets at least 48 px, high contrast for sunlight, and one-handed use.

### Join

- Trip name, app name, and a roster grid. Tap your name to join.
- First run walks through Add to Home Screen (iOS: Share, then Add to Home Screen), then asks for location and notification permission with a one-line reason for each.

### Commissioner setup (before the round)

- **Roster:** add or remove players with name, nickname, optional Venmo handle, and the groom flag.
- **Teams:** drag players between team cards with touch-friendly drag and drop. Add or remove teams, with a team size of 2 to 4. Set a tee time per team. Each team name has a Generate button (AI names) with re-roll, or can be typed.
- **Course:** Jack Frost National comes prefilled. The commissioner can edit par and yardage per hole, and place tee and green points on a satellite map (see Course data).
- **Pots:** set antes and payout rules (see Pots).
- **Settings:** app name, base team size for ghost beer (default 4), commissioner PIN, roasts on or off, and roast frequency.
- **Start round** unlocks scoring for everyone.

### Play (team hole screen, the default tab)

- **Header:** hole number, par, yardage, contest badge (Closest to pin or Long drive), team net to par, and leaderboard position.
- **On the tee:** a button that opens this hole's drink window. Shown until tapped.
- **Score:** a big stepper defaulting to par, with a live net preview that includes this hole's drink credit.
- **Whose tee shot:** one chip per teammate. Drive-minimum status shows directly under it, for example "Needs a drive: 3 holes left on this nine."
- **Drinks:** one row per teammate with Drink, Shotgun, and Shot buttons, a count for this hole, and a camera icon for an optional photo of the empty. Every log has a 10-second undo.
- **Mulligans:** team bank count, a Use mulligan button, and a Groom's Mulligan button on the groom's team while it is unused.
- **Contest button:** Closest to pin on par 3s, Measure drive on par 5s.
- **Next hole:** a button that becomes "On the tee: hole N+1" with a confirm.
- **Scorecard strip:** all 18 holes. Tap any hole to edit it. Every edit posts to the feed, for example "changed hole 6 from a 5 to a 4."
- **Offline badge:** shows "Offline, X changes waiting" when there is no signal.

### Leaderboard

- Live table with Pos, Team, Thru, Gross, Drinks, Credit, Net, and Net to par, sorted by net. Ties share a position.
- Tap a team to see its hole-by-hole card.
- Sub-tabs: Drinkers (individual drinks, shotguns, and shots), Contests (current leader for every contest hole), and Drives (drive-minimum status for every player).

### Feed

A live, newest-first stream of automatic events, photos, text posts, and reactions. Details are in the Feed section.

### Contests

One card per contest hole with entries, the current leader, and the closest-to-pin green plot. Details are in the Contests section.

### Money

Pots, live projected payouts, and settle-up after the round. Details are in the Pots section.

### Awards (after the commissioner finalizes)

- **Champions:** lowest net.
- **Didn't Need the Beer:** lowest gross.
- **Most Drinks:** individual leader, with shotguns and shots broken out.
- **Ghost Whisperers:** team with the most ghost beers.
- **Longest Drive** and **Closest Pin** of the day, each with its photo.
- **Biggest Beer Save:** largest drink credit on a single hole.
- **Worst Hole:** highest gross on any hole.
- **Mulligan Merchant:** most mulligans used.
- **Edit Bandit:** most score edits.
- **Most Suspicious:** most AI judge flags.
- **Gallery:** every photo in a grid, with single downloads and a download-all zip.
- **Recap card:** one shareable image with final standings and award winners.

## Contests

Long drive is measured by GPS against a preset tee point. Closest to pin uses a player-entered distance plotted on a shared green graphic, with an AI judge that roasts but never decides.

### Long drive (every par 5)

- **Eligibility:** the ball must be in the fairway (honor system), and a photo is required.
- **Flow:** the player stands at their ball and taps Measure drive. It is available only on par 5s, for the team's current hole.
- **GPS:** request high-accuracy location and sample for up to 5 seconds, keeping the reading with the best reported accuracy. If accuracy is worse than 12 m, show "GPS is weak, hold still" and retry. After 3 failed tries, allow submitting with a low-accuracy tag for the commissioner to review.
- **Distance:** haversine distance from the hole's preset tee point to the ball, in yards, rounded to the nearest yard. There is no tee marking on the course. Everyone plays the same tees and is measured from the same point, so the ranking stays fair even if the point is a few yards off.
- **Preview:** before the photo, show where the drive would rank ("You'd be 2nd") and the current leader across all groups.
- **Photo:** the camera opens after the measurement. The entry posts to the feed with distance and photo.
- **Sanity check:** distances under 100 or over 400 yards are flagged for the commissioner instead of posted.
- **Limits:** one entry per player per hole. Re-measuring replaces the earlier entry.
- **Winner:** longest distance per par 5 across all groups. The day's longest gets an award.

### Closest to pin (every par 3)

- **Eligibility:** the player's own tee shot, on the green (honor system).
- **Flow:**
  1. Tap Closest to pin.
  2. Take a photo with the ball and the flagstick both in frame.
  3. Enter the distance in feet and inches. Helper text: pace it off, count putter lengths (about 3 ft each), or use the iPhone Measure app.
  4. Drag your ball marker on the green graphic to show which side of the pin you are on. The marker moves only around the pin. Its distance from the pin comes from the entered number.
  5. Submit.
- **Green graphic:** a stylized top-down green with the pin at the center and labeled rings at 5, 10, 20, and 30 ft. Every entry for that hole, from every group, is plotted with the player's name. The leader is highlighted with a ring and the others are dimmed.
- **Winner:** smallest entered distance per par 3. A tie splits the pot.
- **Limits:** one entry per player per hole. Edits are allowed and posted to the feed.

### AI judge for closest to pin (tier 3)

- After an entry is submitted, a server route sends the photo and the claimed distance to the Claude API.
- The prompt asks for an estimate of the ball-to-hole distance, using the flagstick (assume about 7 ft tall) and the cup (4.25 in across) as scale, plus a confidence level and a one-line roast.
- Expected JSON response: `{ "estimate_ft": number, "confidence": "low" | "medium" | "high", "suspicious": boolean, "roast": string }`.
- Mark an entry suspicious when the claimed distance is under 50% of the estimate and confidence is not low.
- The feed posts an AI JUDGE event with the estimate and roast. A suspicious entry gets a red flag on the green plot.
- The AI never changes the official distance. Only the commissioner can override.
- If the API fails, times out (8 s), or there is no photo, skip the judge silently.

## Pots, settle-up and Venmo links

The app runs two kinds of pots: one team match pot and one pot per contest hole. After the round it computes who owes whom and hands off to Venmo. The app never moves money.

### Team match pot

- Every player antes the same amount, set by the commissioner.
- The winning team (lowest net) splits the pot equally among its members. A 1st and 2nd place split is an optional setting, for example 70/30.
- If teams tie on net, the tied teams split the payout.

### Contest pots

- Each par 3 and par 5 has its own pot. Every player antes a per-hole amount, set by the commissioner.
- The hole's winner takes that pot, and ties split it.
- A contest hole with no valid entries rolls its pot into the next contest hole of the same type. If none remains, it rolls into the team match pot.

### Opt-outs and ledger

- Every player is in every pot by default and can opt out of any pot before the round starts.
- The Money tab shows live projected payouts during the round.
- Pots become final only when the commissioner finalizes the round.
- Each player's net = total winnings minus total antes. All nets must sum to zero.

### Settle-up

- Minimize the number of payments: repeatedly match the biggest debtor with the biggest creditor until everyone is at zero.
- Show each payment as "A pays B $X."

### Venmo links (tier 3, keep it simple)

- If the payee has a Venmo handle, show a Pay with Venmo button that opens Venmo with recipient, amount, and a note prefilled, using Venmo's payment deep link (`venmo://paycharge?txn=pay&recipients=<handle>&amount=<amount>&note=<note>`).
- Verify the link format on a real iPhone during the build. If prefill does not work, fall back to showing the handle and amount with a copy button.
- The payer always confirms inside Venmo.

## Feed, AI roasts, team names and push notifications

The in-app feed is required and must work without AI or push. Roasts, AI team names, and push notifications layer on top and fail silently.

### Automatic feed events

- Hole scored: birdie or better (gross), double bogey or worse (gross), and any hole with a net of 0 or below.
- Drinks: batch drinks from the same team within 60 seconds into one post, for example "3 drinks on hole 7." Shotguns, shots, and ghost beers always get their own post.
- Mulligans earned and used. The Groom's Mulligan gets oversized fanfare.
- Leaderboard lead changes and contest lead changes.
- AI judge results and suspicious flags.
- Drive-minimum hard warnings and misses.
- Score edits ("changed hole 6 from a 5 to a 4") and commissioner overrides.
- Round complete for each team, and final results.

### Player posts

- Text or photo posts with the camera or library.
- Reactions from a fixed set of six options. No threaded replies.
- Templated fallback lines cover every automatic event, so the feed stays funny even with AI off.

### AI roasts (tier 3)

- A server route sends event context (team, hole, scores, drinks, standings) to the Claude API and gets back a one- or two-sentence roast.
- Triggers: double bogey or worse, last place at the turn and at the finish, suspicious closest-to-pin entries, drive-minimum misses, lead changes, ghost beers, and the Groom's Mulligan.
- Limits: at most one roast per team every 3 holes, except for the big events, and a cap of 40 roasts per round to control cost.
- Tone: fully unhinged, and profanity is fine. Roast golf, drinking, and on-course decisions only. Off-limits: partners and fiancées, families, jobs, and appearance.
- The commissioner can turn roasts off in settings.

### AI team names

- Generate returns 5 unhinged golf, drinking, or bachelor-party team names. Tap one to pick it, re-roll, or type your own.

### Push notifications (tier 2)

- Use Web Push through the service worker. On iPhone it works only when the app is added to the Home Screen (iOS 16.4 or later). Android Chrome works in the browser.
- Notify on lead changes, contest lead changes, the Groom's Mulligan, AI judge flags, roasts aimed at your team, and final results.
- Throttle to at most one push per player every 2 minutes, and collapse duplicate events.
- Each player can mute notifications in settings.
- A push failure never blocks anything else.

## Course data

Jack Frost National (1 Jack Frost Mountain Rd, Blakeslee, PA) is a par 72 with 4 par 3s and 4 par 5s, so the round has 8 contest holes. Prefill this scorecard as seed data, defaulting to the Membership tees until the group confirms which tees it plays. Yardage is for display only. GPS measurements use the tee points below, not yardage.

| Hole | Par | Stroke index | Advanced (yd) | Membership (yd) | Forward (yd) | Contest |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 4 | 11 | 415 | 380 | 354 |  |
| 2 | 4 | 5 | 365 | 324 | 283 |  |
| 3 | 3 | 17 | 175 | 169 | 162 | Closest to pin |
| 4 | 5 | 7 | 527 | 492 | 463 | Long drive |
| 5 | 4 | 15 | 338 | 329 | 291 |  |
| 6 | 4 | 3 | 424 | 415 | 366 |  |
| 7 | 4 | 9 | 413 | 376 | 367 |  |
| 8 | 3 | 13 | 196 | 168 | 152 | Closest to pin |
| 9 | 5 | 1 | 495 | 471 | 434 | Long drive |
| 10 | 4 | 8 | 436 | 407 | 365 |  |
| 11 | 3 | 18 | 147 | 144 | 130 | Closest to pin |
| 12 | 5 | 2 | 560 | 496 | 428 | Long drive |
| 13 | 4 | 10 | 367 | 335 | 297 |  |
| 14 | 4 | 6 | 464 | 436 | 407 |  |
| 15 | 4 | 14 | 354 | 349 | 313 |  |
| 16 | 3 | 16 | 172 | 162 | 140 | Closest to pin |
| 17 | 4 | 12 | 389 | 368 | 334 |  |
| 18 | 5 | 4 | 504 | 476 | 443 | Long drive |
| Total | 72 |  | 6,741 | 6,297 | 5,729 |  |

Scorecard source: [GolfingRecord, Jack Frost National](https://www.golfingrecord.com/golf-scorecard/57c90c2d-254f-b331-1006-368cbba4da33). Verify against the scorecard at the course.

### Tee and green points

- Store `tee_lat`, `tee_lng`, `green_lat`, and `green_lng` per hole. Required: tee points for the 4 par 5s. Nice to have: all tees and greens, for a hole map.
- **Primary method:** a commissioner Course screen with a satellite map (Leaflet with free Esri World Imagery tiles). The commissioner taps the tee box and green for each hole and saves. This takes about 10 minutes and can be done from the rental house.
- **Optional importer:** a script that tries OpenStreetMap (Overpass API: `golf=tee`, `golf=green`, and `golf=hole` ways inside the course boundary) and prefills any points it finds. Whether the course is mapped in OpenStreetMap is unverified.
- Course data must be editable at any time, so a wrong tee point can be fixed mid-round and long drive distances recomputed.

## Tech stack and architecture

The stack is a Next.js web app that installs to the home screen, hosted on Vercel, with Supabase for data, live sync, and photos. Every player action is written to the phone first and synced later, so the round survives dead zones on a mountain course.

### Stack

- **Frontend:** Next.js (App Router) with TypeScript and Tailwind CSS. Use dnd-kit for touch drag and drop on the Teams screen and Leaflet for maps.
- **Hosting:** Vercel free tier on HTTPS, which geolocation, camera, and Web Push all require.
- **Backend:** Supabase free tier. Postgres for data, Realtime (postgres\_changes) for live updates, and Storage for photos.
- **AI:** Anthropic Messages API, called only from server routes. Use a current Sonnet model for the closest-to-pin judge, since it needs image input, and a current Haiku model for roasts and team names, since they are cheap and fast (for example `claude-sonnet-5-5` and `claude-haiku-5-5`). Confirm model IDs in the [Claude API docs](https://docs.claude.com/en/api/overview) when building. Expect a few dollars of usage for the round.

### Environment variables

- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server only)
- `ANTHROPIC_API_KEY` (server only)
- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` for Web Push
- `COMMISSIONER_PIN_HASH`

### Offline-first sync

- Every player action (score, drink, tee shot, mulligan, contest entry, post) gets a client-generated UUID and timestamp. It is written to a local IndexedDB outbox (Dexie) and shown immediately.
- A sync worker flushes the outbox when the browser comes online, retries with backoff, and upserts by id, so a resend never creates a duplicate.
- The last known state for the whole trip is cached locally, so every screen loads with no signal.
- Show an "Offline, X changes waiting" badge until the outbox is empty.
- **Conflicts:** hole scores use last write wins by server timestamp, and every overwrite posts an edit event to the feed. Drinks, mulligans, and contest entries are append-only events with soft delete, so they never conflict.

### Scoring engine

- One pure TypeScript module, shared by client and server, computes everything derived: drink values and ghost beers, hole nets, standings, drive-minimum status, contest winners, pot payouts, and settle-up.
- Derived values are never the source of truth. Recompute from raw events on every change, which makes edits, moves, and deletes safe.

### Security model

- No user auth. The trip code in the URL scopes every query.
- Supabase row-level security allows anonymous reads and writes only for rows matching a valid trip id.
- Commissioner actions go through server routes that check the PIN, then issue a signed, short-lived cookie.
- AI calls and push sends run server-side only, so keys never reach the phone.

### Photos

- Capture with `<input type="file" accept="image/*" capture="environment">`.
- Compress on the phone to a 1600 px longest side at JPEG quality 0.7 (browser-image-compression), redrawing through a canvas so iPhone HEIC photos become JPEG.
- Queue uploads in the outbox while offline. The feed shows a local preview until the upload finishes.
- Store at `trips/<trip_id>/<type>/<uuid>.jpg` in a bucket with unguessable paths.

### Location

- Use `navigator.geolocation` with `enableHighAccuracy: true` and a 10-second timeout. Ask for permission during onboarding, not mid-shot.
- Distance is haversine on latitude and longitude, ignoring elevation.

### PWA

- Web manifest with app name, icons, theme color, and `display: standalone`.
- A service worker (Serwist or similar) caches the app shell so the app opens with no signal, and handles Web Push.

## Data model

Raw events are the source of truth, and the scoring engine derives everything else. Every table carries `id` (uuid, client-generated where players create rows), `trip_id`, and `created_at`.

| Table | Key fields | Notes |
| --- | --- | --- |
| trips | code, name, app\_name, status (setup, live, final), base\_team\_size, settings json, commissioner\_pin\_hash | One row per round |
| players | name, nickname, venmo\_handle, is\_groom, muted\_push | One groom per trip |
| teams | name, tee\_time, sort\_order | Team size 2 to 4 |
| team\_members | team\_id, player\_id | One team per player |
| holes | number, par, stroke\_index, yardage json by tee, tee\_lat, tee\_lng, green\_lat, green\_lng, contest (ctp, ld, none) | 18 rows, seeded with Jack Frost National |
| team\_round\_state | team\_id, open\_hole, started\_holes array, status (not started, playing, complete) | Drives the drink window |
| hole\_scores | team\_id, hole, strokes, tee\_shot\_player\_id, updated\_by, updated\_at | Upsert by team and hole, last write wins |
| drinks | player\_id, team\_id, hole, type (drink, shotgun, shot), photo\_path, logged\_by, deleted\_at | Append-only; value derived |
| mulligans | team\_id, source (shotgun, shot, groom), source\_drink\_id, used\_on\_hole, used\_by, used\_at | Earned rows created with their drink |
| contest\_entries | hole, player\_id, type (ctp, ld), distance\_value, unit (ft, yd), angle\_deg, lat, lng, gps\_accuracy\_m, photo\_path, ai\_estimate\_ft, ai\_confidence, ai\_suspicious, ai\_roast, status (ok, flagged, overridden), deleted\_at | One active entry per player per hole |
| pots | type (team\_match, contest), hole, ante\_amount, payout\_rule json | Contest pots created per contest hole |
| pot\_optouts | pot\_id, player\_id | Default is all in |
| feed\_events | type, team\_id, player\_id, payload json, photo\_path, text, deleted\_at | Auto events and player posts |
| reactions | feed\_event\_id, player\_id, kind | One per kind per player |
| push\_subscriptions | player\_id, endpoint, keys json | Web Push |

Turn on Realtime for hole\_scores, drinks, mulligans, contest\_entries, team\_round\_state, feed\_events, and reactions.

## Build plan

Build in three tiers and ship each one deployed and working before starting the next. If time runs out, tier 1 alone must carry the round. There is no group test, so automated tests and a demo mode stand in for one.

| Tier | Scope | Done by |
| --- | --- | --- |
| 1. Must work | Join flow, commissioner setup (roster, drag-and-drop teams, groom flag, course seed), Play screen with scoring, tee-shot tracking, drive-minimum warnings, drinks with ghost beer and drink windows, mulligans, live leaderboard, offline outbox, basic feed with templated events and score-edit posts | Sat, Oct 17 |
| 2. The fun | Long drive GPS measure, closest-to-pin entry with green plot, photos everywhere, pots and settle-up, satellite tee and green placement, push notifications | Mon, Oct 19 |
| 3. The chaos | AI closest-to-pin judge, AI roasts, AI team names, Venmo links, awards screen, gallery zip, recap card | Wed, Oct 21 |
| Go live | Commissioner loads roster, teams, pots, and tee points, then sends the trip link to the group chat | Thu, Oct 22 |

### Scoring tests (must pass before tier 1 ships)

- [ ] Foursome logs 4 drinks on hole 1: hole 1 credit is 4.
- [ ] Threesome logs drinks 1, 2, 3: values are 1, 1, 2, and drink 3 posts a ghost beer.
- [ ] Threesome logs 2 drinks on hole 1 and 1 on hole 2: hole 1 credit 2, hole 2 credit 2.
- [ ] Deleting the threesome's 2nd drink recomputes: hole 1 credit 1, hole 2 credit 1.
- [ ] Twosome: every drink is worth 2.
- [ ] A drink logged after the team taps "On the tee" for hole 5 lands on hole 5, not hole 4.
- [ ] A drink logged before hole 1 opens is rejected.
- [ ] Hole 18's window stays open until "Round complete."
- [ ] Strokes 4 with 5 drink credits gives a hole net of -1.
- [ ] Shotgun and Shot each give -1 and add one mulligan; using a mulligan never changes net.
- [ ] Drive-minimum soft and hard warnings fire at the right holes for teams of 3 and 4, and par 3 tee shots count.
- [ ] Haversine matches a known distance within 1 yard.
- [ ] Pot payouts and settle-up sum to zero, ties split, and empty contest pots roll over.
- [ ] Airplane mode: log 10 mixed actions, reconnect, and every action syncs exactly once.
- [ ] Two phones edit the same hole score: last write wins and the feed shows the edit.

### Demo mode and dev tools

- A seed script creates a demo trip with 10 fake players in teams of 4, 3, and 3, then simulates a full round with random scores, drinks, contests, and posts. This exercises the leaderboard, awards, and settle-up end to end.
- A dev-only GPS simulator lets you fake a location on any hole to test long drive.
- A Reset demo button wipes and reseeds.
- A one-page checklist in the README lets the commissioner run a 15-minute solo walkthrough on his own phone before Saturday.

### Day-of fallback

- The commissioner can fix any score, drink, or entry, and every derived number recomputes.
- Each group keeps a paper scorecard in the cart as a backup.

## Config values and open items

All of these live in trip settings and can be changed in the app without a redeploy.

| Setting | Default | Notes |
| --- | --- | --- |
| App name | Placeholder | Shown on Join, header, and recap card |
| Commissioner | Nick | PIN set at setup |
| Groom | Nick | Gets one Groom's Mulligan |
| Base team size for ghost beer | 4 | credit = floor(4d / n) |
| Drink cap | None |  |
| Pre-round drinks | Don't count |  |
| Tees | Membership (6,297 yd) | Display only |
| Team match ante | Set by commissioner | Winner splits, optional 1st/2nd split |
| Contest ante per hole | Set by commissioner | Ties split, empty pots roll over |
| Long drive GPS accuracy limit | 12 m | Low-accuracy entries go to commissioner review |
| Long drive sanity range | 100 to 400 yd |  |
| AI judge suspicious threshold | Claimed under 50% of AI estimate | Ignored when AI confidence is low |
| Roasts | On, max 1 per team per 3 holes, 40 per round | Off-limits: partners, families, jobs, appearance |
| Push throttle | 1 per player per 2 minutes |  |

### Open items

- [ ] App name
- [ ] Which tees the group plays
- [ ] Ante amounts and team match payout (winner take all or 1st/2nd split)
- [ ] Penalty, if any, when a player's drive isn't used on a nine
- [ ] Venmo handles for each player
- [ ] Supabase, Vercel, and Anthropic API accounts and keys ready before the build starts
