"use client";
// Pots: team match ante + payout rule (winner take all or a 1st/2nd split), contest ante per
// hole, max exposure per player, and the opt-out matrix (players × pots). Antes save on blur /
// Enter / chip tap; the split stepper saves after you stop tapping.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useClientState } from "@/lib/client/react";
import { formatCents } from "@/lib/engine/format";
import type { Hole, Player, PotKey, TripSettings } from "@/lib/types";
import { BottomSheet, Button, Card, Chip, SectionHeader, Stepper, Toggle, cx, displayName, useToast } from "@/components/ui";
import {
  centsToInput,
  contestHoles,
  firstShare,
  livePlayers,
  maxExposureCents,
  optKey,
  optOutSet,
  parseDollars,
  payoutLabel,
  payoutMode,
  potKeys,
  potLongLabel,
  potShortLabel,
  splitPayout,
  teamIdByPlayer,
} from "./model";
import { Group, useSetupDispatch } from "./shared";

const TEAM_ANTE_CHIPS = [0, 1000, 2000, 5000];
const CONTEST_ANTE_CHIPS = [0, 200, 500, 1000];

export function PotsSection() {
  const view = useClientState((s) => s.view);
  const dispatch = useSetupDispatch();
  const toast = useToast();
  const [playerPots, setPlayerPots] = useState<string | null>(null);
  if (!view) return null;

  const st = view.trip.settings;
  const holes = contestHoles(view.holes);
  const players = livePlayers(view);
  const onTeam = teamIdByPlayer(view);
  const exposure = maxExposureCents(st, holes.length);
  const mode = payoutMode(st.team_match_payout);
  const live = view.trip.status !== "setup";
  const outs = optOutSet(view);
  const tmIn = players.filter((p) => onTeam.has(p.id) && !outs.has(optKey("team_match", p.id))).length;

  const saveSettings = (settings: Partial<TripSettings>, msg: string, emoji = "💰") => {
    if (dispatch({ type: "trip.update", patch: { settings } })) toast.success(msg, { emoji, id: "pots-saved" });
  };

  const setTeamAnte = (cents: number) => {
    if (cents === st.team_match_ante_cents) return;
    saveSettings({ team_match_ante_cents: cents }, cents > 0 ? `Team match: ${formatCents(cents)} a head.` : "Team match is for pride only.");
  };
  const setContestAnte = (cents: number) => {
    if (cents === st.contest_ante_cents) return;
    saveSettings({ contest_ante_cents: cents }, cents > 0 ? `Contests: ${formatCents(cents)} a hole.` : "Contests are free. Cheap.");
  };
  const setPayout = (payout: number[]) => {
    if (payout.join("/") === st.team_match_payout.join("/")) return;
    saveSettings({ team_match_payout: payout }, `Payout: ${payoutLabel(payout)}.`, payout.length > 1 ? "🥈" : "🏆");
  };

  return (
    <div className="space-y-4" data-testid="setup-pots">
      <SectionHeader title="Pots" subtitle="Virtual money. The app never touches it; Venmo does at the end." />

      {live && (
        <Card tone="hazard" className="text-[15px] font-bold">
          The round is live. Changing antes or opt-outs changes everyone&apos;s projected money right now.
        </Card>
      )}

      <section
        className="rounded-3xl border-2 border-ink px-5 py-4 text-white shadow-hard"
        style={{ background: "radial-gradient(circle at 85% 0%, #19ad5c 0%, #0a7d3e 45%, #064d27 100%)" }}
        data-testid="exposure"
      >
        <p className="text-sm font-black tracking-[0.14em] uppercase">Each player is in for up to</p>
        <p className="loud num mt-1 text-6xl text-hazard" style={{ textShadow: "0 3px 0 rgba(0,0,0,0.35)" }} data-testid="exposure-amount">
          {formatCents(exposure)}
        </p>
        <p className="mt-1 text-[15px] font-bold">
          {formatCents(st.team_match_ante_cents)} team match + {formatCents(st.contest_ante_cents)} × {holes.length} contest holes
        </p>
      </section>

      <Group title="Team match">
        <MoneyField label="Ante per player" cents={st.team_match_ante_cents} onCommit={setTeamAnte} testId="team-ante" />
        <QuickAmounts amounts={TEAM_ANTE_CHIPS} value={st.team_match_ante_cents} onPick={setTeamAnte} />
        <div className="space-y-2 pt-1">
          <p className="text-sm font-extrabold tracking-wider uppercase">Payout</p>
          <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
            <Chip selected={mode === "winner"} tone="ink" onClick={() => setPayout([100])} className="justify-center" data-testid="payout-winner">
              🏆 Winner takes all
            </Chip>
            <Chip
              selected={mode === "split"}
              tone="ink"
              onClick={() => setPayout(splitPayout(firstShare(st.team_match_payout)))}
              className="justify-center"
              data-testid="payout-split"
            >
              🥇🥈 1st / 2nd split
            </Chip>
          </div>
          {mode === "split" && <SplitStepper payout={st.team_match_payout} onCommit={setPayout} />}
          <p className="text-sm font-bold text-muted">
            {formatCents(st.team_match_ante_cents * tmIn)} pot with {tmIn} in.{" "}
            {mode === "split" ? "2nd place gets the rest." : "Winning team splits it evenly."} Tied teams split their places.
          </p>
        </div>
      </Group>

      <Group title={`Contest holes (${holes.length})`}>
        <MoneyField label="Ante per player, per contest hole" cents={st.contest_ante_cents} onCommit={setContestAnte} testId="contest-ante" />
        <QuickAmounts amounts={CONTEST_ANTE_CHIPS} value={st.contest_ante_cents} onPick={setContestAnte} />
        <p className="text-sm font-bold text-muted">
          {holes.map((h) => `#${h.number} ${h.contest === "ctp" ? "CTP" : "LD"}`).join(" · ")}. Winner takes the hole&apos;s pot, ties split, empty pots roll
          to the next hole of the same kind, then into the team match.
        </p>
      </Group>

      <OptOutMatrix holes={view.holes} players={players} outs={outs} onPlayer={setPlayerPots} />
      <PlayerPotsSheet playerId={playerPots} onClose={() => setPlayerPots(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function MoneyField({ label, cents, onCommit, testId }: { label: string; cents: number; onCommit: (cents: number) => void; testId?: string }) {
  const [text, setText] = useState(() => centsToInput(cents));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = focused ? text : centsToInput(cents);
  const commit = () => {
    const c = parseDollars(text);
    if (c === null) {
      setError("Dollars and cents only, like 20 or 12.50.");
      setText(centsToInput(cents));
      return;
    }
    setError(null);
    onCommit(c);
  };
  const id = `money-${testId ?? label}`;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Blurring commits (onBlur); only commit directly if the field somehow isn't focused.
    const el = document.getElementById(id);
    if (el && document.activeElement === el) el.blur();
    else commit();
  };
  return (
    <form onSubmit={onSubmit} noValidate>
      <label htmlFor={id} className="text-sm font-extrabold tracking-wider uppercase">
        {label}
      </label>
      <div className="relative mt-1.5">
        <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-2xl font-black">
          $
        </span>
        <input
          id={id}
          data-testid={testId}
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          value={shown}
          onFocus={(e) => {
            setText(centsToInput(cents));
            setFocused(true);
            e.currentTarget.select();
          }}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onBlur={() => {
            commit();
            setFocused(false);
          }}
          aria-invalid={error ? true : undefined}
          className={cx(
            "num h-16 w-full min-w-0 rounded-xl border-2 bg-paper pr-4 pl-10 text-3xl font-black text-ink",
            error ? "border-flag" : "border-ink",
          )}
        />
      </div>
      {error && <p className="mt-1 text-sm font-bold text-flag">{error}</p>}
    </form>
  );
}

function QuickAmounts({ amounts, value, onPick }: { amounts: number[]; value: number; onPick: (cents: number) => void }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {amounts.map((a) => (
        <Chip key={a} selected={value === a} tone="fairway" showCheck={false} onClick={() => onPick(a)} className="justify-center px-2">
          {a === 0 ? "$0" : formatCents(a)}
        </Chip>
      ))}
    </div>
  );
}

/** 1st-place share in 5% steps (2nd gets the rest). Saves 600 ms after the last tap. */
function SplitStepper({ payout, onCommit }: { payout: number[]; onCommit: (p: number[]) => void }) {
  const saved = firstShare(payout);
  const [first, setFirst] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  });
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      setDirty(false);
      commitRef.current(splitPayout(first));
    }, 600);
    return () => clearTimeout(t);
  }, [first, dirty]);
  const shown = dirty ? first : saved;
  return (
    <div className="rounded-2xl border-2 border-ink bg-sand px-2 py-3" data-testid="split-stepper">
      <Stepper
        size="lg"
        value={shown}
        min={50}
        max={95}
        step={5}
        label="1st / 2nd"
        format={(v) => (
          <span>
            {v}
            <span className="text-muted">/</span>
            {100 - v}
          </span>
        )}
        hint={dirty ? "Saving…" : "Percent of the pot"}
        decrementLabel="Less for 1st place"
        incrementLabel="More for 1st place"
        onChange={(v) => {
          setFirst(v);
          setDirty(true);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------

function OptOutMatrix({ holes, players, outs, onPlayer }: { holes: Hole[]; players: Player[]; outs: Set<string>; onPlayer: (id: string) => void }) {
  const dispatch = useSetupDispatch();
  const keys = potKeys(holes);
  const toggle = (pot: PotKey, p: Player) => {
    const out = !outs.has(optKey(pot, p.id));
    dispatch({ type: "pot.optout", pot_key: pot, player_id: p.id, out });
  };
  return (
    <Group title="Who's in which pot">
      <p className="text-sm font-bold text-muted">
        Everybody&apos;s in by default. Tap a box to opt a player out (players can do it themselves until the round starts). Tap a name for the
        full list.
      </p>
      {players.length === 0 ? (
        <p className="text-base font-bold">Add players first.</p>
      ) : (
        <div className="-mx-1 overflow-x-auto overscroll-x-contain rounded-xl border-2 border-ink" role="region" aria-label="Pot opt-outs" tabIndex={0}>
          <table className="border-separate border-spacing-0 text-left" data-testid="optout-matrix">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 border-r-2 border-b-2 border-ink bg-paper px-2 py-1 text-xs font-black uppercase">
                  Player
                </th>
                {keys.map((k) => (
                  <th key={k} scope="col" className="border-b-2 border-ink bg-sand px-0.5 py-1 text-center text-[11px] leading-tight font-black whitespace-nowrap uppercase">
                    {potShortLabel(k, holes)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.id}>
                  <th scope="row" className="sticky left-0 z-10 border-r-2 border-ink bg-paper p-0">
                    <button
                      type="button"
                      onClick={() => onPlayer(p.id)}
                      className="flex h-12 w-[7.5rem] items-center px-2 text-left text-[15px] font-extrabold active:bg-sand"
                    >
                      <span className="truncate">{displayName(p)}</span>
                    </button>
                  </th>
                  {keys.map((k) => {
                    const isIn = !outs.has(optKey(k, p.id));
                    return (
                      <td key={k} className="p-0.5">
                        <button
                          type="button"
                          aria-pressed={isIn}
                          aria-label={`${displayName(p)} in ${potLongLabel(k, holes)}`}
                          onClick={() => toggle(k, p)}
                          className={cx(
                            "flex h-12 w-12 items-center justify-center rounded-lg border-2 text-xl font-black",
                            isIn ? "border-fairway-dark bg-fairway text-white" : "border-flag bg-flag-soft text-flag",
                          )}
                        >
                          {isIn ? "✓" : "✕"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Group>
  );
}

function PlayerPotsSheet({ playerId, onClose }: { playerId: string | null; onClose: () => void }) {
  const view = useClientState((s) => s.view);
  const dispatch = useSetupDispatch();
  const player = playerId ? (view?.players.find((p) => p.id === playerId && !p.deleted_at) ?? null) : null;
  if (!view) return null;
  const outs = optOutSet(view);
  const keys = potKeys(view.holes);
  const contestKeys = keys.filter((k) => k !== "team_match");
  const set = (pot: PotKey, out: boolean) => {
    if (!player) return;
    if (outs.has(optKey(pot, player.id)) === out) return;
    dispatch({ type: "pot.optout", pot_key: pot, player_id: player.id, out });
  };
  const allContests = (out: boolean) => contestKeys.forEach((k) => set(k, out));
  const inCount = player ? keys.filter((k) => !outs.has(optKey(k, player.id))).length : 0;
  const st = view.trip.settings;
  const exposure = player
    ? keys.reduce(
        (sum, k) => (outs.has(optKey(k, player.id)) ? sum : sum + (k === "team_match" ? st.team_match_ante_cents : st.contest_ante_cents)),
        0,
      )
    : 0;
  return (
    <BottomSheet open={player !== null} onClose={onClose} title={player ? `${displayName(player)}'s pots` : ""} size="tall">
      {player && (
        <div className="space-y-4 pb-4">
          <p className="text-lg font-black">
            In {inCount} of {keys.length} pots · risking {formatCents(exposure)}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => allContests(false)}>
              All contests in
            </Button>
            <Button variant="secondary" onClick={() => allContests(true)}>
              All contests out
            </Button>
          </div>
          <div className="divide-y-2 divide-line rounded-2xl border-2 border-ink px-3">
            {keys.map((k) => (
              <Toggle
                key={k}
                checked={!outs.has(optKey(k, player.id))}
                onChange={(on) => set(k, !on)}
                label={potLongLabel(k, view.holes)}
                description={k === "team_match" ? formatCents(st.team_match_ante_cents) : formatCents(st.contest_ante_cents)}
              />
            ))}
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
