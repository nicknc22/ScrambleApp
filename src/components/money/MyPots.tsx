"use client";
// "Your pots": opt in / out of each pot while the trip is in setup; locked afterwards (the
// commissioner can still change anyone's opt-outs in Setup).
import type { PotKey } from "@/lib/types";
import type { PotView } from "@/lib/engine/types";
import { useClientState, useTripStore } from "@/lib/client/react";
import { formatCents } from "@/lib/engine/format";
import { Button, Card, IconLock, Toggle, cx, useToast } from "@/components/ui";
import { useShellNav } from "@/components/shell/nav";
import { myPots } from "./money";

export function MyPots({ pots }: { pots: readonly PotView[] }) {
  const store = useTripStore();
  const toast = useToast();
  const nav = useShellNav();
  const meId = useClientState((s) => s.meId);
  const status = useClientState((s) => s.view?.trip.status ?? "setup");
  const optouts = useClientState((s) => s.view?.pot_optouts ?? null);
  const isCommissioner = useClientState((s) => s.isCommissioner);

  if (!optouts) return null;

  if (!meId) {
    return (
      <Card tone="sand" className="space-y-3">
        <p className="text-lg font-black">Pick your name to see your pots.</p>
        <Button variant="hazard" full onClick={nav.switchPlayer}>
          Who are you?
        </Button>
      </Card>
    );
  }

  const rows = myPots({ pot_optouts: optouts }, pots, meId);
  const locked = status !== "setup";
  const inCount = rows.filter((r) => r.in).length;
  const myAntes = rows.filter((r) => r.in).reduce((s, r) => s + r.ante_cents, 0);

  const set = (key: PotKey, label: string, nextIn: boolean) => {
    const res = store.dispatch({ type: "pot.optout", pot_key: key, player_id: meId, out: !nextIn });
    if (!res.ok) {
      toast.error(res.reason, { title: "Nope" });
      return;
    }
    toast.show({
      id: `optout-${key}`,
      tone: "success",
      emoji: nextIn ? "💰" : "🐔",
      title: nextIn ? `You're in: ${label}` : `You're out: ${label}`,
      message: nextIn ? "Bold. Financially questionable, but bold." : "Bawk bawk. Your wallet thanks you.",
      action: {
        label: "Undo",
        onAction: () => {
          const undo = store.dispatch({ type: "pot.optout", pot_key: key, player_id: meId, out: nextIn });
          if (!undo.ok) toast.error(undo.reason, { title: "Couldn't undo" });
        },
      },
    });
  };

  return (
    <Card className="border-ink" data-testid="my-pots">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-lg leading-tight font-black">
            You&apos;re in {inCount} of {rows.length} {rows.length === 1 ? "pot" : "pots"}
          </p>
          <p className="num text-[15px] font-bold text-muted">
            {formatCents(myAntes)} {locked ? "in antes" : "on the line if everything plays out"}
          </p>
        </div>
        {locked && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border-2 border-ink bg-sand px-2.5 py-1 text-xs font-black uppercase">
            <IconLock size={14} strokeWidth={3} />
            Locked
          </span>
        )}
      </div>
      <p className="mt-2 text-sm leading-snug font-semibold text-muted">
        {locked
          ? "The round started, so your pots are locked in. Only the commissioner can change them now (Setup)."
          : "Everybody's in everything by default. Chicken out of a pot before the round starts."}
      </p>
      {locked ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Your pots">
          {rows.map((r) => (
            <li
              key={r.key}
              data-in={r.in || undefined}
              className={cx(
                "inline-flex min-h-9 items-center gap-1 rounded-full border-2 px-2.5 text-sm font-extrabold",
                r.in ? "border-fairway bg-fairway-soft text-fairway-dark" : "border-line bg-sand text-muted line-through",
              )}
            >
              <span aria-hidden="true">{r.emoji}</span>
              {r.key === "team_match" ? "Team match" : `Hole ${r.key.slice("contest:".length)}`}
              <span className="sr-only">{r.in ? " (in)" : " (out)"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-2 divide-y-2 divide-line">
          {rows.map((r) => (
            <li key={r.key}>
              <Toggle
                checked={r.in}
                onChange={(next) => set(r.key, r.label, next)}
                label={
                  <span>
                    <span aria-hidden="true">{r.emoji} </span>
                    {r.label}
                  </span>
                }
                description={r.ante_cents > 0 ? `${formatCents(r.ante_cents)} ante · ${r.in ? "you're in" : "chickened out"}` : `No ante · ${r.in ? "in" : "out"}`}
                className="py-1"
              />
            </li>
          ))}
        </ul>
      )}
      {locked && isCommissioner && (
        <Button variant="secondary" full className="mt-3" onClick={() => nav.setTab("setup")}>
          Change opt-outs in Setup
        </Button>
      )}
    </Card>
  );
}
