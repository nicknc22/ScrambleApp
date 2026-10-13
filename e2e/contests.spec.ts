// Contests end to end against the real server: the commissioner sets hole 4's tee point and the
// team reaches hole 4 (API); then a player measures a ~280 yd drive with a faked GPS fix, attaches
// a photo and submits; it shows on the Contests tab. Then a closest-to-pin entry on hole 3 lands
// on the green plot, and an edit of it keeps its photo. The server ends up with both entries (and
// their photos) exactly once.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const TEE4 = { lat: 41.0921, lng: -75.6512 };
/** A point `yards` due north of `p` (mean Earth radius, like the engine's haversine). */
const north = (p: { lat: number; lng: number }, yards: number) => ({ lat: p.lat + ((yards * 0.9144) / 6371008.8) * (180 / Math.PI), lng: p.lng });

async function createTripAtHole4(request: APIRequestContext) {
  const res = await request.post("/api/trips", { data: { pin: "2468", name: "Contests Spec Scramble" } });
  expect(res.status(), await res.text()).toBe(201);
  const { code } = (await res.json()) as { code: string };

  let t = Date.now() - 60_000;
  const op = (o: Record<string, unknown>) => ({ id: randomUUID(), at: new Date(t++).toISOString(), by: null, ...o });
  const names = ["Nick", "Dave", "Mike", "Chris", "Tom", "Jimmy", "Rob"];
  const players = names.map((name, i) => ({ id: randomUUID(), name, nickname: null, is_groom: i === 0, sort_order: i }));
  const teams = [
    { id: randomUUID(), name: "Grip It & Sip It", sort_order: 0 },
    { id: randomUUID(), name: "The Shank Redemption", sort_order: 1 },
  ];
  const teamOf = [0, 0, 0, 0, 1, 1, 1];
  const ops = [
    ...players.map((p) => op({ type: "player.upsert", player: p })),
    ...teams.map((team) => op({ type: "team.upsert", team })),
    ...players.map((p, i) => op({ type: "team.assign", player_id: p.id, team_id: teams[teamOf[i]].id })),
    op({ type: "trip.update", patch: { settings: { contest_ante_cents: 500 } } }),
    op({ type: "hole.update", hole: 4, patch: { tee_lat: TEE4.lat, tee_lng: TEE4.lng } }),
    op({ type: "trip.start" }),
    op({ type: "tee.open", team_id: teams[0].id, hole: 4 }),
  ];
  const sync = await request.post(`/api/t/${code}/sync`, { data: { ops } });
  expect(sync.ok()).toBe(true);
  const body = (await sync.json()) as { results: Array<{ status: string; reason?: string }> };
  expect(body.results.filter((r) => r.status !== "applied")).toEqual([]);
  return { code, players };
}

/** A real JPEG drawn by the browser (a ball on grass), like a phone camera would hand over. */
async function jpeg(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 480;
    c.height = 360;
    const g = c.getContext("2d")!;
    g.fillStyle = "#3fae57";
    g.fillRect(0, 0, 480, 360);
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(240, 220, 28, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  });
  return Buffer.from(b64, "base64");
}

async function dismissFanfare(page: Page) {
  const fanfare = page.getByTestId("fanfare");
  await expect(fanfare).toHaveAttribute("data-tone", "hype");
  await fanfare.click();
  await expect(fanfare).toHaveCount(0);
}

