// Awards tab: gallery photo collection, zip building, recap model, award cards.
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "@/lib/engine";
import { JACK_FROST_HOLES } from "@/lib/course";
import type { FeedEvent } from "@/lib/types";
import { makeTrip, at } from "../fixtures";
import { collectPhotos, photoFileName, slugify, zipFileName } from "@/components/awards/photos";
import { buildPhotoZip, type ZipProgress } from "@/components/awards/download";
import { buildRecapModel, recapDateLabel, sanitizeOgText } from "@/components/awards/recap";
import { AwardCard, ChampionsHero } from "@/components/awards/AwardCards";
import { contentKey, recapUrl } from "@/components/awards/RecapShare";

const P = (kind: string, n: number) => `trips/t1/${kind}/${String(n).padStart(8, "0")}-0000-0000-0000-000000000000.jpg`;

function feedEvent(over: Partial<FeedEvent>): FeedEvent {
  return {
    id: `fe-${Math.random()}`,
    trip_id: "t1",
    type: "post",
    team_id: null,
    player_id: null,
    actor_id: null,
    payload: {},
    photo_path: null,
    text: null,
    dedupe_key: null,
    created_at: at(0),
    updated_at: at(0),
    deleted_at: null,
    ...over,
  };
}

describe("collectPhotos", () => {
  it("takes every photo on an active row, dedupes by path, oldest first", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.drink("A", "A1", 1, "shotgun", { photo: P("drinks", 1), min: 10 });
    f.drink("A", "A2", 1, "drink", { min: 11 }); // no photo
    const gone = f.drink("B", "B1", 2, "shot", { photo: P("drinks", 2), min: 12 });
    f.deleteDrink(gone);
    f.entry({ hole: 3, player_id: f.player.C1, type: "ctp", distance_value: 9, photo_path: P("ctp", 3), created_at: at(5) });
    f.state.feed_events = [
      // A feed event echoing the drink photo: deduped (the drink row wins, it knows the kind).
      feedEvent({ type: "shotgun", photo_path: P("drinks", 1), created_at: at(10), player_id: f.player.A1 }),
      feedEvent({ type: "post", photo_path: P("posts", 4), created_at: at(20), actor_id: f.player.B2 }),
      feedEvent({ type: "post", photo_path: P("posts", 5), created_at: at(1), deleted_at: at(2) }),
      // The deleted drink's photo survives through its active feed event.
      feedEvent({ type: "shot", photo_path: P("drinks", 2), created_at: at(12), payload: { hole: 2 } }),
    ];
    const photos = collectPhotos(f.state);
    expect(photos.map((p) => p.path)).toEqual([P("ctp", 3), P("drinks", 1), P("drinks", 2), P("posts", 4)]);
    expect(photos[0]).toMatchObject({ kind: "ctp", hole: 3, player_id: f.player.C1 });
    expect(photos[1]).toMatchObject({ kind: "shotgun", hole: 1, player_id: f.player.A1 });
    expect(photos[2]).toMatchObject({ kind: "feed", hole: 2 });
    expect(photos[3]).toMatchObject({ kind: "post", hole: null, player_id: f.player.B2 });
  });

  it("names files sortably and safely", () => {
    expect(slugify("Big Nick's Shotgun!")).toBe("big-nicks-shotgun");
    expect(slugify("Café  Ñoño 👑")).toBe("cafe-nono");
    expect(slugify("")).toBe("");
    expect(photoFileName({ path: "x", kind: "shotgun", at: at(0), player_id: null, team_id: null, hole: 4 }, 6, "Big Nick")).toBe(
      "007-hole04-shotgun-big-nick.jpg",
    );
    expect(photoFileName({ path: "x", kind: "post", at: at(0), player_id: null, team_id: null, hole: null }, 0, null)).toBe("001-post.jpg");
    expect(zipFileName("Nick's Last Stand")).toBe("nicks-last-stand-photos.zip");
    expect(zipFileName("👑👑")).toBe("scramble-photos.zip");
  });
});

describe("buildPhotoZip", () => {
  it("zips what it can, retries once, reports failures and progress", async () => {
    const calls = new Map<string, number>();
    const fetchBlob = async (url: string) => {
      calls.set(url, (calls.get(url) ?? 0) + 1);
      if (url === "u/flaky" && calls.get(url) === 1) throw new Error("blip");
      if (url === "u/dead") throw new Error("404");
      return new Blob([new Uint8Array([0xff, 0xd8, 0xff, url.length])], { type: "image/jpeg" });
    };
    const progress: ZipProgress[] = [];
    const res = await buildPhotoZip(
      [
        { url: "u/a", name: "001-a.jpg" },
        { url: "u/flaky", name: "002-flaky.jpg" },
        { url: "u/dead", name: "003-dead.jpg" },
        { url: null, name: "004-pending.jpg" },
        { url: "u/b", name: "005-b.jpg" },
      ],
      { JSZip, fetchBlob, onProgress: (p) => progress.push(p), concurrency: 2 },
    );
    expect(res.added).toBe(3);
    expect(res.failed.sort()).toEqual(["003-dead.jpg", "004-pending.jpg"]);
    expect(calls.get("u/flaky")).toBe(2);
    expect(calls.get("u/dead")).toBe(2);
    expect(progress[progress.length - 1]).toEqual({ done: 5, failed: 2, total: 5 });

    const bytes = await res.zip.generateAsync({ type: "uint8array" });
    const back = await JSZip.loadAsync(bytes);
    expect(Object.keys(back.files).sort()).toEqual(["001-a.jpg", "002-flaky.jpg", "005-b.jpg"]);
    const a = await back.file("001-a.jpg")!.async("uint8array");
    expect([...a]).toEqual([0xff, 0xd8, 0xff, 3]);
  });

  it("handles an empty list", async () => {
    const res = await buildPhotoZip([], { JSZip, fetchBlob: async () => new Blob([]) });
    expect(res).toMatchObject({ added: 0, failed: [] });
  });
});

