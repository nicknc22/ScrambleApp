import { cx } from "./cx";
import { displayName, type NamedPlayer } from "./PlayerName";
import { teamColor } from "./teamColors";

/** Up to two initials from a display name: "Big Nick" -> "BN", "nick" -> "NI". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const chars = Array.from(words[0]);
    return (chars[0] + (chars[1] ?? "")).toUpperCase();
  }
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

const SIZE = {
  sm: "h-8 w-8 text-xs",
  md: "h-11 w-11 text-sm",
  lg: "h-14 w-14 text-lg",
  xl: "h-20 w-20 text-2xl",
} as const;

/** Initials circle in the team's color, with a crown for the groom. */
export function Avatar({
  player,
  teamSortOrder,
  size = "md",
  showCrown = true,
  className,
}: {
  player: NamedPlayer | null | undefined;
  /** Team sort_order for the color; null/undefined = no team (gray). */
  teamSortOrder?: number | null;
  size?: keyof typeof SIZE;
  /** Crown badge for the groom (turn off when a PlayerName next to it already shows 👑). */
  showCrown?: boolean;
  className?: string;
}) {
  const c = teamColor(teamSortOrder);
  return (
    <span className={cx("relative inline-flex shrink-0", className)} aria-hidden="true">
      <span
        className={cx("inline-flex items-center justify-center rounded-full border-2 border-ink font-black", SIZE[size])}
        style={{ backgroundColor: c.bg, color: c.fg }}
      >
        {initials(displayName(player))}
      </span>
      {showCrown && player?.is_groom && (
        <span className="absolute -top-2.5 -right-1.5 rotate-12 text-base leading-none drop-shadow">👑</span>
      )}
    </span>
  );
}
