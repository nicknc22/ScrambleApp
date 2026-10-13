// Play tab end to end against the real server: a threesome player tees off, logs drinks (the 3rd
// is a ghost beer), undoes one, scores, records a tee shot, advances a hole, then keeps playing
// offline and syncs exactly once when the signal comes back. Plus: two phones on one team, the
// par-default advance (and that it never replaces a teammate's score), the inline drink Undo vs.
// Save / On the tee / the tab bar, and the first-screen layout.
import { randomUUID } from "node:crypto";
import { devices, expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface SetupPlayer {
  id: string;
  name: string;
  nickname: string | null;
  is_groom: boolean;
  sort_order: number;
}

async function createLiveTrip(request: APIRequestContext) {
  const res = await request.post("/api/trips", { data: { pin: "2468", name: "Play Spec Scramble" } });
  expect(res.status(), await res.text()).toBe(201);
  const { code } = (await res.json()) as { code: string };

  let t = Date.now() - 60_000;
  const op = (o: Record<string, unknown>) => ({ id: randomUUID(), at: new Date(t++).toISOString(), by: null, ...o });
  const names: Array<[string, string | null, boolean]> = [
    ["Nick", "Big Nick", true],
    ["Dave", null, false],
    ["Mike", null, false],
    ["Chris", null, false],
    ["Tom", null, false],
    ["Jimmy", null, false],
    ["Rob", null, false],
  ];
  const players: SetupPlayer[] = names.map(([name, nickname, is_groom], i) => ({ id: randomUUID(), name, nickname, is_groom, sort_order: i }));
  const teams = [
    { id: randomUUID(), name: "Grip It & Sip It", sort_order: 0 },
    { id: randomUUID(), name: "The Shank Redemption", sort_order: 1 },
  ];
  const teamOf = [0, 0, 0, 0, 1, 1, 1];
  const ops = [
    ...players.map((p) => op({ type: "player.upsert", player: p })),
    ...teams.map((team) => op({ type: "team.upsert", team })),
    ...players.map((p, i) => op({ type: "team.assign", player_id: p.id, team_id: teams[teamOf[i]].id })),
    op({ type: "trip.start" }),
  ];
  const sync = await request.post(`/api/t/${code}/sync`, { data: { ops } });
  expect(sync.ok()).toBe(true);
  const body = (await sync.json()) as { results: Array<{ status: string; reason?: string }> };
  expect(body.results.filter((r) => r.status !== "applied")).toEqual([]);
  return { code, players, threesome: teams[1] };
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

const drinkButton = (page: Page, name: string) => page.getByRole("button", { name: `Drink for ${name}`, exact: true });
const drinkRow = (page: Page, playerId: string) => page.locator(`[data-testid="drink-row"][data-player="${playerId}"]`);
const drinksHeader = (page: Page) => page.getByTestId("drinks-panel").locator("h2 + span");

async function joinAs(page: Page, code: string, playerId: string, viewport?: { width: number; height: number }) {
  await page.context().addInitScript(
    ([c, id]) => {
      localStorage.setItem(`scramble:me:${c}`, id);
      localStorage.setItem("scramble:onboarded", "1");
    },
    [code, playerId],
  );
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(`/t/${code}`);
  await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "play", { timeout: 30_000 });
  await expect(page.getByTestId("hole-number")).toBeVisible();
}

interface ServerState {
  hole_scores: Array<{ team_id: string; hole: number; strokes: number | null; tee_shot_player_id: string | null }>;
  team_round_state: Array<{ team_id: string; open_hole: number | null }>;
  drinks: Array<{ team_id: string; player_id: string; hole: number; deleted_at: string | null }>;
}

async function serverState(request: APIRequestContext, code: string): Promise<ServerState> {
  const res = await request.get(`/api/t/${code}/state`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { state: ServerState }).state;
}

const strokesOf = (state: ServerState, teamId: string) =>
  state.hole_scores
    .filter((s) => s.team_id === teamId && s.strokes !== null)
    .sort((a, b) => a.hole - b.hole)
    .map((s) => [s.hole, s.strokes]);

test("score a hole, drinks with a ghost beer and undo, next hole, then offline and back", async ({ page, context }) => {
  test.setTimeout(150_000);
  const { code, players, threesome } = await createLiveTrip(page.request);
  // Setup needed the commissioner cookie; play the round as a plain player.
  await context.clearCookies();

  await page.goto(`/t/${code}`);
  await expect(page.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("join-player").filter({ hasText: "Tom" }).click();
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.getByRole("button", { name: "Skip setup" }).click();

  const shell = page.getByTestId("trip-shell");
  await expect(shell).toHaveAttribute("data-tab", "play");
  await expect(page.getByTestId("hole-number")).toHaveText("1");
  await expect(page.getByTestId("threesome-reminder")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Before teeing off, drinks don't count: roast, nothing logged.
  await drinkButton(page, "Tom").click();
  await expect(page.getByText("That one doesn't count", { exact: true })).toBeVisible();
  await expect(drinksHeader(page)).toHaveText("No window open");

  // On the tee: Hole 1 -> hype fanfare, window opens.
  const tee = page.getByTestId("tee-cta");
  await expect(tee).toHaveText(/On the tee: Hole 1/);
  await tee.click();
  await dismissFanfare(page, "hype");
  await expect(tee).toHaveCount(0);
  await expect(drinksHeader(page)).toHaveText(/Hole 1: −0/);

  // Three drinks for a threesome: 1, 1, then a ghost beer worth 2.
  await drinkButton(page, "Tom").click();
  await drinkButton(page, "Jimmy").click();
  await expect(drinksHeader(page)).toHaveText(/Hole 1: −2/);
  await drinkButton(page, "Rob").click();
  await expect(page.getByTestId("fanfare")).toContainText(/Ghost beer/i);
  await dismissFanfare(page, "ghost");
  await expect(drinksHeader(page)).toHaveText(/Hole 1: −4/);

  // No toast: one inline Undo chip for the burst, on the newest drink's row (Rob's ghost beer).
  const byName = (n: string) => players.find((p) => p.name === n)!.id;
  await expect(page.getByTestId("drink-undo")).toHaveCount(1);
  await expect(drinkRow(page, byName("Rob")).getByTestId("drink-undo")).toHaveAttribute("data-count", "3");
  await expect(drinkRow(page, byName("Rob")).getByTestId("drink-undo")).toContainText("Ghost beer −2");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  // Undo removes the latest drink (the ghost beer); the chip moves to Jimmy's.
  await page.getByRole("button", { name: "Undo Rob's drink" }).click();
  await expect(drinkRow(page, byName("Rob")).getByTestId("drink-undone")).toHaveText("↩️ Drink undone");
  await expect(drinkRow(page, byName("Jimmy")).getByTestId("drink-undo")).toHaveAttribute("data-count", "2");
  await expect(drinksHeader(page)).toHaveText(/Hole 1: −2/);
  await expect(drinkRow(page, byName("Rob")).getByTestId("drink-count")).toHaveText("0");
  await expect(drinkRow(page, byName("Jimmy")).getByTestId("drink-count")).toHaveText("1");

  // The threesome reminder goes away for the rest of the round once dismissed (checked on hole 2).
  await page.getByRole("button", { name: "Hide the threesome reminder for the rest of the round" }).click();
  await expect(page.getByTestId("threesome-reminder")).toHaveCount(0);

  // Score: par 4 default, bump to 5, live net preview, save.
  await page.getByRole("button", { name: "One more stroke" }).click();
  await expect(page.getByTestId("net-preview")).toContainText("5 − 2 🍺 = 3 net");
  await page.getByTestId("save-score").click();
  await expect(page.getByTestId("saved-state")).toBeVisible();
  await expect(page.getByTestId("score-status")).toHaveText(/Saved/);

  // Whose tee shot: Jimmy.
  const jimmy = page.getByRole("button", { name: /^Jimmy's tee shot/ });
  await jimmy.click();
  await expect(jimmy).toHaveAttribute("aria-pressed", "true");

  // Next hole, through the confirm.
  await page.getByRole("button", { name: "On the tee: hole 2" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("locked in at 5");
  await dialog.getByRole("button", { name: "Tee off 2" }).click();
  await expect(page.getByTestId("hole-number")).toHaveText("2");
  await expect(drinksHeader(page)).toHaveText(/Hole 2: −0/);
  await expect(page.getByTestId("threesome-reminder")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // Make sure everything so far reached the server before going offline.
  await expect(page.getByTestId("offline-badge")).toHaveCount(0, { timeout: 30_000 });

  // No signal: a drink and a score queue up locally.
  await context.setOffline(true);
  await drinkButton(page, "Tom").click();
  // After the undo it's the team's 3rd active drink: another ghost beer, even with no signal.
  await dismissFanfare(page, "ghost");
  await expect(drinksHeader(page)).toHaveText(/Hole 2: −2/);
  await page.getByTestId("save-score").click();
  await expect(page.getByTestId("saved-state")).toBeVisible();
  await expect(page.getByTestId("offline-badge").first()).toContainText("Offline, 2 changes waiting");

  // Signal's back: the outbox drains.
  await context.setOffline(false);
  await expect(page.getByTestId("offline-badge")).toHaveCount(0, { timeout: 45_000 });

  // The server has everything exactly once.
  const state = await serverState(page.request, code);
  const drinks = state.drinks.filter((d) => d.team_id === threesome.id);
  expect(drinks).toHaveLength(4);
  expect(drinks.filter((d) => d.deleted_at !== null).map((d) => d.player_id)).toEqual([byName("Rob")]);
  expect(drinks.filter((d) => d.hole === 2).map((d) => d.player_id)).toEqual([byName("Tom")]);
  const scores = state.hole_scores.filter((s) => s.team_id === threesome.id).sort((a, b) => a.hole - b.hole);
  expect(scores.map((s) => [s.hole, s.strokes])).toEqual([
    [1, 5],
    [2, 4],
  ]);
  expect(scores[0].tee_shot_player_id).toBe(byName("Jimmy"));
  expect(state.team_round_state.find((r) => r.team_id === threesome.id)?.open_hole).toBe(2);
});

test("scorecard strip: open an earlier hole, edit it, and come back", async ({ page, context }) => {
  test.setTimeout(120_000);
  const { code, players } = await createLiveTrip(page.request);
  await context.clearCookies();
  await context.addInitScript(
    ([c, id]) => {
      localStorage.setItem(`scramble:me:${c}`, id);
      localStorage.setItem("scramble:onboarded", "1");
    },
    [code, players.find((p) => p.name === "Dave")!.id],
  );
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/t/${code}`);
  await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "play", { timeout: 30_000 });

  // A foursome: no threesome reminder; groom's team gets the Groom's Mulligan button.
  await expect(page.getByTestId("threesome-reminder")).toHaveCount(0);
  await page.getByTestId("tee-cta").click();
  await dismissFanfare(page, "hype");
  await expect(page.getByRole("button", { name: /Groom's Mulligan/ })).toBeVisible();

  // Leave the stepper at par and go: the confirm's main button saves the par it shows.
  await page.getByRole("button", { name: "On the tee: hole 2" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Par 4 on hole 1?");
  await expect(dialog.getByRole("button", { name: "Tee off without a score" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save 4 & tee off hole 2" }).click();
  await expect(page.getByTestId("hole-number")).toHaveText("2");
  await expect(page.getByTestId("scorecard-strip").getByRole("button", { name: /^Hole 1, par 4, 4 strokes/ })).toBeVisible();

  // Tap hole 1 on the strip: editing bar, change 4 -> 3, save, back.
  await page.getByTestId("scorecard-strip").getByRole("button", { name: /^Hole 1,/ }).click();
  await expect(page.getByTestId("editing-bar")).toContainText("Editing hole 1");
  await expect(page.getByTestId("hole-number")).toHaveText("1");
  await page.getByRole("button", { name: "One fewer stroke" }).click();
  await page.getByTestId("save-score").click();
  await expect(page.getByTestId("saved-state")).toBeVisible();
  await page.getByRole("button", { name: "Back to hole 2" }).first().click();
  await expect(page.getByTestId("editing-bar")).toHaveCount(0);
  await expect(page.getByTestId("hole-number")).toHaveText("2");
  await expect(page.getByTestId("scorecard-strip").getByRole("button", { name: /^Hole 1, par 4, 3 strokes/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("a teammate's tee-off doesn't move a phone with an unsaved score, and Save can't land on the new hole", async ({ browser, page }) => {
  test.setTimeout(150_000);
  const { code, players, threesome } = await createLiveTrip(page.request);
  const id = (n: string) => players.find((p) => p.name === n)!.id;
  const phone = { ...devices["iPhone 13"], baseURL: test.info().project.use.baseURL };
  const ctxA = await browser.newContext(phone);
  const ctxB = await browser.newContext(phone);
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await joinAs(a, code, id("Tom"));
  await joinAs(b, code, id("Jimmy"));

  await a.getByTestId("tee-cta").click();
  await dismissFanfare(a, "hype");
  // B picks up hole 1 on its next poll, then bumps the stepper to 5 without saving.
  await expect(b.getByTestId("tee-cta")).toHaveCount(0, { timeout: 15_000 });
  await b.getByRole("button", { name: "One more stroke" }).click();
  await expect(b.getByTestId("save-score")).toHaveText(/Save\s*5/);

  // A saves 4 on hole 1 and tees off hole 2.
  await a.getByTestId("save-score").click();
  await a.getByRole("button", { name: "On the tee: hole 2" }).click();
  await a.getByRole("dialog").getByRole("button", { name: "Tee off 2" }).click();
  await expect(a.getByTestId("hole-number")).toHaveText("2");

  // B stays on hole 1 with its 5 and is told why.
  await expect(b.getByText("Hole 2 teed off on another phone", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(b.getByTestId("hole-number")).toHaveText("1");
  await expect(b.getByTestId("editing-bar")).toContainText("The team is on hole 2");
  await b.getByTestId("save-score").click();
  await expect(b.getByTestId("saved-state")).toBeVisible();
  await expect.poll(async () => strokesOf(await serverState(page.request, code), threesome.id), { timeout: 20_000 }).toEqual([[1, 5]]);
  await b.getByRole("button", { name: "Back to hole 2" }).first().click();
  await expect(b.getByTestId("hole-number")).toHaveText("2");

  // No draft this time: B follows A to hole 3, and its Save (same spot, same "Save 4") is
  // disabled for a moment, so a tap meant for hole 2 can't score hole 3.
  await a.getByTestId("save-score").click();
  await a.getByRole("button", { name: "On the tee: hole 3" }).click();
  await a.getByRole("dialog").getByRole("button", { name: "Tee off 3" }).click();
  await expect(b.getByTestId("hole-number")).toHaveText("3", { timeout: 15_000 });
  await expect(b.getByTestId("save-score")).toBeDisabled();
  await expect(b.getByText("On the tee: hole 3", { exact: true })).toBeVisible();
  await expect(b.getByTestId("save-score")).toBeEnabled();
  const state = await serverState(page.request, code);
  expect(strokesOf(state, threesome.id)).toEqual([
    [1, 5],
    [2, 4],
  ]);
  await ctxA.close();
  await ctxB.close();
});

/** Buttons of the action bar and the tab bar whose centre is covered by something else. */
async function coveredControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = '[data-testid="play-action-bar"] button, [data-testid="play-action-bar"] [data-testid="saved-state"], nav[aria-label="Main"] button';
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !el.contains(hit)) out.push(`${el.getAttribute("aria-label") ?? el.textContent?.trim()} under ${hit?.textContent?.trim().slice(0, 40)}`);
    }
    return out;
  });
}

/** A raw tap at an element's centre: whatever is on top gets it (no actionability wait). */
async function rawTap(page: Page, testIdOrLocator: string | ReturnType<Page["locator"]>) {
  const loc = typeof testIdOrLocator === "string" ? page.getByTestId(testIdOrLocator) : testIdOrLocator;
  const box = (await loc.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

for (const vp of [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
]) {
  test(`drink undo is inline: a round of drinks, Save, then On the tee right away keeps every drink (${vp.width}x${vp.height})`, async ({ page }) => {
    test.setTimeout(120_000);
    const { code, players } = await createLiveTrip(page.request);
    const id = (n: string) => players.find((p) => p.name === n)!.id;
    const team = ["Nick", "Dave", "Mike", "Chris"];
    await page.context().clearCookies();
    await joinAs(page, code, id("Dave"), vp);
    await page.getByTestId("tee-cta").click();
    await dismissFanfare(page, "hype");

    // Drinks panel right under the header: where stacked toasts used to swallow taps.
    await page.getByTestId("drinks-panel").evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 110));
    const coveredDrinkButtons = () =>
      page.evaluate(() => {
        const top = document.querySelector('[data-testid="trip-shell"] > header')!.getBoundingClientRect().bottom;
        const bottom = document.querySelector('[data-testid="play-action-bar"]')!.getBoundingClientRect().top;
        const out: string[] = [];
        for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-testid="drink-row"] button')) {
          const r = btn.getBoundingClientRect();
          const y = r.top + r.height / 2;
          if (y <= top || y >= bottom) continue; // off screen / under the header or action bar anyway
          const hit = document.elementFromPoint(r.left + r.width / 2, y);
          if (!hit || !btn.contains(hit)) out.push(btn.getAttribute("aria-label") ?? "?");
        }
        return out;
      });

    for (const name of team) {
      const btn = drinkButton(page, name);
      await btn.scrollIntoViewIfNeeded();
      expect(await coveredDrinkButtons(), `buttons covered before logging for ${name}`).toEqual([]);
      await btn.click();
    }
    // One Undo chip, in the newest drink's row; no toast at all.
    await expect(drinkRow(page, id("Chris")).getByTestId("drink-undo")).toHaveAttribute("data-count", "4");
    await expect(page.getByTestId("drink-undo")).toHaveCount(1);
    await expect(page.getByRole("status").filter({ hasText: /drink/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    await page.getByTestId("drinks-panel").evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 110));
    expect(await coveredDrinkButtons()).toEqual([]);
    expect(await coveredControls(page)).toEqual([]);
    for (const n of team) await expect(drinkRow(page, id(n)).getByTestId("drink-count")).toHaveText("1");
    await expectNoHorizontalOverflow(page);

    // End of the hole: tee shot, Save, then On the tee the moment Save's toast is up.
    await page.getByRole("button", { name: /^Mike's tee shot/ }).click();
    await page.getByTestId("save-score").click();
    await expect(page.getByTestId("saved-state")).toBeVisible();
    expect(await coveredControls(page), "a toast covers Save / On the tee / the tab bar").toEqual([]);
    await rawTap(page, "next-hole");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("locked in at 4");
    for (const n of team) await expect(drinkRow(page, id(n)).getByTestId("drink-count")).toHaveText("1");
    await dialog.getByRole("button", { name: "Tee off 2" }).click();
    await expect(page.getByTestId("hole-number")).toHaveText("2");
    // Every drink is still on hole 1 on the server.
    await expect
      .poll(async () => {
        const st = await serverState(page.request, code);
        return st.drinks.filter((d) => d.deleted_at === null && d.hole === 1).length;
      }, { timeout: 20_000 })
      .toBe(4);

    // The chip outlives a trip to another tab (inside its 10 seconds), and tapping a tab while it
    // is up navigates instead of undoing anything.
    await drinkButton(page, "Nick").click();
    await expect(drinkRow(page, id("Nick")).getByTestId("drink-undo")).toBeVisible();
    expect(await coveredControls(page)).toEqual([]);
    await rawTap(page, "tab-contests");
    await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "contests");
    await rawTap(page, "tab-play");
    await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "play");
    await expect(drinkRow(page, id("Nick")).getByTestId("drink-count")).toHaveText("1");
    // Undo takes back only the newest drink.
    await page.getByRole("button", { name: "Undo Nick's drink" }).click();
    await expect(drinkRow(page, id("Nick")).getByTestId("drink-count")).toHaveText("0");
    await expect(page.getByTestId("drink-undo")).toHaveCount(0);
    await expect
      .poll(async () => {
        const st = await serverState(page.request, code);
        return st.drinks.filter((d) => d.deleted_at === null).map((d) => d.hole).sort();
      }, { timeout: 20_000 })
      .toEqual([1, 1, 1, 1]);
  });
}

test("the advance sheet's untouched par never replaces a teammate's real score", async ({ browser, page }) => {
  test.setTimeout(150_000);
  const { code, players, threesome } = await createLiveTrip(page.request);
  const id = (n: string) => players.find((p) => p.name === n)!.id;
  const phone = { ...devices["iPhone 13"], baseURL: test.info().project.use.baseURL };
  const ctxA = await browser.newContext(phone);
  const ctxB = await browser.newContext(phone);
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await joinAs(a, code, id("Tom"));
  await joinAs(b, code, id("Jimmy"));
  await a.getByTestId("tee-cta").click();
  await dismissFanfare(a, "hype");
  await expect(b.getByTestId("tee-cta")).toHaveCount(0, { timeout: 15_000 });
  await expect(a.getByTestId("offline-badge")).toHaveCount(0, { timeout: 30_000 });

  // A loses signal; B saves a real 5 on hole 1.
  await ctxA.setOffline(true);
  await b.getByRole("button", { name: "One more stroke" }).click();
  await b.getByTestId("save-score").click();
  await expect.poll(async () => strokesOf(await serverState(page.request, code), threesome.id), { timeout: 20_000 }).toEqual([[1, 5]]);

  // A never saw it: its sheet offers the par default, and A takes it.
  await a.getByRole("button", { name: "On the tee: hole 2" }).click();
  const dialog = a.getByRole("dialog");
  await expect(dialog).toContainText("Par 4 on hole 1?");
  await dialog.getByRole("button", { name: "Save 4 & tee off hole 2" }).click();
  await expect(a.getByTestId("hole-number")).toHaveText("2");

  // Back online: hole 2 opens, but B's 5 stands (no score edit in the feed), on both phones.
  await ctxA.setOffline(false);
  await expect(a.getByTestId("offline-badge")).toHaveCount(0, { timeout: 45_000 });
  const state = await serverState(page.request, code);
  expect(strokesOf(state, threesome.id)).toEqual([[1, 5]]);
  expect(state.team_round_state.find((r) => r.team_id === threesome.id)?.open_hole).toBe(2);
  const feed = (await (await page.request.get(`/api/t/${code}/state`)).json()) as { state: { feed_events: Array<{ type: string }> } };
  expect(feed.state.feed_events.filter((e) => e.type === "score_edit")).toEqual([]);
  await expect(a.getByTestId("scorecard-strip").getByRole("button", { name: /^Hole 1, par 4, 5 strokes/ })).toBeVisible({ timeout: 20_000 });
  await ctxA.close();
  await ctxB.close();
});

// 390x664 = iPhone 13 Safari's visible area; 390x763 = the Home Screen app (status bar + home
// indicator); 360x740 = a small Android. The chips must clear the action bar everywhere; on the
// Home Screen sizes the stepper's buttons do too.
for (const vp of [
  { width: 390, height: 664, stepper: false },
  { width: 390, height: 763, stepper: true },
  { width: 360, height: 740, stepper: true },
]) {
  test(`the tee-shot chips are on the first screen of a normal hole (${vp.width}x${vp.height})`, async ({ page }) => {
    test.setTimeout(120_000);
    const { code, players } = await createLiveTrip(page.request);
    await page.context().clearCookies();
    for (const who of ["Tom", "Dave"]) {
      await joinAs(page, code, players.find((p) => p.name === who)!.id, { width: vp.width, height: vp.height });
      if (await page.getByTestId("tee-cta").count()) {
        await page.getByTestId("tee-cta").click();
        await dismissFanfare(page, "hype");
      }
      const m = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid="play-action-bar"]')!.getBoundingClientRect().top;
        const chips = [...document.querySelectorAll('[data-testid="teeshot-panel"] [role="group"] button')].map((b) => b.getBoundingClientRect().bottom);
        const plus = document.querySelector('[data-testid="score-panel"] button[aria-label="One more stroke"]')!.getBoundingClientRect().bottom;
        return { scrollY: window.scrollY, bar, chips, plus };
      });
      expect(m.scrollY).toBe(0);
      expect(m.chips.length).toBe(who === "Dave" ? 4 : 3);
      for (const bottom of m.chips) expect(bottom, `${who}: chip bottom ${bottom} vs action bar ${m.bar}`).toBeLessThanOrEqual(m.bar);
      if (vp.stepper) expect(m.plus, `${who}: stepper bottom ${m.plus} vs action bar ${m.bar}`).toBeLessThanOrEqual(m.bar);
    }
  });
}
