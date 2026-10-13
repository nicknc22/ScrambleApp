"use client";
// Teams board: drag players between team cards and the Unassigned pool (dnd-kit: mouse, touch
// press-and-hold, keyboard), or tap a player and pick a team (the reliable path on phones).
// Add/remove teams, tee times and names (with AI or house-list name generation) live in TeamSheet.
import { useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  type Announcements,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useClientState } from "@/lib/client/react";
import { newId } from "@/lib/ids";
import type { OpInput } from "@/lib/ops";
import type { Player, Team } from "@/lib/types";
import {
  Avatar,
  Badge,
  Button,
  Card,
  IconPlus,
  IconRefresh,
  PlayerName,
  SectionHeader,
  cx,
  displayName,
  teamColor,
  useConfirm,
  useToast,
} from "@/components/ui";
import { formatTeeTime } from "@/components/shell/roster";
import {
  MAX_TEAM_SIZE,
  liveTeams,
  livePlayers,
  membersByTeam,
  nextTeamName,
  planShuffle,
  shuffleSizes,
  shuffleTeamCount,
  sizeNote,
  sizesLabel,
  teamIdByPlayer,
  teamSizeStatus,
  unassignedPlayers,
} from "./model";
import { POOL_ID, playerDragId, playerIdOfDragId, teamDropId, teamIdOfDropId, useBoardSensors, zoneCollision } from "./dnd";
import { MoveSheet } from "./MoveSheet";
import { TeamSheet } from "./TeamSheet";
import { buzz, clearSetupToasts, useSetupDispatch } from "./shared";