async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.iw}px viewport`).toBeLessThanOrEqual(m.iw);
}

test("measure a long drive by GPS with a photo, then a closest-to-pin entry on the green plot", async ({ page, context }) => {
  test.setTimeout(150_000);
  const { code, players } = await createTripAtHole4(page.request);
  // Setup needed the commissioner cookie; play as a plain player.
  await context.clearCookies();
  await context.grantPermissions(["geolocation"]);
  const ball = north(TEE4, 280);
  await context.setGeolocation({ latitude: ball.lat, longitude: ball.lng, accuracy: 3 });

  await page.goto(`/t/${code}`);
  await expect(page.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("join-player").filter({ hasText: "Dave" }).click();
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.getByRole("button", { name: "Skip setup" }).click();

  await page.getByTestId("tab-contests").click();
  await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "contests");
  const card4 = page.locator('[data-testid="contest-card"][data-hole="4"]');
  const card3 = page.locator('[data-testid="contest-card"][data-hole="3"]');
  await expect(card4).toContainText("You're here");
  await expect(card4.getByTestId("contest-pot")).toHaveText(/\$35/); // 7 players x $5
  await expectNoHorizontalOverflow(page);

  // ---- Long drive on hole 4 ----
  await card4.getByTestId("contest-enter").click();
  const ld = page.getByTestId("ld-sheet");
  await expect(ld).toHaveAttribute("data-phase", "idle");
  await expect(ld.getByTestId("entrant-chip").first()).toHaveAttribute("aria-pressed", "true");
  await expect(ld.getByTestId("entrant-chip").first()).toContainText("Dave");
  await page.getByTestId("ld-measure").click();
  await expect(ld).toHaveAttribute("data-phase", "fixed", { timeout: 15_000 });
  await expect(page.getByTestId("ld-distance")).toHaveAttribute("data-yards", "280");
  await expect(page.getByTestId("ld-distance")).toContainText("280");
  await expect(page.getByTestId("ld-preview")).toContainText("First on the board");
  // No photo yet: the footer is the camera, there's no submit.
  await expect(page.getByTestId("ld-submit")).toHaveCount(0);
  const photo = await jpeg(page);
  await page.getByTestId("ld-photo").setInputFiles({ name: "ball.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.getByTestId("ld-photo-preview")).toBeVisible();
  await expect(page.getByTestId("ld-submit")).toHaveText(/Submit 280 yd/i);
  await page.getByTestId("ld-submit").click();
  await dismissFanfare(page);
  await expect(ld).toHaveCount(0);

  const daveLd = card4.locator(`[data-testid="contest-entry"][data-player-id="${players[1].id}"]`);
  await expect(daveLd).toHaveAttribute("data-rank", "1");
  await expect(daveLd.getByTestId("contest-distance")).toHaveText("280 yd");
  await expect(daveLd.getByTestId("contest-photo")).toBeVisible();
  await expect(card4.getByTestId("contest-leader")).toContainText("Dave at 280 yd");
  await expect(card4.getByTestId("contest-enter")).toHaveText(/Re-measure my drive/);

  // ---- Closest to pin on hole 3 ----
  await card3.getByTestId("contest-enter").scrollIntoViewIfNeeded();
  await card3.getByTestId("contest-enter").click();
  const ctp = page.getByTestId("ctp-sheet");
  await expect(ctp).toHaveAttribute("data-step", "photo");
  await page.getByTestId("ctp-photo").setInputFiles({ name: "pin.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.getByTestId("ctp-photo-preview")).toBeVisible();
  await page.getByTestId("ctp-next").click();
  await expect(ctp).toHaveAttribute("data-step", "distance");
  await page.getByRole("button", { name: "6 feet", exact: true }).click();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "One inch more" }).click();
  await expect(page.getByTestId("ctp-distance")).toHaveText(`6' 3"`);
  await page.getByTestId("ctp-next").click();
  await expect(ctp).toHaveAttribute("data-step", "where");

  // Drag the ball to the right of the pin: it only moves around the pin.
  const marker = ctp.getByTestId("plot-marker");
  await expect(marker).toHaveAttribute("data-angle", "180");
  const svg = ctp.locator('[data-testid="green-plot"] svg');
  await svg.scrollIntoViewIfNeeded();
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.55, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(marker).toHaveAttribute("data-angle", "90");
  await expect(page.getByTestId("ctp-side")).toContainText(/Right/i);
  // Keyboard nudges too (15° per arrow).
  await marker.focus();
  await page.keyboard.press("ArrowRight");
  await expect(marker).toHaveAttribute("data-angle", "105");

  await page.getByTestId("ctp-submit").click();
  await dismissFanfare(page);
  await expect(ctp).toHaveCount(0);

  const plot = card3.getByTestId("green-plot");
  await expect(plot).toBeVisible();
  await expect(plot.getByTestId("plot-entry")).toHaveCount(1);
  await expect(plot.locator('[data-testid="plot-entry"][data-leader="true"]')).toHaveCount(1);
  await expect(plot).toContainText("Dave");
  const daveCtp = card3.locator(`[data-testid="contest-entry"][data-player-id="${players[1].id}"]`);
  await expect(daveCtp.getByTestId("contest-distance")).toHaveText(`6' 3"`);
  await expect(card3.getByTestId("contest-leader")).toContainText(`Dave at 6' 3"`);
  await expectNoHorizontalOverflow(page);

  // Everything reaches the server (photos first, then the ops), exactly once.
  await expect(page.getByTestId("offline-badge")).toHaveCount(0, { timeout: 45_000 });
  const res = await page.request.get(`/api/t/${code}/state`);
  const body = (await res.json()) as {
    state: {
      contest_entries: Array<{
        hole: number;
        player_id: string;
        type: string;
        distance_value: number;
        angle_deg: number | null;
        lat: number | null;
        photo_path: string | null;
        status: string;
        deleted_at: string | null;
      }>;
    };
  };
  const active = body.state.contest_entries.filter((e) => e.deleted_at === null);
  expect(active).toHaveLength(2);
  const ldRow = active.find((e) => e.type === "ld")!;
  expect(ldRow).toMatchObject({ hole: 4, player_id: players[1].id, distance_value: 280, status: "ok" });
  expect(ldRow.lat).toBeCloseTo(ball.lat, 6);
  const ctpRow = active.find((e) => e.type === "ctp")!;
  expect(ctpRow).toMatchObject({ hole: 3, player_id: players[1].id, angle_deg: 105, status: "ok" });
  expect(ctpRow.distance_value).toBeCloseTo(6.25, 10);
  for (const e of active) {
    expect(e.photo_path).toMatch(/^trips\/.+\/(ld|ctp)\/.+\.jpg$/);
    const img = await page.request.get(`/api/photos/${e.photo_path}`);
    expect(img.status()).toBe(200);
    expect(img.headers()["content-type"]).toContain("image/jpeg");
  }

  // ---- Edit the closest to pin without retaking the photo: the photo stays with the entry (so
  // the AI judge's verdict follows the edit instead of vanishing). No "no photo" escape hatch.
  await card3.getByTestId("contest-enter").click();
  await expect(ctp).toHaveAttribute("data-step", "photo");
  await expect(page.getByTestId("ctp-photo-kept")).toBeVisible();
  await expect(page.getByTestId("ctp-no-photo")).toHaveCount(0);
  await page.getByTestId("ctp-next").click();
  await expect(page.getByTestId("ctp-distance")).toHaveText(`6' 3"`);
  await page.getByRole("button", { name: "One foot more" }).click();
  await page.getByTestId("ctp-next").click();
  await page.getByTestId("ctp-submit").click();
  await dismissFanfare(page);
  await expect(ctp).toHaveCount(0);
  await expect(daveCtp.getByTestId("contest-distance")).toHaveText(`7' 3"`);
  await expect(page.getByTestId("offline-badge")).toHaveCount(0, { timeout: 45_000 });
  const after = (await (await page.request.get(`/api/t/${code}/state`)).json()) as typeof body;
  const ctpRows = after.state.contest_entries.filter((e) => e.type === "ctp" && e.deleted_at === null);
  expect(ctpRows).toHaveLength(1);
  expect(ctpRows[0].distance_value).toBeCloseTo(7.25, 10);
  expect(ctpRows[0].photo_path).toBe(ctpRow.photo_path);
});
