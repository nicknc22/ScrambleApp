// Prefill hole tee/green points from OpenStreetMap for one trip, in the database the environment
// points at (DATABASE_URL, else local PGlite: stop `npm run dev` first).
//   npm run osm-import -- --code <trip code>              fill only missing points
//   npm run osm-import -- --code <trip code> --force      replace every point OSM has
//   npm run osm-import -- --code <trip code> --dry-run    show what would change
//   npm run osm-import -- --code <trip code> --file overpass.json   use a saved Overpass answer
//   npm run osm-import -- --query                         print the Overpass query and exit
// Writes hole.update ops as the commissioner through the normal apply pipeline. "Nothing found"
// is a normal outcome (the course may not be mapped); the Course screen's map always works.
import fs from "node:fs";
import { applyOpsToTrip } from "../src/lib/server/apply";
import { closeDb, getConnection } from "../src/lib/server/db";
import { databaseUrl, pgliteDir } from "../src/lib/server/env";
import { runPostCommit } from "../src/lib/server/hooks";
import { findTripByCode, loadTripState } from "../src/lib/server/repo";
import { normalizeCode } from "../src/lib/server/trips";
import { newId } from "../src/lib/ids";
import { buildOverpassQuery, fetchOverpass, prepareOsmImport, type OsmImportReport } from "../src/lib/osm";

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

const fmt = (p: { lat: number; lng: number } | null) => (p ? `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}` : "—");

function printReport(r: OsmImportReport): void {
  console.log("");
  if (r.holes.length > 0) {
    console.log("hole  tee (source)                        green (source)                      yd   boxes");
    for (const h of r.holes) {
      const tee = `${fmt(h.tee)} (${h.tee_source ?? "none"})`.padEnd(36);
      const green = `${fmt(h.green)} (${h.green_source ?? "none"})`.padEnd(36);
      console.log(`${String(h.hole).padStart(4)}  ${tee}${green}${String(h.length_yd ?? "—").padStart(4)}  ${h.tee_boxes}`);
    }
    console.log("");
  }
  console.log(`found:   ${r.found.hole_lines} hole lines, ${r.found.tees} tee boxes, ${r.found.greens} greens`);
  console.log(`matched: ${r.matched.tees} tee boxes, ${r.matched.greens} greens`);
  console.log(`${r.dry_run ? "would fill" : "filled"}: tees ${r.filled_tees.join(",") || "none"} · greens ${r.filled_greens.join(",") || "none"}`);
  if (r.kept_tees.length + r.kept_greens.length > 0) {
    console.log(`kept (already set; --force replaces): tees ${r.kept_tees.join(",") || "none"} · greens ${r.kept_greens.join(",") || "none"}`);
  }
  console.log(`still missing: tees ${r.missing_tees.join(",") || "none"} · greens ${r.missing_greens.join(",") || "none"}`);
  if (!r.dry_run) console.log(`applied: ${r.applied} hole update${r.applied === 1 ? "" : "s"}`);
  for (const n of r.notes) console.log(`note: ${n}`);
  for (const e of r.errors) console.log(`(endpoint trouble: ${e})`);
  console.log("");
  console.log(r.message);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: npm run osm-import -- --code <trip code> [--force] [--dry-run] [--file overpass.json] [--query]");
    return 0;
  }
  if (args.query) {
    console.log(buildOverpassQuery());
    return 0;
  }
  const code = normalizeCode(args.code);
  if (!code) throw new Error("Pass --code <trip code> (the part after /t/ in the trip link)");
  const force = args.force === "true";
  const dryRun = args["dry-run"] === "true";

  let json: unknown;
  let source: string;
  const errors: string[] = [];
  if (args.file) {
    json = JSON.parse(fs.readFileSync(args.file, "utf8"));
    source = `file:${args.file}`;
  } else {
    console.error("Asking OpenStreetMap (Overpass, up to 60 s per server)…");
    const fetched = await fetchOverpass();
    if (!fetched.ok) {
      for (const e of fetched.errors) console.error(`  ${e}`);
      console.error("Couldn't reach OpenStreetMap. Nothing changed. Try again later, or place the points on the Course screen's map.");
      return 2;
    }
    json = fetched.json;
    source = fetched.endpoint;
    errors.push(...fetched.errors);
  }

  if (!databaseUrl()) console.error(`(using local PGlite at ${pgliteDir()}; stop the dev server first)`);
  const db = await getConnection();
  const found = await findTripByCode(db, code);
  if (!found) throw new Error(`No trip with code ${code}`);
  const state = await loadTripState(db, found.trip.id);
  const prepared = prepareOsmImport(state, json, { force, dryRun, now: new Date().toISOString(), newId, source });
  const report = prepared.report;
  report.errors.push(...errors);

  if (prepared.ops.length > 0) {
    const out = await applyOpsToTrip({ db, trip: found.trip, ops: prepared.ops, isCommissioner: true });
    report.applied = out.results.filter((r) => r.status === "applied").length;
    for (const r of out.results) {
      if (r.status === "rejected") report.notes.push(`A hole update was rejected: ${r.reason ?? r.code ?? "unknown"}`);
    }
    // Phones refresh (Realtime broadcast when configured; they poll otherwise).
    await runPostCommit({
      trip: out.snapshot.state.trip,
      events: out.events,
      ops: out.applied,
      results: out.results,
      state: out.snapshot.state,
      is_commissioner: true,
    });
  }
  console.log(`Trip "${found.trip.name}" (${code}) · source ${source}`);
  printReport(report);
  return 0;
}

main()
  .then(async (exitCode) => {
    await closeDb().catch(() => {});
    process.exit(exitCode);
  })
  .catch(async (e) => {
    console.error(`osm-import failed: ${e instanceof Error ? e.message : String(e)}`);
    await closeDb().catch(() => {});
    process.exit(1);
  });
