// Commissioner PIN in the real app: any PIN the app lets you set (up to 12 digits) can be typed on
// the unlock pad, the 12 dots fit a 360px phone, and a PIN change signs out every phone that had
// commissioner powers under the old PIN.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

const LONG_PIN = "555123456789";

test.use({ viewport: { width: 360, height: 740 } });

async function createTrip(request: APIRequestContext): Promise<{ code: string; me: string }> {
  const res = await request.post("/api/trips", { data: { pin: "2468", name: "PIN E2E" } });
  expect(res.status()).toBe(201);
  const { code } = (await res.json()) as { code: string };
  const me = randomUUID();
  const sync = await request.post(`/api/t/${code}/sync`, {
    data: { ops: [{ id: randomUUID(), at: new Date().toISOString(), by: null, type: "player.upsert", player: { id: me, name: "Nick", is_groom: true } }] },
  });
  expect(sync.ok()).toBeTruthy();
  return { code, me };
}

test("change to a 12-digit PIN, lock, then unlock with all 12 digits on the pad", async ({ page, browser }) => {
  // page.request shares this phone's cookies: creating the trip makes it the commissioner.
  const { code, me } = await createTrip(page.request);

  // A second phone the commissioner unlocked earlier (and forgot to lock).
  const other = await browser.newContext();
  expect((await other.request.post(`/api/t/${code}/commissioner`, { data: { pin: "2468" } })).status()).toBe(200);
  expect(await (await other.request.get(`/api/t/${code}/commissioner`)).json()).toEqual({ is_commissioner: true });

  const changed = await page.request.put(`/api/t/${code}/commissioner`, { data: { pin: "2468", new_pin: LONG_PIN } });
  expect(changed.status()).toBe(200);
  // The PIN change revoked the other phone's powers.
  expect(await (await other.request.get(`/api/t/${code}/commissioner`)).json()).toEqual({ is_commissioner: false });
  await other.close();

  await page.addInitScript(
    ([c, id]) => {
      try {
        localStorage.setItem(`scramble:me:${c}`, id);
        localStorage.setItem("scramble:onboarded", "1");
      } catch {
        /* ignore */
      }
    },
    [code, me] as const,
  );
  await page.goto(`/t/${code}`);
  await expect(page.getByTestId("trip-shell")).toBeVisible({ timeout: 45_000 });

  await page.getByTestId("menu-button").click();
  await page.getByRole("dialog").getByRole("button", { name: /Settings/ }).click();
  await page.getByRole("button", { name: "Lock commissioner powers" }).click();
  await expect(page.getByRole("button", { name: "Unlock commissioner" })).toBeVisible();
  expect(await (await page.request.get(`/api/t/${code}/commissioner`)).json()).toEqual({ is_commissioner: false });

  await page.getByRole("button", { name: "Unlock commissioner" }).click();
  const pad = page.getByRole("dialog");
  for (const d of LONG_PIN) await pad.getByRole("button", { name: d, exact: true }).click();
  await expect(pad.getByLabel("12 digits entered")).toBeVisible();
  // All 12 dots on screen at 360px, no sideways scroll.
  const dots = pad.getByLabel("12 digits entered").locator("span");
  await expect(dots).toHaveCount(12);
  const last = await dots.nth(11).boundingBox();
  expect(last && last.x + last.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await pad.getByRole("button", { name: "Unlock powers" }).click();
  await expect(page.getByText(/Commissioner powers: ON/).first()).toBeVisible({ timeout: 15_000 });
  expect(await (await page.request.get(`/api/t/${code}/commissioner`)).json()).toEqual({ is_commissioner: true });
});

test("security headers on pages and API routes, no X-Powered-By", async ({ request }) => {
  for (const url of ["/", "/api/t/nosuchtrip9/state"]) {
    const res = await request.get(url);
    const h = res.headers();
    expect(h["x-frame-options"], url).toBe("DENY");
    expect(h["x-content-type-options"], url).toBe("nosniff");
    expect(h["referrer-policy"], url).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"], url).toContain("geolocation=(self)");
    expect(h["x-powered-by"], url).toBeUndefined();
  }
});
