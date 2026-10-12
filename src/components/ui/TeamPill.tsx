import type { Team } from "@/lib/types";
import { cx } from "./cx";
import { teamColor } from "./teamColors";

/** Team name in the team's color. `team` null = "No team". */
export function TeamPill({
  team,
  size = "md",
  you = false,
  className,
}: {
  team: Pick<Team, "name" | "sort_order"> | null | undefined;
  size?: "sm" | "md" | "lg";
  /** Adds a ★ to mark the viewer's own team. */
  you?: boolean;
  className?: string;
}) {
  const c = teamColor(team ? team.sort_order : null);
  return (
    <span
      className={cx(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border-2 border-ink font-extrabold leading-none",
        size === "sm" && "px-2 py-1 text-xs",
        size === "md" && "px-3 py-1.5 text-sm",
        size === "lg" && "px-4 py-2 text-base",
        className,
      )}
      style={{ backgroundColor: c.bg, color: c.fg }}
    >
      {you && <span aria-label="your team">★</span>}
      <span className="truncate">{team ? team.name || "Unnamed team" : "No team"}</span>
    </span>
  );
}
