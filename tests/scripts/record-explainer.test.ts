// scripts/record-explainer.mjs: the MP4 is stepped frame by frame on the explainer's own clock
// (finding: the real-time capture lagged ~5 s and the delivered MP4 stopped mid-board, without
// the outro). The timeline maths must reach the outro's last frame and keep every sound effect
// inside its scene.
import { describe, expect, it } from "vitest";
import { SCENE_MS, buildExplainer } from "@/components/explainer/script";
import { SCENE_SFX, frameAt, sfxEvents } from "../../scripts/record-explainer.mjs";

type Scene = { id: string; durationMs: number };
const input = {
  playerName: null,
  isGroom: false,
  tripName: "Caster's Last Scramble",
  groomName: "Caster",
  courseName: "Jack Frost National",
  baseTeamSize: 4,
  teamSizes: [4, 3, 3],
  myTeamSize: null,
  driveNames: ["Caster", "Joe", "Greg", "Rich"],
  teamNames: ["Sand Baggers", "Ghost Riders", "Shank Redemption"],
  teamMatchAnteCents: 2000,
  contestAnteCents: 500,
  aiJudge: false,
  status: "setup" as const,
};
const scenes: Scene[] = buildExplainer(input, { recording: true }).scenes.map((s) => ({ id: s.id, durationMs: s.durationMs }));
const total = scenes.reduce((s, x) => s + x.durationMs, 0);

describe("record-explainer timeline", () => {
  it("every scene gets its frames, in order, and the video ends on the outro's last frame", () => {
    const fps = 30;
    const frames = Math.ceil(((total + 3000) / 1000) * fps);
    const seen: string[] = [];
    let prev = { index: 0, at: -1 };
    for (let k = 0; k < frames; k++) {
      const f = frameAt(scenes, (k * 1000) / fps) as { index: number; at: number };
      expect(f.index >= prev.index).toBe(true);
      if (f.index === prev.index) expect(f.at >= prev.at).toBe(true);
      if (seen[seen.length - 1] !== scenes[f.index].id) seen.push(scenes[f.index].id);
      prev = f;
    }
    expect(seen).toEqual(scenes.map((s) => s.id));
    // The tail holds the outro, finished ("That's it. Tee it up." and FORE! are in).
    expect(prev).toEqual({ index: scenes.length - 1, at: SCENE_MS.outro });
    expect(frameAt(scenes, total - SCENE_MS.outro)).toEqual({ index: scenes.length - 1, at: 0 });
    expect(frameAt(scenes, SCENE_MS["cold-open"] + 100)).toEqual({ index: 1, at: 100 });
  });

  it("sound effects sit on the same timeline as the frames, inside their own scene", () => {
    expect(Object.keys(SCENE_SFX).sort()).toEqual([...Object.keys(SCENE_MS)].sort());
    const events = sfxEvents(scenes) as Array<[string, number]>;
    let start = 0;
    const starts = new Map<string, number>();
    for (const s of scenes) {
      starts.set(s.id, start / 1000);
      start += s.durationMs;
    }
    for (const [kind, t] of events) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(total / 1000);
      expect(typeof kind).toBe("string");
    }
    // The outro's whack lands 1.0 s into the outro.
    expect(events).toContainEqual(["whack", starts.get("outro")! + 1.0]);
    // A whoosh leads into every scene after the first.
    expect(events.filter(([k]) => k === "whoosh").length).toBeGreaterThanOrEqual(scenes.length - 1);
  });
});
