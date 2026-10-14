// Onboarding the way the boys actually do it: the commissioner creates the trip from the home page
// with the crew pre-filled (and lands as Caster, the groom), sends the clean link, a player opens
// it, taps his name and is in (no PIN, no wizard, a "You're in, Joe" with a way out), and "Add to
// Home Screen" carries who he is into the iPhone app (never on Android, never from a shared link).
// Plus the Setup path for a trip created empty ("Load the boys", "Add several at once") and the
// one-row "Get set up" on Play for whoever first opens the link after Start.
import { randomUUID } from "node:crypto";
import { devices, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const CREW = ["Caster", "Joe", "Greg", "Rich", "Reitman", "Drew", "Will", "Ross", "Conner", "Mark"];

interface StateBody {
  state: { players: Array<{ id: string; name: string; is_groom: boolean; sort_order: number; deleted_at: string | null }> };
}

async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `page is ${m.sw}px wide in a ${m.iw}px viewport`).toBeLessThanOrEqual(m.iw);
}

async function livePlayers(page: Page, code: string) {
  const res = await page.request.get(`/api/t/${code}/state`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as StateBody).state.players.filter((p) => !p.deleted_at).sort((a, b) => a.sort_order - b.sort_order);
}

/** Another phone: fresh storage and cookies. */
function newPhone(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ...devices["iPhone 13"], baseURL: test.info().project.use.baseURL });
}

/** An installed Home Screen app: standalone display mode, with its own (empty) storage. iPhone unless `device` says otherwise. */
async function newHomeScreenApp(browser: Browser, device: string = "iPhone 13"): Promise<BrowserContext> {
  const context = await browser.newContext({ ...devices[device], baseURL: test.info().project.use.baseURL });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { get: () => true });
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q.includes("display-mode: standalone") ? ({ ...real(q), matches: true, media: q } as MediaQueryList) : real(q));
  });
  return context;
}

