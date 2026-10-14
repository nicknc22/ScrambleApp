// The "How it works" explainer: the words (rule claims must match SPEC.md + CLAUDE.md and the
// engine), personalisation, the story player's timing/navigation, when it plays by itself, the
// ?explainer= params, the per-trip "seen" pref, and that every cartoon renders at every moment.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { creditFor } from "@/lib/engine/drinks";
import { makeTrip } from "../fixtures";
import {
  MAX_CAPTION_WORDS_PER_SEC,
  SCENE_MS,
  buildExplainer,
  captionWords,
  drinkValues,
  ghostRule,
  ghostTeamSize,
  type ExplainerInput,
  type SceneId,
} from "@/components/explainer/script";
import {
  HOLD_MS,
  MAX_TICK_MS,
  initPlayer,
  isRunning,
  parseExplainerParams,
  sceneTime,
  segmentFill,
  shouldAutoPlay,
  stepPlayer,
  tapZone,
  withoutExplainerParams,
  type PlayerConfig,
  type PlayerState,
} from "@/components/explainer/model";
import { explainerInput, shortName } from "@/components/explainer/personalize";
import { elbowFor, seg, track } from "@/components/explainer/anim";
import { SceneArt } from "@/components/explainer/scenes";
import { captionEntrance } from "@/components/explainer/Explainer";
import { explainerSeenKey, isExplainerSeen, setExplainerSeen } from "@/lib/client/ui-prefs";

const base: ExplainerInput = {
  playerName: "Joe",
  isGroom: false,
  tripName: "Caster's Last Scramble",
  groomName: "Caster",
  courseName: "Jack Frost National",
  baseTeamSize: 4,
  teamSizes: [4, 3, 3],
  myTeamSize: 4,
  driveNames: ["Caster", "Joe", "Greg", "Rich"],
  teamNames: ["Sand Baggers", "Ghost Riders", "Shank Redemption"],
  teamMembers: [
    ["Caster", "Joe", "Greg", "Rich"],
    ["Reitman", "Drew", "Will"],
    ["Ross", "Conner", "Mark"],
  ],
  myTeamIndex: 0,
  teamMatchAnteCents: 2000,
  contestAnteCents: 500,
  aiJudge: true,
  status: "setup",
};

const scene = (input: ExplainerInput, id: SceneId) => {
  const s = buildExplainer(input).scenes.find((x) => x.id === id);
  if (!s) throw new Error(`no ${id} scene`);
  return s;
};
const text = (input: ExplainerInput, id: SceneId) => {
  const s = scene(input, id);
  return [s.kicker, s.title, ...s.lines].join(" \n");
};

