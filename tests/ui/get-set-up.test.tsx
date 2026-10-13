// The pre-round "Get set up" card (replaced the blocking first-run wizard): which rows show, when
// the card hides itself, and what it says.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getSetUpIntro, getSetUpNextRow, getSetUpRows, getSetUpTodo, showGetSetUp, type GetSetUpInput } from "@/components/join/getSetUp";
import { COMPACT_INSTALL_SUB, COMPACT_NOTIFY_SUB, GetSetUpCard, NOTIFY_INSTALL_FIRST } from "@/components/join/GetSetUp";

const base: GetSetUpInput = { standalone: false, platform: "ios", pushOnServer: true, pushSupported: true, pushOn: false };
const noop = () => undefined;

describe("getSetUpRows", () => {
  it("iPhone Safari: install to do, notifications blocked until it's on the Home Screen", () => {
    expect(getSetUpRows({ ...base, pushSupported: false, pushOn: null })).toEqual({ install: "todo", notify: "install_first" });
  });

  it("iPhone Home Screen app: install done, notifications to do / done", () => {
    expect(getSetUpRows({ ...base, standalone: true })).toEqual({ install: "done", notify: "todo" });
    expect(getSetUpRows({ ...base, standalone: true, pushOn: true })).toEqual({ install: "done", notify: "done" });
  });

  it("waits for the subscription check before deciding", () => {
    expect(getSetUpRows({ ...base, pushOn: null }).notify).toBe("checking");
  });

  it("no notifications row when push is off for the trip or this phone can't do it at all", () => {
    expect(getSetUpRows({ ...base, pushOnServer: false }).notify).toBeNull();
    // An old iPhone already on the Home Screen without Web Push: nothing to ask.
    expect(getSetUpRows({ ...base, standalone: true, pushSupported: false }).notify).toBeNull();
    // A desktop/other browser without push: "add to Home Screen first" wouldn't help.
    expect(getSetUpRows({ ...base, platform: "other", pushSupported: false }).notify).toBeNull();
    // Android Chrome does push in the browser.
    expect(getSetUpRows({ ...base, platform: "android" })).toEqual({ install: "todo", notify: "todo" });
  });
});

describe("showGetSetUp", () => {
  it("shows while something is left to do, hides once every row is done", () => {
    expect(showGetSetUp({ install: "todo", notify: "install_first" }, false)).toBe(true);
    expect(showGetSetUp({ install: "done", notify: "todo" }, false)).toBe(true);
    expect(showGetSetUp({ install: "todo", notify: null }, false)).toBe(true);
    expect(showGetSetUp({ install: "done", notify: "done" }, false)).toBe(false);
    expect(showGetSetUp({ install: "done", notify: null }, false)).toBe(false);
  });

  it("Hide wins, and nothing flashes while the push check is out", () => {
    expect(showGetSetUp({ install: "todo", notify: "todo" }, true)).toBe(false);
    expect(showGetSetUp({ install: "todo", notify: "checking" }, false)).toBe(false);
  });

  it("counts only what can be done right now (iPhone Safari's blocked row doesn't count)", () => {
    expect(getSetUpTodo({ install: "todo", notify: "install_first" })).toBe(1);
    expect(getSetUpTodo({ install: "todo", notify: "todo" })).toBe(2);
    expect(getSetUpTodo({ install: "done", notify: "todo" })).toBe(1);
    expect(getSetUpTodo({ install: "todo", notify: null })).toBe(1);
    expect(getSetUpTodo({ install: "done", notify: "done" })).toBe(0);
  });

  it("the intro says what's doable now", () => {
    expect(getSetUpIntro({ install: "todo", notify: "todo" })).toMatch(/^Two quick things/);
    expect(getSetUpIntro({ install: "todo", notify: "install_first" })).toBe(
      "One quick thing now. Notifications come after, from the Home Screen app.",
    );
    expect(getSetUpIntro({ install: "done", notify: "todo" })).toMatch(/^One quick thing before the first tee/);
    expect(getSetUpIntro({ install: "todo", notify: null })).toMatch(/^One quick thing before the first tee/);
  });

  it("during the round: the next thing to do, one row", () => {
    expect(getSetUpNextRow({ install: "todo", notify: "install_first" })).toBe("install");
    expect(getSetUpNextRow({ install: "todo", notify: "todo" })).toBe("install");
    expect(getSetUpNextRow({ install: "done", notify: "todo" })).toBe("notify");
    expect(getSetUpNextRow({ install: "done", notify: "done" })).toBeNull();
    expect(getSetUpNextRow({ install: "done", notify: null })).toBeNull();
  });
});

describe("GetSetUpCard", () => {
  const render = (rows: Parameters<typeof GetSetUpCard>[0]["rows"], extra: { note?: string; busy?: boolean; compact?: boolean } = {}) =>
    renderToStaticMarkup(<GetSetUpCard rows={rows} onInstall={noop} onNotify={noop} onHide={noop} {...extra} />);

  it("iPhone Safari: both rows, notifications disabled with the reason", () => {
    const html = render({ install: "todo", notify: "install_first" });
    expect(html).toContain("Get set up");
    // One row is greyed out, so it doesn't say "Two quick things".
    expect(html).not.toContain("Two quick things");
    expect(html).toContain("One quick thing now");
    expect(html).toContain("Put it on your Home Screen");
    expect(html).toContain(NOTIFY_INSTALL_FIRST.replace("'", "&#x27;"));
    expect(html).toMatch(/data-testid="get-set-up-notify" data-state="blocked"[^>]*>|disabled=""[^>]*data-testid="get-set-up-notify"/);
    expect(html).toContain("Hide");
  });

  it("Home Screen app: install shows done, notifications tappable", () => {
    const html = render({ install: "done", notify: "todo" });
    expect(html).toContain("One quick thing");
    expect(html).toMatch(/data-testid="get-set-up-install" data-state="done"/);
    expect(html).toMatch(/data-testid="get-set-up-notify" data-state="todo"/);
    expect(html).toContain("Turn on notifications");
  });

  it("no notifications row when push is off, and shows why enabling failed", () => {
    expect(render({ install: "todo", notify: null })).not.toContain("Turn on notifications");
    expect(render({ install: "done", notify: "todo" }, { note: "Notifications blocked." })).toContain("Notifications blocked.");
  });

  it("compact (Play during the round): just the next row and Hide, no header or intro", () => {
    const install = render({ install: "todo", notify: "install_first" }, { compact: true });
    expect(install).toContain('data-variant="compact"');
    expect(install).toContain("Add to Home Screen");
    expect(install).toContain(COMPACT_INSTALL_SUB);
    expect(install).not.toContain("Turn on notifications");
    expect(install).not.toContain("quick thing");
    expect(install).toContain('data-testid="get-set-up-hide"');
    const notify = render({ install: "done", notify: "todo" }, { compact: true });
    expect(notify).toContain("Turn on notifications");
    expect(notify).toContain(COMPACT_NOTIFY_SUB);
    expect(notify).not.toContain("Add to Home Screen");
    expect(render({ install: "done", notify: "done" }, { compact: true })).toBe("");
  });
});
