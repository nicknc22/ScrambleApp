// Home Screen install (per-trip manifest), photo uploads that never hold up a score, and the
// "⚠️ N didn't save" list of changes the server refused.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { at, makeTrip } from "../tests/fixtures";

async function createTrip(request: APIRequestContext, opts: { appName: string; live: boolean }) {
  const res = await request.post("/api/trips", { data: { pin: "2468", name: "Sync Spec Scramble", app_name: opts.appName } });
  expect(res.status(), await res.text()).toBe(201);
  const { code } = (await res.json()) as { code: string };
  let t = Date.now() - 60_000;
  const op = (o: Record<string, unknown>) => ({ id: randomUUID(), at: new Date(t++).toISOString(), by: null, ...o });
  const players = ["Dave", "Mike", "Tom", "Rob"].map((name, i) => ({ id: randomUUID(), name, nickname: null, is_groom: i === 0, sort_order: i }));
  const team = { id: randomUUID(), name: "Grip It & Sip It", sort_order: 0 };
  const ops = [
    ...players.map((p) => op({ type: "player.upsert", player: p })),
    op({ type: "team.upsert", team }),
    ...players.map((p) => op({ type: "team.assign", player_id: p.id, team_id: team.id })),
    ...(opts.live ? [op({ type: "trip.start" })] : []),
  ];
  const sync = await request.post(`/api/t/${code}/sync`, { data: { ops } });
  expect(sync.ok()).toBe(true);
  const body = (await sync.json()) as { results: Array<{ status: string }> };
  expect(body.results.filter((r) => r.status !== "applied")).toEqual([]);
  return { code, players, team };
}

/** What an iPhone Home Screen app looks like to the page: standalone, with its own empty storage. */
async function standalonePage(page: Page) {
  const browser = page.context().browser()!;
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { get: () => true });
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q.includes("display-mode: standalone") ? ({ ...real(q), matches: true, media: q } as MediaQueryList) : real(q));
  });
  return context.newPage();
}

test("the trip page links its own manifest, so the Home Screen icon opens the trip", async ({ page }) => {
  const { code } = await createTrip(page.request, { appName: "Bachelor Open", live: false });
  await page.context().clearCookies();
  await page.goto(`/t/${code}`);
  await expect(page.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });

  const hrefs = await page.locator('link[rel="manifest"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toEqual([`/t/${code}/manifest.webmanifest`]);
  const res = await page.request.get(hrefs[0]!);
  expect(res.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = (await res.json()) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    id: `/t/${code}`,
    start_url: `/t/${code}?source=homescreen`,
    scope: "/",
    name: "Bachelor Open",
    short_name: "Bachelor Open",
    display: "standalone",
  });
  // The home page keeps the generic manifest.
  await page.goto("/?home=1");
  expect(await page.locator('link[rel="manifest"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")))).toEqual(["/manifest.webmanifest"]);

  // Launch from the icon with fresh storage (iOS): straight into the trip, not the generic home page.
  const app = await standalonePage(page);
  await app.goto(String(manifest.start_url));
  await expect(app).toHaveURL(new RegExp(`/t/${code}\\?source=homescreen$`));
  await expect(app.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
  await expect(app.getByRole("heading", { name: "Sync Spec Scramble" })).toBeVisible();
  await app.context().close();
});

test("a photo that won't upload never holds up the score, and the phone doesn't claim to be offline", async ({ page, context }) => {
  test.setTimeout(120_000);
  const { code, players, team } = await createTrip(page.request, { appName: "Scramble", live: true });
  await context.clearCookies();
  await context.addInitScript(
    ([c, id]) => {
      localStorage.setItem(`scramble:me:${c}`, id);
    },
    [code, players[1].id],
  );
  // A weak uplink: photo uploads never complete. /sync and /state work fine.
  let uploads = 0;
  await page.route(`**/api/t/${code}/upload**`, () => {
    uploads++;
  });
  await page.goto(`/t/${code}`);
  await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "play", { timeout: 30_000 });
  await page.getByTestId("tee-cta").click();
  const fanfare = page.getByTestId("fanfare");
  await fanfare.click();
  await expect(fanfare).toHaveCount(0);

  // A real JPEG from the page's own canvas.
  const jpeg = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 48;
      const g = c.getContext("2d")!;
      g.fillStyle = "#e0b800";
      g.fillRect(0, 0, 64, 48);
      return c.toDataURL("image/jpeg", 0.8).split(",")[1];
    }),
    "base64",
  );
  await page.getByRole("button", { name: "Log a drink for Mike with a photo of the empty" }).click();
  await page.getByRole("dialog").locator('input[type="file"]').first().setInputFiles({ name: "empty.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect.poll(() => uploads, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.getByTestId("save-score").click();

  // The drink (with its photo path) and the score reach the server while the upload hangs.
  const serverState = async () => {
    const res = await page.request.get(`/api/t/${code}/state`);
    return (await res.json()) as {
      state: { drinks: Array<{ team_id: string; photo_path: string | null }>; hole_scores: Array<{ team_id: string; hole: number; strokes: number | null }> };
    };
  };
  await expect
    .poll(async () => {
      const { state } = await serverState();
      return {
        photoDrinks: state.drinks.filter((d) => d.team_id === team.id && d.photo_path !== null).length,
        hole1: state.hole_scores.find((s) => s.team_id === team.id && s.hole === 1)?.strokes ?? null,
      };
    }, { timeout: 10_000 })
    .toEqual({ photoDrinks: 1, hole1: 4 });
  // Only the photo is waiting, and the badge says so without crying "Offline".
  const badge = page.getByTestId("offline-badge").first();
  await expect(badge).toContainText("Syncing 1");
  await page.waitForTimeout(2_000);
  await expect(badge).not.toContainText("Offline");
});