describe("explainer script", () => {
  it("is eight scenes in story order, about 40 seconds", () => {
    const x = buildExplainer(base);
    expect(x.scenes.map((s) => s.id)).toEqual(["cold-open", "scramble", "drinks", "ghost", "mulligans", "contests", "board", "outro"]);
    expect(x.totalMs).toBeGreaterThanOrEqual(38_000);
    expect(x.totalMs).toBeLessThanOrEqual(46_000);
    for (const s of x.scenes) {
      expect(s.durationMs).toBe(SCENE_MS[s.id]);
      expect(s.heroMs).toBeGreaterThan(0);
      expect(s.heroMs).toBeLessThanOrEqual(s.durationMs);
      expect(s.lines.length).toBeGreaterThan(0);
      expect(s.lines.length).toBeLessThanOrEqual(2);
    }
  });

  it("captions can be read before the scene moves on (finding: 331 words in 43 s, about 460 wpm)", () => {
    expect(captionWords("Play the best ball. Holed out? Team score with + / −, then Save.")).toBe(11);
    const viewers: ExplainerInput[] = [
      base,
      { ...base, playerName: "Caster", isGroom: true },
      { ...base, playerName: "Reitman", myTeamSize: 3, myTeamIndex: 1 },
      { ...base, playerName: null, myTeamSize: null, myTeamIndex: null },
      { ...base, aiJudge: false, teamMatchAnteCents: 0, contestAnteCents: 0 },
      { ...base, teamSizes: [3, 3, 2, 2], myTeamSize: 2 },
    ];
    for (const input of viewers) {
      for (const opts of [{}, { recording: true }, { reducedMotion: true }]) {
        const x = buildExplainer(input, opts);
        let words = 0;
        x.scenes.forEach((s, i) => {
          const n = captionWords([s.title, ...s.lines].join(" "));
          words += n;
          // The last scene holds until "Let's go": no clock to beat.
          if (i === x.scenes.length - 1) return;
          expect(n / (s.durationMs / 1000), `${s.id} (${input.playerName}): ${n} words in ${s.durationMs} ms`).toBeLessThanOrEqual(MAX_CAPTION_WORDS_PER_SEC);
        });
        // Less than half the old script (331 words), outro included.
        expect(words).toBeLessThanOrEqual(160);
      }
    }
    expect(MAX_CAPTION_WORDS_PER_SEC).toBeLessThanOrEqual(3.5);
  });

  it("cold open greets the player by name and names the trip", () => {
    expect(scene(base, "cold-open").title).toBe("Joe, welcome to Caster's Last Scramble.");
    // Nobody picked yet (a recording, the commissioner): the boys.
    expect(scene({ ...base, playerName: null }, "cold-open").title).toBe("Boys, welcome to Caster's Last Scramble.");
    // No double full stop.
    expect(scene({ ...base, tripName: "Send It!" }, "cold-open").title).toBe("Joe, welcome to Send It!");
    // The groom gets told he's not exempt.
    expect(text({ ...base, playerName: "Caster", isGroom: true }, "cold-open")).toMatch(/Yes, groom, you too\./);
  });

  it("says how to drive it, leaves out Hold when nothing moves, and leaves it all out of the MP4 (finding: phone-only line in the video)", () => {
    expect(text(base, "cold-open")).toMatch(/Tap right: next\. Left: back\. Hold: pause\./);
    const still = buildExplainer(base, { reducedMotion: true }).scenes[0].lines.join(" ");
    expect(still).not.toMatch(/Hold/);
    expect(still).toMatch(/Tap right: next\. Left: back\./);
    const rec = buildExplainer({ ...base, playerName: null }, { recording: true }).scenes[0];
    expect(rec.lines).toEqual(["Here's how it works. About 40 seconds."]);
    expect(rec.lines.join(" ")).not.toMatch(/Tap|Hold/);
  });

  it("scramble: best ball, the team score with + / − and Save", () => {
    const t = text(base, "scramble");
    expect(t).toMatch(/Play the best ball/);
    expect(t).toMatch(/Team score with \+ \/ −, then Save/);
  });

  it("drinks: a drink is a stroke, logged by your name, nothing before On the tee on hole 1 (SPEC drink windows rule 3)", () => {
    const t = text(base, "drinks");
    expect(t).toMatch(/Every drink knocks a stroke off/);
    expect(t).toMatch(/Tap Drink by your name/);
    expect(t).toMatch(/Nothing counts before On the tee on hole 1/);
    // Backed by the engine: a full team's drinks are worth 1 each.
    expect(drinkValues(4, 4, 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // The cartoon's math agrees with itself and with the engine.
    const { strokes, credit, net } = buildExplainer(base).art.drinkMath;
    expect(strokes - credit).toBe(net);
    expect(credit).toBe(creditFor(1, 4, 4));
  });

  it("ghost beers come from the engine's credit formula", () => {
    expect(drinkValues(3, 4, 6)).toEqual([1, 1, 2, 1, 1, 2]);
    expect(drinkValues(2, 4, 4)).toEqual([2, 2, 2, 2]);
    for (const [n, b] of [
      [3, 4],
      [2, 4],
      [2, 3],
      [4, 3],
    ]) {
      const v = drinkValues(n, b, 12);
      v.forEach((x, i) => expect(x).toBe(creditFor(i + 1, n, b) - creditFor(i, n, b)));
    }
    expect(ghostRule(3, 4)).toBe("every 3rd drink counts double");
    expect(ghostRule(2, 4)).toBe("every drink counts double");
    expect(ghostRule(4, 4)).toBe("every drink counts once");
    expect(ghostRule(2, 3)).toBe("every 2nd drink counts double");
    expect(ghostRule(4, 3)).toBe("drinks count 0, 1, 1, 1, then repeat");
  });

  it("ghost scene: the threesome rule, personal when it's your team, twosomes called out", () => {
    const t = text(base, "ghost");
    expect(t).toMatch(/Threesomes drink for 4: every 3rd drink counts double\./);
    expect(t).toMatch(/Plus: hit a 4th ball every shot\./);
    // The cartoon draws the values (1, 1, 2, 1, 1, 2) from the engine.
    expect(buildExplainer(base).art.ghost).toEqual({ teamSize: 3, base: 4, values: [1, 1, 2, 1, 1, 2] });

    expect(text({ ...base, myTeamSize: 3 }, "ghost")).toMatch(/Your threesome drinks for 4: every 3rd drink counts double/);
    const withPair = text({ ...base, teamSizes: [4, 4, 2], myTeamSize: 2 }, "ghost");
    expect(withPair).toMatch(/Your twosome drinks for 4: every drink counts double/);
    const mixed = text({ ...base, teamSizes: [3, 3, 2, 2] }, "ghost");
    expect(mixed).toMatch(/Threesomes drink for 4/);
    expect(mixed).toMatch(/Twosomes: every drink counts double/);
    // Nobody short-handed yet (teams not picked): still explains the threesome case.
    expect(ghostTeamSize({ baseTeamSize: 4, teamSizes: [], myTeamSize: null })).toBe(3);
    // Base lowered to 3 with a foursome around: says the foursome gets less.
    expect(text({ ...base, baseTeamSize: 3, teamSizes: [4, 3], myTeamSize: 4 }, "ghost")).toMatch(/Foursomes: drinks count 0, 1, 1, 1, then repeat/);
    // Base 2: nobody can be short-handed, so no ghost scene.
    expect(buildExplainer({ ...base, baseTeamSize: 2, teamSizes: [2, 2], myTeamSize: 2 }).scenes.map((s) => s.id)).not.toContain("ghost");
  });

  it("mulligans: a shotgun or shot is a drink AND a mulligan, the Groom's Mulligan, drives once per nine", () => {
    const t = text(base, "mulligans");
    expect(t).toMatch(/Shotgun or shot = drink \+ mulligan/);
    expect(t).toMatch(/Caster 👑 gets one Groom's Mulligan\./);
    expect(t).toMatch(/Tap whose drive you used: everybody needs one per nine\./);
    expect(text({ ...base, playerName: "Caster", isGroom: true }, "mulligans")).toMatch(/You 👑 get one Groom's Mulligan/);
    expect(text({ ...base, groomName: null }, "mulligans")).toMatch(/The groom 👑 gets one/);
  });

  it("contests: par 5 long drive by GPS with a pic, par 3 closest to pin with a photo; the AI judge only when it's on", () => {
    const on = text(base, "contests");
    expect(on).toMatch(/Par 5: at your ball, tap Measure my drive\./);
    expect(on).toMatch(/Par 3: photo, then feet\. AI judges\./);
    const off = text({ ...base, aiJudge: false }, "contests");
    expect(off).not.toMatch(/AI/);
    expect(off).toMatch(/Honor system/);
    expect(buildExplainer({ ...base, aiJudge: false }).art.aiJudge).toBe(false);
  });

  it("board and money: lowest net wins, antes from the trip, who Venmos who (finding: broken no-antes line)", () => {
    const t = text(base, "board");
    expect(t).toMatch(/Lowest net wins/);
    expect(t).toMatch(/Team match: \$20 a man\. Contests: \$5 a hole\. Then it says who Venmos who\./);
    expect(text({ ...base, teamMatchAnteCents: 0, contestAnteCents: 0 }, "board")).toMatch(/Live standings, net of drinks\. Pots and Venmo on the Money tab\./);
    expect(text({ ...base, teamMatchAnteCents: 0, contestAnteCents: 0 }, "board")).not.toMatch(/the pots live/);
    expect(text({ ...base, contestAnteCents: 0 }, "board")).toMatch(/Team match: \$20 a man\. Then it says/);
    expect(text({ ...base, teamMatchAnteCents: 0 }, "board")).toMatch(/Contests: \$5 a hole\. Then it says/);
  });

  it("settle-up: the cartoon's last-place team pays the team that jumps to 1st, the viewer is 'You' (finding: Reitman pays from 1st)", () => {
    // The board draws teams[1] (Ghost Riders) jumping to 1st and teams[2] (Shank Redemption) last.
    expect(buildExplainer(base).art).toMatchObject({ payer: "Ross", payee: "Reitman", amount: "$20" });
    expect(buildExplainer({ ...base, playerName: null, myTeamIndex: null }).art).toMatchObject({ payer: "Ross", payee: "Reitman" });
    // Reitman (Ghost Riders, 1st on the board) gets paid; Mark (Shank Redemption, last) pays.
    expect(buildExplainer({ ...base, playerName: "Reitman", myTeamIndex: 1 }).art).toMatchObject({ payer: "Ross", payee: "You" });
    expect(buildExplainer({ ...base, playerName: "Mark", myTeamIndex: 2 }).art).toMatchObject({ payer: "You", payee: "Reitman" });
    // Never two teammates (the old "Joe → Caster").
    const art = buildExplainer(base).art;
    const teamOf = (n: string) => base.teamMembers!.findIndex((m) => m.includes(n));
    expect(teamOf(art.payer)).not.toBe(teamOf(art.payee));
    // Two teams drawn: the first ends up last.
    expect(buildExplainer({ ...base, teamNames: ["A", "B"], teamMembers: [["Al"], ["Bo"]], myTeamIndex: null }).art).toMatchObject({ payer: "Al", payee: "Bo" });
    // Placeholder teams: two different roster names, never the viewer paying himself.
    const none = buildExplainer({ ...base, teamMembers: [], myTeamIndex: null }).art;
    expect(none.payer).not.toBe(none.payee);
    expect(none.payer).not.toBe("Joe");
  });

  it("outro: the course before the round, where to watch it again", () => {
    expect(text(base, "outro")).toMatch(/first tee at Jack Frost National/);
    expect(text({ ...base, status: "live" }, "outro")).toMatch(/Go hit it/);
    expect(text(base, "outro")).toMatch(/Watch again anytime: ☰ → How it works\./);
  });
});

describe("explainer personalisation from the roster", () => {
  it("reads the viewer, the groom, team sizes and names from the rows", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup", groom: "A1", settings: { team_match_ante_cents: 2000, contest_ante_cents: 500 } });
    const input = explainerInput(f.state, f.player.B2, { aiEnabled: true });
    expect(input).toMatchObject({
      playerName: "Player B2",
      isGroom: false,
      tripName: "Test Trip",
      groomName: "Player A1",
      baseTeamSize: 4,
      teamSizes: [4, 3, 3],
      myTeamSize: 3,
      driveNames: ["Player B1", "Player B2", "Player B3"],
      teamNames: ["Team A", "Team B", "Team C"],
      teamMatchAnteCents: 2000,
      contestAnteCents: 500,
      aiJudge: true,
      status: "setup",
    });
    expect(explainerInput(f.state, f.player.A1, { aiEnabled: false })).toMatchObject({ isGroom: true, playerName: "Player A1", myTeamSize: 4, aiJudge: false });
    // The board's settle-up names come from the teams it draws (finding: teammates paying each other).
    expect(input.teamMembers).toEqual([
      ["Player A1", "Player A2", "Player A3", "Player A4"],
      ["Player B1", "Player B2", "Player B3"],
      ["Player C1", "Player C2", "Player C3"],
    ]);
    expect(input.myTeamIndex).toBe(1);
    expect(buildExplainer(input).art).toMatchObject({ payer: "Player C1", payee: "You" });
  });

  it("works before teams exist and with nobody picked", () => {
    const f = makeTrip({ teams: [3], status: "setup" });
    const rows = { ...f.state, teams: [], team_members: [] };
    const input = explainerInput(rows, null, { aiEnabled: false });
    expect(input.playerName).toBeNull();
    expect(input.myTeamSize).toBeNull();
    expect(input.teamSizes).toEqual([]);
    expect(input.driveNames).toEqual(["Player A1", "Player A2", "Player A3"]);
    expect(input.teamNames.length).toBe(3); // placeholder names for the cartoon
    expect(input.teamMembers).toEqual([]);
    expect(input.myTeamIndex).toBeNull();
    expect(() => buildExplainer(input)).not.toThrow();
    // A deleted player never shows up.
    const gone = { ...rows, players: rows.players.map((p, i) => (i === 0 ? { ...p, deleted_at: p.created_at } : p)) };
    expect(explainerInput(gone, null, { aiEnabled: false }).driveNames).toEqual(["Player A2", "Player A3"]);
  });

  it("uses nicknames and keeps chip names short", () => {
    const f = makeTrip({ teams: [4], status: "setup" });
    const rows = { ...f.state, players: f.state.players.map((p, i) => (i === 1 ? { ...p, nickname: "Joey Bag" } : p)) };
    expect(explainerInput(rows, f.player.A2, { aiEnabled: false }).playerName).toBe("Joey Bag");
    expect(shortName("Reitman")).toBe("Reitman");
    expect(shortName("Christopher")).toBe("Christo…");
  });
});

describe("explainer player (story timing and navigation)", () => {
  const cfg: PlayerConfig = { durations: [1000, 2000, 1500], autoAdvance: true };
  const step = (s: PlayerState, ...actions: Parameters<typeof stepPlayer>[1][]) => actions.reduce((x, a) => stepPlayer(x, a, cfg), s);
  const start = initPlayer(cfg);

  it("starts at the top, or where the link says (clamped)", () => {
    expect(start).toEqual({ index: 0, elapsed: 0, held: false, paused: false, finished: false });
    expect(initPlayer(cfg, { index: 2, at: 700, paused: true })).toMatchObject({ index: 2, elapsed: 700, paused: true });
    expect(initPlayer(cfg, { index: 9, at: 99_999 })).toMatchObject({ index: 2, elapsed: 1500 });
    expect(initPlayer(cfg, { index: -3, at: -5 })).toMatchObject({ index: 0, elapsed: 0 });
  });

  it("auto-advances when a scene's time is up and holds the last frame", () => {
    let s = step(start, { type: "tick", dt: 200 }, { type: "tick", dt: 200 });
    expect(s).toMatchObject({ index: 0, elapsed: 400 });
    s = step(s, { type: "tick", dt: 200 }, { type: "tick", dt: 200 }, { type: "tick", dt: 200 });
    expect(s).toMatchObject({ index: 1, elapsed: 0 });
    for (let i = 0; i < 40; i++) s = step(s, { type: "tick", dt: 200 });
    expect(s).toMatchObject({ index: 2, elapsed: 1500, finished: false });
    expect(step(s, { type: "tick", dt: 200 })).toBe(s); // nothing changes at the end
  });

  it("clamps a huge frame gap (the phone was locked)", () => {
    expect(step(start, { type: "tick", dt: 60_000 }).elapsed).toBe(MAX_TICK_MS);
    expect(step(start, { type: "tick", dt: -5 })).toBe(start);
  });

  it("tap right = next, tap left = back (restarts the first scene), past the end = finished", () => {
    const mid = step(start, { type: "tick", dt: 200 }, { type: "next" });
    expect(mid).toMatchObject({ index: 1, elapsed: 0 });
    expect(step(mid, { type: "back" })).toMatchObject({ index: 0, elapsed: 0 });
    expect(step(start, { type: "tick", dt: 200 }, { type: "back" })).toMatchObject({ index: 0, elapsed: 0 });
    const last = step(start, { type: "next" }, { type: "next" });
    expect(last).toMatchObject({ index: 2, finished: false });
    expect(step(last, { type: "next" })).toMatchObject({ index: 2, finished: true });
    expect(step(start, { type: "goto", index: 2, at: 300 })).toMatchObject({ index: 2, elapsed: 300 });
  });

  it("press and hold pauses; release resumes; the pause button toggles", () => {
    const held = step(start, { type: "hold" });
    expect(held.held).toBe(true);
    expect(isRunning(held, cfg)).toBe(false);
    expect(step(held, { type: "tick", dt: 200 })).toBe(held);
    const released = step(held, { type: "release" });
    expect(isRunning(released, cfg)).toBe(true);
    expect(step(start, { type: "release" })).toBe(start);
    const paused = step(start, { type: "toggle_pause" });
    expect(step(paused, { type: "tick", dt: 200 })).toBe(paused);
    expect(step(paused, { type: "toggle_pause" }).paused).toBe(false);
    // Navigating lets go of a hold.
    expect(step(held, { type: "next" }).held).toBe(false);
    expect(HOLD_MS).toBeGreaterThan(150);
    expect(HOLD_MS).toBeLessThan(400);
  });

  it("reduced motion: nothing moves on its own, the art shows its hero frame, the bar shows where you are", () => {
    const still: PlayerConfig = { ...cfg, autoAdvance: false };
    const s = initPlayer(still);
    expect(isRunning(s, still)).toBe(false);
    expect(stepPlayer(s, { type: "tick", dt: 200 }, still)).toBe(s);
    expect(sceneTime(s, still, 900)).toBe(900);
    expect(sceneTime({ ...s, elapsed: 300 }, cfg, 900)).toBe(300);
    expect(segmentFill(s, still, 0)).toBe(1);
    expect(segmentFill(stepPlayer(s, { type: "next" }, still), still, 0)).toBe(1);
  });

  it("progress segments: done, filling, waiting", () => {
    const s = step(start, { type: "next" }, { type: "tick", dt: 200 }, { type: "tick", dt: 200 }, { type: "tick", dt: 100 });
    expect([0, 1, 2].map((i) => segmentFill(s, cfg, i))).toEqual([1, 0.25, 0]);
  });

  it("left half goes back, right half goes forward", () => {
    expect(tapZone(10, 360)).toBe("back");
    expect(tapZone(179, 360)).toBe("back");
    expect(tapZone(180, 360)).toBe("next");
    expect(tapZone(350, 360)).toBe("next");
  });
});

describe("when the explainer plays by itself", () => {
  it("once per device per trip, never once the round is final", () => {
    expect(shouldAutoPlay({ seen: false, status: "setup" })).toBe(true);
    expect(shouldAutoPlay({ seen: false, status: "live" })).toBe(true);
    expect(shouldAutoPlay({ seen: true, status: "setup" })).toBe(false);
    expect(shouldAutoPlay({ seen: false, status: "final" })).toBe(false);
  });

  describe("seen pref", () => {
    let map: Map<string, string>;
    beforeEach(() => {
      map = new Map();
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (k: string) => map.get(k) ?? null,
          setItem: (k: string, v: string) => void map.set(k, v),
          removeItem: (k: string) => void map.delete(k),
        },
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("is per trip and can be cleared", () => {
      expect(isExplainerSeen("abc123")).toBe(false);
      setExplainerSeen("abc123");
      expect(map.get(explainerSeenKey("abc123"))).toBe("1");
      expect(explainerSeenKey("abc123")).toBe("scramble:explainer-seen:abc123");
      expect(isExplainerSeen("abc123")).toBe(true);
      expect(isExplainerSeen("dryrun99")).toBe(false);
      setExplainerSeen("abc123", false);
      expect(isExplainerSeen("abc123")).toBe(false);
    });

    it("never throws when storage is blocked", () => {
      vi.stubGlobal("window", {
        get localStorage(): Storage {
          throw new Error("SecurityError");
        },
      });
      expect(isExplainerSeen("abc123")).toBe(false);
      expect(() => setExplainerSeen("abc123")).not.toThrow();
    });
  });
});

describe("?explainer= link", () => {
  it("opens with ?explainer=1, optionally at a scene (1-based) and time, paused, or for the recorder", () => {
    const closed = { open: false, scene: null, at: null, paused: false, rec: false };
    expect(parseExplainerParams("")).toEqual(closed);
    expect(parseExplainerParams("?tab=play")).toMatchObject({ open: false });
    expect(parseExplainerParams("?explainer=1")).toEqual({ open: true, scene: null, at: null, paused: false, rec: false });
    expect(parseExplainerParams("?explainer=true&scene=3&at=1200&paused=1")).toEqual({ open: true, scene: 2, at: 1200, paused: true, rec: false });
    expect(parseExplainerParams("?explainer=1&paused=1&rec=1")).toMatchObject({ open: true, paused: true, rec: true });
    expect(parseExplainerParams("?explainer=1&scene=0&at=-4")).toMatchObject({ scene: null, at: null });
    expect(parseExplainerParams("?explainer=1&scene=abc")).toMatchObject({ scene: null });
    // Without explainer=1 the others mean nothing.
    expect(parseExplainerParams("?scene=3&paused=1&rec=1")).toEqual(closed);
  });

  it("strips only its own params", () => {
    expect(withoutExplainerParams("/t/abc?explainer=1&scene=2&at=10&paused=1&rec=1")).toBe("/t/abc");
    expect(withoutExplainerParams("/t/abc?tab=play&explainer=1&me=xyz#top")).toBe("/t/abc?tab=play&me=xyz#top");
    expect(withoutExplainerParams("/t/abc?tab=play")).toBeNull();
    expect(withoutExplainerParams("/t/abc")).toBeNull();
  });
});

describe("explainer cartoons", () => {
  it("every scene renders at every moment (no NaN, no throw), personalised", () => {
    for (const input of [base, { ...base, playerName: null, groomName: null, driveNames: [], aiJudge: false }, { ...base, playerName: "Caster", isGroom: true, myTeamSize: 3 }]) {
      const x = buildExplainer(input);
      for (const s of x.scenes) {
        for (let t = 0; t <= s.durationMs + 500; t += 250) {
          const html = renderToStaticMarkup(createElement(SceneArt, { id: s.id, t, art: x.art }));
          expect(html, `${s.id} at ${t}`).not.toMatch(/NaN|undefined|Infinity/);
          expect(html).toContain('aria-hidden="true"');
        }
      }
    }
  });

  it("the cold open's shotgun ends with the player's name on a sticker", () => {
    const x = buildExplainer(base);
    expect(renderToStaticMarkup(createElement(SceneArt, { id: "cold-open", t: 6000, art: x.art }))).toContain("JOE!");
    expect(renderToStaticMarkup(createElement(SceneArt, { id: "mulligans", t: 6000, art: x.art }))).toContain("CASTER · ONE SHOT");
  });
});

describe("recording the MP4", () => {
  it("the caption's entrance runs on the scene clock, so stepped frames match a live play", () => {
    expect(captionEntrance(0)).toEqual({ opacity: 0, translateY: 10 });
    expect(captionEntrance(130).opacity).toBeGreaterThan(0.5);
    expect(captionEntrance(260)).toEqual({ opacity: 1, translateY: 0 });
    expect(captionEntrance(5000)).toEqual({ opacity: 1, translateY: 0 });
  });
});

describe("explainer animation kit", () => {
  it("the arm solver keeps both bones their length and reaches what it can", () => {
    const sh = { x: 0, y: 0 };
    for (const hand of [
      { x: 20, y: 30 },
      { x: -40, y: -10 },
      { x: 10, y: -55 },
    ]) {
      for (const bend of [1, -1] as const) {
        const { elbow, hand: h } = elbowFor(sh, hand, 31, 31, bend);
        expect(Math.hypot(elbow.x - sh.x, elbow.y - sh.y)).toBeCloseTo(31, 3);
        expect(Math.hypot(h.x - elbow.x, h.y - elbow.y)).toBeCloseTo(31, 3);
        expect(h.x).toBeCloseTo(hand.x, 3);
        expect(h.y).toBeCloseTo(hand.y, 3);
      }
    }
    // Out of reach: stretched straight towards it.
    const far = elbowFor(sh, { x: 0, y: 500 }, 31, 31, 1);
    expect(far.hand.y).toBeCloseTo(62, 2);
  });

  it("seg and track hold before and after their keyframes", () => {
    expect(seg(-5, 0, 100)).toBe(0);
    expect(seg(50, 0, 100)).toBe(0.5);
    expect(seg(500, 0, 100)).toBe(1);
    const keys = [
      { at: 100, x: 0, y: 0 },
      { at: 200, x: 10, y: 20 },
    ];
    expect(track(0, keys)).toEqual({ x: 0, y: 0 });
    expect(track(150, keys, (p) => p)).toEqual({ x: 5, y: 10 });
    expect(track(999, keys)).toEqual({ x: 10, y: 20 });
  });
});
