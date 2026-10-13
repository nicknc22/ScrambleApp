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

/**
 * The trip's own web manifest (start_url = this trip), so "Add to Home Screen" from here opens
 * the trip. No database work: the page must render (and be served from the SW cache) offline.
 */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const code = normalize((await params).code);
  return {
    title: "Scramble",
    manifest: `/t/${encodeURIComponent(code)}/manifest.webmanifest`,
  };
}

/** Trip page. No server data fetching: the client store loads from cache/network so it works offline. */
export default async function TripPage({ params }: { params: Params }) {
  const { code } = await params;
  return <TripApp code={normalize(code)} />;
}
