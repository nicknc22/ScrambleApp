"use client";
// Edit one team: name (type it, or Generate 5 unhinged ones and tap to pick, re-roll as needed),
// tee time, delete. Changes save as you go (tap a name, leave the field, close the sheet).
import { useEffect, useRef, useState, type RefObject } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { BottomSheet, Button, Chip, IconRefresh, Spinner, TextField, cx, displayName, teamColor, useConfirm, useToast } from "@/components/ui";
import { formatTeeTime } from "@/components/shell/roster";
import { MAX_NAME_CHARS, liveTeams, membersByTeam, normalizeTeeTime, teeTimeSuggestions } from "./model";
import { generateTeamNames, type TeamNamesSource } from "./teamNames";
import { useSetupDispatch } from "./shared";

export function TeamSheet({ teamId, onClose }: { teamId: string | null; onClose: () => void }) {
  const view = useClientState((s) => s.view);
  const team = teamId ? (view?.teams.find((t) => t.id === teamId && !t.deleted_at) ?? null) : null;
  // The form registers a "save before close" hook so X / overlay / Done never lose a typed name.
  const beforeCloseRef = useRef<(() => void) | null>(null);
  const close = () => {
    beforeCloseRef.current?.();
    onClose();
  };
  return (
    <BottomSheet
      open={team !== null}
      onClose={close}
      title={team ? team.name : ""}
      size="tall"
      footer={
        <Button size="xl" full onClick={close} data-testid="team-done">
          Done
        </Button>
      }
    >
      {team && <TeamForm key={team.id} teamId={team.id} beforeCloseRef={beforeCloseRef} onDeleted={onClose} />}
    </BottomSheet>
  );
}

