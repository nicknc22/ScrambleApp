"use client";
// Setup -> Roster in bulk: "Load the boys" (the default crew in one tap, Caster crowned) and
// "Add several at once" (paste a list, one name per line). Both are plain player.upsert ops, one
// per player, exactly like the quick-add field; one toast with a 10-second Undo for the batch.
// Like creating the trip with the crew (home page), Load the boys makes this phone the first name
// (the commissioner): the roster was empty, so it wasn't anybody yet.
import { useId, useMemo, useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { newId } from "@/lib/ids";
import {
  DEFAULT_ROSTER,
  bulkAddEntries,
  bulkAddToast,
  defaultRosterText,
  nameList,
  parseRosterText,
  planRosterAdds,
  type RosterPlayer,
} from "@/lib/roster";
import { BottomSheet, Button, Card, IconPlus, useToast } from "@/components/ui";
import { livePlayers } from "./model";
import { useSetupDispatch } from "./shared";

/** Add players in order; stops at the first refusal (already toasted). Returns the added ids. */
function useBulkPlayers() {
  const dispatch = useSetupDispatch();
  const add = (entries: readonly RosterPlayer[]): string[] => {
    const ids: string[] = [];
    for (const e of entries) {
      const id = newId();
      const op = dispatch({ type: "player.upsert", player: { id, name: e.name, ...(e.is_groom ? { is_groom: true } : {}) } });
      if (!op) break;
      ids.push(id);
    }
    return ids;
  };
  const undo = (ids: readonly string[]) => {
    for (const id of ids) if (!dispatch({ type: "player.delete", player_id: id })) break;
  };
  return { add, undo };
}

/** The first name on the default roster: the commissioner, whose phone this is. */
const FIRST = DEFAULT_ROSTER[0]?.name ?? null;

/** Empty roster: the whole crew in one tap. */
export function LoadTheBoysCard() {
  const store = useTripStore();
  const { add, undo } = useBulkPlayers();
  const toast = useToast();
  const load = () => {
    const entries = DEFAULT_ROSTER.map((p) => ({ name: p.name, is_groom: !!p.is_groom }));
    const ids = add(entries);
    if (ids.length === 0) return;
    // The roster was empty, so this phone wasn't anybody: it's the first name now (as when the trip
    // is created with the crew). Switch player changes it; Undo takes it back.
    const meId = ids[0];
    store.setMe(meId);
    const groom = entries.slice(0, ids.length).find((p) => p.is_groom);
    toast.show({
      tone: "success",
      emoji: "🍻",
      title: "The boys are in",
      // Short: the roster's subtitle already says how many.
      message: `${groom ? `👑 ${groom.name} crowned. ` : ""}This phone is ${entries[0].name}.`,
      id: "player-added",
      action: {
        label: "Undo",
        onAction: () => {
          undo(ids);
          if (store.getState().meId === meId) store.setMe(null);
        },
      },
    });
  };
  return (
    <Card tone="fairway" className="space-y-3" data-testid="load-the-boys">
      <div>
        <h3 className="text-2xl leading-tight font-black">Load the boys</h3>
        <p className="mt-1 text-[15px] font-bold">
          The whole crew in one tap{FIRST ? `, and this phone is ${FIRST}` : ""}. Fix anybody after.
        </p>
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label="The crew">
        {DEFAULT_ROSTER.map((p) => (
          <li
            key={p.name}
            className="max-w-full truncate rounded-full border-2 border-ink bg-paper px-3 py-1 text-base font-extrabold text-ink"
          >
            {p.is_groom && <span aria-hidden="true">👑 </span>}
            {p.name}
            {p.is_groom && <span className="sr-only"> (the groom)</span>}
          </li>
        ))}
      </ul>
      <Button size="xl" full onClick={load} data-testid="load-the-boys-button" leading={<span aria-hidden="true">🍻</span>}>
        Load all {DEFAULT_ROSTER.length}
      </Button>
    </Card>
  );
}

/** Paste a list: adds every name that isn't on the roster yet (case-insensitive). */
export function BulkAddSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Add several at once">
      {/* Mounted only while open: the textarea starts empty every time. */}
      <BulkAddForm onDone={onClose} />
    </BottomSheet>
  );
}

function BulkAddForm({ onDone }: { onDone: () => void }) {
  const id = useId();
  const view = useClientState((s) => s.view);
  const { add, undo } = useBulkPlayers();
  const toast = useToast();
  const [text, setText] = useState("");
  const players = useMemo(() => (view ? livePlayers(view) : []), [view]);
  const names = useMemo(() => parseRosterText(text), [text]);
  const plan = useMemo(() => planRosterAdds(players, names), [players, names]);
  const toAdd = plan.add;
  // The crew members not on the roster yet (offered as a one-tap fill).
  const crewMissing = useMemo(() => planRosterAdds(players, DEFAULT_ROSTER.map((p) => p.name)).add.length, [players]);

  const submit = () => {
    if (toAdd.length === 0) return;
    // No groom yet? Caster comes back crowned, as Load the boys adds him.
    const entries = bulkAddEntries(players, toAdd);
    const ids = add(entries);
    if (ids.length === 0) return; // refused (toasted): keep the list so nothing is lost
    onDone();
    const t = bulkAddToast(ids.length, plan.skipped, players.length + ids.length);
    const crowned = entries.slice(0, ids.length).find((e) => e.is_groom);
    toast.show({
      tone: "success",
      emoji: "🏌️",
      title: t.title,
      message: crowned ? `👑 ${crowned.name} crowned. ${t.message}` : t.message,
      id: "player-added",
      action: { label: "Undo", onAction: () => undo(ids) },
    });
  };

  let preview: string;
  if (names.length === 0) preview = "One name per line (or commas). Anybody already on the roster gets skipped.";
  else if (toAdd.length === 0) preview = "Everybody on that list is already on the roster.";
  else {
    preview = `Adding ${nameList(toAdd)}.`;
    if (plan.skipped.length > 0) preview += ` Skipping ${nameList(plan.skipped)} (already on it).`;
  }

  return (
    <form
      className="space-y-3 pb-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor={`${id}-names`} className="sr-only">
        Names, one per line
      </label>
      <textarea
        id={`${id}-names`}
        data-autofocus
        data-testid="bulk-add-names"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={7}
        autoComplete="off"
        autoCapitalize="words"
        spellCheck={false}
        placeholder={"Joe\nGreg\nRich"}
        aria-describedby={`${id}-preview`}
        className="block min-h-40 w-full min-w-0 resize-y rounded-xl border-2 border-ink bg-paper px-4 py-3 text-lg leading-snug font-bold break-words text-ink placeholder:font-semibold placeholder:text-muted/80"
      />
      <p id={`${id}-preview`} aria-live="polite" className="text-[15px] leading-snug font-bold text-muted" data-testid="bulk-add-preview">
        {preview}
      </p>
      {crewMissing > 0 && text.trim() === "" && (
        <button
          type="button"
          onClick={() => setText(defaultRosterText())}
          className="min-h-12 text-left text-[15px] font-extrabold text-fairway-dark underline underline-offset-4"
          data-testid="bulk-add-crew"
        >
          Fill in the crew ({crewMissing} missing)
        </button>
      )}
      <Button
        type="submit"
        size="xl"
        full
        disabled={toAdd.length === 0}
        leading={<IconPlus size={24} strokeWidth={3.2} />}
        data-testid="bulk-add-submit"
      >
        {toAdd.length === 0 ? "Add them" : `Add ${toAdd.length}`}
      </Button>
    </form>
  );
}
