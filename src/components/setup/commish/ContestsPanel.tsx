"use client";
// Contest review: the queue (flagged, weak GPS, out of range, AI-suspicious) and every entry by
// hole. Approve, flag, set the official distance, or delete. Plus "Add entry": a typed-in
// distance for anyone (day-of fallback: a dead phone, measuring closed, another team's player).
import { useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { newId } from "@/lib/ids";
import type { ContestEntryView } from "@/lib/engine/types";
import type { UUID } from "@/lib/types";
import { Badge, BottomSheet, Button, Chip, EmptyState, IconPlus, PlayerName, TeamPill, cx, displayName, useConfirm, useToast } from "@/components/ui";
import {
  addEntryInput,
  entryStatusLabel,
  feetFromParts,
  formatDistance,
  partsFromFeet,
  reviewItems,
  reviewQueue,
  reviewReasons,
  yardsFromText,
  type ReviewItem,
} from "./commishModel";
import { useCommishDispatch } from "./shared";

const KIND_LABEL = { ctp: "Closest to pin", ld: "Long drive" } as const;

export function ContestsPanel({ focusEntryId }: { focusEntryId?: string } = {}) {
  const derived = useClientState((s) => s.derived);
  const [selected, setSelected] = useState<string | null>(focusEntryId ?? null);
  const [adding, setAdding] = useState(false);
  if (!derived) return null;

  const queue = reviewQueue(derived.contests);
  const all = reviewItems(derived.contests);
  const current = selected ? (all.find((i) => i.view.entry.id === selected) ?? null) : null;

  return (
    <div className="space-y-5" data-testid="commish-contests">
      {derived.contests.length > 0 && (
        <Button variant="primary" size="lg" full onClick={() => setAdding(true)} leading={<IconPlus size={22} strokeWidth={3} />} data-testid="commish-add-entry">
          Add an entry
        </Button>
      )}
      <section className="space-y-2">
        <h3 className="flex items-center gap-2 text-lg font-black uppercase">
          Review queue
          <Badge tone={queue.length > 0 ? "flag" : "fairway"} size="md">
            {queue.length}
          </Badge>
        </h3>
        {queue.length === 0 ? (
          <p className="rounded-2xl bg-fairway-soft px-3 py-3 text-base font-bold">Queue&apos;s clean. Suspiciously clean. 🧐</p>
        ) : (
          <ul className="space-y-2">
            {queue.map((i) => (
              <li key={i.view.entry.id}>
                <EntryCard item={i} onOpen={() => setSelected(i.view.entry.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-lg font-black uppercase">Every entry</h3>
        {derived.contests.every((c) => c.entries.length === 0) && (
          <EmptyState emoji="📏" title="No entries yet" className="py-4">
            Nobody has measured anything. Yet.
          </EmptyState>
        )}
        {derived.contests
          .filter((c) => c.entries.length > 0)
          .map((c) => (
            <div key={c.hole} className="space-y-1.5">
              <p className="text-sm font-extrabold tracking-wider text-muted uppercase">
                Hole {c.hole} · {KIND_LABEL[c.type]}
              </p>
              <ul className="space-y-1.5">
                {all
                  .filter((i) => i.hole === c.hole)
                  .map((i) => (
                    <li key={i.view.entry.id}>
                      <EntryRow item={i} onOpen={() => setSelected(i.view.entry.id)} />
                    </li>
                  ))}
              </ul>
            </div>
          ))}
      </section>

      {current && <EntrySheet key={current.view.entry.id} item={current} onClose={() => setSelected(null)} />}
      {adding && <AddEntrySheet onClose={() => setAdding(false)} />}
    </div>
  );
}

/** A contest entry the commissioner types in for anyone: no GPS, no photo, the distance as given. */
function AddEntrySheet({ onClose }: { onClose: () => void }) {
  const derived = useClientState((s) => s.derived);
  const dispatch = useCommishDispatch();
  const toast = useToast();
  const [hole, setHole] = useState<number | null>(derived?.contests[0]?.hole ?? null);
  const [playerId, setPlayerId] = useState<UUID | null>(null);
  const [ft, setFt] = useState("");
  const [inches, setInches] = useState("");
  const [yd, setYd] = useState("");
  if (!derived) return null;
  const contest = derived.contests.find((c) => c.hole === hole) ?? null;
  const type = contest?.type ?? null;
  const distance = type === "ctp" ? feetFromParts(ft, inches) : type === "ld" ? yardsFromText(yd) : null;
  const player = playerId ? (derived.playerById[playerId] ?? null) : null;
  const draft = { hole, type, playerId, distance };
  const ready = addEntryInput(draft, "") !== null;
  const existing = contest && playerId ? (contest.entries.find((v) => v.player_id === playerId) ?? null) : null;

  const add = () => {
    const input = addEntryInput(draft, newId());
    if (!input || !contest || distance === null) return;
    if (!dispatch(input)) return;
    toast.success(`${displayName(player)}: ${formatDistance(distance, contest.type === "ctp" ? "ft" : "yd")} on hole ${contest.hole}. The feed knows.`, {
      emoji: "📏",
      title: "Entry added",
    });
    onClose();
  };

  return (
    <BottomSheet
      open
      onClose={onClose}
      title="Add an entry"
      size="tall"
      footer={
        <Button variant="primary" size="xl" full disabled={!ready} onClick={add} data-testid="commish-add-entry-save">
          {!player ? "Pick a player" : distance === null ? "Enter the distance" : `Add ${formatDistance(distance, type === "ctp" ? "ft" : "yd")}`}
        </Button>
      }
    >
      <div className="space-y-5 pt-1 pb-2" data-testid="commish-add-entry-sheet">
        <p className="text-[15px] font-bold text-muted">
          For a shot the app never measured: a dead phone, measuring already closed, or someone on another team. No GPS, no photo: the
          distance you type is official. Posts a Commissioner override.
        </p>
        <section className="space-y-2">
          <h3 className="text-sm font-extrabold tracking-wider uppercase">Hole</h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Contest hole">
            {derived.contests.map((c) => (
              <Chip key={c.hole} tone="ink" selected={hole === c.hole} onClick={() => setHole(c.hole)}>
                {c.hole} · {c.type === "ctp" ? "CTP" : "Long drive"}
              </Chip>
            ))}
          </div>
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-extrabold tracking-wider uppercase">Who</h3>
          {derived.teams.map((t) => (
            <div key={t.id} className="space-y-1.5">
              <TeamPill team={t} size="sm" />
              <div className="flex flex-wrap gap-2" role="group" aria-label={`${t.name} players`}>
                {(derived.membersOfTeam[t.id] ?? []).map((p) => (
                  <Chip key={p.id} selected={playerId === p.id} onClick={() => setPlayerId(p.id)}>
                    <PlayerName player={p} />
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </section>
        {type && (
          <section className="space-y-2 rounded-2xl border-2 border-ink p-3">
            <h4 className="text-sm font-extrabold tracking-wider uppercase">{type === "ctp" ? "Distance to the pin" : "Drive"}</h4>
            {type === "ctp" ? (
              <div className="flex items-end gap-2">
                <NumBox label="Feet" value={ft} onChange={setFt} max={3} />
                <NumBox label="Inches" value={inches} onChange={setInches} max={2} />
              </div>
            ) : (
              <NumBox label="Yards" value={yd} onChange={setYd} max={3} />
            )}
          </section>
        )}
        {existing && (
          <p className="rounded-xl border-2 border-ink bg-hazard-soft px-3 py-2 text-[15px] font-bold" role="status">
            Replaces {displayName(player)}&apos;s {formatDistance(existing.distance, existing.unit)} on hole {contest?.hole}, like a re-measure.
          </p>
        )}
      </div>
    </BottomSheet>
  );
}

function EntryCard({ item, onOpen }: { item: ReviewItem; onOpen: () => void }) {
  const derived = useClientState((s) => s.derived);
  const v = item.view;
  const player = derived?.playerById[v.player_id] ?? null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-2xl border-2 border-flag bg-flag-soft p-3 text-left active:scale-[0.99]"
      data-testid="commish-review-item"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-lg font-black">
          <PlayerName player={player} />
        </span>
        <span className="num shrink-0 text-2xl font-black">{formatDistance(v.distance, v.unit)}</span>
      </div>
      <p className="text-sm font-extrabold text-muted">
        Hole {item.hole} · {KIND_LABEL[v.type]} · {entryStatusLabel(v.entry)}
      </p>
      <ul className="mt-1 space-y-0.5">
        {item.reasons.map((r) => (
          <li key={r} className="text-sm font-bold text-flag-dark">
            🚩 {r}
          </li>
        ))}
      </ul>
    </button>
  );
}

function EntryRow({ item, onOpen }: { item: ReviewItem; onOpen: () => void }) {
  const derived = useClientState((s) => s.derived);
  const v = item.view;
  const player = derived?.playerById[v.player_id] ?? null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx(
        "flex min-h-14 w-full items-center gap-3 rounded-xl border-2 px-3 text-left active:scale-[0.99]",
        item.needsReview ? "border-flag bg-paper" : v.rank === 1 ? "border-gold bg-hazard-soft" : "border-line bg-paper",
      )}
    >
      <span className="num w-8 shrink-0 text-center text-lg font-black">{v.rank ? (v.rank === 1 ? "🏆" : v.rank) : "–"}</span>
      <span className="min-w-0 flex-1 truncate text-base font-extrabold">
        <PlayerName player={player} />
      </span>
      {v.suspicious && <span aria-label="AI suspicious">🤖</span>}
      {v.entry.distance_override !== null && <Badge tone="ink">Official</Badge>}
      {v.entry.status !== "ok" && <Badge tone={v.entry.status === "flagged" ? "flag" : "fairway"}>{entryStatusLabel(v.entry)}</Badge>}
      <span className={cx("num shrink-0 text-lg font-black", !v.valid && "text-muted line-through")}>{formatDistance(v.distance, v.unit)}</span>
    </button>
  );
}

function EntrySheet({ item, onClose }: { item: ReviewItem; onClose: () => void }) {
  const derived = useClientState((s) => s.derived);
  const store = useTripStore();
  const dispatch = useCommishDispatch();
  const toast = useToast();
  const confirm = useConfirm();
  const v: ContestEntryView = item.view;
  const e = v.entry;
  const player = derived?.playerById[v.player_id] ?? null;
  const team = derived?.teamById[v.team_id] ?? null;
  const photo = store.photoUrl(e.photo_path);
  const reasons = reviewReasons(v);
  const start = e.distance_override ?? v.distance;
  const parts = partsFromFeet(start);
  const [ft, setFt] = useState(v.unit === "ft" ? String(parts.ft) : "");
  const [inches, setInches] = useState(v.unit === "ft" ? String(parts.inches) : "");
  const [yd, setYd] = useState(v.unit === "yd" ? String(Math.round(start)) : "");
  const official = v.unit === "ft" ? feetFromParts(ft, inches) : yardsFromText(yd);

  const review = (status: "ok" | "flagged" | "overridden", distance_override?: number | null, msg?: string) => {
    if (dispatch({ type: "contest.review", entry_id: e.id, status, ...(distance_override !== undefined ? { distance_override } : {}) })) {
      toast.success(msg ?? "Done. The feed has been informed.", { emoji: "⚖️" });
      onClose();
    }
  };

  const del = async () => {
    const ok = await confirm({
      title: "Delete this entry?",
      body: "It stops counting immediately. The player can re-measure.",
      emoji: "🗑️",
      confirmLabel: "Delete entry",
      tone: "danger",
    });
    if (!ok) return;
    if (dispatch({ type: "contest.delete", entry_id: e.id, as_commissioner: true })) {
      toast.success("Entry deleted. Leaderboard redone.", { emoji: "🧹" });
      onClose();
    }
  };

  return (
    <BottomSheet
      open
      onClose={onClose}
      size="tall"
      title={
        <span>
          Hole {item.hole} <span className="text-base font-extrabold text-muted">{KIND_LABEL[v.type]}</span>
        </span>
      }
    >
      <div className="space-y-4 pt-1 pb-2" data-testid="commish-entry-sheet">
        <div className="flex items-start gap-3">
          {photo ? (
            <a href={photo} target="_blank" rel="noreferrer" className="shrink-0" aria-label="Open the photo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo} alt="Entry photo" className="h-28 w-28 rounded-2xl border-2 border-ink object-cover" />
            </a>
          ) : (
            <span className="flex h-28 w-28 shrink-0 items-center justify-center rounded-2xl border-2 border-line bg-sand text-center text-sm font-bold text-muted">
              No photo
            </span>
          )}
          <div className="min-w-0 space-y-1">
            <p className="text-xl leading-tight font-black">
              <PlayerName player={player} />
            </p>
            <TeamPill team={team} size="sm" />
            <p className="num text-4xl leading-none font-black">{formatDistance(v.distance, v.unit)}</p>
            <p className="text-sm font-bold text-muted">
              {v.valid ? (v.rank === 1 ? "Leading 🏆" : v.rank ? `Ranked ${v.rank}` : "Counts") : "Doesn't count"} · {entryStatusLabel(e)}
            </p>
          </div>
        </div>

        <dl className="space-y-1 rounded-2xl bg-sand p-3 text-[15px] font-semibold">
          <Fact label="Entered" value={formatDistance(e.distance_value, e.unit)} />
          {e.distance_override !== null && <Fact label="Official (yours)" value={formatDistance(e.distance_override, e.unit)} />}
          {v.type === "ld" && e.gps_accuracy_m !== null && <Fact label="GPS accuracy" value={`±${Math.round(e.gps_accuracy_m)} m${e.low_accuracy ? " (weak)" : ""}`} />}
          {e.ai_estimate_ft !== null && (
            <Fact label="AI judge" value={`~${formatDistance(e.ai_estimate_ft, "ft")} (${e.ai_confidence ?? "?"} confidence)`} />
          )}
        </dl>
        {e.ai_roast && <p className="rounded-2xl border-2 border-ink bg-hazard-soft px-3 py-2 text-base font-bold">🤖 “{e.ai_roast}”</p>}
        {reasons.length > 0 && (
          <ul className="space-y-1">
            {reasons.map((r) => (
              <li key={r} className="text-base font-extrabold text-flag-dark">
                🚩 {r}
              </li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button variant="primary" size="lg" onClick={() => review("overridden", undefined, "Approved. It counts.")} disabled={e.status === "overridden"}>
            ✅ Approve
          </Button>
          <Button variant="hazard" size="lg" onClick={() => review("flagged", undefined, "Flagged. It doesn't count until you say so.")} disabled={e.status === "flagged"}>
            🚩 Flag
          </Button>
        </div>
        {e.status !== "ok" && (
          <Button variant="ghost" full className="underline" onClick={() => review("ok", undefined, "Back to normal rules.")}>
            Reset to normal (no ruling)
          </Button>
        )}

        <section className="space-y-2 rounded-2xl border-2 border-ink p-3">
          <h4 className="text-sm font-extrabold tracking-wider uppercase">Official distance</h4>
          {v.unit === "ft" ? (
            <div className="flex items-end gap-2">
              <NumBox label="Feet" value={ft} onChange={setFt} max={3} />
              <NumBox label="Inches" value={inches} onChange={setInches} max={2} />
            </div>
          ) : (
            <NumBox label="Yards" value={yd} onChange={setYd} max={3} />
          )}
          <Button
            variant="ink"
            size="lg"
            full
            disabled={official === null}
            onClick={() => review("overridden", official, `Official: ${formatDistance(official ?? 0, v.unit)}. Approved.`)}
          >
            Set {official === null ? "distance" : formatDistance(official, v.unit)} & approve
          </Button>
          {e.distance_override !== null && (
            <Button variant="ghost" full className="underline" onClick={() => review(e.status, null, "Official distance cleared.")}>
              Clear the official distance
            </Button>
          )}
        </section>

        <Button variant="danger" size="lg" full onClick={() => void del()}>
          Delete entry
        </Button>
      </div>
    </BottomSheet>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="num text-right font-extrabold text-ink">{value}</dd>
    </div>
  );
}

function NumBox({ label, value, onChange, max }: { label: string; value: string; onChange: (v: string) => void; max: number }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-xs font-extrabold tracking-wide uppercase">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, "").slice(0, max))}
        className="num h-14 w-full rounded-xl border-2 border-ink bg-paper px-3 text-center text-2xl font-black"
      />
    </label>
  );
}