test.describe("changes the server refused (mocked API)", () => {
  const CODE = "syncissues01";

  test("stay listed under ⚠️ across a reload until dismissed", async ({ page }) => {
    const f = makeTrip({ teams: [4, 3], status: "live" });
    f.state.trip.code = CODE;
    f.state.trip.name = "Refusal Scramble";
    f.teeOff("A", 1);
    const snapshot = JSON.stringify({
      state: f.state,
      meta: { server_time: at(0), photo_base_url: "/api/photos/", realtime: null, vapid_public_key: null, ai_enabled: false, push_enabled: false },
    });
    await page.route(`**/api/t/${CODE}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/state")) return route.fulfill({ contentType: "application/json", body: snapshot });
      if (url.pathname.endsWith("/commissioner")) return route.fulfill({ contentType: "application/json", body: '{"is_commissioner":false}' });
      if (url.pathname.endsWith("/sync")) {
        const { ops } = route.request().postDataJSON() as { ops: Array<{ id: string }> };
        const results = ops.map((o) => ({ id: o.id, status: "rejected", code: "conflict", reason: "Hole 1 already got a newer edit: 3" }));
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ results, snapshot: JSON.parse(snapshot) }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });
    await page.addInitScript(
      ([c, id]) => {
        localStorage.setItem(`scramble:me:${c}`, id);
      },
      [CODE, f.player.A1],
    );
    await page.goto(`/t/${CODE}`);
    await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "play", { timeout: 30_000 });
    await expect(page.getByTestId("sync-issues-chip")).toHaveCount(0);

    await page.getByTestId("save-score").click();
    // The toast says what didn't save...
    await expect(page.getByText("Hole 1 score: 4 · Team A — Hole 1 already got a newer edit: 3")).toBeVisible();
    // ...and the header keeps a count after it's gone.
    const chip = page.getByTestId("sync-issues-chip");
    await expect(chip).toHaveText("⚠️ 1");

    await page.reload();
    await expect(page.getByTestId("trip-shell")).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveText("⚠️ 1");
    // Not toasted again after the reload.
    await expect(page.getByText("That didn't save")).toHaveCount(0);

    await chip.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByTestId("sync-issue")).toHaveCount(1);
    await expect(sheet.getByTestId("sync-issue")).toContainText("Score");
    await expect(sheet.getByTestId("sync-issue")).toContainText("Hole 1 score: 4 · Team A");
    await expect(sheet.getByTestId("sync-issue")).toContainText("Hole 1 already got a newer edit: 3");
    await page.setViewportSize({ width: 360, height: 740 });
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(m.sw).toBeLessThanOrEqual(m.iw);
    await sheet.getByRole("button", { name: /^Dismiss: Hole 1 score/ }).click();
    await expect(sheet).toHaveCount(0);
    await expect(chip).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("trip-shell")).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveCount(0);
  });
});
