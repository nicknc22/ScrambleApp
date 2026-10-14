// The Oct 13 usability pass, end to end against the real server: Play (a drink before tee-off doesn't
// count and its roast opens hole 1, the untouched par default is a quiet fill-if-empty Save, your own drinks row
// first, unsaved scores outlive a tab trip, the contest badge on the hole is the way in), help (the
// pre-round steps, ☰ → Rules & lingo, "We're live!", the commissioner's desk), Board / Money /
// Contests in plain words, the Setup "Next:" strip and one-tap random teams, and the link preview.
import { randomUUID } from "node:crypto";
import { devices, expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

const CREW = [{ name: "Caster", is_groom: true }, "Joe", "Greg", "Rich", "Reitman", "Drew", "Will", "Ross", "Conner", "Mark"];
const TEAM_NAMES = ["Sand Baggers", "Ghost Riders", "Shank Redemption"];
/** 4 / 3 / 3: Caster, Joe, Greg, Rich | Reitman, Drew, Will | Ross, Conner, Mark. */
const SPLIT = [0, 0, 0, 0, 1, 1, 1, 2, 2, 2];

interface Trip {
  code: string;
  players: Array<{ id: string; name: string }>;
  teams: string[];
}

const id = (trip: Trip, name: string) => trip.players.find((p) => p.name === name)!.id;

let clock = Date.now() - 30 * 60_000;
const op = (o: Record<string, unknown>) => ({ id: randomUUID(), at: new Date((clock += 1000)).toISOString(), by: null, ...o });

async function sync(request: APIRequestContext, code: string, ops: Array<Record<string, unknown>>) {
  const res = await request.post(`/api/t/${code}/sync`, { data: { ops } });
  expect(res.ok(), await res.text()).toBe(true);
  const results = ((await res.json()) as { results: Array<{ status: string; reason?: string }> }).results;
  expect(results.filter((r) => r.status !== "applied"), JSON.stringify(results)).toEqual([]);
}

/** A real trip with the crew (the request context keeps the commissioner cookie). Teams 4/3/3 unless `teams: false`. */
async function createTrip(request: APIRequestContext, opts: { teams?: boolean; antes?: boolean; start?: boolean } = {}): Promise<Trip> {
  const res = await request.post("/api/trips", { data: { pin: "2468", name: "Caster's Last Scramble", roster: CREW } });
  expect(res.status(), await res.text()).toBe(201);
  const { code, players } = (await res.json()) as { code: string; players: Array<{ id: string; name: string }> };
  const teams = [randomUUID(), randomUUID(), randomUUID()];
  const ops: Array<Record<string, unknown>> = [];
  if (opts.antes) ops.push(op({ type: "trip.update", patch: { settings: { team_match_ante_cents: 2000, contest_ante_cents: 500 } } }));
  if (opts.teams !== false) {
    ops.push(...teams.map((tid, i) => op({ type: "team.upsert", team: { id: tid, name: TEAM_NAMES[i], sort_order: i } })));
    ops.push(...players.map((p, i) => op({ type: "team.assign", player_id: p.id, team_id: teams[SPLIT[i]] })));
  }
  if (opts.start) ops.push(op({ type: "trip.start" }));
  if (ops.length > 0) await sync(request, code, ops);
  return { code, players, teams };
}

/** A player's phone: no commissioner cookie, already picked (no "Who are you?", no auto-explainer). */
async function playerPhone(browser: Browser, code: string, playerId: string, viewport = { width: 360, height: 780 }) {
  const context = await browser.newContext({ ...devices["iPhone 13"], baseURL: test.info().project.use.baseURL, viewport, permissions: ["geolocation"] });
  await context.addInitScript(
    ([c, me]) => {
      localStorage.setItem(`scramble:me:${c}`, me);
      localStorage.setItem(`scramble:explainer-seen:${c}`, "1");
    },
    [code, playerId],
  );
  return context;
}

async function dismissFanfare(page: Page, tone: string) {
  const fanfare = page.getByTestId("fanfare");
  await expect(fanfare).toHaveAttribute("data-tone", tone);
  await fanfare.click();
  await expect(fanfare).toHaveCount(0);
}

async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.iw}px viewport`).toBeLessThanOrEqual(m.iw);
}

interface ServerState {
  hole_scores: Array<{ team_id: string; hole: number; strokes: number | null; tee_shot_player_id?: string | null }>;
  drinks: Array<{ team_id: string; player_id: string; hole: number; deleted_at: string | null }>;
  feed_events: Array<{ type: string }>;
}

async function serverState(request: APIRequestContext, code: string): Promise<ServerState> {
  const res = await request.get(`/api/t/${code}/state`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { state: ServerState }).state;
}

const drinkRow = (page: Page, playerId: string) => page.locator(`[data-testid="drink-row"][data-player="${playerId}"]`);
const drinksHeader = (page: Page) => page.getByTestId("drinks-panel").locator("h2 + span");

test("Play: a drink before tee-off doesn't count (its button opens hole 1); the par default is a quiet Save; your row first; drafts survive a tab trip", async ({ browser, page }) => {
  test.setTimeout(150_000);
  const trip = await createTrip(page.request, { start: true });
  const ross = id(trip, "Ross"); // threesome, last on the roster: his row moves to the top
  const ctx = await playerPhone(browser, trip.code, ross);
  const p = await ctx.newPage();
  try {
    await p.goto(`/t/${trip.code}`);
    await expect(p.getByTestId("hole-number")).toHaveText("1", { timeout: 30_000 });

    // Nobody has entered a score: "Team score" + a grey "No score yet" (not a yellow "Not saved").
    await expect(p.getByTestId("score-name")).toHaveText("Team score");
    await expect(p.getByTestId("score-status")).toHaveText("No score yet");
    await expect(p.getByTestId("score-status")).toHaveAttribute("data-state", "empty");

    // This phone's row comes first, marked YOU.
    const firstRow = p.getByTestId("drink-row").first();
    await expect(firstRow).toHaveAttribute("data-player", ross);
    await expect(firstRow).toHaveAttribute("data-me", "true");
    await expect(firstRow.getByTestId("drink-row-you")).toBeVisible();

    // A drink before anyone teed off doesn't count (SPEC drink windows rule 3): the roast says so,
    // and its button only opens hole 1. The tapped drink is never logged (no banking range beers).
    await p.getByRole("button", { name: "Drink for Ross", exact: true }).click();
    const host = p.locator("[data-toast-host]");
    await expect(host.getByText("Not teed off yet", { exact: true })).toBeVisible();
    await expect(host).toContainText("doesn't count");
    await expect(host).not.toContainText(/count it/i);
    await expect(drinksHeader(p)).toHaveText("Not teed off yet");
    await host.getByRole("button", { name: "⛳ We're on the tee: open hole 1" }).click();
    await dismissFanfare(p, "hype");
    await expect(host.getByText("Not teed off yet", { exact: true })).toHaveCount(0);
    await expect(p.getByTestId("tee-cta")).toHaveCount(0);
    await expect(drinksHeader(p)).toHaveText(/^Hole 1: no drinks yet/);
    await expect(drinkRow(p, ross).getByTestId("drink-count")).toHaveText("0");
    await expect
      .poll(async () => (await serverState(p.request, trip.code)).feed_events.filter((e) => e.type === "tee_off").length, { timeout: 20_000 })
      .toBe(1);
    expect((await serverState(p.request, trip.code)).drinks).toEqual([]);
    // The next drink, now on the tee, counts on hole 1.
    await p.getByRole("button", { name: "Drink for Ross", exact: true }).click();
    await expect(drinksHeader(p)).toHaveText(/Hole 1: −1/);
    await expect(drinkRow(p, ross).getByTestId("drink-count")).toHaveText("1");
    await expect
      .poll(async () => (await serverState(p.request, trip.code)).drinks.filter((d) => d.deleted_at === null).map((d) => [d.player_id, d.hole]), { timeout: 20_000 })
      .toEqual([[ross, 1]]);

    // Right after tee-off, the Drinks header peeks above the action bar on a 360x780 phone.
    await p.evaluate(() => window.scrollTo(0, 0));
    const fold = await p.evaluate(() => ({
      drinks: document.querySelector('[data-testid="drinks-panel"]')!.getBoundingClientRect().top,
      bar: document.querySelector('[data-testid="play-action-bar"]')!.getBoundingClientRect().top,
    }));
    expect(fold.drinks, `drinks panel at ${fold.drinks}, action bar at ${fold.bar}`).toBeLessThan(fold.bar);

    // The untouched par default: a quiet outline Save that reads as "later".
    const save = p.getByTestId("save-score");
    await expect(save).toHaveAttribute("data-untouched", "true");
    await expect(save).toHaveText(/Hole out, then\s*Save\s*4/);
    // The next-hole button asks, then acts.
    await expect(p.getByTestId("next-hole")).toHaveText(/Done with 1\?\s*Tee off 2/);
    await expectNoHorizontalOverflow(p);

    // Dial in a 6: "Not saved", the big green Save 6.
    await p.getByRole("button", { name: "One more stroke" }).click();
    await p.getByRole("button", { name: "One more stroke" }).click();
    await expect(p.getByTestId("score-status")).toHaveText("Not saved");
    await expect(save).toHaveText(/Save\s*6/);
    await expect(save).not.toHaveAttribute("data-untouched", "true");

    // Board and back: the unsaved 6 is still there.
    await p.getByTestId("tab-leaderboard").click();
    await expect(p.getByTestId("trip-shell")).toHaveAttribute("data-tab", "leaderboard");
    await p.getByTestId("tab-play").click();
    await expect(p.getByTestId("score-status")).toHaveText("Not saved");
    await expect(p.getByTestId("save-score")).toHaveText(/Save\s*6/);

    // Saved: a round trip shows it saved, not a stale draft.
    await p.getByTestId("save-score").click();
    await expect(p.getByTestId("saved-state")).toBeVisible();
    await p.getByTestId("tab-leaderboard").click();
    await p.getByTestId("tab-play").click();
    await expect(p.getByTestId("score-status")).toHaveText("✓ Saved");
    await expect(p.getByTestId("saved-state")).toBeVisible();
    await expect
      .poll(async () => (await serverState(p.request, trip.code)).hole_scores.filter((s) => s.strokes !== null).map((s) => [s.hole, s.strokes]), { timeout: 20_000 })
      .toEqual([[1, 6]]);
  } finally {
    await ctx.close();
  }
});

test("a tap on the untouched \"Save 4\" is a real score: a later fix posts the edit, a stale offline score loses", async ({ browser, page }) => {
  test.setTimeout(150_000);
  const trip = await createTrip(page.request, { start: true });
  const team = trip.teams[0];
  const ctx = await playerPhone(browser, trip.code, id(trip, "Joe"));
  const p = await ctx.newPage();
  try {
    await p.goto(`/t/${trip.code}`);
    await p.getByTestId("tee-cta").click({ timeout: 30_000 });
    await dismissFanfare(p, "hype");

    // The untouched default, one tap: par is the most common score, so this is how most holes go in.
    const save = p.getByTestId("save-score");
    await expect(save).toHaveAttribute("data-untouched", "true");
    await save.click();
    await expect(p.getByTestId("saved-state")).toBeVisible();
    await expect
      .poll(async () => (await serverState(p.request, trip.code)).hole_scores.filter((s) => s.team_id === team && s.strokes !== null).map((s) => [s.hole, s.strokes]), { timeout: 20_000 })
      .toEqual([[1, 4]]);

    // Fixing it to a 3 is an edit everyone sees (finding: a weak default made every later edit silent).
    await p.getByRole("button", { name: "One fewer stroke" }).click();
    await p.getByTestId("save-score").click();
    await expect
      .poll(async () => (await serverState(p.request, trip.code)).feed_events.filter((e) => e.type === "score_edit").length, { timeout: 20_000 })
      .toBe(1);
    const st = await serverState(p.request, trip.code);
    expect(st.hole_scores.filter((s) => s.team_id === team && s.strokes !== null).map((s) => [s.hole, s.strokes])).toEqual([[1, 3]]);

    // A teammate's phone that typed a 5 offline five minutes ago doesn't quietly replace it.
    const stale = { id: randomUUID(), at: new Date(Date.now() - 5 * 60_000).toISOString(), by: id(trip, "Greg"), type: "score.set", team_id: team, hole: 1, strokes: 5 };
    const res = await page.request.post(`/api/t/${trip.code}/sync`, { data: { ops: [stale] } });
    expect(res.ok()).toBe(true);
    const [result] = ((await res.json()) as { results: Array<{ status: string; code?: string }> }).results;
    expect(result).toMatchObject({ status: "rejected", code: "conflict" });
    const after = await serverState(p.request, trip.code);
    expect(after.hole_scores.filter((s) => s.team_id === team && s.strokes !== null).map((s) => s.strokes)).toEqual([3]);
  } finally {
    await ctx.close();
  }
});

test("leaving a hole with no drive picked: the sheet asks whose, loud on hole 9; holes 10-18 keep 'Par 4' on one line", async ({ browser, page }) => {
  test.setTimeout(150_000);
  const trip = await createTrip(page.request, { start: true });
  const team = trip.teams[1]; // Reitman, Drew, Will
  const [reitman, drew, will] = ["Reitman", "Drew", "Will"].map((n) => id(trip, n));
  // Holes 1-8 played on Drew's and Will's drives: Reitman still needs one, hole 9 is the last chance.
  const ops: Array<Record<string, unknown>> = [];
  for (let h = 1; h <= 9; h++) ops.push(op({ type: "tee.open", team_id: team, hole: h, as_commissioner: true }));
  for (let h = 1; h <= 8; h++) {
    ops.push(op({ type: "score.set", team_id: team, hole: h, strokes: 4, as_commissioner: true }));
    ops.push(op({ type: "teeshot.set", team_id: team, hole: h, player_id: h % 2 ? drew : will, as_commissioner: true }));
  }
  await sync(page.request, trip.code, ops);
  const ctx = await playerPhone(browser, trip.code, drew);
  const p = await ctx.newPage();
  try {
    await p.goto(`/t/${trip.code}`);
    await expect(p.getByTestId("hole-number")).toHaveText("9", { timeout: 30_000 });

    // No drive picked, "Done with 9?": the sheet asks, red, and says what's at stake.
    await p.getByTestId("next-hole").click();
    const sheet = p.getByRole("dialog");
    const ask = sheet.getByTestId("advance-drive");
    await expect(ask).toBeVisible();
    await expect(ask).toHaveAttribute("data-urgent", "true");
    await expect(ask).toContainText("Whose drive on hole 9?");
    await expect(sheet.getByTestId("advance-drive-note")).toHaveText("No drive picked, and the front nine ends here. Still needs one: Reitman.");
    const chip = ask.getByRole("button", { name: /^Reitman's tee shot on hole 9/ });
    expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await expectNoHorizontalOverflow(p);
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(sheet.getByTestId("advance-drive-note")).toHaveCount(0);
    await sheet.getByTestId("advance-confirm").click();
    await expect(p.getByTestId("hole-number")).toHaveText("10");

    // Hole 9 went in with Reitman's drive, and the nine closed with nobody missed.
    await expect
      .poll(async () => {
        const st = await serverState(p.request, trip.code);
        return st.hole_scores.find((s) => s.team_id === team && s.hole === 9)?.tee_shot_player_id ?? null;
      }, { timeout: 20_000 })
      .toBe(reitman);
    await p.waitForTimeout(1_500);
    expect((await serverState(p.request, trip.code)).feed_events.filter((e) => e.type === "drive_miss")).toEqual([]);

    // Hole 10 at 360px: "Par 4" and "407 yd" each on one line (finding: 'PAR / 4' on the back nine).
    const parLine = p.getByTestId("hole-par-line");
    const lineBox = (await parLine.boundingBox())!;
    expect(lineBox.height, "the par line wrapped").toBeLessThan(44);
    const header = (await p.getByTestId("hole-header").boundingBox())!;
    expect(lineBox.x).toBeGreaterThanOrEqual(header.x);
    // The drinks header says so instead of "−0".
    await expect(drinksHeader(p)).toHaveText("Hole 10: no drinks yet");

    // A relaxed hole asks quietly (the drive is still optional).
    await p.getByTestId("next-hole").click();
    await expect(p.getByRole("dialog").getByTestId("advance-drive")).toHaveAttribute("data-urgent", "false");
    await p.getByRole("dialog").getByRole("button", { name: "Never mind" }).click();
  } finally {
    await ctx.close();
  }
});

test("the hole header's contest badge is the way in (and only when it can be entered)", async ({ browser, page }) => {
  test.setTimeout(150_000);
  const trip = await createTrip(page.request, { start: true });
  const team = trip.teams[2];
  await sync(page.request, trip.code, [
    ...[1, 2, 3].map((hole) => op({ type: "tee.open", team_id: team, hole, as_commissioner: true })),
    op({ type: "score.set", team_id: team, hole: 1, strokes: 4, as_commissioner: true }),
    op({ type: "score.set", team_id: team, hole: 2, strokes: 4, as_commissioner: true }),
  ]);
  const ctx = await playerPhone(browser, trip.code, id(trip, "Conner"), { width: 390, height: 664 });
  const p = await ctx.newPage();
  try {
    await p.goto(`/t/${trip.code}`);
    await expect(p.getByTestId("hole-number")).toHaveText("3", { timeout: 30_000 });

    // Par 3: "🎯 Closest to pin ›" is a button with a ≥48px hit area that keeps the header's size.
    const badge = p.getByTestId("hole-contest");
    await expect(badge).toHaveAttribute("aria-label", "Closest to pin · Enter");
    expect(await badge.evaluate((el) => el.tagName)).toBe("BUTTON");
    const hits = await badge.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return [cy - 20, cy + 20].map((y) => {
        const hit = document.elementFromPoint(cx, y);
        return !!hit && el.contains(hit);
      });
    });
    expect(hits).toEqual([true, true]);
    await badge.click();
    await expect(p.getByRole("dialog", { name: "Closest to pin · Hole 3" })).toBeVisible();
    await p.keyboard.press("Escape");
    await expect(p.getByRole("dialog")).toHaveCount(0);
    await expect(p.getByTestId("contest-panel-enter")).toHaveText(/Enter my distance/);

    // Par 5, the team's current hole: "💣 Long drive" opens the measuring sheet.
    await p.getByRole("button", { name: "On the tee: hole 4" }).click();
    await p.getByRole("dialog").getByRole("button", { name: "Tee off without a score" }).click();
    await expect(p.getByTestId("hole-number")).toHaveText("4");
    await expect(p.getByTestId("hole-contest")).toHaveAttribute("aria-label", "Long drive · Measure");
    await expect(p.getByTestId("hole-header")).toContainText("💣");
    await expect(p.locator("body")).not.toContainText("💥 Long drive");
    await p.getByTestId("hole-contest").click();
    await expect(p.getByRole("dialog", { name: "Long drive · Hole 4" })).toBeVisible();
    await p.keyboard.press("Escape");
    await expect(p.getByRole("dialog")).toHaveCount(0);

    // A par 5 the team has left: you measure standing at your ball, so the badge is just a badge.
    await p.getByRole("button", { name: "On the tee: hole 5" }).click();
    await p.getByRole("dialog").getByRole("button", { name: "Tee off without a score" }).click();
    await expect(p.getByTestId("hole-number")).toHaveText("5");
    await p.getByTestId("scorecard-strip").getByRole("button", { name: /^Hole 4,/ }).click();
    await expect(p.getByTestId("hole-number")).toHaveText("4");
    expect(await p.getByTestId("hole-contest").evaluate((el) => el.tagName)).not.toBe("BUTTON");
    await expectNoHorizontalOverflow(p);
  } finally {
    await ctx.close();
  }
});

test("help: the pre-round steps, ☰ → Rules & lingo, \"We're live!\" on the boys' phones, the commissioner's desk", async ({ browser, page }) => {
  test.setTimeout(150_000);
  const trip = await createTrip(page.request);
  const ctx = await playerPhone(browser, trip.code, id(trip, "Joe"));
  const p = await ctx.newPage();
  try {
    await p.goto(`/t/${trip.code}`);
    await expect(p.getByTestId("waiting-for-start")).toBeVisible({ timeout: 30_000 });

    // The steps, right under the hero and above the teams. The old House rules card is gone.
    const steps = p.getByTestId("how-it-works-steps");
    await expect(steps).toContainText("takes a stroke off your team");
    await expect(steps).toContainText("Every 3rd drink counts 2");
    await expect(steps).toContainText("Caster 👑 gets one Groom's Mulligan");
    const stepsTop = (await steps.boundingBox())!.y;
    const teamsTop = (await p.getByRole("heading", { name: /^The teams$/i }).boundingBox())!.y;
    expect(stepsTop).toBeLessThan(teamsTop);
    await expect(p.getByText("House rules")).toHaveCount(0);
    await expectNoHorizontalOverflow(p);

    // ☰ → Rules & lingo: the steps plus the lingo, and the cartoon one tap away.
    await p.getByTestId("menu-button").click();
    await p.getByRole("dialog").getByRole("button", { name: /Rules & lingo/ }).click();
    const rules = p.getByRole("dialog", { name: "Rules & lingo" });
    await expect(rules).toBeVisible();
    await expect(rules.getByTestId("rules-lingo")).toContainText("To par");
    await expect(rules.getByTestId("rules-lingo")).toContainText("banked");
    await expectNoHorizontalOverflow(p);
    await rules.getByTestId("rules-watch").click();
    const xp = p.getByRole("dialog", { name: "How it works" });
    await expect(xp).toBeVisible();
    await expect(xp.getByTestId("explainer-title")).toHaveText("Joe, welcome to Caster's Last Scramble.");
    await xp.getByTestId("explainer-skip").click();
    await expect(p.getByRole("dialog")).toHaveCount(0);

    // The commissioner starts it: every player phone sitting here says so, and what to do first.
    await sync(page.request, trip.code, [op({ type: "trip.start" })]);
    const fanfare = p.getByTestId("fanfare");
    await expect(fanfare).toContainText("We're live!", { timeout: 20_000 });
    await expect(fanfare).toContainText("hit the big yellow button");
    await dismissFanfare(p, "hype");
    await expect(p.getByTestId("tee-cta")).toBeVisible();
  } finally {
    await ctx.close();
  }

  // The commissioner's own phone: no "We're live!" (it has its own fanfare), and once live the
  // Setup row is the Commissioner desk.
  await page.addInitScript(([c, me]) => localStorage.setItem(`scramble:me:${c}`, me), [trip.code, id(trip, "Caster")] as const);
  await page.goto(`/t/${trip.code}`);
  await expect(page.getByTestId("hole-number")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("fanfare")).toHaveCount(0);
  await page.getByTestId("menu-button").click();
  await expect(page.getByRole("dialog").getByRole("button", { name: /Commissioner desk/ })).toContainText("Fix scores, drinks, contests");
});

test("Board, Money and Contests say it in plain words; no antes, no money banner", async ({ browser, page }) => {
  test.setTimeout(150_000);
  const trip = await createTrip(page.request, { antes: true, start: true });
  const [t0, t1, t2] = trip.teams;
  // Hole 1: Sand Baggers par with 2 drinks (2 under), Ghost Riders bogey, Shank Redemption par.
  // Then every team tees off hole 4 (everyone's past the hole 3 closest to pin).
  await sync(page.request, trip.code, [
    ...trip.teams.map((t) => op({ type: "tee.open", team_id: t, hole: 1, as_commissioner: true })),
    op({ type: "drink.log", drink_id: randomUUID(), team_id: t0, player_id: id(trip, "Joe"), hole: 1, drink_type: "drink", photo_path: null, as_commissioner: true }),
    op({ type: "drink.log", drink_id: randomUUID(), team_id: t0, player_id: id(trip, "Greg"), hole: 1, drink_type: "drink", photo_path: null, as_commissioner: true }),
    op({ type: "score.set", team_id: t0, hole: 1, strokes: 4, as_commissioner: true }),
    op({ type: "score.set", team_id: t1, hole: 1, strokes: 5, as_commissioner: true }),
    op({ type: "score.set", team_id: t2, hole: 1, strokes: 4, as_commissioner: true }),
    ...trip.teams.flatMap((t) => [2, 3, 4].map((hole) => op({ type: "tee.open", team_id: t, hole, as_commissioner: true }))),
  ]);
  const ctx = await playerPhone(browser, trip.code, id(trip, "Drew"));
  const p = await ctx.newPage();
  try {
    // Board: the leader in words, and where I stand.
    await p.goto(`/t/${trip.code}?tab=leaderboard`);
    await expect(p.getByTestId("leader-score")).toHaveText("2 under · thru 1", { timeout: 30_000 });
    await expect(p.getByTestId("leader-chase")).toHaveText("You: 3rd, 3 back");
    const legend = p.getByTestId("board-legend");
    await expect(legend).toContainText("To par");
    await expect(legend).toContainText("Thru");
    await expect(legend).toContainText("banked");
    await expectNoHorizontalOverflow(p);

    // Money: projected, and "what do I owe?" right under the banner; the You tile jumps to it.
    await p.getByTestId("tab-money").click();
    const banner = p.getByTestId("money-banner");
    await expect(banner).toContainText("Final when the commissioner signs off.");
    await expect(banner).not.toContainText("Projected. ");
    const myPay = p.locator('[data-testid="payment"][data-mine="pay"]').first();
    await expect(myPay).toBeVisible();
    await p.evaluate(() => window.scrollTo(0, 0));
    expect((await myPay.boundingBox())!.y + (await p.evaluate(() => window.scrollY))).toBeLessThan(1000);
    const seeMine = p.getByTestId("money-see-mine");
    expect((await seeMine.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await seeMine.scrollIntoViewIfNeeded();
    await seeMine.click();
    await expect(p.locator("#money-settle")).toBeInViewport();
    // It lands near the top, just under the sticky header (not merely somewhere on screen).
    await expect.poll(async () => (await p.locator("#money-settle").boundingBox())!.y, { timeout: 5_000 }).toBeLessThan(250);
    await expectNoHorizontalOverflow(p);

    // Contests: 💣 for long drive, and hole 3 (everyone's through) offers a quiet late entry.
    await p.getByTestId("tab-contests").click();
    const card3 = p.locator('[data-testid="contest-card"][data-hole="3"]');
    await expect(card3).toContainText("Everyone's through");
    await expect(card3.getByTestId("contest-enter")).toHaveAttribute("data-late", "true");
    await expect(card3.getByTestId("contest-enter")).toContainText("Forgot to enter? Add it late");
    await expect(p.locator('[data-testid="contest-card"][data-hole="4"]')).toContainText("💣");
    await expect(p.locator("body")).not.toContainText("💥 Long drive");
    await expectNoHorizontalOverflow(p);
  } finally {
    await ctx.close();
  }

  // A trip with no antes: just the empty state (no "$0 in play" banner on top of "No money").
  const free = await createTrip(page.request, { start: true });
  const ctx2 = await playerPhone(browser, free.code, id(free, "Mark"));
  const q = await ctx2.newPage();
  try {
    await q.goto(`/t/${free.code}?tab=money`);
    await expect(q.getByText("No money on the line")).toBeVisible({ timeout: 30_000 });
    await expect(q.getByTestId("money-banner")).toHaveCount(0);
  } finally {
    await ctx2.close();
  }
});

test("Setup: the Next strip, one-tap random teams, Venmo on file, ante chips that fit, Live first once it's live", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const trip = await createTrip(page.request, { teams: false });
  await page.addInitScript(([c, me]) => localStorage.setItem(`scramble:me:${c}`, me), [trip.code, id(trip, "Caster")] as const);
  await page.goto(`/t/${trip.code}?tab=setup`);
  const screen = page.getByTestId("setup-screen");
  await expect(screen).toHaveAttribute("data-section", "roster", { timeout: 30_000 });
  await expect(page.getByTestId("roster-venmo-count")).toHaveText("Venmo on file: 0 of 10 · Pay buttons need these");

  // Tab badges: Teams blocks (red !), Course only wants long-drive tee points (yellow dot).
  const tab = (name: RegExp) => page.getByRole("tab", { name });
  await expect(tab(/^Teams/).locator('[data-testid="setup-tab-badge"]')).toHaveAttribute("data-level", "block");
  await expect(tab(/^Course/).locator('[data-testid="setup-tab-badge"]')).toHaveAttribute("data-level", "warn");

  // The one thing to do next, a tap away.
  const next = page.getByTestId("setup-next");
  await expect(next).toHaveText("Next: 10 not on a team →");
  await next.click();
  await expect(screen).toHaveAttribute("data-section", "teams");

  // No teams yet: random teams are the big button, one tap, no confirm, with an Undo.
  const shuffle = page.getByTestId("shuffle-teams");
  await expect(shuffle).toHaveText(/Make 3 random teams \(4, 3, 3\)/);
  await expect(page.getByTestId("add-team")).toHaveText(/Build teams by hand/);
  await shuffle.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("team-size")).toHaveText(["4/4", "3/4", "3/4"]);
  await expect(page.locator("[data-toast-host]").getByRole("button", { name: "Undo" })).toBeVisible();
  // Teams exist now: a reshuffle asks first.
  await page.getByTestId("shuffle-teams").click();
  await expect(page.getByRole("dialog")).toContainText("Shuffle into teams of");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // Pots: every quick ante shows in full ("$50", not "$…") and is a real tap target.
  await tab(/^Pots/).click();
  const chips = page.getByTestId("quick-amount");
  expect(await chips.count()).toBeGreaterThanOrEqual(8);
  const fit = await chips.evaluateAll((els) => els.map((e) => ({ text: e.textContent?.trim(), sw: e.scrollWidth, cw: e.clientWidth, h: e.getBoundingClientRect().height })));
  for (const c of fit) {
    expect(c.sw, `${c.text} is clipped`).toBeLessThanOrEqual(c.cw);
    expect(c.h).toBeGreaterThanOrEqual(48);
  }
  expect(fit.map((c) => c.text)).toContain("$50");

  // Pre-flight: Venmo is an optional extra, not a blocker.
  await tab(/^Round/).click();
  await expect(page.getByTestId("preflight-item").filter({ hasText: "No Venmo for 10 players" })).toHaveAttribute("data-level", "warn");
  await expect(page.getByTestId("preflight-ready")).toContainText("10 players · 3 teams (4/3/3)");

  // Live: Setup opens on the Live tools even though Pots was the last section used.
  await tab(/^Pots/).click();
  await sync(page.request, trip.code, [op({ type: "trip.start" })]);
  await page.goto(`/t/${trip.code}?tab=setup`);
  await expect(screen).toHaveAttribute("data-section", "round", { timeout: 30_000 });
  await expect(page.getByTestId("setup-next")).toHaveCount(0);
});

test("the trip link's preview: share title, description and a 1200x630 image with the trip's name", async ({ page }) => {
  const trip = await createTrip(page.request, { teams: false });
  const html = await (await page.request.get(`/t/${trip.code}`)).text();
  expect(html).toContain('property="og:title" content="You&#x27;re in: the Scramble ⛳"');
  expect(html).toMatch(/property="og:description" content="Open it, tap your name\./);
  expect(html).toContain('name="twitter:card" content="summary_large_image"');
  const image = /property="og:image" content="([^"]+)"/.exec(html)?.[1];
  expect(image, "og:image").toBeTruthy();
  const path = new URL(image!.replace(/&amp;/g, "&"), "http://x").pathname + new URL(image!.replace(/&amp;/g, "&"), "http://x").search;
  expect(path).toMatch(new RegExp(`^/t/${trip.code}/opengraph-image`));
  for (const url of [path, "/t/zzzz-nope/opengraph-image"]) {
    const res = await page.request.get(url);
    expect(res.status(), url).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    const png = await res.body();
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], url).toEqual([1200, 630]);
  }
});