function TeamForm({
  teamId,
  beforeCloseRef,
  onDeleted,
}: {
  teamId: string;
  beforeCloseRef: RefObject<(() => void) | null>;
  onDeleted: () => void;
}) {
  const store = useTripStore();
  const view = useClientState((s) => s.view);
  const code = useClientState((s) => s.code);
  const aiEnabled = useClientState((s) => s.snapshot?.meta.ai_enabled ?? false);
  const dispatch = useSetupDispatch();
  const toast = useToast();
  const confirm = useConfirm();
  const team = view?.teams.find((t) => t.id === teamId) ?? null;
  const [name, setName] = useState(team?.name ?? "");
  const [tee, setTee] = useState(team?.tee_time ?? "");
  const [names, setNames] = useState<string[]>([]);
  const [source, setSource] = useState<TeamNamesSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [renamedFrom, setRenamedFrom] = useState<string | null>(null);
  const reqSeq = useRef(0);

  // Read the live store (not this render's view): blur and close can both fire before a re-render.
  const currentTeam = () => store.getState().view?.teams.find((t) => t.id === teamId && !t.deleted_at) ?? null;

  const saveName = (next: string) => {
    const cur = currentTeam();
    if (!cur) return;
    const trimmed = next.trim();
    if (!trimmed) {
      setName(cur.name);
      toast.roast("Every team needs a name. Put the old one back.");
      return;
    }
    if (trimmed === cur.name) return;
    const prev = cur.name;
    if (!dispatch({ type: "team.upsert", team: { id: teamId, name: trimmed } })) {
      setName(prev);
      return;
    }
    setName(trimmed);
    // Inline feedback (the field already shows the new name); toasts would park over the sheet title.
    setRenamedFrom(prev);
  };

  const undoRename = () => {
    if (!renamedFrom) return;
    if (dispatch({ type: "team.upsert", team: { id: teamId, name: renamedFrom } })) {
      setName(renamedFrom);
      setRenamedFrom(null);
    }
  };

  const saveTee = (next: string) => {
    const cur = currentTeam();
    if (!cur) return;
    const value = next.trim() === "" ? null : normalizeTeeTime(next);
    if (next.trim() !== "" && value === null) {
      toast.error("Tee time must look like 12:50.");
      setTee(cur.tee_time ?? "");
      return;
    }
    if (value === (cur.tee_time ?? null)) return;
    if (dispatch({ type: "team.upsert", team: { id: teamId, tee_time: value } })) setTee(value ?? "");
  };

  // Latest-values ref so the sheet's close hook commits whatever is typed.
  const latest = useRef({ name, tee, saveName, saveTee });
  useEffect(() => {
    latest.current = { name, tee, saveName, saveTee };
  });
  useEffect(() => {
    beforeCloseRef.current = () => {
      const l = latest.current;
      l.saveName(l.name);
      l.saveTee(l.tee);
    };
    return () => {
      beforeCloseRef.current = null;
    };
  }, [beforeCloseRef]);

  if (!view || !team) return null;
  const otherNames = liveTeams(view)
    .filter((t) => t.id !== teamId)
    .map((t) => t.name);
  const members = membersByTeam(view).get(teamId) ?? [];
  const c = teamColor(team.sort_order);
  const live = view.trip.status !== "setup";

  const generate = async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    const r = await generateTeamNames({ code, exclude: [...otherNames, ...names], aiEnabled });
    if (seq !== reqSeq.current) return;
    setLoading(false);
    setNames(r.names);
    setSource(r.source);
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${team.name}?`,
      emoji: "💥",
      tone: "danger",
      confirmLabel: "Delete team",
      body:
        members.length > 0
          ? `${members.map((p) => displayName(p)).join(", ")} go back to Unassigned.`
          : live
            ? "Teams with scores or drinks can't be deleted. History is history."
            : "It's empty anyway. Nobody will miss it.",
    });
    if (!ok) return;
    if (dispatch({ type: "team.delete", team_id: teamId })) {
      toast.info(`${team.name} has been dissolved. Thoughts and prayers.`, { emoji: "💥" });
      onDeleted();
    }
  };

  const suggestions = teeTimeSuggestions(liveTeams(view), teamId);

  return (
    <div className="space-y-6 pt-1 pb-4" data-testid="team-form">
      <div className="flex items-center gap-3 rounded-2xl border-2 border-ink px-3 py-2" style={{ backgroundColor: c.soft }}>
        <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-full border-2 border-ink" style={{ backgroundColor: c.bg }} />
        <p className="min-w-0 flex-1 text-[15px] font-bold">
          {members.length === 0 ? "Nobody on this team yet." : members.map((p) => displayName(p)).join(", ")}
        </p>
      </div>

      <section className="space-y-3">
        <TextField
          label="Team name"
          value={name}
          maxLength={MAX_NAME_CHARS}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => saveName(name)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              saveName(name);
            }
          }}
          autoComplete="off"
          autoCapitalize="words"
          enterKeyHint="done"
          data-testid="team-name-input"
        />
        {/* Fixed-height slot: the "Saved" row appears on blur, i.e. on the pointerdown of whatever is
            tapped next. If it pushed the chips below down, that tap would land on nothing. */}
        <div className="h-14" role="status" data-testid="team-name-status">
          {renamedFrom && renamedFrom !== team.name ? (
            <div className="flex h-full items-center gap-2 rounded-xl border-2 border-fairway bg-fairway-soft pr-0.5 pl-3">
              <p className="min-w-0 flex-1 truncate text-[15px] font-extrabold">✅ Saved. Was “{renamedFrom}”</p>
              <Button variant="ghost" className="shrink-0" onClick={undoRename}>
                Undo
              </Button>
            </div>
          ) : (
            <p className="flex h-full items-center px-1 text-sm font-bold text-muted">Saves when you leave the field. Or roll some below.</p>
          )}
        </div>
        <Button
          variant="ghostbeer"
          size="lg"
          full
          loading={loading}
          onClick={generate}
          leading={names.length > 0 ? <IconRefresh size={22} strokeWidth={3} /> : <span aria-hidden="true">🎲</span>}
          data-testid="generate-names"
        >
          {names.length > 0 ? "Re-roll names" : "Generate names"}
        </Button>
        {loading && names.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-2 text-[15px] font-bold text-muted">
            <Spinner size={20} label="Thinking" /> Consulting the golf gods…
          </div>
        )}
        {names.length > 0 && (
          <div className={cx("space-y-2", loading && "opacity-50")} data-testid="name-suggestions">
            <p className="text-sm font-extrabold tracking-wider text-muted uppercase">
              {source === "ai" ? "Fresh from the AI. Tap one to take it" : "From the house list. Tap one to take it"}
            </p>
            {names.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => saveName(n)}
                className={cx(
                  "flex min-h-14 w-full items-center rounded-2xl border-2 px-4 text-left text-lg leading-tight font-black transition-transform active:scale-[0.98]",
                  team.name === n ? "border-ghost-dark bg-ghost text-white" : "border-ink bg-paper text-ink",
                )}
                aria-pressed={team.name === n}
                data-testid="name-suggestion"
              >
                {team.name === n ? "✓ " : ""}
                {n}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <label htmlFor={`tee-${teamId}`} className="block text-sm font-extrabold tracking-wider text-ink uppercase">
          Tee time
        </label>
        <div className="flex gap-2">
          <input
            id={`tee-${teamId}`}
            type="time"
            value={tee}
            onChange={(e) => setTee(e.target.value)}
            onBlur={() => saveTee(tee)}
            className="h-14 min-w-0 flex-1 rounded-xl border-2 border-ink bg-paper px-4 text-lg font-bold text-ink"
            data-testid="tee-time-input"
          />
          {tee && (
            <Button
              variant="secondary"
              className="shrink-0"
              onClick={() => {
                setTee("");
                saveTee("");
              }}
            >
              Clear
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <Chip
              key={s}
              selected={normalizeTeeTime(tee) === s}
              tone="ink"
              onClick={() => {
                setTee(s);
                saveTee(s);
              }}
            >
              {formatTeeTime(s)}
            </Chip>
          ))}
        </div>
      </section>

      <section className="border-t-2 border-line pt-4">
        <Button variant="danger" size="lg" full onClick={remove} data-testid="delete-team">
          Delete team
        </Button>
      </section>
    </div>
  );
}
