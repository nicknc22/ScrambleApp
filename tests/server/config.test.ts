// Deploy hardening: baseline security headers, no X-Powered-By, no dev-only pages in production.
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import DevLayout from "@/app/dev/layout";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("next.config", () => {
  it("sends baseline security headers on every path (no CSP) and hides X-Powered-By", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all, "a catch-all header rule").toBeTruthy();
    const headers = Object.fromEntries(all!.headers.map((h) => [h.key, h.value]));
    expect(headers).toMatchObject({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    // The app itself needs the camera (photos) and GPS (long drive, closest-to-pin plot).
    expect(headers["Permissions-Policy"]).toMatch(/camera=\(self\)/);
    expect(headers["Permissions-Policy"]).toMatch(/geolocation=\(self\)/);
    expect(Object.keys(headers).some((k) => /content-security-policy/i.test(k))).toBe(false);
    // The service worker rule is still there.
    expect(rules.find((r) => r.source === "/sw.js")?.headers).toEqual(
      expect.arrayContaining([{ key: "Service-Worker-Allowed", value: "/" }]),
    );
  });
});

describe("/dev/* pages", () => {
  it("are a 404 on a Vercel production build, and render locally (dev, and the e2e `next start`)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    expect(() => DevLayout({ children: "gallery" })).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    vi.stubEnv("VERCEL", "");
    expect(DevLayout({ children: "gallery" })).toBe("gallery");
    vi.stubEnv("NODE_ENV", "development");
    expect(DevLayout({ children: "gallery" })).toBe("gallery");
  });
});
