// Server-render the primitives (no DOM needed) and check the pure helpers behind them.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Avatar,
  Badge,
  Button,
  Chip,
  EmptyState,
  OfflineBadge,
  PlayerName,
  SegmentedControl,
  StatTile,
  Stepper,
  TeamPill,
  displayName,
  formatCountdown,
  initials,
  offlineBadgeText,
  teamColor,
  toastDuration,
  TEAM_PALETTE,
  NO_TEAM_COLOR,
  UNDO_MS,
} from "@/components/ui";

const nick = { name: "Nick Caster", nickname: "Big Nick", is_groom: true };
const dave = { name: "Dave Thompson", nickname: null, is_groom: false };

describe("names", () => {
  it("prefers nickname, trims, falls back", () => {
    expect(displayName(nick)).toBe("Big Nick");
    expect(displayName(dave)).toBe("Dave Thompson");
    expect(displayName({ name: "Al", nickname: "   " })).toBe("Al");
    expect(displayName(null)).toBe("Somebody");
  });

  it("PlayerName shows the crown for the groom and (you)", () => {
    const html = renderToStaticMarkup(<PlayerName player={nick} you showRealName />);
    expect(html).toContain("Big Nick");
    expect(html).toContain("👑");
    expect(html).toContain("(Nick Caster)");
    expect(html).toContain("(you)");
    const plain = renderToStaticMarkup(<PlayerName player={dave} />);
    expect(plain).not.toContain("👑");
    expect(plain).not.toContain("(you)");
  });

  it("initials", () => {
    expect(initials("Big Nick")).toBe("BN");
    expect(initials("nick")).toBe("NI");
    expect(initials("  ")).toBe("?");
    expect(initials("Christopher Montgomery Wellington")).toBe("CM");
  });

  it("Avatar colors by team and can hide the crown", () => {
    const html = renderToStaticMarkup(<Avatar player={nick} teamSortOrder={1} />);
    expect(html).toContain("BN");
    expect(html).toContain("👑");
    expect(html.toLowerCase()).toContain(TEAM_PALETTE[1].bg);
    expect(renderToStaticMarkup(<Avatar player={nick} teamSortOrder={1} showCrown={false} />)).not.toContain("👑");
  });
});

describe("team colors", () => {
  it("is deterministic by sort_order and wraps", () => {
    expect(teamColor(0)).toBe(TEAM_PALETTE[0]);
    expect(teamColor(TEAM_PALETTE.length)).toBe(TEAM_PALETTE[0]);
    expect(teamColor(-1)).toBe(TEAM_PALETTE[TEAM_PALETTE.length - 1]);
    expect(teamColor(null)).toBe(NO_TEAM_COLOR);
    expect(teamColor(Number.NaN)).toBe(NO_TEAM_COLOR);
  });

  it("every team color is dark enough for white text (WCAG AA 4.5:1)", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    for (const c of [...TEAM_PALETTE, NO_TEAM_COLOR]) {
      expect((1.05 / (lum(c.bg) + 0.05)) >= 4.5, `${c.name} ${c.bg}`).toBe(true);
    }
  });

  it("TeamPill renders the name, a star for my team, and 'No team'", () => {
    expect(renderToStaticMarkup(<TeamPill team={{ name: "Fore Play", sort_order: 2 }} you />)).toMatch(/★.*Fore Play/);
    expect(renderToStaticMarkup(<TeamPill team={null} />)).toContain("No team");
  });
});

describe("offline badge", () => {
  it("says offline with pending count, syncing, or nothing", () => {
    expect(offlineBadgeText({ pendingCount: 3, online: false })).toEqual({ text: "Offline, 3 changes waiting", tone: "offline" });
    expect(offlineBadgeText({ pendingCount: 1, online: false })?.text).toBe("Offline, 1 change waiting");
    expect(offlineBadgeText({ pendingCount: 0, online: false })?.text).toBe("Offline");
    expect(offlineBadgeText({ pendingCount: 2, online: true })).toEqual({ text: "Syncing 2…", tone: "syncing" });
    expect(offlineBadgeText({ pendingCount: 0, online: true })).toBeNull();
    expect(offlineBadgeText({ pendingCount: Number.NaN, online: true })).toBeNull();
  });

  it("renders nothing when synced", () => {
    expect(renderToStaticMarkup(<OfflineBadge pendingCount={0} online />)).toBe("");
    expect(renderToStaticMarkup(<OfflineBadge pendingCount={4} online={false} />)).toContain("Offline, 4 changes waiting");
  });
});

describe("buttons and controls", () => {
  it("loading disables the button and shows a spinner", () => {
    const html = renderToStaticMarkup(<Button loading>Save</Button>);
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("animate-spin");
    expect(renderToStaticMarkup(<Button variant="hazard" size="xl" full>Go</Button>)).toMatch(/btn-xl.*bg-hazard.*w-full|bg-hazard.*w-full/);
  });

  it("Chip exposes aria-pressed", () => {
    expect(renderToStaticMarkup(<Chip selected>Dave</Chip>)).toContain('aria-pressed="true"');
    expect(renderToStaticMarkup(<Chip>Dave</Chip>)).toContain('aria-pressed="false"');
  });

  it("Stepper labels its buttons and disables at the limits", () => {
    const html = renderToStaticMarkup(<Stepper value={1} onChange={() => {}} min={1} max={20} label="Strokes" />);
    expect(html).toContain('aria-label="Decrease"');
    expect(html).toContain('aria-label="Increase"');
    // the decrement button is disabled at min
    expect(html).toMatch(/aria-label="Decrease" disabled=""/);
  });

  it("SegmentedControl marks the selected tab", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl value="b" onChange={() => {}} options={[{ value: "a", label: "Standings" }, { value: "b", label: "Drinkers", badge: 3 }]} />,
    );
    expect(html).toContain('role="tablist"');
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1);
    expect(html).toContain(">3<");
  });

  it("misc primitives render", () => {
    expect(renderToStaticMarkup(<Badge tone="flag">Live</Badge>)).toContain("Live");
    expect(renderToStaticMarkup(<StatTile label="Net" value="-4" />)).toContain("-4");
    expect(renderToStaticMarkup(<EmptyState title="Quiet">Nothing yet</EmptyState>)).toContain("Nothing yet");
  });
});

describe("timing helpers", () => {
  it("toast durations: undo toasts get 10 s", () => {
    expect(UNDO_MS).toBe(10_000);
    expect(toastDuration({ action: { label: "Undo", onAction: () => {} } })).toBe(10_000);
    expect(toastDuration({ tone: "error" })).toBe(5500);
    expect(toastDuration({ tone: "info" })).toBe(4000);
    expect(toastDuration({ duration: 0 })).toBe(0);
    expect(toastDuration({ duration: -5 })).toBe(0);
  });

  it("formats countdowns", () => {
    expect(formatCountdown(9_000)).toBe("0:09");
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(2 * 3600_000 + 13 * 60_000)).toBe("2h 13m");
    expect(formatCountdown(3 * 86400_000 + 4 * 3600_000)).toBe("3d 4h");
    expect(formatCountdown(-1)).toBe("0:00");
  });
});
