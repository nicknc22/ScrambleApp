import { ImageResponse } from "next/og";

// App icon: a bold beer mug + golf flag + ball on Scramble green. Drawn as one SVG (no fonts, no
// emoji CDN, so it renders at build time with no network). Everything sits inside the central
// 80% circle so the same art works as a maskable icon. Shared by icon, apple-icon and the
// /icon-192.png, /icon-512.png manifest icons.

const GREEN = "#0a7d3e";
const AMBER = "#f5b00d";
const AMBER_DARK = "#c98500";
const WHITE = "#ffffff";
const RED = "#e5322d";

export function scrambleMarkSvg(): string {
  const dimples = [
    [330, 330],
    [352, 318],
    [374, 330],
    [341, 352],
    [363, 352],
    [352, 374],
    [330, 374],
    [374, 374],
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.5" fill="#d9dee3"/>`)
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">`,
    `<rect width="512" height="512" fill="${GREEN}"/>`,
    `<g transform="translate(-18 -8)">`,
    // flag pin
    `<rect x="364" y="112" width="12" height="200" rx="6" fill="${WHITE}"/>`,
    `<path d="M376 116 L436 142 L376 168 Z" fill="${RED}"/>`,
    // mug handle
    `<rect x="262" y="222" width="76" height="118" rx="34" fill="none" stroke="${WHITE}" stroke-width="42"/>`,
    `<rect x="262" y="222" width="76" height="118" rx="34" fill="none" stroke="${AMBER_DARK}" stroke-width="18"/>`,
    // mug body (white outline, amber beer)
    `<rect x="122" y="178" width="164" height="226" rx="30" fill="${WHITE}"/>`,
    `<rect x="138" y="196" width="132" height="192" rx="20" fill="${AMBER}"/>`,
    `<rect x="160" y="236" width="16" height="128" rx="8" fill="${AMBER_DARK}" opacity="0.55"/>`,
    `<rect x="232" y="236" width="16" height="128" rx="8" fill="${AMBER_DARK}" opacity="0.55"/>`,
    // foam
    `<circle cx="150" cy="186" r="38" fill="${WHITE}"/>`,
    `<circle cx="204" cy="164" r="46" fill="${WHITE}"/>`,
    `<circle cx="258" cy="184" r="38" fill="${WHITE}"/>`,
    `<rect x="122" y="178" width="164" height="40" fill="${WHITE}"/>`,
    // golf ball (front)
    `<circle cx="352" cy="352" r="62" fill="${GREEN}"/>`,
    `<circle cx="352" cy="352" r="54" fill="${WHITE}"/>`,
    dimples,
    `</g>`,
    `</svg>`,
  ].join("");
}

function toBase64(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  return Buffer.from(s, "utf8").toString("base64");
}

/** PNG of the mark at `px` square. */
export function renderScrambleMark(px: number): ImageResponse {
  const src = `data:image/svg+xml;base64,${toBase64(scrambleMarkSvg())}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: GREEN }}>
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <img src={src} width={px} height={px} />
      </div>
    ),
    { width: px, height: px },
  );
}

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return renderScrambleMark(size.width);
}
