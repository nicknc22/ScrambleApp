// Course editor (satellite tee/green placement) and the live-round Commissioner Tools, driven
// through the real app against `next start`. The trip is created and seeded through the API
// (POST /api/trips sets the commissioner cookie on this browser context). Satellite tiles may
// not load in CI (no network): nothing here depends on them, pins are placed by clicking the
// map container.
import { randomUUID } from "node:crypto";
import { devices, expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

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
    drinks: { id: string; team_id: string; player_id: string; type: string; hole: number; moved_from_hole: number | null; deleted_at: string | null }[];
    hole_scores: { team_id: string; hole: number; strokes: number | null }[];
    contest_entries: { hole: number; player_id: string; distance_value: number; status: string; deleted_at: string | null }[];
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
    await expect(page.getByTestId("course-status")).toContainText("Needed for long drive");

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
    await reveal(page, tools, /commissioner|tools|fix|live|round/i);

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

  test("finalize lists missing scores and pending rulings with Fix links; the commissioner adds a missed drink and a CTP", async ({ page }) => {
    // Findings: rules/finalize-no-missing-hole-warning, walkthrough/finalize-ignores-missing-hole-scores,
    // money/finalize-ignores-review-queue, speccheck/commish-cant-add-missed-drink.
    test.setTimeout(150_000);
    const seed = await createTrip(page.request);
    const [teamA, teamB] = seed.teams;
    const [nick, dan, , sully, murph] = seed.players;
    const PARS = [4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 3, 5, 4, 4, 4, 3, 4, 5];
    await sync(page.request, seed.code, [op({ type: "trip.start" })]);
    const round: Op[] = [];
    for (const team of [teamA, teamB]) {
      for (let h = 1; h <= 18; h++) {
        round.push(op({ type: "tee.open", team_id: team.id, hole: h }));
        if (h === 4) {
          // Shank Redemption's 300 yd drive had weak GPS (flagged); Grip It's 250 yd counts.
          const p = team === teamA ? dan : sully;
          round.push(
            op({ type: "contest.submit", entry_id: randomUUID(), hole: 4, player_id: p.id, contest_type: "ld", distance_value: team === teamA ? 300 : 250, angle_deg: null, lat: null, lng: null, gps_accuracy_m: team === teamA ? 30 : 4, low_accuracy: team === teamA, photo_path: null }, p.id),
          );
        }
        // Shank Redemption forgets hole 7.
        if (!(team === teamA && h === 7)) round.push(op({ type: "score.set", team_id: team.id, hole: h, strokes: PARS[h - 1] }));
      }
      round.push(op({ type: "round.complete", team_id: team.id }));
    }
    await sync(page.request, seed.code, round);

    await openSetup(page, seed);
    const tools = page.getByTestId("commish-tools");
    await reveal(page, tools, /live|round/i);

    // ---- Add a drink Murph slammed on 18 after his team tapped Round complete ----------------
    await tools.getByRole("tab", { name: /Drinks/ }).click();
    await page.getByTestId("commish-add-drink").click();
    const addDrink = page.getByTestId("commish-add-drink-sheet");
    await addDrink.getByRole("button", { name: teamB.name }).click();
    await addDrink.getByRole("button", { name: "Murph" }).click();
    await addDrink.getByRole("button", { name: /Shotgun/ }).click();
    await expect(addDrink.getByRole("button", { name: "Hole 18", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("commish-add-drink-save").click();
    await expect(page.getByTestId("commish-drink-row").filter({ hasText: "Murph" })).toContainText("Hole 18");

    // ---- Add a CTP on hole 3 for Sully (the other team), typed in by hand --------------------
    await tools.getByRole("tab", { name: /^Contests/ }).click();
    await page.getByTestId("commish-add-entry").click();
    const addEntry = page.getByTestId("commish-add-entry-sheet");
    await addEntry.getByRole("button", { name: /^3 · CTP/ }).click();
    await addEntry.getByRole("button", { name: "Sully" }).click();
    await addEntry.getByLabel("Feet").fill("4");
    await addEntry.getByLabel("Inches").fill("6");
    await page.getByTestId("commish-add-entry-save").click();
    await expect(page.getByTestId("commish-add-entry-sheet")).toHaveCount(0);

    await expect
      .poll(
        async () => {
          const s = await state(page.request, seed.code);
          const drink = s.drinks.find((d) => d.player_id === murph.id && d.deleted_at === null);
          const ctp = s.contest_entries.find((e) => e.hole === 3 && e.player_id === sully.id && e.deleted_at === null);
          return { drink: drink && [drink.hole, drink.type, drink.team_id], ctp: ctp && [ctp.distance_value, ctp.status] };
        },
        { timeout: 20_000 },
      )
      .toEqual({ drink: [18, "shotgun", teamB.id], ctp: [4.5, "overridden"] }); // commissioner-typed entries are official

    // ---- Finalize: the check lists the blank hole and the flagged drive ----------------------
    await page.getByTestId("finalize-round").click();
    const check = page.getByTestId("finalize-summary");
    await expect(check).toContainText(`${teamA.name}: no score on hole 7`);
    await expect(check).toContainText("Hole 4 long drive · Dan · 300 yd · Flagged: GPS was weak");
    await expect(page.getByRole("dialog").getByRole("button", { name: "Finalize anyway" })).toBeVisible();

    // Fix the blank hole: straight into its score sheet.
    await check.getByRole("button", { name: `Enter ${teamA.name}'s hole 7` }).click();
    await expect(page.getByRole("dialog")).toContainText("Hole 7");
    await page.getByRole("dialog").getByRole("button", { name: "One more stroke" }).click(); // par 4 -> 5
    await page.getByTestId("commish-score-save").click();
    await expect(page.getByTestId("commish-score-7")).toContainText("5");

    // Back to Finalize: only the ruling is left. Fix it: the entry sheet opens; approve it.
    await page.getByTestId("finalize-round").click();
    await expect(check).not.toContainText("no score on hole 7");
    await check.getByRole("button", { name: "Rule on Dan's hole 4 entry" }).click();
    await expect(page.getByTestId("commish-entry-sheet")).toBeVisible();
    await page.getByTestId("commish-entry-sheet").getByRole("button", { name: /Approve/ }).click();
    await expect(page.getByTestId("commish-entry-sheet")).toHaveCount(0);

    // All clear: a plain "Finalize it".
    await page.getByTestId("finalize-round").click();
    await expect(page.getByTestId("finalize-clean")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Finalize it" }).click();
    await expect(page.getByTestId("setup-round")).toHaveAttribute("data-status", "final", { timeout: 20_000 });
    await expect.poll(async () => (await state(page.request, seed.code)).trip.status, { timeout: 20_000 }).toBe("final");
    expect(nick.id).toBeTruthy();
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(m.sw).toBeLessThanOrEqual(m.iw);
  });

  test("GPS simulator: commissioner-only on a real trip, loud while on, and a player's leftover is cleared", async ({ page, browser, baseURL }) => {
    // Findings: security/gps-simulator-enabled-in-production, speccheck/gps-sim-in-prod.
    test.setTimeout(120_000);
    const seed = await createTrip(page.request);
    const openSettings = async (p: Page) => {
      await p.getByTestId("menu-button").click();
      await p.getByRole("dialog").getByRole("button", { name: /^Settings/ }).click();
      return p.getByRole("button", { name: /^Scramble v/ });
    };

    // The commissioner (trip creator) unlocks it, fakes a position, and the header shouts.
    await openSetup(page, seed);
    const version = await openSettings(page);
    for (let i = 0; i < 7; i++) await version.click();
    const sim = page.getByTestId("gps-simulator");
    await expect(sim).toBeVisible();
    await sim.getByLabel("Lat").fill("41.0954");
    await sim.getByLabel("Lng").fill("-75.6716");
    await sim.getByRole("button", { name: "Set position" }).click();
    const banner = page.getByTestId("gps-sim-banner");
    await expect(banner).toContainText("Simulated GPS");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: "Turn off" }).click();
    await expect(banner).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("scramble:gps-sim"))).toBeNull();

    // A plain player's phone (no commissioner cookie) with dev mode on and a simulation left over
    // from the demo: it's cleared on sight, no strip, and seven taps don't unlock the simulator.
    const ctx = await browser.newContext({ ...devices["iPhone 13"], baseURL });
    try {
      const p2 = await ctx.newPage();
      await p2.addInitScript(
        ([code, me]) => {
          localStorage.setItem(`scramble:me:${code}`, me);
          localStorage.setItem("scramble:dev", "1");
          if (!sessionStorage.getItem("seeded")) {
            localStorage.setItem("scramble:gps-sim", JSON.stringify({ lat: 41.1, lng: -75.6, accuracy: 3 }));
            sessionStorage.setItem("seeded", "1");
          }
        },
        [seed.code, seed.players[3].id] as const,
      );
      await p2.goto(`/t/${seed.code}`);
      await expect(p2.getByTestId("trip-shell")).toBeVisible({ timeout: 45_000 });
      await expect.poll(() => p2.evaluate(() => localStorage.getItem("scramble:gps-sim"))).toBeNull();
      await expect(p2.getByTestId("gps-sim-banner")).toHaveCount(0);
      const v2 = await openSettings(p2);
      await expect(p2.getByRole("button", { name: "Unlock commissioner" })).toBeVisible();
      for (let i = 0; i < 7; i++) await v2.click();
      await expect(p2.getByTestId("gps-simulator")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
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
