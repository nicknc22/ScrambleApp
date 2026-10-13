"use client";
// Add / edit one player: name, nickname, Venmo handle (no @), groom flag. Delete with a confirm.
import { useState, type FormEvent } from "react";
import { useClientState } from "@/lib/client/react";
import { newId } from "@/lib/ids";
import { BottomSheet, Button, TextField, Toggle, displayName, useConfirm, useFanfare, useToast } from "@/components/ui";
import { draftOfPlayer, duplicateName, groomOf, teamIdByPlayer, validatePlayerDraft, type PlayerDraft } from "./model";
import { useSetupDispatch } from "./shared";

/** `playerId`: an existing player's id, "new" to add, null = closed. */
export function PlayerSheet({ playerId, onClose }: { playerId: string | "new" | null; onClose: () => void }) {
  const view = useClientState((s) => s.view);
  const player = playerId && playerId !== "new" ? (view?.players.find((p) => p.id === playerId && !p.deleted_at) ?? null) : null;
  const open = playerId === "new" || player !== null;
  const title = playerId === "new" ? "Add a player" : player ? `Edit ${displayName(player)}` : "";
  return (
    <BottomSheet open={open} onClose={onClose} title={title} size="tall">
      {open && <PlayerForm key={playerId ?? "x"} playerId={playerId === "new" ? null : (player?.id ?? null)} onClose={onClose} />}
    </BottomSheet>
  );
}

function PlayerForm({ playerId, onClose }: { playerId: string | null; onClose: () => void }) {
  const view = useClientState((s) => s.view);
  const dispatch = useSetupDispatch();
  const toast = useToast();
  const confirm = useConfirm();
  const fanfare = useFanfare();
  const player = playerId ? (view?.players.find((p) => p.id === playerId) ?? null) : null;
  const [draft, setDraft] = useState<PlayerDraft>(() => draftOfPlayer(player));
  const [touched, setTouched] = useState(false);
  /** Players added in this sheet session ("Add + next"), newest last. Feedback lives here, not in a toast. */
  const [added, setAdded] = useState<Array<{ id: string; name: string }>>([]);
  if (!view) return null;

  const { errors, value } = validatePlayerDraft(draft);
  const shown = touched ? errors : {};
  const currentGroom = groomOf(view);
  const stealsCrown = draft.is_groom && currentGroom && currentGroom.id !== playerId;
  const dup = duplicateName(view.players, draft.name, playerId);
  const live = view.trip.status !== "setup";
  const teamId = playerId ? teamIdByPlayer(view).get(playerId) : undefined;
  const team = teamId ? view.teams.find((t) => t.id === teamId) : undefined;

  const set = <K extends keyof PlayerDraft>(k: K, v: PlayerDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = (another: boolean) => {
    setTouched(true);
    if (!value) return;
    const id = playerId ?? newId();
    const crowned = value.is_groom && !(player?.is_groom ?? false);
    const op = dispatch({
      type: "player.upsert",
      player: { id, name: value.name, nickname: value.nickname, venmo_handle: value.venmo_handle, is_groom: value.is_groom },
    });
    if (!op) return;
    const shownName = value.nickname || value.name;
    if (crowned) {
      fanfare.show({ emoji: "👑", title: `${shownName} is the groom`, subtitle: "One Groom's Mulligan. Infinite immunity. Kneel.", tone: "groom" });
    }
    if (playerId) {
      toast.success(`${shownName} saved.`, { emoji: "✍️", id: "player-saved" });
      onClose();
      return;
    }
    if (another) {
      setAdded((a) => [...a, { id, name: shownName }]);
      setDraft(draftOfPlayer(null));
      setTouched(false);
      requestAnimationFrame(() => document.getElementById("player-name-input")?.focus());
      return;
    }
    toast.show({
      tone: "success",
      emoji: "🏌️",
      title: `${shownName} is in`,
      message: "Now put him on a team.",
      id: "player-added",
      action: { label: "Undo", onAction: () => dispatch({ type: "player.delete", player_id: id }) },
    });
    onClose();
  };

  const undoLast = () => {
    const last = added[added.length - 1];
    if (!last) return;
    if (dispatch({ type: "player.delete", player_id: last.id })) setAdded((a) => a.slice(0, -1));
  };

  const remove = async () => {
    if (!player) return;
    const name = displayName(player);
    const ok = await confirm({
      title: `Delete ${name}?`,
      emoji: "🗑️",
      tone: "danger",
      confirmLabel: `Delete ${name}`,
      body: live
        ? `The round is live. Deleting ${name} pulls him off ${team?.name ?? "his team"} and changes the ghost beer math for everyone on it.`
        : `Off the roster${team ? ` and off ${team.name}` : ""}. There's no undo for this one.`,
    });
    if (!ok) return;
    if (dispatch({ type: "player.delete", player_id: player.id })) {
      toast.info(`${name} has been cut. Brutal.`, { emoji: "✂️" });
      onClose();
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save(playerId === null);
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4 pt-1 pb-2" data-testid="player-form">
      {added.length > 0 && (
        <div className="flex items-center gap-2 rounded-2xl border-2 border-fairway bg-fairway-soft py-1 pr-1 pl-3" role="status">
          <p className="min-w-0 flex-1 text-[15px] leading-snug font-extrabold">
            ✅ Added {added.map((a) => a.name).join(", ")}
          </p>
          <Button variant="ghost" className="shrink-0" onClick={undoLast}>
            Undo {added[added.length - 1].name}
          </Button>
        </div>
      )}
      <TextField
        id="player-name-input"
        label="Name"
        placeholder="Real name, e.g. Dave"
        value={draft.name}
        onChange={(e) => set("name", e.target.value)}
        error={shown.name}
        hint={dup ? `There's already a ${dup.name}. Give one of them a nickname.` : undefined}
        maxLength={80}
        autoComplete="off"
        autoCapitalize="words"
        enterKeyHint={playerId ? "done" : "next"}
        data-autofocus
      />
      <TextField
        label="Nickname (optional)"
        placeholder="e.g. Big Nick, The Shank"
        value={draft.nickname}
        onChange={(e) => set("nickname", e.target.value)}
        error={shown.nickname}
        hint="Shown everywhere instead of the real name."
        maxLength={80}
        autoComplete="off"
        autoCapitalize="words"
      />
      <TextField
        label="Venmo handle (optional)"
        placeholder="username, no @"
        value={draft.venmo}
        onChange={(e) => set("venmo", e.target.value.replace(/^\s*@+/, ""))}
        error={shown.venmo}
        hint={shown.venmo ? undefined : "For the Pay with Venmo buttons at settle-up."}
        maxLength={64}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <div className="rounded-2xl border-2 border-ink bg-gold/25 px-3">
        <Toggle
          checked={draft.is_groom}
          onChange={(v) => set("is_groom", v)}
          label="👑 The groom"
          description={
            stealsCrown
              ? `This takes the crown from ${displayName(currentGroom)}. There can be only one.`
              : "Gets the Groom's Mulligan and a crown on every screen."
          }
        />
      </div>
      <div className="flex flex-col gap-2.5 pt-2">
        {playerId ? (
          <>
            <Button type="submit" size="xl" full data-testid="player-save">
              Save
            </Button>
            <Button variant="danger" size="lg" full onClick={remove} data-testid="player-delete">
              Delete player
            </Button>
          </>
        ) : (
          <>
            <Button type="submit" size="xl" full data-testid="player-add-next">
              Add + next player
            </Button>
            <Button variant="secondary" size="lg" full onClick={() => save(false)} data-testid="player-add-done">
              Add and close
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
