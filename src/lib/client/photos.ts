"use client";
// Photo compression and photo-path helpers.
// compressPhoto: 1600px longest side, JPEG q0.7 via browser-image-compression; if that fails
// (e.g. HEIC on a browser that can't decode it in the worker), redraw through a canvas so the
// result is always a JPEG. Last resort: a smaller, lower-quality canvas redraw. An uncompressed
// original is never uploaded (a full-size phone JPEG can top the host's 4.5 MB request limit);
// when nothing can shrink it, compressPhoto throws and the caller logs the action without the
// photo (with a toast).
import imageCompression from "browser-image-compression";
import type { Op } from "../ops";

export const PHOTO_MAX_DIMENSION = 1600;
export const PHOTO_QUALITY = 0.7;
/** Last-resort redraw: smaller and lower quality, still plenty for a feed photo. */
export const PHOTO_FALLBACK_DIMENSION = 1024;
export const PHOTO_FALLBACK_QUALITY = 0.5;
/** Largest photo the client will queue (the server takes 4 MB; Vercel refuses bodies over 4.5 MB). */
export const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
export const PHOTO_KINDS = ["drinks", "ld", "ctp", "posts"] as const;

const PHOTO_PATH_RE = /^trips\/[A-Za-z0-9_-]+\/(drinks|ld|ctp|posts)\/[A-Za-z0-9_-]+\.jpg$/;

/** `trips/<trip_id>/<kind>/<uuid>.jpg` */
export function isPhotoPath(value: unknown): value is string {
  return typeof value === "string" && PHOTO_PATH_RE.test(value);
}

export function photoPath(tripId: string, kind: (typeof PHOTO_KINDS)[number], id: string): string {
  return `trips/${tripId}/${kind}/${id}.jpg`;
}

/** Photo paths an op references (any top-level field holding a photo path). */
export function photoPathsOf(op: Op): string[] {
  const out: string[] = [];
  for (const value of Object.values(op as unknown as Record<string, unknown>)) {
    if (isPhotoPath(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoError";
  }
}

export interface CompressDeps {
  /** browser-image-compression (injectable for tests). */
  compressLib?: (file: File, options: Parameters<typeof imageCompression>[1]) => Promise<Blob>;
  /** Canvas redraw fallback (injectable for tests). */
  redraw?: (file: Blob, opts?: RedrawOptions) => Promise<Blob>;
  /** Max time for the web-worker attempt before falling back to the main thread. */
  workerTimeoutMs?: number;
}

function asFile(blob: Blob): File {
  if (typeof File !== "undefined" && blob instanceof File) return blob;
  if (typeof File !== "undefined") {
    return new File([blob], "photo", { type: blob.type || "image/jpeg", lastModified: Date.now() });
  }
  return blob as File;
}

function isJpeg(blob: Blob | null | undefined): blob is Blob {
  return !!blob && blob.size > 0 && /^image\/jpe?g$/i.test(blob.type);
}

/** A JPEG small enough to upload. */
function usable(blob: Blob | null | undefined): blob is Blob {
  return isJpeg(blob) && blob.size <= PHOTO_MAX_BYTES;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.();
      reject(new PhotoError("Photo compression timed out"));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Compress a camera photo to a ≤1600px JPEG (quality 0.7). Always resolves to an image/jpeg Blob
 * of at most PHOTO_MAX_BYTES, or throws PhotoError when nothing could shrink it (never hands back
 * the uncompressed original).
 */
export async function compressPhoto(file: Blob, deps: CompressDeps = {}): Promise<Blob> {
  if (!file || file.size === 0) throw new PhotoError("That photo is empty");
  const lib = deps.compressLib ?? ((f, o) => imageCompression(f, o));
  const redraw = deps.redraw ?? redrawToJpeg;
  const options = {
    maxWidthOrHeight: PHOTO_MAX_DIMENSION,
    initialQuality: PHOTO_QUALITY,
    fileType: "image/jpeg",
  };

  // 1) Web worker (the library falls back to the main thread itself when the worker can't load
  //    its script offline; the timeout guards against a worker stuck on a dead network).
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const out = await withTimeout(
      lib(asFile(file), { ...options, useWebWorker: true, signal: ctrl?.signal }),
      deps.workerTimeoutMs ?? 20_000,
      () => ctrl?.abort(),
    );
    if (usable(out)) return out;
  } catch {
    /* fall through */
  }
  // 2) Main thread.
  try {
    const out = await withTimeout(lib(asFile(file), { ...options, useWebWorker: false }), 30_000);
    if (usable(out)) return out;
  } catch {
    /* fall through */
  }
  // 3) Canvas redraw (HEIC -> JPEG where the browser can decode it).
  try {
    const out = await redraw(file);
    if (usable(out)) return out;
  } catch {
    /* fall through */
  }
  // 4) Smaller and rougher, but it uploads.
  try {
    const out = await redraw(file, { maxDimension: PHOTO_FALLBACK_DIMENSION, quality: PHOTO_FALLBACK_QUALITY });
    if (usable(out)) return out;
  } catch {
    /* fall through */
  }
  throw new PhotoError("Couldn't shrink that photo. Try again or pick a different one.");
}

function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall back to <img> */
    }
  }
  if (typeof document === "undefined" || typeof Image === "undefined") throw new PhotoError("No image decoder");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new PhotoError("Image failed to decode"));
      img.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

export interface RedrawOptions {
  maxDimension?: number;
  quality?: number;
}

/** Redraw any decodable image through a canvas into a JPEG (default ≤1600px, quality 0.7). */
export async function redrawToJpeg(file: Blob, opts: RedrawOptions = {}): Promise<Blob> {
  const quality = opts.quality ?? PHOTO_QUALITY;
  const img = await decode(file);
  try {
    const { w, h } = fitWithin(img.width, img.height, opts.maxDimension ?? PHOTO_MAX_DIMENSION);
    if (typeof OffscreenCanvas !== "undefined") {
      try {
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img.source, 0, 0, w, h);
          return await canvas.convertToBlob({ type: "image/jpeg", quality });
        }
      } catch {
        /* fall back to a DOM canvas */
      }
    }
    if (typeof document === "undefined") throw new PhotoError("No canvas available");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoError("No 2d context");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img.source, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new PhotoError("Canvas export failed"))), "image/jpeg", quality),
    );
  } finally {
    img.close();
  }
}
