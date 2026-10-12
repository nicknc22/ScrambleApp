import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["iPhone 13"],
    browserName: "chromium",
    trace: "retain-on-failure",
    permissions: ["geolocation"],
  },
  webServer: {
    // Production build against a throwaway local PGlite database.
    command: `rm -rf .data/e2e && npm run build && PGLITE_DIR=.data/e2e UPLOADS_DIR=.data/e2e-uploads COMMISSIONER_PIN_HASH=$(npx tsx scripts/hash-pin.ts 2468) npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
  },
});
