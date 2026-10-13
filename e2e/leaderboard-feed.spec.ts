// Leaderboard + Feed against the real server: the spec creates its own trip through the API,
// sets it up and plays a hole via commissioner sync ops, then drives the UI.
// page.request shares the browser context's cookies, so the page is the commissioner too.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 48x36 JPEG (a golf ball on grass).
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAkADADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDFooormPICiuq8K+GY7+IX+oDdbHIjjDYLnoSSOgB/zjra8S+FIIbNrzSk8sQqWliLEgqOSwJPUen9etcrtc1VGbjzHF0UUVJkFFFFAHaeD/ENtDarpl6yQCPJilY4Ugkkgk9Dyf8A9fW54o8SWkVhJZ2UkVzLcIVZkbcqKeCcjv6D8T7+f0VfO7WNlXko8oUUUVBiFFFFABRRRQAUUUUAf//Z",
  "base64",
);

let clock = Date.now() - 30 * 60_000;
type RawOp = Record<string, unknown> & { type: string };
const op = (o: RawOp, by: string | null = null) => ({ id: randomUUID(), at: new Date((clock += 1000)).toISOString(), by, ...o });

async function sync(request: APIRequestContext, code: string, ops: Array<ReturnType<typeof op>>) {
  const res = await request.post(`/api/t/${code}/sync`, { data: { ops } });
  expect(res.ok(), `sync ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { results: Array<{ status: string; reason?: string }> };
  const rejected = body.results.filter((r) => r.status === "rejected");
  expect(rejected, JSON.stringify(rejected)).toEqual([]);
}

interface Seeded {
  code: string;
  team: Record<"A" | "B" | "C", string>;
  player: Record<"A1" | "A2" | "B1" | "B2" | "C1" | "C2", string>;
}

/** 3 twosomes. Hole 1 (par 4): A birdies + 1 drink (worth 2: ghost beer) = -3; B edits 5 -> 4; C pars. */
async function seedTrip(request: APIRequestContext): Promise<Seeded> {
  const res = await request.post("/api/trips", { data: { pin: "2468", name: "Board & Feed Spec" } });
  expect(res.status()).toBe(201);
  const { code } = (await res.json()) as { code: string };
  const team = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
  const player = { A1: randomUUID(), A2: randomUUID(), B1: randomUUID(), B2: randomUUID(), C1: randomUUID(), C2: randomUUID() };
  const names: Record<keyof typeof player, string> = {
    A1: "Ace Ventura",
    A2: "Al Bundy",
    B1: "Bo Jackson",
    B2: "Bob Barker",
    C1: "Cal Naughton",
    C2: "Chubbs Peterson",
  };
  const teamOf = (p: string) => p[0] as "A" | "B" | "C";
  await sync(request, code, [
    ...Object.entries(player).map(([label, id], i) =>
      op({ type: "player.upsert", player: { id, name: names[label as keyof typeof player], is_groom: label === "A1", sort_order: i } }),
    ),
    op({ type: "team.upsert", team: { id: team.A, name: "Alpha Hydration", sort_order: 0 } }),
    op({ type: "team.upsert", team: { id: team.B, name: "Bravo Bogeys", sort_order: 1 } }),
    op({ type: "team.upsert", team: { id: team.C, name: "Charlie Chunks", sort_order: 2 } }),
    ...Object.entries(player).map(([label, id]) => op({ type: "team.assign", player_id: id, team_id: team[teamOf(label)] })),
  ]);
  await sync(request, code, [op({ type: "trip.start" })]);
  await sync(request, code, [
    op({ type: "tee.open", team_id: team.A, hole: 1 }, player.A1),
    op({ type: "teeshot.set", team_id: team.A, hole: 1, player_id: player.A1 }, player.A1),
    op({ type: "score.set", team_id: team.A, hole: 1, strokes: 3 }, player.A1),
    op(
      { type: "drink.log", drink_id: randomUUID(), team_id: team.A, player_id: player.A2, hole: 1, drink_type: "drink", photo_path: null },
      player.A1,
    ),
    op({ type: "tee.open", team_id: team.B, hole: 1 }, player.B1),
    op({ type: "score.set", team_id: team.B, hole: 1, strokes: 5 }, player.B1),
    op({ type: "tee.open", team_id: team.C, hole: 1 }, player.C1),
    op({ type: "score.set", team_id: team.C, hole: 1, strokes: 4 }, player.C1),
  ]);
  // A separate later edit so it is an edit of an existing value ("changed hole 1 from a 5 to a 4").
  await sync(request, code, [op({ type: "score.set", team_id: team.B, hole: 1, strokes: 4 }, player.B2)]);
  return { code, team, player };
}

async function openAs(page: Page, code: string, meId: string, tab: string) {
  await page.addInitScript(
    ([c, me]) => {
      localStorage.setItem(`scramble:me:${c}`, me);
      localStorage.setItem("scramble:onboarded", "1");
    },
    [code, meId],
  );
  await page.goto(`/t/${code}?tab=${tab}`);
  await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", tab, { timeout: 30_000 });
}

async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.iw}px viewport`).toBeLessThanOrEqual(m.iw);
}

