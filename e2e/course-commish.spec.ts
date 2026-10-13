// Course editor (satellite tee/green placement) and the live-round Commissioner Tools, driven
// through the real app against `next start`. The trip is created and seeded through the API
// (POST /api/trips sets the commissioner cookie on this browser context). Satellite tiles may
// not load in CI (no network): nothing here depends on them, pins are placed by clicking the
// map container.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

interface Seed {
  code: string;
  players: { id: string; name: string }[];
  teams: { id: string; name: string }[];
}

type Op = Record<string, unknown> & { id: string; at: string; by: string | null; type: string };

let clock = Date.now() - 30 * 60_000;
function op(o: Record<string, unknown> & { type: string }, by: string | null = null): Op {
  clock += 1000;
  return { id: randomUUID(), at: new Date(clock).toISOString(), by, ...o };
}

async function sync(request: APIRequestContext, code: string, ops: Op[]) {
  const res = await request.post(`/api/t/${code}/sync`, { data: { ops } });
  expect(res.ok(), `sync HTTP ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { results: { id: string; status: string; reason?: string }[] };
  const bad = body.results.filter((r) => r.status !== "applied");
  expect(bad, JSON.stringify(bad)).toEqual([]);
  return body;
}

async function state(request: APIRequestContext, code: string) {
  const res = await request.get(`/api/t/${code}/state`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).state as {
    trip: { status: string };
    holes: { number: number; tee_lat: number | null; tee_lng: number | null; green_lat: number | null; green_lng: number | null }[];
    drinks: { id: string; hole: number; moved_from_hole: number | null; deleted_at: string | null }[];
    hole_scores: { team_id: string; hole: number; strokes: number | null }[];
    feed_events: { type: string; payload: Record<string, unknown>; deleted_at: string | null }[];
  };
}

async function createTrip(request: APIRequestContext): Promise<Seed> {
  const res = await request.post("/api/trips", { data: { pin: "2468", name: "Course & Commish E2E" } });
  expect(res.status()).toBe(201);
  const { code } = (await res.json()) as { code: string };
  const players = ["Nick", "Dan", "Bobby", "Sully", "Murph"].map((name) => ({ id: randomUUID(), name }));
  const teams = [
    { id: randomUUID(), name: "Shank Redemption" },
    { id: randomUUID(), name: "Grip It & Sip It" },
  ];
  await sync(request, code, [
    ...players.map((p, i) => op({ type: "player.upsert", player: { id: p.id, name: p.name, is_groom: i === 0, sort_order: i } })),
    ...teams.map((t, i) => op({ type: "team.upsert", team: { id: t.id, name: t.name, sort_order: i } })),
    ...players.map((p, i) => op({ type: "team.assign", player_id: p.id, team_id: teams[i < 3 ? 0 : 1].id })),
  ]);
  return { code, players, teams };
}

/** Open the trip as the commissioner (already a player on this phone) on the Setup tab. */
async function openSetup(page: Page, seed: Seed) {
  await page.addInitScript(
    ([code, me]) => {
      try {
        localStorage.setItem(`scramble:me:${code}`, me);
        localStorage.setItem("scramble:onboarded", "1");
      } catch {
        /* ignore */
      }
    },
    [seed.code, seed.players[0].id] as const,
  );
  await page.goto(`/t/${seed.code}?tab=setup`);
  await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "setup", { timeout: 45_000 });
}

/**
 * Bring a section of the Setup screen into view: it may be rendered inline, or behind a sub-tab /
 * section button the Setup screen owns (matched loosely by name).
 */
async function reveal(page: Page, target: Locator, names: RegExp) {
  const candidates = [
    page.getByRole("tab", { name: names }),
    page.getByRole("button", { name: names }),
    page.getByRole("link", { name: names }),
    page.locator("summary").filter({ hasText: names }),
  ];
  await expect
    .poll(
      async () => {
        if (await target.isVisible().catch(() => false)) return true;
        for (const c of candidates) {
          const first = c.first();
          if (await first.isVisible().catch(() => false)) {
            await first.click().catch(() => {});
            if (await target.isVisible().catch(() => false)) return true;
          }
        }
        return false;
      },
      { timeout: 30_000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  await target.scrollIntoViewIfNeeded();
}

/** Click the map container at a relative position (avoids the overlay buttons). */
async function tapMap(page: Page, fx: number, fy: number) {
  const map = page.getByTestId("course-map").locator(".leaflet-container");
  await expect(map).toBeVisible({ timeout: 30_000 });
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no box");
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

test.describe("course editor + commissioner tools", () => {
  test("pin hole 4 on the satellite map, then fix a drink and a score mid-round", async ({ page }) => {
    test.setTimeout(150_000);
    // Hermetic: no satellite tiles (like a CI box or a dead zone). The map must still work.
    await page.route(/server\.arcgisonline\.com/, (route) => route.abort());
    const seed = await createTrip(page.request);
    const [teamA] = seed.teams;
    const nick = seed.players[0];

    // ---- Course editor: place hole 4's tee and green on the map -------------------------------
    await openSetup(page, seed);
    const editor = page.getByTestId("course-editor");
    await reveal(page, editor, /^course\b/i);
    const hole4 = page.getByTestId("course-hole-4");
    await expect(hole4).toHaveAttribute("data-required", "true"); // par 5 without a tee point
    await expect(page.getByTestId("course-status")).toContainText("REQUIRED");

    await page.getByTestId("course-map-4").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("map-sheet-title")).toContainText("Hole 4");
    await expect(dialog.getByTestId("map-ld-required")).toBeVisible();
    await expect(page.getByTestId("map-mode-tee")).toHaveAttribute("aria-pressed", "true");

    await expect(dialog.getByText(/No satellite tiles/)).toBeVisible();
    await tapMap(page, 0.4, 0.68); // tee
    await expect(page.getByTestId("map-mode-tee")).toContainText("SET");
    // Placing the tee hops straight to the green.
    await expect(page.getByTestId("map-mode-green")).toHaveAttribute("aria-pressed", "true");
    await tapMap(page, 0.4, 0.4); // green
    await expect(page.getByTestId("map-mode-green")).toContainText("SET");
    await expect(page.getByTestId("map-distance")).toContainText("yd");

    await page.getByTestId("map-save").click();
    await expect(page.getByTestId("map-save")).toContainText("Saved");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(hole4).not.toHaveAttribute("data-required", "true");

    await expect
      .poll(
        async () => {
          const h = (await state(page.request, seed.code)).holes.find((x) => x.number === 4)!;
          return [h.tee_lat, h.tee_lng, h.green_lat, h.green_lng].every((v) => typeof v === "number");
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const placed = (await state(page.request, seed.code)).holes.find((x) => x.number === 4)!;
    // Somewhere on the course, and the tee isn't the green.
    expect(Math.abs(placed.tee_lat! - 41.0948)).toBeLessThan(0.05);
    expect(Math.abs(placed.tee_lng! + 75.648)).toBeLessThan(0.05);
    expect(placed.tee_lat).not.toBe(placed.green_lat);

    // ---- Live round: a drink and a score arrive from a player's phone ------------------------
    await sync(page.request, seed.code, [op({ type: "trip.start" })]);
    const drinkId = randomUUID();
    await sync(page.request, seed.code, [
      op({ type: "tee.open", team_id: teamA.id, hole: 1 }, nick.id),
      op({ type: "drink.log", drink_id: drinkId, team_id: teamA.id, player_id: seed.players[1].id, hole: 1, drink_type: "drink", photo_path: null }, nick.id),
      op({ type: "score.set", team_id: teamA.id, hole: 1, strokes: 5 }, nick.id),
    ]);

    await page.reload();
    await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "setup", { timeout: 45_000 });
    const tools = page.getByTestId("commish-tools");
    await reveal(page, tools, /commissioner|tools|fix/i);

    // Course stays editable mid-round, with a note.
    const live = page.getByTestId("course-live-note");
    if ((await live.count()) > 0) await expect(live).toContainText("live");

    // Drinks: move the drink from hole 1 to hole 3.
    await tools.getByRole("tab", { name: /Drinks/ }).click();
    const row = page.locator(`[data-testid="commish-drink-row"][data-drink-id="${drinkId}"]`);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /Move drink/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Hole 3", exact: true }).click();
    await expect(row).toContainText("Hole 3");
    await expect(row).toContainText("(was 1)");

    // Scores: hole 1 from 5 to 6.
    await tools.getByRole("tab", { name: /Scores/ }).click();
    await page.getByTestId("commish-score-1").click();
    await page.getByRole("dialog").getByRole("button", { name: "One more stroke" }).click();
    await page.getByTestId("commish-score-save").click();
    await expect(page.getByTestId("commish-score-1")).toContainText("6");

    // Server agrees, and every fix posted a Commissioner override.
    await expect
      .poll(
        async () => {
          const s = await state(page.request, seed.code);
          const drink = s.drinks.find((d) => d.id === drinkId);
          const score = s.hole_scores.find((h) => h.team_id === teamA.id && h.hole === 1);
          const overrides = s.feed_events.filter((e) => e.type === "commissioner_override" && e.deleted_at === null).map((e) => String(e.payload.op_type));
          return {
            hole: drink?.hole,
            from: drink?.moved_from_hole,
            strokes: score?.strokes,
            move: overrides.includes("drink.move"),
            score: overrides.includes("score.set"),
          };
        },
        { timeout: 20_000 },
      )
      .toEqual({ hole: 3, from: 1, strokes: 6, move: true, score: true });

    // No sideways scrolling on the tools.
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(m.sw).toBeLessThanOrEqual(m.iw);
  });

  test("OpenStreetMap import route is commissioner-only", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const seedCtx = await playwright.request.newContext({ baseURL });
    const res = await seedCtx.post("/api/trips", { data: { pin: "2468", name: "OSM guard" } });
    const { code } = (await res.json()) as { code: string };
    const denied = await anon.post(`/api/t/${code}/osm-import`, { data: {} });
    expect(denied.status()).toBe(403);
    await anon.dispose();
    await seedCtx.dispose();
  });
});
