import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scramble",
  description: "One scramble. Drinks for strokes. Ghost beers. Zero dignity.",
  applicationName: "Scramble",
  appleWebApp: {
    capable: true,
    title: "Scramble",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: "#0a7d3e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Pinch zoom stays allowed: squinting golfers need it.
  userScalable: true,
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-paper text-ink antialiased">
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