test.describe("leaderboard", () => {
  test("order, ties, every column at 360px, and the team drill-down", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const s = await seedTrip(page.request);
    await openAs(page, s.code, s.player.A1, "leaderboard");

    const rows = page.getByTestId("standings-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute("data-team-id", s.team.A);
    await expect(rows.nth(0)).toHaveAttribute("data-pos", "1");
    await expect(rows.nth(0)).toHaveAttribute("data-leader", "true");
    await expect(rows.nth(0)).toHaveAttribute("data-mine", "true");
    await expect(rows.nth(0)).toHaveAttribute("aria-label", /thru 1, gross 3, 1 drinks, credit -2, net 1, net to par -3/);
    await expect(rows.nth(1)).toHaveAttribute("data-pos", "T2");
    await expect(rows.nth(2)).toHaveAttribute("data-pos", "T2");
    await expect(rows.nth(1)).toHaveAttribute("aria-label", /net to par E/);
    await expect(page.getByTestId("leader-banner")).toContainText("Alpha Hydration");

    // Every column header and every cell of the first row is on screen at 360px.
    const table = page.getByTestId("standings");
    for (const h of ["Pos", "Team", "Thru", "Grs", "Drk", "Cred", "Net"]) await expect(table.getByText(h, { exact: true })).toBeVisible();
    await expect(table.getByText(/To\s*par/)).toBeVisible();
    const cells = await rows.nth(0).evaluate((el) =>
      Array.from(el.children)
        .filter((c) => (c as HTMLElement).offsetWidth > 8)
        .map((c) => {
          const r = c.getBoundingClientRect();
          return { left: r.left, right: r.right, text: (c as HTMLElement).innerText.trim() };
        }),
    );
    expect(cells.map((c) => c.text)).toEqual(["1", "★ Alpha Hydration", "1", "3", "1", "-2", "1", "-3"]);
    for (const c of cells) {
      expect(c.left).toBeGreaterThanOrEqual(0);
      expect(c.right).toBeLessThanOrEqual(360);
    }
    await expectNoHorizontalOverflow(page);

    // Drill-down card.
    await rows.nth(0).click();
    const card = page.getByTestId("team-card");
    await expect(card).toHaveAttribute("data-team-id", s.team.A);
    const hole1 = card.locator('[data-testid="card-hole"][data-hole="1"]');
    await expect(hole1).toContainText("3"); // strokes
    await expect(hole1).toContainText("-2"); // credit (ghost beer)
    await expect(hole1).toContainText("AV"); // Ace Ventura's tee shot
    await expect(card.getByTestId("card-ghosts")).toContainText("1 ghost beer");
    await expect(card.getByTestId("card-sum-tot")).toContainText("-2");
    await expect(card.getByTestId("card-banked")).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(card).toHaveCount(0);

    // A drink on Charlie's open, unscored hole 2 is "banked": a small marker under the name, not in
    // Drk / Cred / Net until hole 2 has a score. The row still fits 360px.
    await sync(page.request, s.code, [
      op({ type: "tee.open", team_id: s.team.C, hole: 2 }, s.player.C1),
      op(
        { type: "drink.log", drink_id: randomUUID(), team_id: s.team.C, player_id: s.player.C2, hole: 2, drink_type: "drink", photo_path: null },
        s.player.C1,
      ),
    ]);
    const charlie = page.locator(`[data-testid="standings-row"][data-team-id="${s.team.C}"]`);
    await expect(charlie.getByTestId("standings-banked")).toHaveText("+1 🍺 banked", { timeout: 20_000 });
    await expect(charlie).toHaveAttribute("aria-label", /gross 4, 0 drinks, credit 0, net 4, net to par E, plus 1 banked drink \(-2\) on an unscored hole/);
    await expect(rows.filter({ has: page.getByTestId("standings-banked") })).toHaveCount(1);
    const banked = (await charlie.getByTestId("standings-banked").boundingBox())!;
    expect(banked.x + banked.width).toBeLessThanOrEqual(360);
    await expectNoHorizontalOverflow(page);
    await charlie.click();
    await expect(card.getByTestId("card-banked")).toContainText("+1 🍺 banked (−2)");
    await expect(card.getByTestId("card-sum-tot")).toContainText("4");
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

    // Sub-tabs.
    await page.getByRole("tab", { name: /^Drinkers/ }).click();
    await expect(page.getByTestId("drinker-row").first()).toHaveAttribute("data-player-id", s.player.A2);
    await page.getByRole("tab", { name: /^Contests/ }).click();
    await expect(page.getByTestId("contest-row")).toHaveCount(8);
    await expect(page.getByTestId("contest-row").first()).toContainText("No entries yet");
    await page.getByRole("tab", { name: /^Drives/ }).click();
    await expect(page.getByTestId("drive-team")).toHaveCount(3);
    await expect(page.locator(`[data-testid="drive-player"][data-player-id="${s.player.A1}"]`)).toHaveAttribute("data-front", "ok");
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("feed", () => {
  test("templated events, post, react, photo upload, commissioner delete", async ({ page }) => {
    const s = await seedTrip(page.request);
    await openAs(page, s.code, s.player.A1, "feed");

    // Templated automatic events.
    await expect(page.getByText(/changed hole 1 from a 5 to a 4/)).toBeVisible();
    await expect(page.locator('[data-testid="feed-item"][data-type="ghost_beer"]')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Text post -> top of the feed.
    await page.getByTestId("composer-text").fill("E2E says the fairway is a suggestion");
    await page.getByTestId("composer-submit").click();
    const mine = page.getByTestId("feed-item").first();
    await expect(mine).toHaveAttribute("data-type", "post");
    await expect(mine).toContainText("E2E says the fairway is a suggestion");
    await expect(mine.getByTestId("feed-time")).toHaveText("now");

    // React (toggle on), and it reaches the server.
    const fire = mine.getByTestId("react-fire");
    await fire.click();
    await expect(fire).toHaveAttribute("aria-pressed", "true");
    await expect(fire).toHaveAttribute("data-count", "1");
    await expect
      .poll(async () => {
        const st = (await (await page.request.get(`/api/t/${s.code}/state`)).json()) as {
          state: { reactions: Array<{ player_id: string; kind: string; deleted_at: string | null }> };
        };
        return st.state.reactions.some((r) => r.player_id === s.player.A1 && r.kind === "fire" && !r.deleted_at);
      })
      .toBe(true);

    // Photo post: local preview with an "uploading" badge until the (slowed) upload lands.
    await page.route("**/upload?**", async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.getByTestId("composer-text").fill("Photo drop");
    await page.getByTestId("composer-library").setInputFiles({ name: "ball.jpg", mimeType: "image/jpeg", buffer: TINY_JPEG });
    await expect(page.getByTestId("composer-preview")).toBeVisible();
    await page.getByTestId("composer-submit").click();
    const photoPost = page.getByTestId("feed-item").filter({ hasText: "Photo drop" });
    await expect(photoPost.getByTestId("feed-photo")).toBeVisible();
    await expect(photoPost.getByTestId("photo-uploading")).toBeVisible();
    await expect(photoPost.getByTestId("photo-uploading")).toHaveCount(0, { timeout: 20_000 });
    await photoPost.getByTestId("feed-photo").click();
    await expect(page.getByTestId("photo-viewer")).toBeVisible();
    await page.getByRole("button", { name: "Close photo" }).click();
    await expect(page.getByTestId("photo-viewer")).toHaveCount(0);
    await expect
      .poll(async () => {
        const st = (await (await page.request.get(`/api/t/${s.code}/state`)).json()) as {
          state: { feed_events: Array<{ text: string | null; photo_path: string | null }> };
        };
        return st.state.feed_events.find((e) => e.text === "Photo drop")?.photo_path ?? null;
      })
      .toMatch(/^trips\/.+\/posts\/.+\.jpg$/);

    // Commissioner deletes somebody else's (automatic) item via the menu + confirm.
    const edit = page.locator('[data-testid="feed-item"][data-type="score_edit"]');
    await expect(edit).toHaveCount(1);
    await edit.getByTestId("feed-menu").click();
    await page.getByTestId("feed-delete").click();
    await page.getByRole("button", { name: "Delete it" }).click();
    await expect(edit).toHaveCount(0);
    // The server records it as a commissioner override (transparency).
    await expect(page.locator('[data-testid="feed-item"][data-type="commissioner_override"]')).toBeVisible({ timeout: 20_000 });

    // Filters.
    await page.getByTestId("feed-filter-photos").click();
    await expect(page.getByTestId("feed-item")).toHaveCount(1);
    await page.getByTestId("feed-filter-drinks").click();
    await expect(page.locator('[data-testid="feed-item"][data-type="ghost_beer"]')).toBeVisible();
    await expect(page.locator('[data-testid="feed-item"][data-type="post"]')).toHaveCount(0);
    await page.getByTestId("feed-filter-all").click();
    await expectNoHorizontalOverflow(page);
  });

  test("lurkers can read but must pick a name to post", async ({ page }) => {
    const s = await seedTrip(page.request);
    // Commissioner without a player: skip the roster, land on the feed.
    await page.goto(`/t/${s.code}?tab=feed`);
    await page.getByRole("button", { name: /skip/i }).first().click({ timeout: 30_000 });
    await expect(page.getByTestId("trip-shell")).toBeVisible();
    await expect(page.getByTestId("composer-locked")).toBeVisible();
    await expect(page.getByText(/changed hole 1 from a 5 to a 4/)).toBeVisible();
  });
});
