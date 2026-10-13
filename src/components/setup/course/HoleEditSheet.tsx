"use client";
// Edit one hole's card data (par, stroke index, yardage). One Save = one hole.update with only
// the changed fields, so a live round gets one "Commissioner override" post, not ten.
import { useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { contestForPar } from "@/lib/course";
import type { Hole } from "@/lib/types";
import { Badge, BottomSheet, Button, Stepper, cx, useConfirm, useToast } from "@/components/ui";
import {
  TEE_SETS,
  TEE_SET_LABEL,
  contestLabel,
  draftErrors,
  draftOf,
  formatPoint,
  greenOf,
  holeDraftPatch,
  teeOf,
  type HoleDraft,
} from "./courseModel";

export interface HoleEditSheetProps {
  hole: Hole | null;
  onClose: () => void;
  onPlaceOnMap: (hole: number) => void;
}

export function HoleEditSheet({ hole, onClose, onPlaceOnMap }: HoleEditSheetProps) {
  if (!hole) return null;
  // key: a fresh draft for each hole opened.
  return <HoleEditBody key={hole.id} hole={hole} onClose={onClose} onPlaceOnMap={onPlaceOnMap} />;
}

function HoleEditBody({ hole, onClose, onPlaceOnMap }: { hole: Hole; onClose: () => void; onPlaceOnMap: (hole: number) => void }) {
  const store = useTripStore();
  const view = useClientState((s) => s.view);
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<HoleDraft>(() => draftOf(hole));
  const [yardText, setYardText] = useState<Record<string, string>>(() =>
    Object.fromEntries(TEE_SETS.map((t) => [t, String(hole.yardage[t] ?? "")])),
  );

  const errors = draftErrors(draft);
  const patch = holeDraftPatch(hole, draft);
  const dirty = Object.keys(patch).length > 0;
  const hasErrors = Object.keys(errors).length > 0;
  const live = view?.trip.status === "live" || view?.trip.status === "final";
  const nextContest = draft.par !== hole.par ? contestForPar(draft.par) : hole.contest;
  const contest = contestLabel(nextContest);
  const otherSi = (view?.holes ?? []).filter((h) => h.number !== hole.number && h.stroke_index === draft.stroke_index).map((h) => h.number);
  const tee = teeOf(hole);
  const green = greenOf(hole);

  const save = async () => {
    if (!dirty || hasErrors) return;
    if (nextContest !== hole.contest && live) {
      const entries = (view?.contest_entries ?? []).filter((e) => e.hole === hole.number && e.deleted_at === null).length;
      const ok = await confirm({
        title: `Make hole ${hole.number} a par ${draft.par}?`,
        body:
          entries > 0
            ? `That changes the contest to ${contest ?? "none"}, and the ${entries} existing entr${entries === 1 ? "y" : "ies"} stop counting. Everyone sees this in the feed.`
            : `The contest becomes ${contest ?? "none"}. Everyone sees this in the feed.`,
        emoji: "⚠️",
        confirmLabel: "Change par",
        tone: "hazard",
      });
      if (!ok) return;
    }
    const r = store.dispatch({ type: "hole.update", hole: hole.number, patch });
    if (!r.ok) {
      toast.error(r.reason);
      return;
    }
    toast.success(`Hole ${hole.number} updated.`, { emoji: "📝" });
    onClose();
  };

  const clearPoint = async (kind: "tee" | "green") => {
    const ok = await confirm({
      title: `Remove hole ${hole.number}'s ${kind} point?`,
      body: kind === "tee" && hole.contest === "ld" ? "Long drives on this hole can't be measured without it." : "You can drop a new one on the map any time.",
      emoji: "🧹",
      confirmLabel: "Remove it",
      tone: "danger",
    });
    if (!ok) return;
    const r = store.dispatch({
      type: "hole.update",
      hole: hole.number,
      patch: kind === "tee" ? { tee_lat: null, tee_lng: null } : { green_lat: null, green_lng: null },
    });
    if (!r.ok) toast.error(r.reason);
    else toast.info(`Hole ${hole.number} ${kind} point removed.`);
  };

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={`Hole ${hole.number}`}
      footer={
        <Button variant="primary" size="xl" full disabled={!dirty || hasErrors} onClick={() => void save()} data-testid="hole-save">
          {dirty ? `Save hole ${hole.number}` : "No changes"}
        </Button>
      }
    >
      <div className="space-y-5 pt-1 pb-2">
        <section>
          <h3 className="mb-2 text-sm font-extrabold tracking-wider text-ink uppercase">Par</h3>
          <div className="grid grid-cols-4 gap-2" role="group" aria-label="Par">
            {[3, 4, 5, 6].map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={draft.par === p}
                onClick={() => setDraft((d) => ({ ...d, par: p }))}
                className={cx(
                  "num min-h-14 rounded-2xl border-2 text-2xl font-black transition-transform active:scale-[0.96]",
                  draft.par === p ? "border-fairway-dark bg-fairway text-white shadow-hard-sm" : "border-ink bg-paper text-ink",
                )}
              >
                {p}
              </button>
            ))}
          </div>
          <p className="mt-2 flex items-center gap-2 text-sm font-bold text-muted">
            Contest:
            {contest ? <Badge tone={nextContest === "ld" ? "sky" : "ghost"}>{contest}</Badge> : <span>none</span>}
            <span className="font-semibold">(par 3 = closest to pin, par 5 = long drive)</span>
          </p>
        </section>

        <section>
          <Stepper
            size="lg"
            label="Stroke index"
            value={draft.stroke_index}
            min={1}
            max={18}
            onChange={(v) => setDraft((d) => ({ ...d, stroke_index: v }))}
            decrementLabel="Lower stroke index"
            incrementLabel="Higher stroke index"
            hint={otherSi.length > 0 ? `Hole ${otherSi.join(", ")} also has SI ${draft.stroke_index}` : "1 = hardest hole"}
          />
        </section>

        <section>
          <h3 className="mb-2 text-sm font-extrabold tracking-wider text-ink uppercase">Yardage (display only)</h3>
          <div className="grid grid-cols-3 gap-2">
            {TEE_SETS.map((t) => (
              <label key={t} className="flex min-w-0 flex-col gap-1">
                <span className={cx("truncate text-xs font-extrabold tracking-wide uppercase", view?.trip.settings.tee_set === t ? "text-fairway-dark" : "text-muted")}>
                  {TEE_SET_LABEL[t]}
                  {view?.trip.settings.tee_set === t ? " ★" : ""}
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={yardText[t]}
                  aria-label={`${TEE_SET_LABEL[t]} yardage`}
                  aria-invalid={errors[t] ? true : undefined}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, "").slice(0, 4);
                    setYardText((y) => ({ ...y, [t]: raw }));
                    setDraft((d) => ({ ...d, yardage: { ...d.yardage, [t]: raw === "" ? NaN : Number(raw) } }));
                  }}
                  className={cx(
                    "num h-14 w-full min-w-0 rounded-xl border-2 bg-paper px-3 text-center text-xl font-black text-ink",
                    errors[t] ? "border-flag" : "border-ink",
                  )}
                />
              </label>
            ))}
          </div>
          {TEE_SETS.some((t) => errors[t]) && <p className="mt-1 text-sm font-bold text-flag">Yardage is 0 to 1000.</p>}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-extrabold tracking-wider text-ink uppercase">Map points</h3>
          {(["tee", "green"] as const).map((k) => {
            const p = k === "tee" ? tee : green;
            return (
              <div key={k} className="flex min-h-12 items-center gap-2 rounded-xl bg-sand px-3 py-1.5">
                <span className="text-xl" aria-hidden="true">
                  {k === "tee" ? "⛳" : "🚩"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-extrabold uppercase">{k}</span>
                  <span className={cx("num block truncate text-sm font-semibold", p ? "text-ink" : "text-muted")}>{formatPoint(p)}</span>
                </span>
                {p && (
                  <Button variant="ghost" className="underline" onClick={() => void clearPoint(k)}>
                    Remove
                  </Button>
                )}
              </div>
            );
          })}
          {hole.contest === "ld" && !tee && (
            <p className="rounded-xl border-2 border-ink bg-hazard px-3 py-2 text-sm font-extrabold">⚠️ Long drive needs this tee point.</p>
          )}
          <Button variant="secondary" size="lg" full leading={<span aria-hidden="true">🛰️</span>} onClick={() => onPlaceOnMap(hole.number)}>
            Place on the satellite map
          </Button>
        </section>
      </div>
    </BottomSheet>
  );
}
