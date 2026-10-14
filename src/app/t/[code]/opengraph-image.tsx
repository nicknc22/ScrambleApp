import { ImageResponse } from "next/og";
import { JACK_FROST_NAME } from "@/lib/course";
import { getDb } from "@/lib/server/db";
import { findTripByCode } from "@/lib/server/repo";
import { normalizeCode } from "@/lib/server/trips";
import { scrambleMarkSvg } from "@/app/icon";

// The link preview for /t/<code> (iMessage, WhatsApp, Slack...): the flag mark on fairway green,
// the trip name, the course and what to do. The name is read with a short timeout (like the trip
// manifest's app name): on a slow or broken database, or an unknown code, the preview still
// answers with "The Scramble". No emoji anywhere: ImageResponse would fetch emoji art from a CDN
// at request time. Rendered per request (force-dynamic) so a rename shows up and a fallback drawn
// while the database was slow is never cached as the trip's preview.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const alt = "The Scramble: open the link, tap your name, every beer you log is a stroke off your team's score.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export const OG_FALLBACK = { name: "The Scramble", course: JACK_FROST_NAME } as const;
const LOOKUP_TIMEOUT_MS = 1500;
const MAX_NAME = 48;

const GREEN = "#0a7d3e";
const GREEN_DARK = "#064d27";
const HAZARD = "#ffd400";
const INK = "#0b0f0c";
const WHITE = "#ffffff";

export interface OgText {
  name: string;
  course: string;
}

function clip(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Trip name and course for the preview. `lookup` (tests) defaults to the trip table; anything
 * that fails, times out or finds nothing gives the fallback.
 */
export async function ogText(
  rawCode: string,
  lookup: (code: string) => Promise<{ name: string; course: string } | null> = async (code) => {
    const found = await findTripByCode(getDb(), code);
    return found ? { name: found.trip.name, course: found.trip.settings?.course_name ?? "" } : null;
  },
  timeoutMs = LOOKUP_TIMEOUT_MS,
): Promise<OgText> {
  const code = normalizeCode(rawCode);
  if (!code) return { ...OG_FALLBACK };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const found = await Promise.race([lookup(code), timeout]);
    return {
      name: clip(found?.name?.trim() || OG_FALLBACK.name, MAX_NAME),
      course: clip(found?.course?.trim() || OG_FALLBACK.course, 40),
    };
  } catch {
    return { ...OG_FALLBACK };
  } finally {
    clearTimeout(timer);
  }
}

/** Big for short names, smaller for long ones (two lines max at 1200 wide). */
export function nameFontSize(name: string): number {
  const n = name.length;
  if (n <= 14) return 104;
  if (n <= 22) return 88;
  if (n <= 32) return 72;
  return 60;
}

function toBase64(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  return Buffer.from(s, "utf8").toString("base64");
}

export function renderOgImage(text: OgText): ImageResponse {
  const mark = `data:image/svg+xml;base64,${toBase64(scrambleMarkSvg())}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          padding: "56px 64px",
          backgroundColor: GREEN,
          backgroundImage: `radial-gradient(circle at 85% 0%, #15a356 0%, ${GREEN} 45%, ${GREEN_DARK} 100%)`,
          color: WHITE,
        }}
      >
        <div
          style={{
            display: "flex",
            flexShrink: 0,
            width: 300,
            height: 300,
            borderRadius: 48,
            border: `8px solid ${WHITE}`,
            overflow: "hidden",
            boxShadow: `12px 12px 0 ${INK}`,
          }}
        >
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          <img src={mark} width={284} height={284} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 56, flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", fontSize: 30, letterSpacing: 6, textTransform: "uppercase", color: HAZARD }}>
            {text.course}
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 12,
              fontSize: nameFontSize(text.name),
              lineHeight: 1.02,
              letterSpacing: -2,
              color: WHITE,
            }}
          >
            {text.name}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignSelf: "flex-start",
              marginTop: 36,
              padding: "18px 28px",
              borderRadius: 24,
              border: `5px solid ${INK}`,
              backgroundColor: HAZARD,
              color: INK,
              fontSize: 38,
              lineHeight: 1.2,
            }}
          >
            <div style={{ display: "flex" }}>Open it. Tap your name.</div>
            <div style={{ display: "flex" }}>Every beer = a stroke off.</div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}

export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  let code = "";
  try {
    code = (await params).code;
  } catch {
    /* fallback below */
  }
  return renderOgImage(await ogText(code));
}
