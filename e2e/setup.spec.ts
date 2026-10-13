// Commissioner Setup end to end against the real server: create the trip from the home page
// (roster box cleared, so it starts empty), build the roster by hand, make 3 teams (tap-to-move for most players, one real mouse drag), crown the
// groom, set antes with a 70/30 split, start the round, and check Play unlocks for a player.
import { randomUUID } from "node:crypto";
import { devices, expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { LOCAL_TEAM_NAMES } from "../src/components/setup/teamNames";

/** Typed for Team 2: not on (or inside a name of) the generator's house list Team 1 picks from. */
const TEAM2_NAME = "Dew Sweepers";

const PLAYERS = ["Nick", "Dave", "Mike", "Chris", "Tom", "Jimmy", "Rob", "Steve", "Pete", "Gus"];

async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.iw}px viewport`).toBeLessThanOrEqual(m.iw);
}

const section = (page: Page, name: RegExp) => page.getByRole("tablist", { name: "Setup sections" }).getByRole("tab", { name });

async function dismissFanfare(page: Page, tone: string) {
  const fanfare = page.getByTestId("fanfare");
  await expect(fanfare).toHaveAttribute("data-tone", tone);
  await fanfare.click();
  await expect(fanfare).toHaveCount(0);
}

/** Tap a player on the Teams board, then pick the team in the sheet. */
async function tapMove(page: Page, player: string, team: string) {
  await page.getByTestId("team-player").filter({ hasText: player }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByTestId("move-sheet")).toBeVisible();
  await sheet.getByRole("button", { name: `Move to ${team}`, exact: true }).click();
  await expect(page.getByTestId("team-zone").filter({ hasText: team }).getByTestId("team-player").filter({ hasText: player })).toBeVisible();
}

test("commissioner sets up the trip from scratch and starts the round", async ({ page, browser }) => {
  test.setTimeout(180_000);

  // ---- Create the trip from the home page ----
  await page.goto("/?home=1");
  await page.getByRole("button", { name: "Create the trip" }).click();
  await page.getByLabel("Trip name").fill("Setup Spec Scramble");
  // The roster box comes pre-filled with the crew (e2e/onboarding.spec.ts covers that path); empty
  // it to build a different roster by hand. No names, no groom picker.
  await expect(page.getByTestId("create-roster")).toHaveValue(/^Caster\nJoe\n/);
  await page.getByTestId("create-roster").fill("");
  await expect(page.getByTestId("create-groom")).toHaveCount(0);
  await page.getByLabel("Commissioner PIN").fill("2468");
  await page.getByRole("button", { name: "Create trip" }).click();
  await expect(page).toHaveURL(/\/t\/[a-z0-9]+\?tab=setup/, { timeout: 30_000 });
  const code = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByTestId("setup-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("setup-roster")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // ---- Roster: 10 players via quick add (the commissioner stays in Setup the whole time) ----
  const nameInput = page.getByTestId("quick-add-name");
  for (const name of PLAYERS) {
    await nameInput.fill(name);
    await nameInput.press("Enter");
    await expect(page.getByTestId("roster-row").filter({ hasText: name })).toBeVisible();
  }
  await expect(page.getByTestId("roster-row")).toHaveCount(10);
  await expect(page.getByTestId("setup-screen")).toBeVisible();

  // ---- Groom: edit Nick, flip the groom switch ----
  await page.getByTestId("roster-row").filter({ hasText: "Nick" }).click();
  await page.getByRole("dialog").getByRole("switch", { name: /The groom/ }).click();
  await page.getByTestId("player-save").click();
  await dismissFanfare(page, "groom");
  await expect(page.getByRole("button", { name: "Edit Nick, the groom" })).toBeVisible();

  // ---- Teams: 3 teams ----
  await section(page, /Teams/).click();
  await expect(page.getByTestId("setup-teams")).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByTestId("add-team").click();
  await expect(page.getByTestId("team-zone")).toHaveCount(3);
  await expect(page.getByTestId("team-name")).toHaveText(["Team 1", "Team 2", "Team 3"]);

  // Tap-to-move for 9 players: 3 / 3 / 3, leaving Gus in the pool.
  const plan: Array<[string, string]> = [
    ["Nick", "Team 1"],
    ["Dave", "Team 1"],
    ["Mike", "Team 1"],
    ["Chris", "Team 2"],
    ["Tom", "Team 2"],
    ["Jimmy", "Team 2"],
    ["Rob", "Team 3"],
    ["Steve", "Team 3"],
    ["Pete", "Team 3"],
  ];
  for (const [player, team] of plan) await tapMove(page, player, team);
  const pool = page.getByTestId("pool-zone");
  await expect(pool.getByTestId("team-player")).toHaveCount(1);

  // One real drag with the mouse: Gus from the pool onto Team 1 (the zone right below it).
  const team1 = page.getByTestId("team-zone").filter({ hasText: "Team 1" });
  await pool.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -150)); // clear the sticky header + section bar
  const gus = pool.getByTestId("team-player").filter({ hasText: "Gus" });
  const from = (await gus.boundingBox())!;
  const to = (await team1.boundingBox())!;
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const drop = { x: to.x + to.width / 2, y: to.y + Math.min(70, to.height / 2) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 4 });
  await page.mouse.move(drop.x, drop.y, { steps: 16 });
  await page.mouse.up();
  await expect(team1.getByTestId("team-player").filter({ hasText: "Gus" })).toBeVisible();
  await expect(pool.getByTestId("team-player")).toHaveCount(0);
  await expect(page.getByTestId("team-size")).toHaveText(["4/4", "3/4", "3/4"]);

  // A full team refuses a 5th player in the tap-to-move sheet.
  await page.getByTestId("team-zone").filter({ hasText: "Team 2" }).getByTestId("team-player").filter({ hasText: "Chris" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Move to Team 1", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // Rename Team 1 from the generator (AI is off in e2e: house list) and set a tee time.
  await team1.getByTestId("edit-team").click();
  const teamSheet = page.getByRole("dialog");
  await teamSheet.getByTestId("generate-names").click();
  const suggestions = teamSheet.getByTestId("name-suggestion");
  await expect(suggestions).toHaveCount(5);
  const picked = (await suggestions.first().textContent())!.trim();
  await suggestions.first().click();
  await expect(teamSheet.getByTestId("team-name-input")).toHaveValue(picked);
  await teamSheet.getByRole("button", { name: "12:50 PM" }).click();
  await teamSheet.getByTestId("team-done").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("team-name").first()).toHaveText(picked);
  await expect(page.getByTestId("team-zone").first()).toContainText("12:50 PM");

  // Type Team 2's name, then tap a tee-time chip straight away: the blur saves the name and the
  // "Saved" row must not shove the chips down mid-tap (the tee time used to be silently lost).
  // The name isn't on the generator's house list, so it can never collide with Team 1's pick.
  expect(LOCAL_TEAM_NAMES.filter((n) => n.includes(TEAM2_NAME))).toEqual([]);
  expect(picked).not.toContain(TEAM2_NAME);
  await page.getByTestId("team-zone").filter({ hasText: "Team 2" }).getByTestId("edit-team").click();
  const sheet2 = page.getByRole("dialog");
  await sheet2.getByTestId("team-name-input").fill(TEAM2_NAME);
  await sheet2.getByRole("button", { name: "1:00 PM" }).click();
  await expect(sheet2.getByTestId("tee-time-input")).toHaveValue("13:00");
  await expect(sheet2.getByTestId("team-name-status")).toContainText("Saved");
  await sheet2.getByTestId("team-done").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const team2 = page.getByTestId("team-zone").filter({ hasText: TEAM2_NAME });
  await expect(team2).toContainText("1:00 PM");
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/t/${code}/state`);
      const body = (await res.json()) as { state: { teams: { name: string; tee_time: string | null }[] } };
      return body.state.teams.find((t) => t.name === TEAM2_NAME)?.tee_time ?? null;
    })
    .toBe("13:00");

  // ---- Pots: $20 team match, $5 per contest hole, 70/30 ----
  await section(page, /Pots/).click();
  await page.getByTestId("team-ante").fill("20");
  await page.getByTestId("team-ante").press("Enter");
  await page.getByTestId("contest-ante").fill("5");
  await page.getByTestId("contest-ante").press("Enter");
  await page.getByTestId("payout-split").click();
  await expect(page.getByTestId("payout-split")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("split-stepper")).toContainText("70/30");
  await expect(page.getByTestId("exposure-amount")).toHaveText("$60");
  await expect(page.getByTestId("optout-matrix")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // ---- Round: pre-flight, then start ----
  await section(page, /Round/).click();
  await expect(page.getByTestId("preflight-item").filter({ hasText: "Everyone is on a team" })).toHaveAttribute("data-level", "ok");
  await expect(page.getByTestId("preflight-item").filter({ hasText: "Groom: Nick" })).toHaveAttribute("data-level", "ok");
  await expect(page.getByTestId("preflight-item").filter({ hasText: "Antes set" })).toHaveAttribute("data-level", "ok");
  await expect(page.getByTestId("preflight-item").filter({ hasText: "Long drive tee points" })).toHaveAttribute("data-level", "warn");
  await expect(page.locator('[data-testid="preflight-item"][data-level="block"]')).toHaveCount(0);
  await page.getByTestId("start-round").click();
  await page.getByRole("dialog").getByRole("button", { name: "Start it" }).click();
  await dismissFanfare(page, "hype");
  await expect(page.getByTestId("setup-round")).toHaveAttribute("data-status", "live");
  await expect(page.getByTestId("round-status")).toContainText("Round is live");
  await expect(page.getByTestId("finalize-round")).toBeVisible();

  // The server agrees.
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/t/${code}/state`);
      const body = (await res.json()) as { state: { trip: { status: string; settings: { team_match_payout: number[]; team_match_ante_cents: number } } } };
      return [body.state.trip.status, body.state.trip.settings.team_match_payout.join("/"), body.state.trip.settings.team_match_ante_cents];
    })
    .toEqual(["live", "70/30", 2000]);

  // Play unlocked for the commissioner (no more "waiting for the commissioner").
  // (Under `next dev` the dev-tools badge sits on top of the Play tab; it doesn't exist in production.)
  await page.evaluate(() => document.querySelector("nextjs-portal")?.remove());
  await page.getByTestId("tab-play").click();
  await expect(page.getByTestId("waiting-for-start")).toHaveCount(0);
  await expect(page.getByTestId("team-picker")).toBeVisible();

  // ...and for a plain player on another phone.
  const player = await browser.newContext({ ...devices["iPhone 13"], baseURL: test.info().project.use.baseURL });
  try {
    const p2 = await player.newPage();
    await p2.goto(`/t/${code}`);
    await expect(p2.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
    await p2.getByTestId("join-player").filter({ hasText: "Tom" }).click();
    await expect(p2.getByTestId("trip-shell")).toHaveAttribute("data-tab", "play");
    await expect(p2.getByTestId("waiting-for-start")).toHaveCount(0);
    await expect(p2.getByTestId("tee-cta")).toBeVisible();
  } finally {
    await player.close();
  }
});

// ---------------------------------------------------------------------------

async function seedTrip(request: APIRequestContext) {
  const res = await request.post("/api/trips", { data: { pin: "2468", name: "Setup Width Check" } });
  expect(res.status(), await res.text()).toBe(201);
  const { code } = (await res.json()) as { code: string };
  let t = Date.now() - 60_000;
  const op = (o: Record<string, unknown>) => ({ id: randomUUID(), at: new Date(t++).toISOString(), by: null, ...o });
  const players = PLAYERS.map((name, i) => ({
    id: randomUUID(),
    name: i === 1 ? "Christopher Montgomery" : name,
    nickname: i === 0 ? "Big Nick The Groom" : null,
    is_groom: i === 0,
    sort_order: i,
  }));
  const teams = [
    { id: randomUUID(), name: "Weapons of Grass Destruction", sort_order: 0, tee_time: "12:50" },
    { id: randomUUID(), name: "The Shank Redemption", sort_order: 1 },
    { id: randomUUID(), name: "Bogey Nights", sort_order: 2 },
  ];
  const teamOf = [0, 0, 0, 0, 1, 1, 1, 2, 2];
  const ops = [
    ...players.map((p) => op({ type: "player.upsert", player: p })),
    ...teams.map((team) => op({ type: "team.upsert", team })),
    ...teamOf.map((ti, i) => op({ type: "team.assign", player_id: players[i].id, team_id: teams[ti].id })),
    op({ type: "trip.update", patch: { settings: { team_match_ante_cents: 2000, contest_ante_cents: 500, team_match_payout: [70, 30] } } }),
  ];
  const sync = await request.post(`/api/t/${code}/sync`, { data: { ops } });
  expect(sync.ok()).toBe(true);
  return { code };
}

test("every setup section fits a 360px phone, settings save, and Setup is commissioner-only", async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 740 });
  const { code } = await seedTrip(page.request);
  await page.goto(`/t/${code}?tab=setup`);
  // Players exist and this phone hasn't picked one: the commissioner can skip the join screen.
  await expect(page.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /Skip for now/ }).click();
  await expect(page.getByTestId("setup-screen")).toBeVisible({ timeout: 30_000 });

  for (const [name, testId] of [
    [/Roster/, "setup-roster"],
    [/Teams/, "setup-teams"],
    [/Pots/, "setup-pots"],
    [/settings/i, "setup-settings"],
    [/Round/, "setup-round"],
  ] as const) {
    await section(page, name).click();
    await expect(page.getByTestId(testId)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  // All six section tabs fit the 360px bar: none clipped or scrolled away, no label cut off.
  const fit = await page.getByTestId("setup-tabs").evaluate((bar) => {
    const box = bar.getBoundingClientRect();
    return [...bar.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => {
      const r = tab.getBoundingClientRect();
      const label = tab.querySelector<HTMLElement>("span:not([aria-hidden])")!;
      return {
        label: label.textContent,
        inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.right <= window.innerWidth,
        cut: label.scrollWidth > label.clientWidth,
      };
    });
  });
  expect(fit.map((t) => t.label)).toEqual(["Roster", "Teams", "Course", "Pots", "Trip", "Round"]);
  expect(fit.filter((t) => !t.inside || t.cut)).toEqual([]);
  // Round: Gus isn't on a team, so Start is blocked and says why.
  await expect(page.locator('[data-testid="preflight-item"][data-level="block"]').filter({ hasText: "1 not on a team" })).toBeVisible();
  await expect(page.getByTestId("start-round")).toBeDisabled();

  // Settings: a change shows the save bar; saving persists it.
  await section(page, /settings/i).click();
  await page.getByTestId("setting-app-name").fill("Last Swing Before the Ring");
  await expect(page.getByTestId("settings-save-bar")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-save-bar")).toHaveCount(0);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/t/${code}/state`)).json()) as { state: { trip: { app_name: string } } }).state.trip.app_name)
    .toBe("Last Swing Before the Ring");

  // Without the commissioner cookie, ?tab=setup falls back to Play for a regular player.
  await context.clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/t/${code}?tab=setup`);
  await expect(page.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("join-player").filter({ hasText: "Tom" }).click();
  await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "play");
  await expect(page.getByTestId("waiting-for-start")).toBeVisible();
  // Pre-round, the optional "Get set up" card leads (Home Screen + notifications), and fits 360px.
  await expect(page.getByTestId("get-set-up")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
