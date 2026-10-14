// "How it works": the 40-second story-style explainer. Plays by itself once per phone per trip
// right after you tap your name (never once the round is final), story controls (auto-advance,
// tap right/left, hold to pause, pause button, arrows, Escape, Skip, Let's go), replays from the
// pre-round card and the ☰ menu, ?explainer=1 for recording, and prefers-reduced-motion. Back
// closes it (not the trip); it only counts as seen once it's on screen; a cut-off greeting comes
// back after a reload; "We're live!" waits for it; the caption is one stable live region; the
// recorder's rec mode.
import { randomUUID } from "node:crypto";
import { devices, expect, test, type APIRequestContext, type Page } from "@playwright/test";

const CREW = [{ name: "Caster", is_groom: true }, "Joe", "Greg", "Rich", "Reitman", "Drew", "Will", "Ross", "Conner", "Mark"];

async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.iw}px viewport`).toBeLessThanOrEqual(m.iw);
}

/** A real trip with the crew; optionally teams of 4/3/3 and started (and finalized). */
async function createTrip(request: APIRequestContext, opts: { start?: boolean; finalize?: boolean; teams?: boolean } = {}) {
  const res = await request.post("/api/trips", { data: { pin: "2468", name: "Caster's Last Scramble", roster: CREW } });
  expect(res.status(), await res.text()).toBe(201);
  const { code, players } = (await res.json()) as { code: string; players: Array<{ id: string; name: string }> };
  if (opts.start || opts.finalize || opts.teams) {
    const teams = [randomUUID(), randomUUID(), randomUUID()];
    const split = [0, 0, 0, 0, 1, 1, 1, 2, 2, 2];
    let t = Date.now() - 60_000;
    const op = (o: Record<string, unknown>) => ({ id: randomUUID(), at: new Date(t++).toISOString(), by: null, ...o });
    const ops = [
      ...teams.map((id, i) => op({ type: "team.upsert", team: { id, name: ["Sand Baggers", "Ghost Riders", "Shank Redemption"][i], sort_order: i } })),
      ...players.map((p, i) => op({ type: "team.assign", player_id: p.id, team_id: teams[split[i]] })),
      ...(opts.start || opts.finalize ? [op({ type: "trip.start" })] : []),
      ...(opts.finalize ? [op({ type: "trip.finalize" })] : []),
    ];
    const sync = await request.post(`/api/t/${code}/sync`, { data: { ops } });
    const results = ((await sync.json()) as { results: Array<{ status: string }> }).results;
    expect(results.every((r) => r.status === "applied"), JSON.stringify(results)).toBe(true);
  }
  return code;
}

test("plays once after you pick your name; story controls; replays from the pre-round card and the menu", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const code = await createTrip(page.request);
  await page.context().clearCookies(); // a plain player's phone

  await page.goto(`/t/${code}`);
  await expect(page.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("join-player").filter({ hasText: "Joe" }).click();

  const xp = page.getByRole("dialog", { name: "How it works" });
  await expect(xp).toBeVisible();
  await expect(xp).toHaveAttribute("data-scene", "cold-open");
  await expect(xp.getByTestId("explainer-title")).toHaveText("Joe, welcome to Caster's Last Scramble.");
  await expect(xp.getByTestId("explainer-art")).toBeVisible();
  await expect(page.getByText("You're in, Joe.")).toHaveCount(0);
  const skip = xp.getByTestId("explainer-skip");
  const box = await skip.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(48);
  await expectNoHorizontalOverflow(page);

  // Auto-advance after ~6 s.
  await expect(xp).toHaveAttribute("data-index", "1", { timeout: 12_000 });
  await expect(xp).toHaveAttribute("data-scene", "scramble");
  // Tap left = back, tap right = next, arrows too.
  await xp.getByTestId("explainer-back").click();
  await expect(xp).toHaveAttribute("data-index", "0");
  await xp.getByTestId("explainer-next").click();
  await expect(xp).toHaveAttribute("data-index", "1");
  await page.keyboard.press("ArrowRight");
  await expect(xp).toHaveAttribute("data-scene", "drinks");
  await expect(xp.getByTestId("explainer-caption")).toContainText("Tap Drink by your name. Nothing counts before On the tee on hole 1.");

  // Press and hold pauses (and doesn't navigate on release).
  const next = await xp.getByTestId("explainer-next").boundingBox();
  await page.mouse.move(next!.x + next!.width / 2, next!.y + next!.height / 2);
  await page.mouse.down();
  await expect(xp).toHaveAttribute("data-paused", "true");
  await page.waitForTimeout(6_500);
  await expect(xp).toHaveAttribute("data-scene", "drinks");
  await page.mouse.up();
  await expect(xp).toHaveAttribute("data-paused", "false");
  await expect(xp).toHaveAttribute("data-scene", "drinks");

  // The pause button does the same for thumbs that can't hold (and for keyboards).
  await xp.getByTestId("explainer-pause").click();
  await expect(xp.getByTestId("explainer-pause")).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(6_500);
  await expect(xp).toHaveAttribute("data-scene", "drinks");
  await xp.getByTestId("explainer-pause").click();

  // Escape closes; now "You're in, Joe." (with its way out of a fat-thumb pick).
  await page.keyboard.press("Escape");
  await expect(xp).toHaveCount(0);
  await expect(page.getByText("You're in, Joe.")).toBeVisible();
  expect(await page.evaluate((c) => localStorage.getItem(`scramble:explainer-seen:${c}`), code)).toBe("1");

  // Once per phone per trip.
  await page.reload();
  await expect(page.getByTestId("waiting-for-start")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId("explainer")).toHaveCount(0);

  // Replay from the pre-round card; Skip hands focus back.
  const replay = page.getByTestId("how-it-works");
  await expect(replay).toHaveText(/How it works \(40 sec\)/);
  await replay.click();
  await expect(xp).toHaveAttribute("data-index", "0");
  await xp.getByTestId("explainer-skip").click();
  await expect(xp).toHaveCount(0);
  await expect(replay).toBeFocused();

  // Replay from the menu, tap through to the end, Let's go.
  await page.getByTestId("menu-button").click();
  await page.getByRole("dialog").getByRole("button", { name: /How it works/ }).click();
  await expect(xp).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1); // the menu closed
  for (let i = 0; i < 7; i++) await xp.getByTestId("explainer-next").click();
  await expect(xp).toHaveAttribute("data-scene", "outro");
  await expect(xp.getByTestId("explainer-go")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await xp.getByTestId("explainer-go").click();
  await expect(xp).toHaveCount(0);
});

test("?explainer=1 opens it directly (recording), before anyone picks a name; reduced motion holds still", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    baseURL: test.info().project.use.baseURL,
    reducedMotion: "reduce",
    viewport: { width: 360, height: 780 },
  });
  try {
    const page = await context.newPage();
    const code = await createTrip(page.request);
    await context.clearCookies();
    await page.goto(`/t/${code}?explainer=1&scene=3`);
    const xp = page.getByRole("dialog", { name: "How it works" });
    await expect(xp).toBeVisible({ timeout: 30_000 });
    await expect(xp).toHaveAttribute("data-scene", "drinks");
    await expect(xp).toHaveAttribute("data-motion", "reduce");
    await expect(xp.getByTestId("explainer-pause")).toHaveCount(0);
    await page.waitForTimeout(7_000);
    await expect(xp).toHaveAttribute("data-scene", "drinks");
    await xp.getByTestId("explainer-back").click();
    await xp.getByTestId("explainer-back").click();
    // Nobody picked: the boys.
    await expect(xp.getByTestId("explainer-title")).toHaveText("Boys, welcome to Caster's Last Scramble.");
    await expectNoHorizontalOverflow(page);
    await xp.getByTestId("explainer-skip").click();
    await expect(xp).toHaveCount(0);
    await expect(page).not.toHaveURL(/explainer=/);
    await expect(page.getByTestId("join-screen")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("mid-round it plays the first time too; once the round is final it doesn't", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const live = await createTrip(page.request, { start: true });
  const final = await createTrip(page.request, { finalize: true });
  const phone = await browser.newContext({ ...devices["iPhone 13"], baseURL: test.info().project.use.baseURL });
  try {
    const p = await phone.newPage();
    await p.goto(`/t/${live}`);
    await p.getByTestId("join-player").filter({ hasText: "Rich" }).click();
    await expect(p.getByRole("dialog", { name: "How it works" })).toBeVisible();
    await p.getByTestId("explainer-skip").click();
    await expect(p.getByTestId("hole-number")).toBeVisible();

    await p.goto(`/t/${final}`);
    await p.getByTestId("join-player").filter({ hasText: "Rich" }).click();
    await expect(p.getByText("You're in, Rich.")).toBeVisible();
    await expect(p.getByTestId("explainer")).toHaveCount(0);
  } finally {
    await phone.close();
  }
});

const IPHONE = { ...devices["iPhone 13"], viewport: { width: 360, height: 780 } };

test("Back closes the explainer and stays on the trip; Play starts at the top for a name low on the list", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const code = await createTrip(page.request, { start: true });
  const phone = await browser.newContext({ ...IPHONE, baseURL: test.info().project.use.baseURL });
  try {
    const p = await phone.newPage();
    // Arrived from somewhere else (a group-chat link opens the trip after another page).
    await p.goto("/");
    await p.goto(`/t/${code}`);
    const mark = p.getByTestId("join-player").filter({ hasText: "Mark" });
    await mark.scrollIntoViewIfNeeded();
    expect(await p.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await mark.click();
    const xp = p.getByRole("dialog", { name: "How it works" });
    await expect(xp).toBeVisible();

    // Android back / iOS swipe-back: closes the explainer, not the trip.
    await p.goBack();
    await expect(xp).toHaveCount(0);
    // Still the trip (on iPhone the address keeps ?me= for Add to Home Screen).
    expect(new URL(p.url()).pathname).toBe(`/t/${code}`);
    expect(new URL(p.url()).searchParams.get("me")).toBe(await p.evaluate((c) => localStorage.getItem(`scramble:me:${c}`), code));
    await expect(p.getByText("You're in, Mark.")).toBeVisible();
    await expect(p.getByTestId("hole-number")).toBeVisible();
    expect(await p.evaluate(() => window.scrollY)).toBe(0);
    expect(await p.evaluate((c) => localStorage.getItem(`scramble:explainer-seen:${c}`), code)).toBe("1");

    // Replay from the menu, Skip: the explainer's history entry goes with it (one Back = leave).
    await p.getByTestId("menu-button").click();
    await p.getByRole("dialog").getByRole("button", { name: /How it works/ }).click();
    await expect(xp).toBeVisible();
    await xp.getByTestId("explainer-skip").click();
    await expect(xp).toHaveCount(0);
    await p.waitForTimeout(500);
    expect(new URL(p.url()).pathname).toBe(`/t/${code}`);
    await p.goBack();
    await expect(p).not.toHaveURL(/\/t\//);
  } finally {
    await phone.close();
  }
});

test("only counts as seen once it's on screen: no chunk, no auto-play used up; a reload keeps the greeting", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const code = await createTrip(page.request, { start: true });
  // No service worker: nothing cached the chunk on this phone yet.
  const phone = await browser.newContext({ ...IPHONE, baseURL: test.info().project.use.baseURL, serviceWorkers: "block" });
  try {
    const p = await phone.newPage();
    // Bad signal on the first tee: the explainer's chunk never loads.
    let blocked = 0;
    await p.route("**/_next/static/chunks/**", async (route) => {
      const res = await route.fetch();
      const body = await res.text();
      if (body.includes("explainer-art")) {
        blocked++;
        await route.abort();
      } else await route.fulfill({ response: res, body });
    });
    await p.goto(`/t/${code}`);
    await p.getByTestId("join-player").filter({ hasText: "Will" }).click();
    await expect(p.getByText("You're in, Will.")).toBeVisible();
    await expect(p.getByTestId("explainer")).toHaveCount(0);
    expect(blocked).toBeGreaterThan(0);
    expect(await p.evaluate((c) => localStorage.getItem(`scramble:explainer-seen:${c}`), code)).toBeNull();

    // Signal's back: Switch player, pick again, and it plays.
    await p.unroute("**/_next/static/chunks/**");
    await p.reload();
    await p.getByTestId("menu-button").click();
    await p.getByRole("dialog").getByRole("button", { name: /Not you/ }).click();
    await p.getByTestId("join-player").filter({ hasText: "Will" }).click();
    const xp = p.getByRole("dialog", { name: "How it works" });
    await expect(xp).toBeVisible({ timeout: 20_000 });

    // A reload mid-explainer: the pick stuck, and "You're in · Not you?" still shows up.
    await p.reload();
    await expect(p.getByTestId("hole-number")).toBeVisible({ timeout: 30_000 });
    await expect(p.getByText("You're in, Will.")).toBeVisible();
    await expect(p.getByTestId("explainer")).toHaveCount(0);
    expect(await p.evaluate((c) => localStorage.getItem(`scramble:greet-pending:${c}`), code)).toBeNull();
    // Only once.
    await p.reload();
    await expect(p.getByTestId("hole-number")).toBeVisible({ timeout: 30_000 });
    await p.waitForTimeout(1_000);
    await expect(p.getByText("You're in, Will.")).toHaveCount(0);
  } finally {
    await phone.close();
  }
});

test("\"We're live!\" waits for the explainer; the caption is one live region the whole way", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const code = await createTrip(page.request, { teams: true });
  const phone = await browser.newContext({ ...IPHONE, baseURL: test.info().project.use.baseURL });
  try {
    const p = await phone.newPage();
    await p.goto(`/t/${code}`);
    await p.getByTestId("join-player").filter({ hasText: "Conner" }).click();
    const xp = p.getByRole("dialog", { name: "How it works" });
    await expect(xp).toBeVisible();
    await xp.getByTestId("explainer-pause").click();

    // Screen readers announce changes inside an existing live region: the region stays put.
    const region = await xp.getByTestId("explainer-caption").elementHandle();
    expect(await region!.getAttribute("aria-live")).toBe("polite");
    await xp.getByTestId("explainer-next").click();
    await expect(xp).toHaveAttribute("data-scene", "scramble");
    expect(await region!.evaluate((el) => el.isConnected && el.getAttribute("aria-live"))).toBe("polite");
    await expect(xp.getByTestId("explainer-caption")).toContainText("One ball. Everybody hits.");

    // The commissioner starts the round while Conner watches: no fanfare stacked on top.
    const start = await page.request.post(`/api/t/${code}/sync`, { data: { ops: [{ id: randomUUID(), at: new Date().toISOString(), by: null, type: "trip.start" }] } });
    expect(start.ok()).toBe(true);
    await expect(p.getByTestId("hole-number")).toBeAttached({ timeout: 20_000 });
    await p.waitForTimeout(1_000);
    await expect(p.getByTestId("fanfare")).toHaveCount(0);
    // Closed: now it says so.
    await xp.getByTestId("explainer-skip").click();
    await expect(xp).toHaveCount(0);
    await expect(p.getByTestId("fanfare")).toContainText("We're live!");
  } finally {
    await phone.close();
  }
});

test("rec mode (the group-chat MP4): no phone-only controls line, frame-steppable, settle-up matches the board", async ({ page }) => {
  test.setTimeout(90_000);
  const code = await createTrip(page.request, { teams: true });
  await page.context().clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/${code}?explainer=1&paused=1&rec=1`);
  const xp = page.getByRole("dialog", { name: "How it works" });
  await expect(xp).toHaveAttribute("data-rec", "true", { timeout: 30_000 });
  await expect(xp.getByTestId("explainer-title")).toHaveText("Boys, welcome to Caster's Last Scramble.");
  await expect(xp.getByTestId("explainer-caption")).not.toContainText("Tap right");
  await expect(xp.getByTestId("explainer-caption")).not.toContainText("Hold");

  const scenes = await page.evaluate(() => (window as unknown as { __xpRec: { scenes: Array<{ id: string }> } }).__xpRec.scenes.map((s) => s.id));
  expect(scenes).toEqual(["cold-open", "scramble", "drinks", "ghost", "mulligans", "contests", "board", "outro"]);
  // Board, after the settle-up slides in: the last-place team (Shank Redemption) pays the team that
  // jumped to 1st (Ghost Riders), never two teammates.
  await page.evaluate(() => (window as unknown as { __xpRec: { seek: (i: number, at: number) => void } }).__xpRec.seek(6, 5000));
  await expect(xp).toHaveAttribute("data-scene", "board");
  await expect(xp).toHaveAttribute("data-t", "5000");
  await expect(xp.getByTestId("explainer-art")).toContainText("Ross → Reitman");
  await expect(xp.getByTestId("explainer-caption")).toContainText("Lowest net wins.");
  // The outro's last frame: everything in.
  await page.evaluate(() => (window as unknown as { __xpRec: { seek: (i: number, at: number) => void } }).__xpRec.seek(7, 3600));
  await expect(xp).toHaveAttribute("data-scene", "outro");
  await expect(xp.getByTestId("explainer-title")).toHaveText("That's it. Tee it up.");
  await expect(xp.getByTestId("explainer-caption")).toContainText("Watch again anytime: ☰ → How it works.");
  // Still paused: stepping, not playing.
  await page.waitForTimeout(500);
  await expect(xp).toHaveAttribute("data-t", "3600");
});
