"use client";
// Photo downloads: fetch -> blob -> a[download], and the download-all zip (jszip) with progress
// and per-file failure handling. The zip builder takes its dependencies so tests can drive it.
import type JSZip from "jszip";

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; blob(): Promise<Blob> }>;

/** GET a URL as a Blob with a timeout. Throws on HTTP errors, timeouts and empty bodies. */
export async function fetchBlob(url: string, opts: { timeoutMs?: number; fetch?: FetchLike } = {}): Promise<Blob> {
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, { ...init, cache: "no-cache" }));
  const ctrl = typeof AbortController === "undefined" ? null : new AbortController();
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000) : null;
  try {
    const res = await doFetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob || blob.size === 0) throw new Error("empty file");
    return blob;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Save a blob as a file via a temporary <a download>. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // iOS needs the URL alive for a moment after the click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface ZipItem {
  /** URL to fetch (null = not available, counts as a failure). */
  url: string | null;
  /** File name inside the zip. */
  name: string;
}

export interface ZipProgress {
  done: number;
  failed: number;
  total: number;
}

export interface ZipResult {
  zip: JSZip;
  added: number;
  /** Names of the files that couldn't be fetched (after one retry). */
  failed: string[];
}

/**
 * Fetch every item (a few at a time, one retry each) into a new zip. Never throws for a single
 * bad file: it lands in `failed` and the rest carry on.
 */
export async function buildPhotoZip(
  items: readonly ZipItem[],
  deps: {
    JSZip: new () => JSZip;
    fetchBlob?: (url: string) => Promise<Blob>;
    onProgress?: (p: ZipProgress) => void;
    concurrency?: number;
  },
): Promise<ZipResult> {
  const zip = new deps.JSZip();
  const get = deps.fetchBlob ?? ((url: string) => fetchBlob(url));
  const failed: string[] = [];
  let added = 0;
  let next = 0;
  const report = () => deps.onProgress?.({ done: added + failed.length, failed: failed.length, total: items.length });

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      let blob: Blob | null = null;
      if (item.url) {
        for (let attempt = 0; attempt < 2 && !blob; attempt++) {
          try {
            blob = await get(item.url);
          } catch {
            blob = null;
          }
        }
      }
      let data: ArrayBuffer | Blob | null = null;
      if (blob) {
        try {
          data = typeof blob.arrayBuffer === "function" ? await blob.arrayBuffer() : blob;
        } catch {
          data = null;
        }
      }
      if (data) {
        // JPEGs don't compress: store them as-is (fast on phones).
        zip.file(item.name, data, { binary: true, compression: "STORE" });
        added++;
      } else {
        failed.push(item.name);
      }
      report();
    }
  };

  report();
  const n = Math.max(1, Math.min(deps.concurrency ?? 4, items.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return { zip, added, failed };
}
