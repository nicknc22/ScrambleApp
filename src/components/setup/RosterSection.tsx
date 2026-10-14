"use client";
// Roster: quick-add by name, tap a row to edit (nickname, Venmo, groom), crown the groom.
// Empty roster: "Load the boys" adds the default crew in one tap; "Add several at once" takes a
// pasted list (RosterBulk.tsx). With players: "Send the link" (the clean /t/<code> link).
import { useRef, useState, type FormEvent } from "react";
import { useClientState } from "@/lib/client/react";
import { newId } from "@/lib/ids";
import {
  Avatar,
  Badge,
  BottomSheet,
  Button,
  Card,
  IconChevronRight,
  IconPlus,
  PlayerName,
  SectionHeader,
  TeamPill,
  cx,
  displayName,
  useFanfare,
  useToast,
} from "@/components/ui";
import { duplicateName, groomOf, livePlayers, teamIdByPlayer, venmoOnFile } from "./model";
import { PlayerSheet } from "./PlayerSheet";
import { ShareTripLinkCard } from "@/components/shell/ShareTripLink";
import { BulkAddSheet, LoadTheBoysCard } from "./RosterBulk";
import { clearSetupToasts, useSetupDispatch } from "./shared";

export function RosterSection() {
  const view = useClientState((s) => s.view);
  const meId = useClientState((s) => s.meId);
  const dispatch = useSetupDispatch();
  const toast = useToast();
  const [editing, setEditingState] = useState<string | "new" | null>(null);
  const setEditing = (v: string | "new" | null) => {
    if (v !== null) clearSetupToasts(toast);
    setEditingState(v);
  };
  const [groomPicker, setGroomPicker] = useState(false);
  const [bulkOpen, setBulkOpenState] = useState(false);
  const setBulkOpen = (v: boolean) => {
    if (v) clearSetupToasts(toast);
    setBulkOpenState(v);
  };
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  if (!view) return null;

  const players = livePlayers(view);
  const tOf = teamIdByPlayer(view);
  const teamById = new Map(view.teams.map((t) => [t.id, t]));
  const groom = groomOf(view);
  const live = view.trip.status !== "setup";
  const withVenmo = venmoOnFile(players);

  const quickAdd = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      toast.roast("Type a name first. \"Hey you\" won't fit on the leaderboard.");
      inputRef.current?.focus();
      return;
    }
    const dup = duplicateName(view.players, n, null);
    const id = newId();
    const op = dispatch({ type: "player.upsert", player: { id, name: n } });
    if (!op) return;
    setName("");
    toast.show({
      tone: "success",
      emoji: "🏌️",
      title: `${n} is in`,
      message: dup ? `Two ${n}s? Give one a nickname (tap his row).` : `${players.length + 1} on the roster.`,
      id: "player-added",
      action: { label: "Undo", onAction: () => dispatch({ type: "player.delete", player_id: id }) },
    });
    inputRef.current?.focus();
  };

  return (
    <div className="space-y-4" data-testid="setup-roster">
      <SectionHeader
        title="Roster"
        subtitle={
          players.length === 0 ? (
            "Who's coming? Load the boys, then make teams."
          ) : (
            <>
              {`${players.length} degenerate${players.length === 1 ? "" : "s"}${groom ? ` · 👑 ${displayName(groom)}` : ""}`}
              <span className={cx("block", withVenmo < players.length && "text-ink")} data-testid="roster-venmo-count">
                Venmo on file: {withVenmo} of {players.length}
                {withVenmo < players.length && " · Pay buttons need these"}
              </span>
            </>
          )
        }
      />

      {live && (
        <Card tone="hazard" className="text-[15px] font-bold">
          The round is live. Roster edits post to the feed, and deleting a player changes his team&apos;s ghost beer math.
        </Card>
      )}

      {players.length === 0 ? <LoadTheBoysCard /> : <ShareTripLinkCard code={view.trip.code} tripName={view.trip.name} />}

      <form onSubmit={quickAdd} className="flex items-end gap-2" noValidate>
        <div className="min-w-0 flex-1">
          <label htmlFor="quick-add-player" className="text-sm font-extrabold tracking-wider text-ink uppercase">
            Add a player
          </label>
          <input
            ref={inputRef}
            id="quick-add-player"
            data-testid="quick-add-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name, then hit Add"
            maxLength={80}
            autoComplete="off"
            autoCapitalize="words"
            enterKeyHint="done"
            className="mt-1.5 h-14 w-full min-w-0 rounded-xl border-2 border-ink bg-paper px-4 text-lg font-bold text-ink placeholder:font-semibold placeholder:text-muted/80"
          />
        </div>
        <Button type="submit" size="lg" className="shrink-0 px-5" leading={<IconPlus size={22} strokeWidth={3.2} />} data-testid="quick-add-submit">
          Add
        </Button>
      </form>
      <div className="-mt-2 flex flex-wrap gap-x-5">
        <button
          type="button"
          onClick={() => setBulkOpen(true)}
          className="min-h-12 text-left text-[15px] font-extrabold text-fairway-dark underline underline-offset-4"
          data-testid="bulk-add-open"
        >
          Add several at once
        </button>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="min-h-12 text-left text-[15px] font-extrabold text-fairway-dark underline underline-offset-4"
        >
          Add with nickname, Venmo and groom flag
        </button>
      </div>

      {players.length > 0 && !groom && (
        <Card tone="hazard" className="flex items-center gap-3">
          <span className="text-4xl leading-none" aria-hidden="true">
            👑
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-lg leading-tight font-black">No groom yet</p>
            <p className="text-sm font-bold">No groom, no Groom&apos;s Mulligan. Crown somebody.</p>
          </div>
          <Button variant="ink" className="shrink-0" onClick={() => setGroomPicker(true)} data-testid="crown-groom">
            Crown
          </Button>
        </Card>
      )}

      {players.length > 0 && (
        <ul className="overflow-hidden rounded-2xl border-2 border-ink" data-testid="roster-list">
          {players.map((p, i) => {
            const team = teamById.get(tOf.get(p.id) ?? "");
            return (
              <li key={p.id} className={cx(i > 0 && "border-t-2 border-line")}>
                <button
                  type="button"
                  onClick={() => setEditing(p.id)}
                  className="flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left active:bg-sand"
                  data-testid="roster-row"
                  data-player={p.name}
                  aria-label={`Edit ${displayName(p)}${p.is_groom ? ", the groom" : ""}`}
                >
                  <Avatar player={p} teamSortOrder={team?.sort_order ?? null} showCrown={false} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-lg leading-tight font-black">
                      <PlayerName player={p} showRealName you={p.id === meId} />
                    </span>
                    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-bold text-muted">
                      {team ? <TeamPill team={team} size="sm" /> : <Badge tone="hazard">No team</Badge>}
                      <span className={cx("truncate", p.venmo_handle ? "text-ink" : "text-muted")}>
                        {p.venmo_handle ? `@${p.venmo_handle}` : "no Venmo"}
                      </span>
                    </span>
                  </span>
                  <IconChevronRight size={22} strokeWidth={3} className="shrink-0 text-muted" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <PlayerSheet playerId={editing} onClose={() => setEditing(null)} />
      <GroomPicker open={groomPicker} onClose={() => setGroomPicker(false)} />
      <BulkAddSheet open={bulkOpen} onClose={() => setBulkOpen(false)} />
    </div>
  );
}

function GroomPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const view = useClientState((s) => s.view);
  const dispatch = useSetupDispatch();
  const fanfare = useFanfare();
  const players = view ? livePlayers(view) : [];
  const crown = (id: string) => {
    const p = players.find((x) => x.id === id);
    if (!p) return;
    if (dispatch({ type: "player.upsert", player: { id, is_groom: true } })) {
      fanfare.show({ emoji: "👑", title: `${displayName(p)} is the groom`, subtitle: "One Groom's Mulligan. Infinite immunity. Kneel.", tone: "groom" });
      onClose();
    }
  };
  return (
    <BottomSheet open={open} onClose={onClose} title="Who's getting married?">
      <div className="grid grid-cols-2 gap-2 pb-2">
        {players.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => crown(p.id)}
            className="btn min-h-14 justify-start border-ink bg-paper px-3 text-left text-base text-ink active:bg-gold"
          >
            <span className="truncate">{displayName(p)}</span>
          </button>
        ))}
      </div>
    </BottomSheet>
  );
}
