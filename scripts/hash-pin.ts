// Prints the scrypt hash for a PIN (and nothing else on stdout), for COMMISSIONER_PIN_HASH:
//   npm run hash-pin -- 2468
//   COMMISSIONER_PIN_HASH=$(npx tsx scripts/hash-pin.ts 2468) npm run dev
import { hashPin, isValidPin } from "../src/lib/server/auth";

async function main(): Promise<void> {
  const pin = (process.argv[2] ?? "").trim();
  if (!isValidPin(pin)) {
    process.stderr.write("usage: npm run hash-pin -- <pin>   (4 to 12 digits)\n");
    process.exit(1);
  }
  process.stdout.write(`${await hashPin(pin)}\n`);
}

main().catch((e) => {
  process.stderr.write(`hash-pin failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
