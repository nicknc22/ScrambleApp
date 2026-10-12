import type { Player } from "@/lib/types";
import { cx } from "./cx";

export type NamedPlayer = Pick<Player, "name" | "nickname" | "is_groom">;

/** Nickname if set, else name. */
export function displayName(p: Pick<Player, "name" | "nickname"> | null | undefined): string {
  if (!p) return "Somebody";
  const nick = p.nickname?.trim();
  return nick ? nick : p.name.trim() || "Somebody";
}

/** Player's display name, 👑 for the groom, optional "(you)" marker. */
export function PlayerName({
  player,
  you = false,
  showRealName = false,
  className,
}: {
  player: NamedPlayer | null | undefined;
  you?: boolean;
  /** Also show the real name in muted text when a nickname is used. */
  showRealName?: boolean;
  className?: string;
}) {
  const name = displayName(player);
  const showReal = showRealName && player?.nickname?.trim() && player.nickname.trim() !== player.name.trim();
  return (
    <span className={cx("inline min-w-0", className)}>
      <span>{name}</span>
      {player?.is_groom && (
        <span className="ml-1" role="img" aria-label="the groom" title="The Groom">
          👑
        </span>
      )}
      {showReal && <span className="ml-1 font-semibold text-muted">({player!.name})</span>}
      {you && <span className="ml-1 font-semibold text-muted">(you)</span>}
    </span>
  );
}