export function TeamsSection() {
  const view = useClientState((s) => s.view);
  const dispatch = useSetupDispatch();
  const toast = useToast();
  const confirm = useConfirm();
  const sensors = useBoardSensors();
  const [dragging, setDragging] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [editingTeam, setEditingTeam] = useState<string | null>(null);
  /** Swallow the click that some browsers fire right after a drop. */
  const suppressTap = useRef(false);
  if (!view) return null;

  const players = livePlayers(view);
  const teams = liveTeams(view);
  const members = membersByTeam(view);
  const tOf = teamIdByPlayer(view);
  const free = unassignedPlayers(view);
  const playerById = new Map(players.map((p) => [p.id, p]));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const live = view.trip.status !== "setup";
  const shuffleCount = shuffleTeamCount(players.length, teams.length);
  const plannedSizes = shuffleSizes(players.length, shuffleCount);

  const zoneName = (id: string | number | null | undefined) => {
    const t = teamIdOfDropId(id ?? null);
    if (t === null) return "Unassigned";
    if (t === undefined) return "nowhere";
    return teamById.get(t)?.name ?? "a team";
  };
  const nameOf = (dragId: string | number) => displayName(playerById.get(playerIdOfDragId(dragId) ?? "") ?? null);

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}. Arrow keys move between teams, space drops, escape cancels.`,
    onDragOver: ({ active, over }) => (over ? `${nameOf(active.id)} is over ${zoneName(over.id)}.` : `${nameOf(active.id)} is not over a team.`),
    onDragEnd: ({ active, over }) => (over ? `${nameOf(active.id)} dropped on ${zoneName(over.id)}.` : `${nameOf(active.id)} dropped. Nothing changed.`),
    onDragCancel: ({ active }) => `Cancelled. ${nameOf(active.id)} stays put.`,
  };

  /** Move a player (null = unassigned) with an undo toast. */
  const move = (playerId: string, teamId: string | null) => {
    const p = playerById.get(playerId);
    if (!p) return;
    const from = tOf.get(playerId) ?? null;
    if (from === teamId) return;
    const target = teamId ? teamById.get(teamId) : null;
    if (target && (members.get(target.id)?.length ?? 0) >= MAX_TEAM_SIZE) {
      toast.error(`${target.name} already has ${MAX_TEAM_SIZE}. It's a scramble, not a clown car.`, { title: "Team's full" });
      return;
    }
    if (!dispatch({ type: "team.assign", player_id: playerId, team_id: teamId })) return;
    buzz();
    toast.show({
      tone: "success",
      emoji: target ? "🤝" : "🪑",
      title: target ? `${displayName(p)} → ${target.name}` : `${displayName(p)} benched`,
      message: target ? `${(members.get(target.id)?.length ?? 0) + 1} on ${target.name}` : "Back in the pool.",
      id: "team-move",
      duration: 6000,
      action: { label: "Undo", onAction: () => dispatch({ type: "team.assign", player_id: playerId, team_id: from }) },
    });
  };

  const onDragStart = (e: DragStartEvent) => {
    setDragging(playerIdOfDragId(e.active.id));
    buzz(18);
  };
  // A keyboard drop (Space) is followed by the button's own keyup "click": swallow that one.
  // Pointer drags need nothing: dnd-kit already eats the click after a real drag.
  const holdOffTaps = (activator: Event | null | undefined) => {
    if (typeof KeyboardEvent === "undefined" || !(activator instanceof KeyboardEvent)) return;
    suppressTap.current = true;
    setTimeout(() => {
      suppressTap.current = false;
    }, 300);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    holdOffTaps(e.activatorEvent);
    const playerId = playerIdOfDragId(e.active.id);
    const teamId = teamIdOfDropId(e.over?.id ?? null);
    if (!playerId || teamId === undefined || !e.over) return;
    move(playerId, teamId);
  };
  const onDragCancel = (e: DragCancelEvent) => {
    setDragging(null);
    holdOffTaps(e.activatorEvent);
  };
  const tapPlayer = (playerId: string) => {
    if (suppressTap.current) return;
    clearSetupToasts(toast);
    setMoving(playerId);
  };

  const addTeam = () => {
    const id = newId();
    const name = nextTeamName(view.teams);
    if (!dispatch({ type: "team.upsert", team: { id, name } })) return;
    toast.show({
      tone: "success",
      emoji: "🏳️",
      title: `${name} is born`,
      message: "Tap Edit to give it a worse name.",
      id: "team-added",
      action: { label: "Undo", onAction: () => dispatch({ type: "team.delete", team_id: id }) },
    });
  };

  const shuffle = async () => {
    const plan = planShuffle(
      players.map((p) => p.id),
      teams.length,
    );
    if (!plan) {
      toast.roast("Need at least 2 players to make a team. Golf is a team sport today.");
      return;
    }
    const ok = await confirm({
      title: `Shuffle into teams of ${sizesLabel(plan.sizes)}?`,
      emoji: "🎲",
      body:
        plan.create > 0
          ? `Random teams for all ${players.length}. ${plan.create} new team${plan.create === 1 ? "" : "s"} get created. Current teams get scrambled.`
          : `Random teams for all ${players.length}. Current teams get scrambled. The groom gets no special treatment.`,
      confirmLabel: "Shuffle 'em",
    });
    if (!ok) return;
    const before = new Map(tOf);
    const teamIds = teams.slice(0, plan.sizes.length).map((t) => t.id);
    const created: string[] = [];
    for (let i = 0; i < plan.create; i++) {
      const id = newId();
      if (!dispatch({ type: "team.upsert", team: { id, name: nextTeamName(view.teams, i) } })) return;
      created.push(id);
      teamIds.push(id);
    }
    // Empty every team first so no one bounces off a "full" team mid-shuffle.
    const run = (ops: OpInput[]) => ops.every((op) => dispatch(op) !== null);
    const cleared = run(players.filter((p) => tOf.has(p.id)).map((p) => ({ type: "team.assign", player_id: p.id, team_id: null }) as OpInput));
    const assigned =
      cleared && run(plan.assignments.map((a) => ({ type: "team.assign", player_id: a.player_id, team_id: teamIds[a.team_index] }) as OpInput));
    if (!assigned) return;
    buzz(30);
    toast.show({
      tone: "success",
      emoji: "🎲",
      title: `Teams of ${sizesLabel(plan.sizes)}`,
      message: "The golf gods have spoken. Drag to tweak.",
      id: "team-shuffle",
      action: {
        label: "Undo",
        onAction: () => {
          run(players.map((p) => ({ type: "team.assign", player_id: p.id, team_id: null }) as OpInput));
          run(
            [...before.entries()]
              .filter(([, t]) => teamById.has(t))
              .map(([player_id, team_id]) => ({ type: "team.assign", player_id, team_id }) as OpInput),
          );
          run(created.map((team_id) => ({ type: "team.delete", team_id }) as OpInput));
        },
      },
    });
  };

  const draggingPlayer = dragging ? (playerById.get(dragging) ?? null) : null;
  const draggingTeam = dragging ? (tOf.get(dragging) ?? null) : null;

  return (
    <div className="space-y-4" data-testid="setup-teams">
      <SectionHeader
        title="Teams"
        subtitle={
          teams.length === 0
            ? "Add teams, then drag (or tap) players onto them."
            : `${teams.length} team${teams.length === 1 ? "" : "s"} · ${players.length - free.length}/${players.length} assigned`
        }
      />

      {live && (
        <Card tone="hazard" className="text-[15px] font-bold">
          The round is live. Moving players changes team sizes and the ghost beer math. Commissioner fixes only.
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button size="lg" className="min-w-0 px-3" onClick={addTeam} leading={<IconPlus size={22} strokeWidth={3.2} />} data-testid="add-team">
          Add team
        </Button>
        <Button
          variant="secondary"
          size="lg"
          onClick={shuffle}
          disabled={live || plannedSizes.length === 0}
          className="min-w-0 px-3"
          leading={<IconRefresh size={20} strokeWidth={3} className="max-[399px]:hidden" />}
          data-testid="shuffle-teams"
        >
          <span className="truncate">{plannedSizes.length > 0 ? `Shuffle ${sizesLabel(plannedSizes)}` : "Shuffle"}</span>
        </Button>
      </div>
      <p className="text-sm font-bold text-muted">
        Tap a player to move them. Or press and hold, then drag. Teams are 2 to 4; threesomes get ghost beers.
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={zoneCollision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: "Press Enter to pick a team, or Space to pick this player up and arrow keys to move between teams.",
          },
        }}
      >
        <PoolZone count={free.length} dragging={dragging !== null} draggingFrom={draggingTeam}>
          {free.map((p) => (
            <PlayerToken key={p.id} player={p} teamSortOrder={null} onTap={() => tapPlayer(p.id)} />
          ))}
        </PoolZone>

        {teams.map((t) => (
          <TeamZone
            key={t.id}
            team={t}
            count={members.get(t.id)?.length ?? 0}
            dragging={dragging !== null}
            isHome={draggingTeam === t.id}
            onEdit={() => {
              clearSetupToasts(toast);
              setEditingTeam(t.id);
            }}
          >
            {(members.get(t.id) ?? []).map((p) => (
              <PlayerToken key={p.id} player={p} teamSortOrder={t.sort_order} onTap={() => tapPlayer(p.id)} />
            ))}
          </TeamZone>
        ))}

        <DragOverlay dropAnimation={null} zIndex={95}>
          {draggingPlayer ? (
            <TokenFace player={draggingPlayer} teamSortOrder={teamById.get(draggingTeam ?? "")?.sort_order ?? null} lifted />
          ) : null}
        </DragOverlay>
      </DndContext>

      {teams.length === 0 && (
        <Card tone="sand" className="text-center">
          <div className="text-5xl leading-none" aria-hidden="true">
            🏳️
          </div>
          <p className="mt-2 text-lg font-black">No teams yet</p>
          <p className="text-[15px] font-bold text-muted">Hit Add team (or Shuffle) to get this circus organized.</p>
        </Card>
      )}

      <MoveSheet playerId={moving} onClose={() => setMoving(null)} onMove={(teamId) => moving && move(moving, teamId)} />
      <TeamSheet teamId={editingTeam} onClose={() => setEditingTeam(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drop zones
// ---------------------------------------------------------------------------

function PoolZone({ count, dragging, draggingFrom, children }: { count: number; dragging: boolean; draggingFrom: string | null; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: POOL_ID });
  const homeless = draggingFrom === null && dragging;
  return (
    <section
      ref={setNodeRef}
      aria-label="Unassigned players"
      data-testid="pool-zone"
      className={cx(
        "rounded-2xl border-2 border-dashed p-3 transition-colors",
        isOver && !homeless ? "border-solid border-ink bg-hazard" : count > 0 ? "border-ink bg-hazard-soft" : "border-line-strong bg-sand",
      )}
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-lg font-black uppercase">Unassigned</h3>
        {count > 0 ? <Badge tone="hazard">{count} need a team</Badge> : <Badge tone="fairway">Everyone&apos;s placed</Badge>}
      </div>
      {count > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">{children}</div>
      ) : (
        <p className="mt-1 text-sm font-bold text-muted">{dragging ? "Drop here to bench them." : "Nobody left out. Drop a player here to bench him."}</p>
      )}
    </section>
  );
}

function TeamZone({
  team,
  count,
  dragging,
  isHome,
  onEdit,
  children,
}: {
  team: Team;
  count: number;
  dragging: boolean;
  isHome: boolean;
  onEdit: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: teamDropId(team.id) });
  const c = teamColor(team.sort_order);
  const status = teamSizeStatus(count);
  const blocked = isOver && !isHome && count >= MAX_TEAM_SIZE;
  const tee = formatTeeTime(team.tee_time);
  return (
    <section
      ref={setNodeRef}
      aria-label={`${team.name}, ${count} players`}
      data-testid="team-zone"
      data-team={team.name}
      className={cx(
        "overflow-hidden rounded-2xl border-2 border-ink transition-[box-shadow,transform]",
        isOver && !blocked && !isHome && "scale-[1.01] shadow-hard",
        blocked && "border-flag",
        dragging && !isOver && "opacity-95",
      )}
      style={{ backgroundColor: blocked ? "var(--color-flag-soft)" : c.soft }}
    >
      <div className="flex min-h-14 items-center gap-2 py-1.5 pr-1.5 pl-3" style={{ backgroundColor: c.bg, color: c.fg }}>
        <h3 className="min-w-0 flex-1 truncate text-xl leading-tight font-black" data-testid="team-name">
          {team.name}
        </h3>
        <span
          className={cx(
            "num shrink-0 rounded-full border-2 px-2 py-0.5 text-sm font-black",
            status === "ok" || status === "full" ? "border-white bg-white text-ink" : "border-ink bg-hazard text-ink",
          )}
          data-testid="team-size"
        >
          {count}/{MAX_TEAM_SIZE}
        </span>
        <button
          type="button"
          onClick={onEdit}
          className="btn min-h-12 shrink-0 border-ink bg-paper px-3 text-base text-ink active:bg-sand"
          aria-label={`Edit ${team.name}`}
          data-testid="edit-team"
        >
          Edit
        </button>
      </div>
      <div className="px-3 pt-2 pb-3">
        <p className="flex flex-wrap items-center gap-x-2 text-sm font-bold text-ink">
          <span className={cx(!tee && "text-muted")}>⏰ {tee ?? "No tee time"}</span>
          <span aria-hidden="true">·</span>
          <span className={cx(status === "short" || status === "empty" ? "text-flag" : "text-ink")}>{blocked ? "FULL. Find another team." : sizeNote(count)}</span>
        </p>
        {count > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">{children}</div>
        ) : (
          <div className="mt-2 flex min-h-14 items-center justify-center rounded-xl border-2 border-dashed border-ink/40 text-[15px] font-extrabold text-muted">
            Drop players here
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Player tokens
// ---------------------------------------------------------------------------

function PlayerToken({ player, teamSortOrder, onTap }: { player: Player; teamSortOrder: number | null; onTap: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: playerDragId(player.id) });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={onTap}
      aria-label={`${displayName(player)}${player.is_groom ? ", the groom" : ""}. Tap to move.`}
      data-testid="team-player"
      data-player={player.name}
      className={cx(
        "max-w-full touch-manipulation rounded-full select-none [-webkit-touch-callout:none]",
        isDragging && "opacity-30",
      )}
    >
      <TokenFace player={player} teamSortOrder={teamSortOrder} />
    </button>
  );
}

function TokenFace({ player, teamSortOrder, lifted = false }: { player: Player; teamSortOrder: number | null; lifted?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex min-h-12 max-w-full items-center gap-2 rounded-full border-2 border-ink bg-paper py-1 pr-3.5 pl-1.5 text-base font-extrabold text-ink",
        lifted ? "scale-110 rotate-[-3deg] shadow-hard" : "active:bg-sand",
      )}
    >
      <Avatar player={player} teamSortOrder={teamSortOrder} size="sm" showCrown={false} />
      <span className="min-w-0 truncate">
        <PlayerName player={player} />
      </span>
      <span aria-hidden="true" className="-mr-1 text-lg leading-none text-muted">
        ⠿
      </span>
    </span>
  );
}
