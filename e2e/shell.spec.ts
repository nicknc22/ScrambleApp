// App shell + design system smoke tests. The trip-shell test mocks the trip API with
// page.route, so it only depends on the client (store, shell, join flow), not on server data.
import { expect, test, type Page } from "@playwright/test";
import { makeTrip, at } from "../tests/fixtures";

async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.iw}px viewport`).toBeLessThanOrEqual(m.iw);
}

test.describe("home", () => {
  test("renders join, commissioner and demo entry points", async ({ page }) => {
    await page.goto("/?home=1");
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Join a trip" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Let's go/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create the trip" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try the demo" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("rejects an empty code with a friendly error", async ({ page }) => {
    await page.goto("/?home=1");
    await page.getByRole("button", { name: /Let's go/i }).click();
    await expect(page.getByText(/not a trip code/i)).toBeVisible();
  });

  test("a pasted trip link navigates to the trip", async ({ page }) => {
    await page.route("**/api/t/pasted123/**", (r) => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await page.goto("/?home=1");
    await page.getByTestId("join-code").fill("https://example.com/t/Pasted123?tab=feed");
    await page.getByRole("button", { name: /Let's go/i }).click();
    await expect(page).toHaveURL(/\/t\/pasted123$/);
    await expect(page.getByTestId("load-error")).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("design system gallery", () => {
  for (const width of [360, 390]) {
    test(`/dev/ui has no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/dev/ui");
      await expect(page.getByTestId("dev-ui")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }

  test("undo toast shows a countdown and the fanfare dismisses on tap", async ({ page }) => {
    await page.goto("/dev/ui");
    await page.getByRole("button", { name: "Drink with 10 s undo" }).click();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
    await expect(page.locator(".toast-countdown")).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByText("Undone. Pretend it never happened.")).toBeVisible();

    await page.getByRole("button", { name: "Groom's Mulligan" }).click();
    const fanfare = page.getByTestId("fanfare");
    await expect(fanfare).toBeVisible();
    await expect(fanfare).toHaveAttribute("data-tone", "groom");
    await fanfare.click();
    await expect(fanfare).toHaveCount(0);
  });
});

test.describe("trip shell (mocked API)", () => {
  const CODE = "shellspec01";

  function snapshot() {
    const f = makeTrip({ teams: [4, 3, 3], status: "live" });
    f.state.trip.code = CODE;
    f.state.trip.name = "Shell Spec Scramble";
    f.teeOff("A", 1);
    f.score("A", 1, 4, "A1");
    return {
      fixture: f,
      body: JSON.stringify({
        state: f.state,
        meta: { server_time: at(0), photo_base_url: "/api/photos/", realtime: null, vapid_public_key: null, ai_enabled: false, push_enabled: false },
      }),
    };
  }

  test("join -> onboarding -> tabs, with the tab in the URL", async ({ page }) => {
    const { body } = snapshot();
    await page.route(`**/api/t/${CODE}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/state")) return route.fulfill({ contentType: "application/json", body });
      if (url.pathname.endsWith("/commissioner")) return route.fulfill({ contentType: "application/json", body: '{"is_commissioner":false}' });
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });
    await page.goto(`/t/${CODE}`);
    await expect(page.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Shell Spec Scramble" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByTestId("join-player").first().click();
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await page.getByRole("button", { name: "Skip setup" }).click();

    const shell = page.getByTestId("trip-shell");
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute("data-tab", "play");
    await page.getByTestId("tab-leaderboard").click();
    await expect(shell).toHaveAttribute("data-tab", "leaderboard");
    await expect(page).toHaveURL(/tab=leaderboard/);
    await expectNoHorizontalOverflow(page);

    // Reload: remembered player (no join screen), tab restored from the URL.
    await page.reload();
    await expect(page.getByTestId("trip-shell")).toHaveAttribute("data-tab", "leaderboard", { timeout: 30_000 });

    // Menu -> Settings -> Switch player goes back to the roster.
    await page.getByTestId("menu-button").click();
    await page.getByRole("dialog").getByRole("button", { name: /Switch player/ }).click();
    await expect(page.getByTestId("join-screen")).toBeVisible();
  });

  test("unknown trip shows the not-found screen", async ({ page }) => {
    await page.route("**/api/t/nosuchtrip9/**", (r) => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await page.goto("/t/nosuchtrip9");
    await expect(page.getByTestId("load-error")).toHaveAttribute("data-kind", "not_found", { timeout: 30_000 });
    await expect(page.getByRole("link", { name: "Go home" })).toBeVisible();
  });
});