/** Home page -> Commissioner -> Create the trip. `roster` replaces the pre-filled names when given. */
async function createFromHome(page: Page, name: string, roster?: string): Promise<string> {
  await page.goto("/?home=1");
  await page.getByRole("button", { name: "Create the trip" }).click();
  await page.getByLabel("Trip name").fill(name);
  if (roster !== undefined) await page.getByTestId("create-roster").fill(roster);
  await page.getByLabel("Commissioner PIN").fill("2468");
  await page.getByRole("button", { name: "Create trip" }).click();
  await expect(page).toHaveURL(/\/t\/[a-z0-9]+\?tab=setup/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split("/").pop()!;
}

test("the boys come pre-loaded: create, open the link, tap your name, carry it to the Home Screen", async ({ page, browser }) => {
  test.setTimeout(150_000);

  // ---- (a) Commissioner: the create form starts with the crew and Caster as the groom ----
  await page.goto("/?home=1");
  await page.getByRole("button", { name: "Create the trip" }).click();
  await expect(page.getByTestId("create-roster")).toHaveValue(CREW.join("\n"));
  await expect(page.getByText("10 players. First name is you.")).toBeVisible();
  await expect(page.getByTestId("create-groom")).toHaveValue("caster");
  await expectNoHorizontalOverflow(page);
  // Fixing the groom's spelling keeps the crown on him (never a silent switch back to Caster)...
  await page.getByTestId("create-groom").selectOption("joe");
  await page.getByTestId("create-roster").fill(CREW.map((n) => (n === "Joe" ? "Joey" : n)).join("\n"));
  await expect(page.getByTestId("create-groom")).toHaveValue("joey");
  // ...and deleting his line says "pick again" instead of quietly crowning someone else.
  await page.getByTestId("create-roster").fill(CREW.filter((n) => n !== "Joe").join("\n"));
  await expect(page.getByTestId("create-groom")).toHaveValue("");
  await expect(page.getByTestId("create-groom-lost")).toBeVisible();
  const code = await createFromHome(page, "Caster's Last Scramble");

  // Straight into Setup with all 10 on the roster, Caster crowned, and this phone already Caster.
  await expect(page.getByTestId("setup-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("join-screen")).toHaveCount(0);
  await expect(page.getByTestId("roster-row")).toHaveCount(10);
  expect(await page.getByTestId("roster-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-player")))).toEqual(CREW);
  await expect(page.getByRole("button", { name: "Edit Caster, the groom" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Caster, the groom" })).toContainText("(you)");
  await expect(page.getByTestId("roster-row").filter({ hasText: "(you)" })).toHaveCount(1);
  await expect(page.getByTestId("load-the-boys")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // "Send the link": the clean /t/<code> link (no ?tab=, no ?me=) through the share sheet.
  const origin = new URL(page.url()).origin;
  const clean = `${origin}/t/${code}`;
  await expect(page.getByTestId("share-link-url")).toHaveText(clean);
  await page.evaluate(() => {
    (window as unknown as { __shared: ShareData[] }).__shared = [];
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (d: ShareData) => void (window as unknown as { __shared: ShareData[] }).__shared.push(d),
    });
  });
  await page.getByTestId("share-link").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared.map((d) => d.url))).toEqual([clean]);
  // No share sheet (desktop): copied instead, with a toast. Same from the menu.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void ((window as unknown as { __copied: string }).__copied = t) },
    });
  });
  await page.getByTestId("menu-button").click();
  await page.getByRole("dialog").getByRole("button", { name: /Send the trip link/ }).click();
  await expect(page.getByText("Link copied")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe(clean);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const players = await livePlayers(page, code);
  expect(players.map((p) => p.name)).toEqual(CREW);
  expect(players.filter((p) => p.is_groom).map((p) => p.name)).toEqual(["Caster"]);
  const caster = players[0].id;
  const joe = players.find((p) => p.name === "Joe")!.id;
  expect(await page.evaluate((c) => localStorage.getItem(`scramble:me:${c}`), code)).toBe(caster);
  await expect(page).toHaveURL(new RegExp(`[?&]me=${caster}`));

  // ---- (b) A player's phone opens the link: "Who are you?" -> Joe -> in, no wizard ----
  const phone = await newPhone(browser);
  try {
    const p2 = await phone.newPage();
    await p2.goto(`/t/${code}`);
    await expect(p2.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
    await expect(p2.getByRole("heading", { name: "Who are you?" })).toBeVisible();
    await expect(p2.getByTestId("join-player")).toHaveCount(10);
    const names = await p2.getByTestId("join-player").allInnerTexts();
    CREW.forEach((n, i) => expect(names[i]).toContain(n));
    // No teams yet: no "Free agents" label over the whole crew.
    await expect(p2.getByText("Free agents")).toHaveCount(0);
    await expectNoHorizontalOverflow(p2);

    await p2.getByTestId("join-player").filter({ hasText: "Joe" }).click();
    // First time on this phone: the 40-second "How it works" plays, personalised, and the
    // "You're in" toast waits for it (it would sit under the explainer otherwise).
    const explainer = p2.getByRole("dialog", { name: "How it works" });
    await expect(explainer).toBeVisible();
    await expect(explainer.getByTestId("explainer-title")).toHaveText("Joe, welcome to Caster's Last Scramble.");
    await expect(p2.getByText("You're in, Joe.")).toHaveCount(0);
    await expectNoHorizontalOverflow(p2);
    await explainer.getByTestId("explainer-skip").click();
    await expect(explainer).toHaveCount(0);
    const shell = p2.getByTestId("trip-shell");
    await expect(shell).toHaveAttribute("data-tab", "play");
    await expect(p2.getByTestId("waiting-for-start")).toBeVisible();
    // No PIN, so the phone says who it is now, with a way out of a mis-tap.
    await expect(p2.getByText("You're in, Joe.")).toBeVisible();
    await expect(p2.getByRole("button", { name: "Not you?" }).first()).toBeVisible();
    await expect(p2.getByTestId("you-are")).toContainText("You're Joe");
    await expect(p2.getByTestId("onboarding")).toHaveCount(0);
    await expect(p2.getByRole("heading", { name: "The field" })).toBeVisible();
    await expect(p2.getByText("Teams drop soon. The commissioner is agonizing.")).toBeVisible();

    // The optional "Get set up" card leads; its Home Screen row opens the install guide.
    const card = p2.getByTestId("get-set-up");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("get-set-up-intro")).toHaveText(/^Two quick things/);
    await expect(card.getByTestId("get-set-up-install")).toHaveAttribute("data-state", "todo");
    await expect(card.getByTestId("get-set-up-notify")).toHaveAttribute("data-state", "todo");
    await expectNoHorizontalOverflow(p2);
    await card.getByTestId("get-set-up-install").click();
    const sheet = p2.getByRole("dialog");
    await expect(sheet.getByTestId("get-set-up-install-sheet")).toBeVisible();
    await sheet.getByRole("button", { name: "Got it" }).click();
    await expect(p2.getByRole("dialog")).toHaveCount(0);

    // The page carries Joe into "Add to Home Screen": manifest link + address bar.
    const href = `/t/${code}/manifest.webmanifest?me=${joe}`;
    await expect(p2.locator('link[rel="manifest"]')).toHaveAttribute("href", href);
    await expect(p2).toHaveURL(new RegExp(`/t/${code}\\?(.+&)?me=${joe}(&|$)`));
    const res = await p2.request.get(href);
    expect(res.ok()).toBe(true);
    const manifest = (await res.json()) as { id: string; start_url: string };
    expect(manifest.id).toBe(`/t/${code}`);
    expect(manifest.start_url).toBe(`/t/${code}?source=homescreen&me=${joe}`);

    // Hide is remembered on this phone, for this trip only.
    await card.getByTestId("get-set-up-hide").click();
    await expect(p2.getByTestId("get-set-up")).toHaveCount(0);
    expect(await p2.evaluate((c) => localStorage.getItem(`scramble:get-set-up-hidden:${c}`), code)).toBe("1");
    await p2.reload();
    await expect(p2.getByTestId("waiting-for-start")).toBeVisible({ timeout: 30_000 });
    await expect(p2.getByTestId("get-set-up")).toHaveCount(0);
    // The explainer played once on this phone for this trip: never again by itself.
    await expect(p2.getByTestId("explainer")).toHaveCount(0);

    // ---- (c) The Home Screen app (own empty storage) starts as Joe: no "Who are you?" ----
    const app = await newHomeScreenApp(browser);
    try {
      const a = await app.newPage();
      await a.goto(manifest.start_url);
      await expect(a.getByTestId("trip-shell")).toHaveAttribute("data-tab", "play", { timeout: 30_000 });
      await expect(a.getByTestId("join-screen")).toHaveCount(0);
      await expect(a.getByTestId("waiting-for-start")).toBeVisible();
      expect(await a.evaluate((c) => localStorage.getItem(`scramble:me:${c}`), code)).toBe(joe);
      await expect(a.getByText("You're in, Joe.")).toBeVisible();
      await expect(a.getByText(/Picked up from Safari/)).toBeVisible();
      // Already on the Home Screen: that row is done (notifications are still to do).
      await expect(a.getByTestId("get-set-up-install")).toHaveAttribute("data-state", "done");
      await expect(a.getByTestId("get-set-up-notify")).toHaveAttribute("data-state", "todo");
    } finally {
      await app.close();
    }

    // Switch player on Joe's phone stops carrying Joe into the Home Screen app.
    await p2.getByTestId("menu-button").click();
    await p2.getByRole("dialog").getByRole("button", { name: /Switch player/ }).click();
    await expect(p2.getByTestId("join-screen")).toBeVisible();
    await expect(p2).not.toHaveURL(/[?&]me=/);
    await expect(p2.locator('link[rel="manifest"]')).toHaveAttribute("href", `/t/${code}/manifest.webmanifest`);

    // The same link opened in a normal browser tab never makes you Joe: it asks, and drops `me`.
    const tab = await newPhone(browser);
    try {
      const t = await tab.newPage();
      await t.goto(manifest.start_url);
      await expect(t.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
      await expect(t).not.toHaveURL(/[?&]me=/);
      await expect(t.locator('link[rel="manifest"]')).toHaveAttribute("href", `/t/${code}/manifest.webmanifest`);
      expect(await t.evaluate((c) => localStorage.getItem(`scramble:me:${c}`), code)).toBeNull();
    } finally {
      await tab.close();
    }

    // Caster's copied address bar (?tab=setup&me=<caster>) opened by an Android phone with an
    // installed app (Android opens in-scope links standalone): it asks, it never becomes Caster,
    // and Android never puts a player in the URL at all.
    const android = await newHomeScreenApp(browser, "Pixel 7");
    try {
      const d = await android.newPage();
      await d.goto(`/t/${code}?tab=setup&me=${caster}`);
      await expect(d.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
      expect(await d.evaluate((c) => localStorage.getItem(`scramble:me:${c}`), code)).toBeNull();
      await expect(d).not.toHaveURL(/[?&]me=/);
      await d.getByTestId("join-player").filter({ hasText: "Greg" }).click();
      await d.getByTestId("explainer-skip").click();
      await expect(d.getByTestId("you-are")).toContainText("You're Greg");
      await expect(d).not.toHaveURL(/[?&]me=/);
      await expect(d.locator('link[rel="manifest"]')).toHaveAttribute("href", `/t/${code}/manifest.webmanifest`);
    } finally {
      await android.close();
    }

    // An iPhone that can't load the trip yet (no signal on a first visit) drops the sender's `me`
    // anyway, so "Add to Home Screen" from the error screen can't save Caster's link.
    const offline = await newPhone(browser);
    try {
      const o = await offline.newPage();
      await o.route("**/api/t/*/state**", (route) => route.abort());
      await o.goto(`/t/${code}?tab=setup&me=${caster}`);
      await expect(o.getByTestId("load-error")).toBeVisible({ timeout: 30_000 });
      await expect(o).not.toHaveURL(/[?&]me=/);
      await expect(o).toHaveURL(new RegExp(`/t/${code}\\?tab=setup$`));
    } finally {
      await offline.close();
    }
  } finally {
    await phone.close();
  }
});

test("a trip created empty: Load the boys, then Add several at once skips who's already there", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 780 });
  const code = await createFromHome(page, "Empty Start Scramble", "");

  // Nobody on the roster and nobody to be: the commissioner stays in Setup, with the one-tap load.
  await expect(page.getByTestId("setup-roster")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("join-screen")).toHaveCount(0);
  await expect(page.getByTestId("roster-row")).toHaveCount(0);
  expect(await page.evaluate((c) => localStorage.getItem(`scramble:me:${c}`), code)).toBeNull();
  const load = page.getByTestId("load-the-boys");
  await expect(load).toBeVisible();
  const crew = load.getByRole("list", { name: "The crew" }).getByRole("listitem");
  await expect(crew).toHaveText(CREW.map((n) => new RegExp(`^(👑 )?${n}( \\(the groom\\))?$`)));
  await expect(crew.first()).toHaveText("👑 Caster (the groom)");
  await expectNoHorizontalOverflow(page);

  await page.getByTestId("load-the-boys-button").click();
  await expect(page.getByTestId("roster-row")).toHaveCount(10);
  await expect(page.getByText("The boys are in")).toBeVisible();
  expect(await page.getByTestId("roster-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-player")))).toEqual(CREW);
  await expect(page.getByRole("button", { name: "Edit Caster, the groom" })).toBeVisible();
  await expect(page.getByTestId("load-the-boys")).toHaveCount(0);
  await expect
    .poll(async () => {
      const players = await livePlayers(page, code);
      return [players.length, players.filter((p) => p.is_groom).map((p) => p.name).join()];
    })
    .toEqual([10, "Caster"]);
  // Like creating the trip with the crew, this phone is now the first name: Caster.
  const caster = (await livePlayers(page, code))[0].id;
  await expect(page.getByText(/This phone is Caster/)).toBeVisible();
  expect(await page.evaluate((c) => localStorage.getItem(`scramble:me:${c}`), code)).toBe(caster);
  await expect(page.getByRole("button", { name: /Pick your name/ })).toHaveCount(0);

  // Add several at once: new names in, duplicates (any case) skipped, one toast with Undo.
  await page.getByTestId("bulk-add-open").click();
  const sheet = page.getByRole("dialog");
  // Everybody from the crew is already here: no "Fill in the crew" shortcut.
  await expect(sheet.getByTestId("bulk-add-crew")).toHaveCount(0);
  await sheet.getByTestId("bulk-add-names").fill("joe\nNewGuy\n");
  await expect(sheet.getByTestId("bulk-add-preview")).toHaveText("Adding NewGuy. Skipping joe (already on it).");
  await expect(sheet.getByTestId("bulk-add-submit")).toHaveText(/Add 1/);
  await expectNoHorizontalOverflow(page);
  await sheet.getByTestId("bulk-add-submit").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("roster-row")).toHaveCount(11);
  await expect(page.getByTestId("roster-row").filter({ hasText: "NewGuy" })).toBeVisible();
  await expect(page.getByText("Added 1")).toBeVisible();
  await expect(page.getByText("11 on the roster. Skipped joe: already on it.")).toBeVisible();
  await expect.poll(async () => (await livePlayers(page, code)).map((p) => p.name)).toEqual([...CREW, "NewGuy"]);

  // Undo takes the whole batch back.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("roster-row")).toHaveCount(10);
  await expect.poll(async () => (await livePlayers(page, code)).length).toBe(10);
  expect(await page.evaluate((c) => localStorage.getItem(`scramble:me:${c}`), code)).toBe(caster);
});

