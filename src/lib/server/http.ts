// Shared helpers for Route Handlers (src/app/api/**/route.ts).
// Error bodies are always JSON `{ error: "<human (funny) message>", code?: "<machine code>" }`;
// the client reads `error` / `reason` / `message`.
import type { Trip } from "@/lib/types";
import { getDb, type Db } from "./db";
import { findTripByCode } from "./repo";
import { normalizeCode } from "./trips";

export const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, max-age=0",
};

/** JSON response; no-store unless the caller sets its own Cache-Control. */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorJson(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, { status });
}

export function notFound(message = "No trip with that code. Double-check the link from the group chat."): Response {
  return errorJson(404, message, { code: "not_found" });
}

export function badRequest(message: string, code = "invalid"): Response {
  return errorJson(400, message, { code });
}

export function serverError(message = "The server shanked it. Try again in a sec."): Response {
  return errorJson(500, message, { code: "server_error" });
}

export interface TripContext {
  db: Db;
  trip: Trip;
  /** commissioner_pin_hash: server-side only, never send it anywhere. */
  pinHash: string;
  code: string;
}

/** Look up the trip for a route's [code] param, or a 404 Response. */
export async function loadTripOr404(rawCode: string | undefined, db: Db = getDb()): Promise<TripContext | Response> {
  const code = normalizeCode(rawCode);
  if (!code) return notFound();
  const found = await findTripByCode(db, code);
  if (!found) return notFound();
  return { db, trip: found.trip, pinHash: found.pin_hash, code };
}

/**
 * Parse a JSON object body (≤ maxBytes). Returns the object or a 400/413 Response.
 * An empty body parses as {}.
 */
export async function readJsonObject(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return errorJson(413, "That's way too much text.", { code: "too_large" });
  let text: string;
  try {
    const bytes = await readBody(request, maxBytes);
    if (bytes === null) return errorJson(413, "That's way too much text.", { code: "too_large" });
    text = new TextDecoder().decode(bytes);
  } catch {
    return badRequest("Couldn't read the request.");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return badRequest("That wasn't JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return badRequest("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

/** Read the whole body, giving up (null) once it exceeds maxBytes. */
export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Wrap a handler so an unexpected throw becomes a logged JSON 500 instead of an HTML error page. */
export function withErrors<A extends unknown[]>(handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (e) {
      console.error("API error:", e);
      return serverError();
    }
  };
}
