import { describe, expect, it, vi } from "vitest";
import {
  compressPhoto,
  isPhotoPath,
  PHOTO_COMPRESS_TIMEOUT_MS,
  PHOTO_MAX_BYTES,
  PhotoError,
  photoPath,
  photoPathsOf,
  type RedrawOptions,
} from "@/lib/client/photos";
import type { Op } from "@/lib/ops";

const jpeg = (s = "jpeg") => new Blob([s], { type: "image/jpeg" });
const heic = () => new Blob(["heic"], { type: "image/heic" });

describe("photo paths", () => {
  it("recognizes trips/<trip_id>/<kind>/<uuid>.jpg", () => {
    expect(isPhotoPath("trips/0b6f3a52-1c1e-4c51-9f4f-2a3b4c5d6e7f/drinks/9a8b7c6d-1111-2222-3333-444455556666.jpg")).toBe(true);
    expect(isPhotoPath(photoPath("t1", "ctp", "abc"))).toBe(true);
    for (const bad of [null, 3, "", "trips/t/other/x.jpg", "trips/t/drinks/x.png", "../trips/t/drinks/x.jpg", "trips/t/drinks/../x.jpg", "https://x/trips/t/drinks/x.jpg"]) {
      expect(isPhotoPath(bad)).toBe(false);
    }
  });

  it("finds the photo paths an op references", () => {
    const base = { id: "o", at: "2026-10-24T17:00:00.000Z", by: null };
    const p = photoPath("t1", "drinks", "u1");
    expect(photoPathsOf({ ...base, type: "drink.log", drink_id: "d", team_id: "t", player_id: "p", hole: 1, drink_type: "drink", photo_path: p } as Op)).toEqual([p]);
    expect(photoPathsOf({ ...base, type: "post.create", event_id: "e", text: "hi", photo_path: null } as Op)).toEqual([]);
    expect(photoPathsOf({ ...base, type: "score.set", team_id: "t", hole: 1, strokes: 4 } as Op)).toEqual([]);
  });
});

describe("compressPhoto", () => {
  it("uses browser-image-compression with the spec'd options, on the main thread (its web worker loads the library from a CDN)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const out = await compressPhoto(jpeg("big"), {
      compressLib: async (_f, o) => {
        calls.push(o as Record<string, unknown>);
        return jpeg("small");
      },
    });
    expect(await out.text()).toBe("small");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ maxWidthOrHeight: 1600, initialQuality: 0.7, fileType: "image/jpeg", useWebWorker: false });
    // No third-party script at runtime: no worker, no libURL pointing anywhere.
    expect(calls[0].libURL).toBeUndefined();
  });

  it("falls back to a canvas redraw (HEIC -> JPEG) when the library can't decode it", async () => {
    const modes: unknown[] = [];
    let redraws = 0;
    const out = await compressPhoto(heic(), {
      compressLib: async (_f, o) => {
        modes.push(o?.useWebWorker);
        throw new Error("cannot decode");
      },
      redraw: async () => {
        redraws++;
        return jpeg("redrawn");
      },
    });
    expect(modes).toEqual([false]);
    expect(redraws).toBe(1);
    expect(out.type).toBe("image/jpeg");
    expect(await out.text()).toBe("redrawn");
  });

  it("a library call that hangs is aborted after ~6 s and the canvas takes over (a stalled connection can't hold up a log)", async () => {
    expect(PHOTO_COMPRESS_TIMEOUT_MS).toBeLessThanOrEqual(6_000);
    vi.useFakeTimers();
    try {
      let aborted = false;
      let settled = false;
      const p = compressPhoto(jpeg(), {
        compressLib: (_f, o) => new Promise((_, reject) => o?.signal?.addEventListener("abort", () => ((aborted = true), reject(new Error("aborted"))))),
        redraw: async () => jpeg("canvas"),
      }).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(PHOTO_COMPRESS_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted).toBe(true);
      expect(await (await p).text()).toBe("canvas");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never returns a non-JPEG from the library", async () => {
    const out = await compressPhoto(heic(), {
      compressLib: async () => new Blob(["png"], { type: "image/png" }),
      redraw: async () => jpeg("canvas"),
    });
    expect(await out.text()).toBe("canvas");
  });

  it("last resort: a smaller, lower-quality canvas redraw; never the uncompressed original (deploy: 4.5 MB body limit)", async () => {
    const fail = async () => {
      throw new Error("nope");
    };
    const original = jpeg("original");
    const calls: Array<RedrawOptions | undefined> = [];
    const out = await compressPhoto(original, {
      compressLib: fail,
      redraw: async (_f, o) => {
        calls.push(o);
        if (!o) throw new Error("full-size redraw failed");
        return jpeg("small");
      },
    });
    expect(out).not.toBe(original);
    expect(await out.text()).toBe("small");
    expect(calls).toEqual([undefined, { maxDimension: 1024, quality: 0.5 }]);

    // Every compressor fails: a PhotoError (the caller logs the action without the photo), even
    // for a JPEG that could have been shipped as-is.
    await expect(compressPhoto(original, { compressLib: fail, redraw: fail })).rejects.toBeInstanceOf(PhotoError);
    await expect(compressPhoto(heic(), { compressLib: fail, redraw: fail })).rejects.toBeInstanceOf(PhotoError);
    await expect(compressPhoto(new Blob([], { type: "image/jpeg" }))).rejects.toBeInstanceOf(PhotoError);
  });

  it("a result too big to upload counts as a failure and falls through to a smaller redraw", async () => {
    const huge = new Blob([new Uint8Array(PHOTO_MAX_BYTES + 1)], { type: "image/jpeg" });
    const out = await compressPhoto(jpeg("big"), {
      compressLib: async () => huge,
      redraw: async (_f, o) => (o ? jpeg("fallback") : huge),
    });
    expect(await out.text()).toBe("fallback");
    await expect(compressPhoto(jpeg("big"), { compressLib: async () => huge, redraw: async () => huge })).rejects.toBeInstanceOf(PhotoError);
  });
});
