// Money + Awards end to end: a real trip created through the API, a full round pushed through
// /sync (as the phones would), finalized; then the Money tab (FINAL, ledger sums to $0, Venmo
// deep links), the Awards tab (champions, award cards, gallery, recap preview) and the recap PNG.
// Also: opting out of a pot during setup syncs to the server.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const PIN = "2468";

/** Jack Frost National pars (holes 1..18). */
const PARS = [4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 3, 5, 4, 4, 4, 3, 4, 5];

type Json = Record<string, unknown>;

interface TripCtx {
  code: string;
  tripId: string;
  api: APIRequestContext;
  clock: { t: number };
}

async function createTrip(api: APIRequestContext, name: string): Promise<TripCtx> {
  const res = await api.post("/api/trips", { data: { pin: PIN, name, app_name: "Scramble" } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { code: string; trip_id: string };
  return { code: body.code, tripId: body.trip_id, api, clock: { t: Date.now() - 4 * 3600_000 } };
}

function op(ctx: TripCtx, o: Json): Json {
  ctx.clock.t += 20_000;
  return { id: randomUUID(), at: new Date(ctx.clock.t).toISOString(), by: null, ...o };
}

/** POST ops to /sync (the commissioner cookie from trip creation rides along); every op must apply. */
async function sync(ctx: TripCtx, ops: Json[]): Promise<void> {
  for (let i = 0; i < ops.length; i += 150) {
    const res = await ctx.api.post(`/api/t/${ctx.code}/sync`, { data: { ops: ops.slice(i, i + 150) } });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { results: { id: string; status: string; reason?: string }[] };
    expect(body.results.filter((r) => r.status === "rejected")).toEqual([]);
  }
}

/** A real JPEG drawn by the browser, uploaded like a phone would. */
async function uploadPhoto(page: Page, ctx: TripCtx, kind: string, label: string): Promise<string> {
  const b64 = await page.evaluate((text) => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 480;
    const g = c.getContext("2d")!;
    g.fillStyle = "#0a7d3e";
    g.fillRect(0, 0, 640, 480);
    g.fillStyle = "#ffffff";
    g.font = "bold 64px sans-serif";
    g.fillText(text, 30, 260);
    return c.toDataURL("image/jpeg", 0.8).split(",")[1];
  }, label);
  const path = `trips/${ctx.tripId}/${kind}/${randomUUID()}.jpg`;
  const res = await ctx.api.post(`/api/t/${ctx.code}/upload?path=${encodeURIComponent(path)}`, {
    headers: { "content-type": "image/jpeg" },
    data: Buffer.from(b64, "base64"),
  });
  expect(res.status(), await res.text()).toBe(200);
  return path;
}

interface Roster {
  players: { id: string; name: string; venmo_handle: string | null; sort_order: number }[];
  teams: { id: string; name: string; sort_order: number }[];
  /** team index per player */
  assign: number[];
}

function roster(): Roster {
  const names = ["Nick", "Dave", "Mike", "Chris", "Jon", "Tom", "Sam"];
  return {
    players: names.map((name, i) => ({ id: randomUUID(), name, venmo_handle: `@${name.toLowerCase()}-e2e`, sort_order: i })),
    teams: [
      { id: randomUUID(), name: "Grip It & Sip It", sort_order: 0 },
      { id: randomUUID(), name: "Shank Redemption", sort_order: 1 },
    ],
    assign: [0, 0, 0, 0, 1, 1, 1],
  };
}

function setupOps(ctx: TripCtx, r: Roster): Json[] {
  return [
    ...r.players.map((p) => op(ctx, { type: "player.upsert", player: { ...p, is_groom: p.sort_order === 0 } })),
    ...r.teams.map((t) => op(ctx, { type: "team.upsert", team: t })),
    ...r.players.map((p, i) => op(ctx, { type: "team.assign", player_id: p.id, team_id: r.teams[r.assign[i]].id })),
    op(ctx, { type: "trip.update", patch: { settings: { team_match_ante_cents: 2000, contest_ante_cents: 500, team_match_payout: [100] } } }),
    op(ctx, { type: "hole.update", hole: 4, patch: { tee_lat: 41.1, tee_lng: -75.4 } }),
  ];
}

async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.iw}px viewport`).toBeLessThanOrEqual(m.iw);
}

async function openAs(page: Page, code: string, playerId: string, tab: string) {
  await page.addInitScript(
    ([c, me]) => {
      localStorage.setItem("scramble:onboarded", "1");
      localStorage.setItem(`scramble:me:${c}`, me);
    },
    [code, playerId],
  );
  await page.goto(`/t/${code}?tab=${tab}`);
  await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", tab, { timeout: 60_000 });
}

test.describe("money + awards", () => {
  test("a finalized round: FINAL money, balanced ledger, Venmo links, awards and the recap card", async ({ page, request }) => {
    await page.goto("/?home=1"); // a page for drawing test photos
    const ctx = await createTrip(request, "E2E Money Scramble");
    const r = roster();
    await sync(ctx, setupOps(ctx, r));
    await sync(ctx, [op(ctx, { type: "trip.start" })]);

    const ctpPhoto = await uploadPhoto(page, ctx, "ctp", "CTP 3");
    const drinkPhoto = await uploadPhoto(page, ctx, "drinks", "SHOTGUN");
    const play: Json[] = [];
    r.teams.forEach((team, ti) => {
      const members = r.players.filter((_, i) => r.assign[i] === ti);
      for (let h = 1; h <= 18; h++) {
        play.push(op(ctx, { type: "tee.open", team_id: team.id, hole: h }));
        if (h % 5 === ti) {
          const p = members[h % members.length];
          play.push(
            op(ctx, {
              type: "drink.log",
              drink_id: randomUUID(),
              team_id: team.id,
              player_id: p.id,
              hole: h,
              drink_type: h === 5 ? "shotgun" : "drink",
              photo_path: h === 5 ? drinkPhoto : null,
              by: p.id,
            }),
          );
        }
        if (h === 3 && ti === 1) {
          play.push(
            op(ctx, {
              type: "contest.submit",
              entry_id: randomUUID(),
              hole: 3,
              player_id: members[0].id,
              contest_type: "ctp",
              distance_value: 7.25,
              angle_deg: 45,
              lat: null,
              lng: null,
              gps_accuracy_m: null,
              low_accuracy: false,
              photo_path: ctpPhoto,
              by: members[0].id,
            }),
          );
        }
        if (h === 4 && ti === 0) {
          play.push(
            op(ctx, {
              type: "contest.submit",
              entry_id: randomUUID(),
              hole: 4,
              player_id: members[1].id,
              contest_type: "ld",
              distance_value: 250,
              angle_deg: null,
              lat: 41.1 + 0.00205,
              lng: -75.4,
              gps_accuracy_m: 4,
              low_accuracy: false,
              photo_path: null,
              by: members[1].id,
            }),
          );
        }
        // Team 0 shoots par, team 1 bogeys every third hole.
        play.push(op(ctx, { type: "score.set", team_id: team.id, hole: h, strokes: PARS[h - 1] + (ti === 1 && h % 3 === 0 ? 1 : 0) }));
      }
      play.push(op(ctx, { type: "round.complete", team_id: team.id }));
    });
    await sync(ctx, play);
    await sync(ctx, [op(ctx, { type: "trip.finalize" })]);

    // Somebody on the losing team (they owe money).
    const payer = r.players[4];
    await openAs(page, ctx.code, payer.id, "money");

    const banner = page.getByTestId("money-banner");
    await expect(banner).toHaveAttribute("data-final", "true");
    await expect(banner).toContainText("FINAL");

    // Ledger: every player on a team, nets sum to exactly $0.
    const rows = page.getByTestId("ledger-row");
    await expect(rows).toHaveCount(7);
    const nets = await rows.evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-net-cents"))));
    expect(nets.every((n) => Number.isInteger(n))).toBe(true);
    expect(nets.reduce((s, n) => s + n, 0)).toBe(0);
    expect(nets.some((n) => n !== 0)).toBe(true);
    await expect(page.getByTestId("ledger-sum")).toHaveAttribute("data-sum-cents", "0");

    // Settle-up: my payment first, with a Venmo deep link + https fallback.
    const payments = page.getByTestId("payment");
    expect(await payments.count()).toBeGreaterThan(0);
    await expect(payments.first()).toHaveAttribute("data-mine", "pay");
    await expect(payments.first()).toContainText("You pay");
    const venmo = payments.first().getByTestId("venmo-pay");
    await expect(venmo).toBeVisible();
    const href = await venmo.getAttribute("href");
    expect(href).toMatch(/^venmo:\/\/paycharge\?txn=pay&recipients=[a-z]+-e2e&amount=\d+\.\d{2}&note=Scramble%3A%20E2E%20Money%20Scramble%20settle-up$/);
    const web = await payments.first().getByTestId("venmo-web").getAttribute("href");
    expect(web).toMatch(/^https:\/\/venmo\.com\/[a-z]+-e2e\?txn=pay&amount=\d+\.\d{2}&note=/);
    await expectNoHorizontalOverflow(page);

    // Pots: the team match was won, hole 3 has a winner.
    await expect(page.locator('[data-testid="pot-card"][data-pot="team_match"]')).toContainText("Won");
    await expect(page.locator('[data-testid="pot-card"][data-pot="contest:3"]')).toContainText("Won");

    // Awards.
    await page.goto(`/t/${ctx.code}?tab=awards`);
    await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "awards", { timeout: 60_000 });
    await expect(page.getByTestId("champions")).toContainText("Grip It & Sip It");
    await expect(page.getByTestId("award")).toHaveCount(10);
    await expect(page.locator('[data-testid="award"][data-award="closest_pin"]')).toContainText("Jon");
    await expect(page.locator('[data-testid="award"][data-award="longest_drive"]')).toContainText("Dave");
    await expect(page.getByTestId("gallery-photo")).toHaveCount(2);
    await expectNoHorizontalOverflow(page);

    // Photo viewer opens and closes.
    await page.getByTestId("gallery-photo").first().click();
    await expect(page.getByTestId("photo-viewer")).toBeVisible();
    await page.getByRole("button", { name: "Close photo" }).click();
    await expect(page.getByTestId("photo-viewer")).toHaveCount(0);

    // The recap preview actually loads as an image.
    const img = page.getByTestId("recap-img");
    await img.scrollIntoViewIfNeeded();
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 60_000 })
      .toBe(1080);

    // And the endpoint itself.
    const png = await request.get(`/api/t/${ctx.code}/recap`);
    expect(png.status()).toBe(200);
    expect(png.headers()["content-type"]).toBe("image/png");
    expect(png.headers()["cache-control"]).toContain("no-store");
    const bytes = await png.body();
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect((await request.get("/api/t/nosuchtrip99/recap")).status()).toBe(404);
  });

  test("opting out of a pot during setup syncs, and locks once the round starts", async ({ page, request }) => {
    const ctx = await createTrip(request, "E2E Optout Scramble");
    const r = roster();
    await sync(ctx, setupOps(ctx, r));
    const me = r.players[2];
    await openAs(page, ctx.code, me.id, "money");

    const myPots = page.getByTestId("my-pots");
    await expect(myPots).toBeVisible();
    const hole3 = myPots.getByRole("switch", { name: /Hole 3 · Closest to pin/ });
    await expect(hole3).toHaveAttribute("aria-checked", "true");
    await hole3.click();
    await expect(hole3).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText(/You're out: Hole 3/)).toBeVisible();

    // It reaches the server.
    await expect
      .poll(
        async () => {
          const s = (await (await request.get(`/api/t/${ctx.code}/state`)).json()) as {
            state: { pot_optouts: { pot_key: string; player_id: string; deleted_at: string | null }[] };
          };
          return s.state.pot_optouts.filter((o) => o.player_id === me.id && o.deleted_at === null).map((o) => o.pot_key);
        },
        { timeout: 30_000 },
      )
      .toEqual(["contest:3"]);
    await expectNoHorizontalOverflow(page);

    // Once the round starts the toggles are gone (locked summary).
    await sync(ctx, [op(ctx, { type: "trip.start" })]);
    await page.reload();
    await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "money", { timeout: 60_000 });
    await expect(page.getByTestId("my-pots")).toContainText("Locked");
    await expect(page.getByTestId("my-pots").getByRole("switch")).toHaveCount(0);
    await expect(page.getByTestId("my-pots")).toContainText("You're in 8 of 9 pots");
  });
});
