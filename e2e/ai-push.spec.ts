// AI team names and Web Push subscription endpoints against the real server. The e2e server runs
// without ANTHROPIC_API_KEY, so team names come from the built-in list (ai: false) and AI judge /
// roasts stay silent; it has no VAPID env keys either, so it generates and stores its own pair and
// push is on. The assertions also hold with AI on.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

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
  tripId: string;
  team: { A: string; B: string };
  player: { A1: string; A2: string; B1: string; B2: string };
}

/** Two twosomes, round started. The request context keeps the commissioner cookie. */
async function seedTrip(request: APIRequestContext): Promise<Seeded> {
  const res = await request.post("/api/trips", { data: { pin: "2468", name: "AI + Push Spec" } });
  expect(res.status()).toBe(201);
  const { code, trip_id: tripId } = (await res.json()) as { code: string; trip_id: string };
  const team = { A: randomUUID(), B: randomUUID() };
  const player = { A1: randomUUID(), A2: randomUUID(), B1: randomUUID(), B2: randomUUID() };
  await sync(request, code, [
    ...Object.entries(player).map(([label, id], i) => op({ type: "player.upsert", player: { id, name: `Player ${label}`, sort_order: i } })),
    op({ type: "team.upsert", team: { id: team.A, name: "Sip Happens", sort_order: 0 } }),
    op({ type: "team.upsert", team: { id: team.B, name: "Par-Tee Fouls", sort_order: 1 } }),
    ...Object.entries(player).map(([label, id]) => op({ type: "team.assign", player_id: id, team_id: label.startsWith("A") ? team.A : team.B })),
  ]);
  await sync(request, code, [op({ type: "trip.start" })]);
  return { code, tripId, team, player };
}

const subscription = () => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${randomUUID()}`,
  expirationTime: null,
  keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
});

test.describe("AI team names", () => {
  test("returns 5 names (built-in list when AI is off) and 404s unknown trips", async ({ request }) => {
    const s = await seedTrip(request);
    const res = await request.post(`/api/t/${s.code}/ai/team-names`, { data: { seed: "bachelor party, last round of freedom" } });
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toMatch(/no-store/);
    const body = (await res.json()) as { names: string[]; ai: boolean };
    expect(typeof body.ai).toBe("boolean");
    expect(body.names).toHaveLength(5);
    expect(new Set(body.names.map((n) => n.toLowerCase())).size).toBe(5);
    for (const n of body.names) {
      expect(n.length).toBeGreaterThan(1);
      expect(n.length).toBeLessThanOrEqual(32);
    }
    // Names already used by the trip's teams are never suggested.
    expect(body.names).not.toContain("Sip Happens");
    expect(body.names).not.toContain("Par-Tee Fouls");

    // No body at all is fine too.
    const bare = await request.post(`/api/t/${s.code}/ai/team-names`);
    expect(((await bare.json()) as { names: string[] }).names).toHaveLength(5);

    expect((await request.post("/api/t/nosuchtrip9/ai/team-names", { data: {} })).status()).toBe(404);
  });
});

test.describe("push subscriptions", () => {
  test("subscribe, re-subscribe (upsert), unsubscribe; junk and strangers are refused", async ({ request }) => {
    const s = await seedTrip(request);
    const sub = subscription();

    const ok = await request.post(`/api/t/${s.code}/push`, { data: { player_id: s.player.A1, subscription: sub } });
    expect(ok.status()).toBe(200);
    const okBody = (await ok.json()) as { ok: boolean; push_enabled: boolean };
    expect(okBody.ok).toBe(true);
    expect(typeof okBody.push_enabled).toBe("boolean");

    // Same endpoint again (e.g. picked another name on this phone): still fine.
    const again = await request.post(`/api/t/${s.code}/push`, { data: { player_id: s.player.B2, subscription: sub } });
    expect(again.status()).toBe(200);

    // Not a browser push service → refused (the server never POSTs to arbitrary URLs).
    const evil = await request.post(`/api/t/${s.code}/push`, {
      data: { player_id: s.player.A1, subscription: { ...subscription(), endpoint: "https://169.254.169.254/latest/meta-data" } },
    });
    expect(evil.status()).toBe(400);
    expect(((await evil.json()) as { code: string }).code).toBe("bad_subscription");

    // Somebody who isn't on this trip.
    const stranger = await request.post(`/api/t/${s.code}/push`, { data: { player_id: randomUUID(), subscription: subscription() } });
    expect(stranger.status()).toBe(400);
    expect(((await stranger.json()) as { code: string }).code).toBe("unknown_player");

    const del = await request.delete(`/api/t/${s.code}/push`, { data: { player_id: s.player.B2, endpoint: sub.endpoint } });
    expect(del.status()).toBe(200);
    expect(await del.json()).toEqual({ ok: true, removed: 1 });
    const delAgain = await request.delete(`/api/t/${s.code}/push`, { data: { player_id: null, endpoint: sub.endpoint } });
    expect(await delAgain.json()).toEqual({ ok: true, removed: 0 });

    expect((await request.post("/api/t/nosuchtrip9/push", { data: { player_id: s.player.A1, subscription: sub } })).status()).toBe(404);
  });
});

test.describe("closest to pin with a photo", () => {
  test("syncs and posts to the feed; the AI judge (when configured) never blocks or changes the entry", async ({ page }) => {
    const request = page.request;
    const s = await seedTrip(request);
    const photoPath = `trips/${s.tripId}/ctp/${randomUUID()}.jpg`;
    const up = await request.post(`/api/t/${s.code}/upload?path=${encodeURIComponent(photoPath)}`, {
      data: TINY_JPEG,
      headers: { "content-type": "image/jpeg" },
    });
    expect(up.status()).toBe(200);
    const entryId = randomUUID();
    await sync(request, s.code, [
      op({ type: "tee.open", team_id: s.team.A, hole: 1 }, s.player.A1),
      op({ type: "score.set", team_id: s.team.A, hole: 1, strokes: 4 }, s.player.A1),
      op({ type: "score.set", team_id: s.team.A, hole: 2, strokes: 4 }, s.player.A1),
      op({ type: "tee.open", team_id: s.team.A, hole: 3 }, s.player.A1),
      op(
        { type: "contest.submit", entry_id: entryId, hole: 3, player_id: s.player.A2, contest_type: "ctp", distance_value: 4.5, angle_deg: 45, lat: null, lng: null, gps_accuracy_m: null, low_accuracy: false, photo_path: photoPath },
        s.player.A2,
      ),
    ]);
    // Give the post-commit hooks a moment, then the entry is still the player's claim.
    await page.waitForTimeout(1500);
    const state = (await (await request.get(`/api/t/${s.code}/state`)).json()) as {
      state: { contest_entries: Array<{ id: string; status: string; distance_value: number; distance_override: number | null }>; feed_events: Array<{ type: string }> };
    };
    const entry = state.state.contest_entries.find((e) => e.id === entryId)!;
    expect(entry).toMatchObject({ status: "ok", distance_value: 4.5, distance_override: null });
    expect(state.state.feed_events.some((e) => e.type === "contest_entry")).toBe(true);

    // The feed renders for a player with no horizontal scroll.
    await page.setViewportSize({ width: 360, height: 740 });
    await page.addInitScript(
      ([c, me]) => {
        localStorage.setItem(`scramble:me:${c}`, me);
      },
      [s.code, s.player.A1],
    );
    await page.goto(`/t/${s.code}?tab=feed`);
    await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "feed", { timeout: 30_000 });
    await expect(page.getByText(/closest to pin/i).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
