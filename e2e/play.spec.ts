// Play tab end to end against the real server: a threesome player tees off, logs drinks (the 3rd
// is a ghost beer), undoes one, scores, records a tee shot, advances a hole, then keeps playing
// offline and syncs exactly once when the signal comes back.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

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
const drinksHeader = (page: Page) => page.getByTestId("drinks-panel").locator("h2 + span");

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

  // Undo the ghost beer (the newest undo toast).
  await page.getByRole("button", { name: "Undo", exact: true }).last().click();
  await expect(page.getByText("Drink undone. Pretend it never happened.")).toBeVisible();
  await expect(drinksHeader(page)).toHaveText(/Hole 1: −2/);
  await expect(page.getByTestId("drink-row").filter({ hasText: "Rob" }).getByTestId("drink-count")).toHaveText("0");

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
  const res = await page.request.get(`/api/t/${code}/state`);
  expect(res.ok()).toBe(true);
  const { state } = (await res.json()) as {
    state: {
      drinks: Array<{ team_id: string; player_id: string; hole: number; deleted_at: string | null }>;
      hole_scores: Array<{ team_id: string; hole: number; strokes: number | null; tee_shot_player_id: string | null }>;
      team_round_state: Array<{ team_id: string; open_hole: number | null }>;
    };
  };
  const byName = (n: string) => players.find((p) => p.name === n)!.id;
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

  await page.getByTestId("save-score").click(); // par 4 on hole 1
  await page.getByRole("button", { name: "On the tee: hole 2" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Tee off 2" }).click();
  await expect(page.getByTestId("hole-number")).toHaveText("2");

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
