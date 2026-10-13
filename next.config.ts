import type { NextConfig } from "next";

/**
 * Baseline security headers on every response. No CSP on purpose: the app needs inline styles,
 * Supabase (https + wss) and blob:/data: photo previews, and a wrong CSP breaks the round.
 * Camera and geolocation stay allowed for the app itself (photos, long-drive GPS).
 */
export const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), geolocation=(self), microphone=(), payment=(), usb=()" },
] as const;

const nextConfig: NextConfig = {
  // The trip app is a client-rendered SPA under /t/[code]; server work is Route Handlers.
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "web-push"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...SECURITY_HEADERS],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
