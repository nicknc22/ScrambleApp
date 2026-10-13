// GET /api/cron/keepalive: one cheap read a day (Vercel cron, see vercel.json) so a free Supabase
// project doesn't pause for inactivity between setup and the round (Supabase: "a few user requests
// to the database each day is typically enough"). Public and harmless: it reads, never writes.
import { getDb } from "@/lib/server/db";
import { json, withErrors } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrors(async () => {
  await getDb().query("select count(*) from trips");
  return json({ ok: true });
});
