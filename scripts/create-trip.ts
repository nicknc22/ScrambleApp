// Create a trip in the database the environment points at (DATABASE_URL, else local PGlite).
//   npm run create-trip -- --name "Jack Frost Scramble" --app-name "Scramble" --pin 2468
//   (without --pin, the trip uses COMMISSIONER_PIN_HASH, else COMMISSIONER_PIN)
// Prints the join code and the /t/<code> link. With PGlite, stop `npm run dev` first: an embedded
// database can only be opened by one process at a time.
import { hashPin, isValidPin, serverPin } from "../src/lib/server/auth";
import { closeDb, getConnection } from "../src/lib/server/db";
import { databaseUrl, pgliteDir } from "../src/lib/server/env";
import { createTrip, DEFAULT_APP_NAME, DEFAULT_TRIP_NAME } from "../src/lib/server/trips";

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: npm run create-trip -- [--name "Trip name"] [--app-name "App"] [--pin 2468] [--base-url https://...]');
    return;
  }
  let pinHash: string | undefined;
  if (args.pin) {
    if (!isValidPin(args.pin)) throw new Error("--pin must be 4 to 12 digits");
    pinHash = await hashPin(args.pin);
  } else {
    const server = serverPin();
    if (server.kind === "invalid") throw new Error(server.message);
    if (server.kind === "hash") pinHash = server.hash;
    if (server.kind === "plain") pinHash = await hashPin(server.pin);
  }
  if (!pinHash) throw new Error("Pass --pin <digits> or set COMMISSIONER_PIN (or COMMISSIONER_PIN_HASH)");
  if (!databaseUrl()) console.error(`(using local PGlite at ${pgliteDir()}; stop the dev server first)`);

  const db = await getConnection();
  const trip = await createTrip(db, {
    name: args.name ?? DEFAULT_TRIP_NAME,
    app_name: args["app-name"] ?? DEFAULT_APP_NAME,
    pin_hash: pinHash,
  });
  const base = (args["base-url"] ?? "").replace(/\/+$/, "");
  console.log(`Created "${trip.name}"`);
  console.log(`code: ${trip.code}`);
  console.log(`url:  ${base}/t/${trip.code}`);
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(`create-trip failed: ${e instanceof Error ? e.message : String(e)}`);
    await closeDb().catch(() => {});
    process.exit(1);
  });
