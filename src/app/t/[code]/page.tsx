import type { Metadata } from "next";
import { TripApp } from "@/components/TripApp";

type Params = Promise<{ code: string }>;

function normalize(code: string): string {
  let normalized = code;
  try {
    normalized = decodeURIComponent(code);
  } catch {
    /* keep raw */
  }
  return normalized.trim().toLowerCase();
}

/** Link preview copy (the same for every trip: the page does no database work). */
const SHARE_TITLE = "You're in: the Scramble ⛳";
const SHARE_DESCRIPTION = "Open it, tap your name. Every beer you log knocks a stroke off your team's score.";

/**
 * The trip's own web manifest (start_url = this trip), so "Add to Home Screen" from here opens
 * the trip, plus static link-preview text for the group chat (the preview image with the trip's
 * name is ./opengraph-image.tsx, which Next.js links in automatically). No database work: the
 * page must render (and be served from the SW cache) offline.
 */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const code = normalize((await params).code);
  return {
    title: "Scramble",
    manifest: `/t/${encodeURIComponent(code)}/manifest.webmanifest`,
    openGraph: { title: SHARE_TITLE, description: SHARE_DESCRIPTION, type: "website" },
    twitter: { card: "summary_large_image", title: SHARE_TITLE, description: SHARE_DESCRIPTION },
  };
}

/** Trip page. No server data fetching: the client store loads from cache/network so it works offline. */
export default async function TripPage({ params }: { params: Params }) {
  const { code } = await params;
  return <TripApp code={normalize(code)} />;
}
