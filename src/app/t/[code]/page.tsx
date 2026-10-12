import type { Metadata } from "next";
import { TripApp } from "@/components/TripApp";

export const metadata: Metadata = {
  title: "Scramble",
};

/** Trip page. No server data fetching: the client store loads from cache/network so it works offline. */
export default async function TripPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  let normalized = code;
  try {
    normalized = decodeURIComponent(code);
  } catch {
    /* keep raw */
  }
  normalized = normalized.trim().toLowerCase();
  return <TripApp code={normalized} />;
}
