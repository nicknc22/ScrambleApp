// GET /t/<code>/manifest.webmanifest — the trip page's web app manifest. Its start_url is the
// trip itself, so a Home Screen icon added from /t/<code> opens the trip. (iOS launches the
// manifest's start_url, and a Home Screen app gets storage separate from Safari's, so the
// remembered-trip redirect on "/" can't help there.) The name is the trip's app_name, read with
// a short timeout: on a slow or broken database the manifest still answers, named "Scramble".
//
// ?me=<player id> (a uuid; anything else is ignored): on iPhone/iPad the trip page links the
// manifest this way once the phone knows who it is, so the Home Screen app's start_url carries the
// player and its first launch skips "Who are you?" (see adoptMeFromLaunch, iOS only). `id` stays
// /t/<code> either way, so it's the same app no matter who installed it.
import manifest from "@/app/manifest";
import { getDb } from "@/lib/server/db";
import { findTripByCode, isUuid } from "@/lib/server/repo";
import { DEFAULT_APP_NAME, normalizeCode } from "@/lib/server/trips";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_NAME_TIMEOUT_MS = 1500;

async function appNameFor(code: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), APP_NAME_TIMEOUT_MS);
  });
  try {
    const found = await Promise.race([findTripByCode(getDb(), code), timeout]);
    return found?.trip.app_name?.trim() || DEFAULT_APP_NAME;
  } catch {
    return DEFAULT_APP_NAME;
  } finally {
    clearTimeout(timer);
  }
}

/** The ?me= player id, when it's exactly one well-formed uuid. */
function meParam(request: Request): string | null {
  try {
    const all = new URL(request.url).searchParams.getAll("me");
    return all.length === 1 && isUuid(all[0]) ? all[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  const code = normalizeCode((await ctx.params).code);
  if (!code) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const me = meParam(request);
  const name = await appNameFor(code);
  const body = {
    ...manifest(),
    id: `/t/${code}`,
    name,
    short_name: name,
    start_url: `/t/${code}?source=homescreen${me ? `&me=${me}` : ""}`,
    scope: "/",
  };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
