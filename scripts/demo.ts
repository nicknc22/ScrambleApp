// Create (or reset) a demo trip in the database the environment points at (DATABASE_URL, else
// local PGlite at PGLITE_DIR), with a simulated round. Prints the link.
//   npm run demo                               new demo, round in progress (teams on 15, 12, 7)
//   npm run demo -- --mode full                all 18 holes played and finalized
//   npm run demo -- --mode setup               roster/teams/pots/course only, round not started
//   npm run demo -- --code demo1234 --mode full   reset that demo trip (or create it with that code)
//   npm run demo -- --seed 7 --base-url https://your-app.vercel.app
// Demo commissioner PIN: 0000. With PGlite, stop `npm run dev` first: an embedded database can only
// be opened by one process at a time.
import { closeDb, getConnection } from "../src/lib/server/db";
import { DEMO_MODES, DEMO_PIN, DemoError, createDemoTrip, isDemoMode, resetDemoTrip, type DemoResult } from "../src/lib/server/demo";
import { databaseUrl, pgliteDir } from "../src/lib/server/env";
import { findTripByCode } from "../src/lib/server/repo";
import { normalizeCode } from "../src/lib/server/trips";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = "true";
  }
  return out;
}

const USAGE = `usage: npm run demo -- [--mode ${DEMO_MODES.join("|")}] [--code <code>] [--seed <n>] [--no-photos] [--base-url https://...]`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const mode = args.mode ?? "partial";
  if (!isDemoMode(mode)) throw new Error(`--mode must be one of: ${DEMO_MODES.join(", ")}`);
  const seed = args.seed === undefined ? undefined : Number(args.seed);
  if (seed !== undefined && !Number.isFinite(seed)) throw new Error("--seed must be a number");
  const photos = args["no-photos"] !== "true";
  if (!databaseUrl()) console.error(`(using local PGlite at ${pgliteDir()}; stop the dev server first)`);

  const db = await getConnection();
  let result: DemoResult;
  if (args.code) {
    const code = normalizeCode(args.code);
    if (!code) throw new Error("--code must be 3-64 letters and digits");
    const existing = await findTripByCode(db, code);
    result = existing
      ? await resetDemoTrip(db, code, { mode, seed, photos })
      : await createDemoTrip(db, { mode, code, seed, photos });
  } else {
    result = await createDemoTrip(db, { mode, seed, photos });
  }

  const base = (args["base-url"] ?? "").replace(/\/+$/, "");
  const s = result.stats;
  console.log(`Demo "${result.trip.name}" (${result.mode}, ${result.trip.status})`);
  console.log(`code: ${result.code}`);
  console.log(`url:  ${base}${result.url}`);
  console.log(`commissioner PIN: ${DEMO_PIN}`);
  console.log(`${s.applied}/${s.ops} ops in ${s.batches} syncs, ${s.photos} photos, ${(s.ms / 1000).toFixed(1)} s`);
  if (s.rejected.length) console.error(`warning: ${s.rejected.length} simulated ops were rejected (see log above)`);
  if (s.photo_failures) console.error(`warning: ${s.photo_failures} photo uploads failed; those rows have no photo`);
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (e) => {
    const msg = e instanceof DemoError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);
    console.error(`demo failed: ${msg}`);
    console.error(USAGE);
    await closeDb().catch(() => {});
    process.exit(1);
  });
