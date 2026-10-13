// Demo mode end to end against the real server: "Try the demo" on the home page builds a fake trip
// with a simulated round (POST /api/demo), we join as a player, see a populated leaderboard and feed,
// then reset the demo from Settings and check that our own changes are wiped.
import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.iw}px viewport`).toBeLessThanOrEqual(m.iw);
}

interface StateBody {
  state: { trip: { code: string; is_demo: boolean; status: string }; feed_events: Array<{ text: string | null; deleted_at: string | null }> };
}

async function serverState(page: Page, code: string): Promise<StateBody["state"]> {
  const res = await page.request.get(`/api/t/${code}/state`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as StateBody).state;
}

test.describe("demo mode", () => {
  test("try the demo, play along, reset it from Settings", async ({ page }) => {
    await page.goto("/?home=1");
    await page.getByRole("button", { name: "Try the demo" }).click();
    await expect(page).toHaveURL(/\/t\/demo[a-z0-9]{8}$/, { timeout: 60_000 });
    const code = new URL(page.url()).pathname.split("/").pop()!;

    // Join: the fake roster, 10 degenerates in 3 teams.
    await expect(page.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Demo Scramble" })).toBeVisible();
    await expect(page.getByTestId("join-player")).toHaveCount(10);
    await expectNoHorizontalOverflow(page);
    await page.getByTestId("join-player").filter({ hasText: "Captain Mulligan" }).click();
    const onboarding = page.getByTestId("onboarding");
    if (await onboarding.isVisible().catch(() => false)) await page.getByRole("button", { name: "Skip setup" }).click();
    const shell = page.getByTestId("trip-shell");
    await expect(shell).toBeVisible();

    // Leaderboard: three teams mid-round, someone leading.
    await page.getByTestId("tab-leaderboard").click();
    await expect(shell).toHaveAttribute("data-tab", "leaderboard");
    const rows = page.getByTestId("standings-row");
    await expect(rows).toHaveCount(3);
    for (const name of ["Grip It & Sip It", "Ghost Beer Gang", "The Shank Redemption"]) {
      await expect(rows.filter({ hasText: name })).toHaveCount(1);
    }
    await expect(page.getByTestId("leader-banner").first()).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Feed: the simulated round's events and posts.
    await page.getByTestId("tab-feed").click();
    await expect(page.getByTestId("feed-list")).toBeVisible();
    expect(await page.getByTestId("feed-item").count()).toBeGreaterThan(10);
    await expect(page.getByTestId("feed-item").filter({ hasText: /ghost beer/i }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Leave a mark, and wait until the server has it (so the reset is what removes it).
    const marker = `e2e demo marker ${Date.now()}`;
    await page.getByTestId("composer-text").fill(marker);
    await page.getByTestId("composer-submit").click();
    await expect(page.getByTestId("feed-item").filter({ hasText: marker })).toHaveCount(1);
    await expect
      .poll(async () => (await serverState(page, code)).feed_events.some((e) => e.text === marker), { timeout: 30_000 })
      .toBe(true);

    // Settings → Demo mode → Reset demo.
    await page.getByTestId("menu-button").click();
    await page.getByRole("dialog").getByRole("button", { name: /Settings/ }).click();
    const tools = page.getByTestId("demo-tools");
    await expect(tools).toBeVisible();
    await expect(page.getByTestId("demo-pin")).toHaveText("0000");
    await tools.getByRole("button", { name: "Reset demo" }).click();
    await page.getByRole("button", { name: "Reset it" }).click();
    await expect(page.getByText("Demo reset. Fresh fake golf, same link.")).toBeVisible({ timeout: 60_000 });

    // Same code, a fresh simulated round, our post gone, and we're still logged in as our player.
    const after = await serverState(page, code);
    expect(after.trip).toMatchObject({ code, is_demo: true, status: "live" });
    expect(after.feed_events.some((e) => e.text === marker)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("demo-tools")).toHaveCount(0);
    await expect(shell).toHaveAttribute("data-tab", "feed");
    await expect(page.getByTestId("feed-item").filter({ hasText: marker })).toHaveCount(0, { timeout: 30_000 });
    expect(await page.getByTestId("feed-item").count()).toBeGreaterThan(10);
  });

  test("demo tools never touch a real trip", async ({ page }) => {
    const created = await page.request.post("/api/trips", { data: { pin: "2468", name: "Not A Demo" } });
    expect(created.status()).toBe(201);
    const { code } = (await created.json()) as { code: string };
    const res = await page.request.post("/api/demo", { data: { code } });
    expect(res.status()).toBe(403);
    expect((await serverState(page, code)).trip.is_demo).toBe(false);
  });
});
