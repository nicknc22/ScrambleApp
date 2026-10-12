// Deterministic team colors by team sort_order. Every fill is dark enough for white text (AA+).

export interface TeamColor {
  name: string;
  /** Solid fill. */
  bg: string;
  /** Text on the solid fill. */
  fg: string;
  /** Light tint for card backgrounds (ink text on it). */
  soft: string;
}

export const TEAM_PALETTE: readonly TeamColor[] = [
  { name: "blue", bg: "#1d4ed8", fg: "#ffffff", soft: "#dde7fd" },
  { name: "orange", bg: "#c2410c", fg: "#ffffff", soft: "#fde4d6" },
  { name: "magenta", bg: "#be185d", fg: "#ffffff", soft: "#fbdeeb" },
  { name: "teal", bg: "#0f766e", fg: "#ffffff", soft: "#d4f1ed" },
  { name: "brown", bg: "#854d0e", fg: "#ffffff", soft: "#f6e8d2" },
  { name: "indigo", bg: "#4338ca", fg: "#ffffff", soft: "#e2e1fb" },
  { name: "olive", bg: "#3f6212", fg: "#ffffff", soft: "#e7f1d4" },
  { name: "slate", bg: "#334155", fg: "#ffffff", soft: "#e2e8f0" },
];

/** Colors for "no team yet". */
export const NO_TEAM_COLOR: TeamColor = { name: "none", bg: "#5b665f", fg: "#ffffff", soft: "#eef1ef" };

/** Team color by sort_order (wraps around the palette; null/undefined = no team). */
export function teamColor(sortOrder: number | null | undefined): TeamColor {
  if (sortOrder === null || sortOrder === undefined || !Number.isFinite(sortOrder)) return NO_TEAM_COLOR;
  const n = TEAM_PALETTE.length;
  const i = ((Math.trunc(sortOrder) % n) + n) % n;
  return TEAM_PALETTE[i];
}