describe("recap model", () => {
  it("strips emoji / symbols the bundled font can't draw (they'd trigger network fetches)", () => {
    expect(sanitizeOgText("Big Nick 👑")).toBe("Big Nick");
    expect(sanitizeOgText("Grip It & Sip It 🍺🍺")).toBe("Grip It & Sip It");
    expect(sanitizeOgText("Café Ñoño – “quotes” · ok…")).toBe("Café Ñoño – “quotes” · ok…");
    expect(sanitizeOgText("★ Star ★")).toBe("Star");
    expect(sanitizeOgText("line\nbreak\ttab")).toBe("line break tab");
    expect(sanitizeOgText("👨‍👩‍👧")).toBe("");
    expect(sanitizeOgText(null)).toBe("");
    expect(sanitizeOgText("abcdefghij", 5)).toBe("abcd…");
  });

  it("formats the date in the course's time zone", () => {
    expect(recapDateLabel("2026-10-24T23:30:00.000Z")).toBe("SAT, OCT 24, 2026");
    expect(recapDateLabel("2026-10-25T02:00:00.000Z")).toBe("SAT, OCT 24, 2026"); // still Saturday in the Poconos
    expect(recapDateLabel(null)).toBe("");
    expect(recapDateLabel("garbage")).toBe("");
  });

  it("builds standings, champion and award lines from derive()", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "final" });
    f.state.trip.name = "Nick's Last Stand 🍻";
    f.state.teams = f.state.teams.map((t) => (t.id === f.team.B ? { ...t, name: "Grip It & Sip It 🍺" } : t));
    for (const t of ["A", "B", "C"]) {
      for (const h of JACK_FROST_HOLES) {
        f.teeOff(t, h.number);
        f.score(t, h.number, t === "B" ? h.par - 1 : h.par);
      }
      f.complete(t);
    }
    f.drink("A", "A1", 2, "shotgun");
    const model = buildRecapModel(f.state, derive(f.state));
    expect(model.final).toBe(true);
    expect(model.tripName).toBe("Nick's Last Stand");
    expect(model.appName).toBe("Scramble");
    expect(model.courseName).toBe("Jack Frost National");
    expect(model.standings).toHaveLength(3);
    expect(model.standings[0]).toMatchObject({ pos: "1", team: "Grip It & Sip It", toPar: "-18", thru: "F" });
    expect(model.champion).toMatchObject({ team: "Grip It & Sip It", toPar: "-18" });
    expect(model.awards.map((a) => a.title)).not.toContain("Champions");
    expect(model.awards).toHaveLength(10);
    const drinks = model.awards.find((a) => a.title === "Most Drinks")!;
    expect(drinks).toMatchObject({ awarded: true, winners: "Player A1" });
    const sus = model.awards.find((a) => a.title === "Most Suspicious")!;
    expect(sus).toMatchObject({ awarded: false, winners: "Nobody", value: "Boring." });
    // Nothing in the model contains characters outside the bundled font's range.
    expect(JSON.stringify(model)).not.toMatch(/[\u{1F000}-\u{1FFFF}☀-➿]/u);
  });

  it("recap URL + content key", () => {
    expect(recapUrl("abc123", "k1")).toBe("/api/t/abc123/recap?v=k1");
    expect(contentKey([1, "a"])).toBe(contentKey([1, "a"]));
    expect(contentKey([1, "a"])).not.toBe(contentKey([1, "b"]));
  });
});

describe("award cards (server-rendered)", () => {
  it("champions hero + awarded / not awarded cards", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "final" });
    for (const t of ["A", "B", "C"]) {
      f.teeOff(t, 1);
      f.score(t, 1, t === "C" ? 3 : 5);
    }
    f.entry({ hole: 3, player_id: f.player.A2, type: "ctp", distance_value: 4, photo_path: P("ctp", 9) });
    const d = derive(f.state);
    const champs = d.awards.find((a) => a.key === "champions")!;
    const hero = renderToStaticMarkup(<ChampionsHero award={champs} people={d} meId={f.player.C1} />);
    expect(hero).toContain("Team C");
    expect(hero).toContain("Player C1");
    expect(hero).toContain("(you)");
    expect(hero).toContain("Net to par");

    const pin = d.awards.find((a) => a.key === "closest_pin")!;
    const pinHtml = renderToStaticMarkup(<AwardCard award={pin} people={d} meId={null} photoUrl="/api/photos/x.jpg" />);
    expect(pinHtml).toContain("Closest Pin");
    expect(pinHtml).toContain("Player A2");
    expect(pinHtml).toContain('src="/api/photos/x.jpg"');

    const sus = d.awards.find((a) => a.key === "most_suspicious")!;
    const susHtml = renderToStaticMarkup(<AwardCard award={sus} people={d} meId={null} photoUrl={null} />);
    expect(susHtml).toContain("Nobody. Boring.");

    const empty = renderToStaticMarkup(<ChampionsHero award={undefined} people={d} meId={null} />);
    expect(empty).toContain("No champions");
  });
});