test("whoever first opens the link after Start lands on Play: one Get set up row, under the scorecard", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const roster = [{ name: "Caster", is_groom: true }, "Joe", "Greg", "Rich"];
  const res = await page.request.post("/api/trips", { data: { pin: "2468", name: "Late Tee Time Scramble", roster } });
  expect(res.status(), await res.text()).toBe(201);
  const { code, players } = (await res.json()) as { code: string; players: Array<{ id: string; name: string }> };
  const teams = [randomUUID(), randomUUID()];
  let t = Date.now() - 60_000;
  const op = (o: Record<string, unknown>) => ({ id: randomUUID(), at: new Date(t++).toISOString(), by: null, ...o });
  const sync = await page.request.post(`/api/t/${code}/sync`, {
    data: {
      ops: [
        op({ type: "team.upsert", team: { id: teams[0], name: "Early Birds", sort_order: 0 } }),
        op({ type: "team.upsert", team: { id: teams[1], name: "Late Sleepers", sort_order: 1 } }),
        ...players.map((p, i) => op({ type: "team.assign", player_id: p.id, team_id: teams[i < 2 ? 0 : 1] })),
        op({ type: "trip.start" }),
      ],
    },
  });
  expect(((await sync.json()) as { results: Array<{ status: string }> }).results.every((r) => r.status === "applied")).toBe(true);

  const phone = await newPhone(browser);
  try {
    const p = await phone.newPage();
    await p.setViewportSize({ width: 390, height: 664 });
    await p.goto(`/t/${code}`);
    await expect(p.getByTestId("join-screen")).toBeVisible({ timeout: 30_000 });
    await p.getByTestId("join-player").filter({ hasText: "Greg" }).click();
    // Mid-round too, the first time: the explainer, then "You're in".
    await p.getByTestId("explainer-skip").click();
    await expect(p.getByTestId("trip-shell")).toHaveAttribute("data-tab", "play");
    await expect(p.getByTestId("hole-number")).toBeVisible();
    await expect(p.getByText("You're in, Greg.")).toBeVisible();

    const row = p.getByTestId("get-set-up");
    await expect(row).toHaveAttribute("data-variant", "compact");
    await expect(row.getByTestId("get-set-up-install")).toBeVisible();
    await expect(row.getByTestId("get-set-up-notify")).toHaveCount(0);
    // Under the scorecard, never above it: the chips and the stepper keep the first screen.
    const m = await p.evaluate(() => ({
      row: document.querySelector('[data-testid="get-set-up"]')!.getBoundingClientRect().top,
      stepper: document.querySelector('[data-testid="score-panel"]')!.getBoundingClientRect().bottom,
      bar: document.querySelector('[data-testid="play-action-bar"]')!.getBoundingClientRect().top,
      plus: document.querySelector('[data-testid="score-panel"] button[aria-label="One more stroke"]')!.getBoundingClientRect().bottom,
    }));
    expect(m.row).toBeGreaterThanOrEqual(m.stepper);
    expect(m.plus).toBeLessThanOrEqual(m.bar);
    await expectNoHorizontalOverflow(p);

    await row.getByTestId("get-set-up-install").click();
    await expect(p.getByRole("dialog").getByTestId("get-set-up-install-sheet")).toBeVisible();
    await p.getByRole("dialog").getByRole("button", { name: "Got it" }).click();
    await row.getByTestId("get-set-up-hide").click();
    await expect(p.getByTestId("get-set-up")).toHaveCount(0);
    await p.reload();
    await expect(p.getByTestId("hole-number")).toBeVisible({ timeout: 30_000 });
    await expect(p.getByTestId("get-set-up")).toHaveCount(0);
  } finally {
    await phone.close();
  }
});
