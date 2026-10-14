"use client";
// Round: pre-flight checklist and Start round (setup), the commissioner's live tools and
// Finalize (live), Reopen (final). Start/finalize fire their own fanfare locally.
import { useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { Button, Card, ConfirmSheet, IconChevronRight, SectionHeader, cx, displayName, useConfirm, useFanfare, useToast } from "@/components/ui";
import { CommissionerTools, type ToolFocus } from "@/components/setup/commish/CommissionerTools";
import { pendingRulings } from "@/components/setup/commish/commishModel";
import { FinalizeSummary, finalizeIssueCount, type FinalizeFix, type FinalizeIssues } from "./FinalizeSummary";
import {
  beforeRoundDay,
  liveTeams,
  livePlayers,
  membersByTeam,
  payeesWithoutVenmo,
  preflight,
  readySummary,
  scoreGaps,
  startConfirmCopy,
  unfinishedTeams,
  type CheckItem,
  type SetupSection,
} from "./model";
import { clearSetupToasts, useSetupDispatch } from "./shared";

const LEVEL_ICON: Record<CheckItem["level"], string> = { ok: "✅", warn: "⚠️", block: "⛔" };

function clock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function RoundSection({ onGo }: { onGo: (s: SetupSection) => void }) {
  const view = useClientState((s) => s.view);
  if (!view) return null;
  const status = view.trip.status;
  return (
    <div className="space-y-4" data-testid="setup-round" data-status={status}>
      {status === "setup" ? <PreRound onGo={onGo} /> : <LiveRound onGo={onGo} />}
    </div>
  );
}

function PreRound({ onGo }: { onGo: (s: SetupSection) => void }) {
  const view = useClientState((s) => s.view);
  const store = useTripStore();
  const dispatch = useSetupDispatch();
  const confirm = useConfirm();
  const fanfare = useFanfare();
  const toast = useToast();
  // When this screen opened (server-corrected): the helper line under Start. The confirm re-checks at tap time.
  const [openedAt] = useState(() => store.serverNow());
  if (!view) return null;
  const pf = preflight(view);
  const teams = liveTeams(view);
  const members = membersByTeam(view);
  const players = livePlayers(view);
  const early = beforeRoundDay(new Date(openedAt), view.trip.is_demo);

  const start = async () => {
    if (!pf.canStart) {
      toast.error(`${pf.blocking} thing${pf.blocking === 1 ? "" : "s"} to fix first. See the red ones.`, { title: "Not yet" });
      return;
    }
    // A leftover Setup toast would park over the sheet's title.
    clearSetupToasts(toast);
    const copy = startConfirmCopy(new Date(store.serverNow()), view.trip.is_demo);
    const ok = await confirm({
      title: "Start the round? Do it on the first tee.",
      emoji: copy.warning ? "⏳" : "⛳",
      tone: copy.tone,
      confirmLabel: copy.confirmLabel,
      cancelLabel: copy.cancelLabel,
      body: (
        <span data-testid="start-confirm-body">
          {players.length} players, {teams.length} teams ({teams.map((t) => members.get(t.id)?.length ?? 0).join("/")}).
          <span className="mt-2 block text-base">
            There&apos;s no going back to setup: shuffle locks, players can&apos;t opt out of pots, the feed announces it, and every phone flips to
            the scorecard.
          </span>
          {copy.warning && (
            <span className="mt-2 block rounded-xl border-2 border-ink bg-hazard px-3 py-2 text-base font-black" data-testid="start-too-early">
              {copy.warning}
            </span>
          )}
          {pf.warnings > 0 && (
            <span className="mt-2 block text-base text-muted">
              {pf.warnings} optional extra{pf.warnings === 1 ? "" : "s"} still open. You can fix those mid-round.
            </span>
          )}
        </span>
      ),
    });
    if (!ok) return;
    if (dispatch({ type: "trip.start" }, "Can't start yet")) {
      fanfare.show({ emoji: "⛳", title: "Round is live", subtitle: "Scoring is unlocked on every phone. God help us all.", tone: "hype", key: "round-started" });
    }
  };

  const checklist = (
    <ul className="overflow-hidden rounded-2xl border-2 border-ink" data-testid="preflight">
      {pf.items.map((item, i) => (
        <li key={item.id} className={cx(i > 0 && "border-t-2 border-line")}>
          <button
            type="button"
            onClick={() => onGo(item.section)}
            data-testid="preflight-item"
            data-level={item.level}
            className={cx(
              "flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left active:bg-sand",
              item.level === "block" && "bg-flag-soft",
              item.level === "warn" && "bg-hazard-soft",
            )}
          >
            <span className="shrink-0 text-2xl leading-none" aria-hidden="true">
              {LEVEL_ICON[item.level]}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[17px] leading-tight font-black">{item.title}</span>
              {item.detail && <span className="block text-sm font-bold text-muted">{item.detail}</span>}
            </span>
            {item.level !== "ok" && <IconChevronRight size={20} strokeWidth={3} className="shrink-0" />}
          </button>
        </li>
      ))}
    </ul>
  );

  const startButton = (
    <div className="space-y-2">
      <Button size="xl" full onClick={start} disabled={!pf.canStart} data-testid="start-round" leading={<span aria-hidden="true">⛳</span>}>
        Start round
      </Button>
      <p className="text-center text-sm font-bold text-muted" data-testid="start-hint">
        {!pf.canStart
          ? `${pf.blocking} blocker${pf.blocking === 1 ? "" : "s"} above. Tap one to fix it.`
          : early
            ? "You're set. Start it on the first tee Saturday."
            : pf.warnings > 0
              ? "Optional extras below."
              : "All green. Pre-round drinks still don't count."}
      </p>
    </div>
  );

  return (
    <>
      <SectionHeader title="Pre-flight" subtitle={pf.canStart ? "Nothing's blocking. Start it on the first tee." : "Clear the red ones, then send it."} />
      {pf.canStart ? (
        <>
          <Card tone="fairway" className="text-[17px] leading-snug font-black" data-testid="preflight-ready">
            ✅ You&apos;re set: {readySummary(view)}.
          </Card>
          {startButton}
          {checklist}
        </>
      ) : (
        <>
          {checklist}
          <div className="pt-2">{startButton}</div>
        </>
      )}
    </>
  );
}

function LiveRound({ onGo }: { onGo: (s: SetupSection) => void }) {
  const view = useClientState((s) => s.view);
  const derived = useClientState((s) => s.derived);
  const dispatch = useSetupDispatch();
  const confirm = useConfirm();
  const fanfare = useFanfare();
  const toast = useToast();
  const [finalizing, setFinalizing] = useState(false);
  // Which Commissioner Tools panel to open (a Fix link in the finalize check); seq re-fires it.
  const [focus, setFocus] = useState<ToolFocus | null>(null);
  if (!view) return null;
  const final = view.trip.status === "final";
  const unfinished = unfinishedTeams(view);
  const teams = liveTeams(view);
  const complete = teams.length - unfinished.length;
  const leader = derived?.leaderTeamIds.length ? derived.teamById[derived.leaderTeamIds[0]] : null;
  const issues: FinalizeIssues = { unfinished, gaps: scoreGaps(view), rulings: derived ? pendingRulings(derived.contests, derived.money.pots) : [] };
  const issueCount = finalizeIssueCount(issues);
  // Who settle-up says gets paid but has no Venmo: their payers get no Pay button (a note, not a blocker).
  const noVenmo = derived ? payeesWithoutVenmo(derived.money.payments, derived.playerById).map((p) => displayName(p)) : [];
  const loose = [
    issues.gaps.length > 0 ? `${issues.gaps.length} team${issues.gaps.length === 1 ? "" : "s"} missing a score` : null,
    issues.rulings.length > 0 ? `${issues.rulings.length} ruling${issues.rulings.length === 1 ? "" : "s"} pending` : null,
  ].filter((x): x is string => x !== null);

  const finalize = () => {
    setFinalizing(false);
    if (dispatch({ type: "trip.finalize" }, "Can't finalize")) {
      fanfare.show({ emoji: "🏁", title: "It's final", subtitle: "Pens down. Pay your debts. Awards are up.", tone: "hype", key: "round-finalized" });
    }
  };

  const fix = (f: FinalizeFix) => {
    setFinalizing(false);
    const next: Omit<ToolFocus, "seq"> =
      f.kind === "round"
        ? { tab: "rounds", teamId: f.teamId }
        : f.kind === "score"
          ? { tab: "scores", teamId: f.teamId, hole: f.hole }
          : { tab: "contests", entryId: f.entryId };
    setFocus((prev) => ({ ...next, seq: (prev?.seq ?? 0) + 1 }));
  };

  const reopen = async () => {
    const ok = await confirm({
      title: "Reopen the round?",
      emoji: "🔓",
      tone: "primary",
      confirmLabel: "Reopen",
      body: "Back to live: scores, drinks and contests are editable again and the money goes back to projected.",
    });
    if (!ok) return;
    if (dispatch({ type: "trip.reopen" })) toast.info("Round reopened. Somebody found a scorecard error, huh?", { emoji: "🔓" });
  };

  return (
    <>
      <section
        className={cx("rounded-3xl border-2 border-ink px-5 py-4 shadow-hard", final ? "bg-gold text-ink" : "text-white")}
        style={final ? undefined : { background: "radial-gradient(circle at 85% 0%, #ff5a5f 0%, #e5262d 45%, #8f1015 100%)" }}
        data-testid="round-status"
      >
        <p className="flex items-center gap-2 text-sm font-black tracking-[0.15em] uppercase">
          {!final && (
            <span className="relative inline-flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-hazard opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-hazard" />
            </span>
          )}
          {final ? `Final${view.trip.finalized_at ? ` · ${clock(view.trip.finalized_at)}` : ""}` : `Live${view.trip.started_at ? ` since ${clock(view.trip.started_at)}` : ""}`}
        </p>
        <h2 className="loud mt-2 text-[clamp(2rem,10vw,3rem)]">{final ? "Round is final" : "Round is live"}</h2>
        <p className="mt-1 text-[15px] font-bold">
          {complete}/{teams.length} teams done{leader ? ` · ${leader.name} leads` : ""}
        </p>
      </section>

      <CommissionerTools focus={focus} />

      <Card tone={final ? "sand" : "hazard"} className="space-y-3" data-testid={final ? "final-fix-card" : undefined}>
        {final ? (
          <>
            <p className="text-[15px] font-bold">
              <span className="text-lg leading-tight font-black">Wrong score?</span> Fix it right here: tap the hole in the Scores tool above.
              Everyone gets a Results changed alert. Reopen only if a team still has holes to play.
            </p>
            <Button variant="secondary" size="md" onClick={reopen} data-testid="reopen-round" className="w-full text-[15px]">
              Reopen round
            </Button>
          </>
        ) : (
          <>
            <p className="text-lg leading-tight font-black">When the last putt drops</p>
            <p className="text-[15px] font-bold">
              {unfinished.length === 0
                ? issueCount === 0
                  ? "Every team is done. Lock it in."
                  : "Every team is done."
                : `${unfinished.length} team${unfinished.length === 1 ? "" : "s"} still playing: ${unfinished.map((u) => u.team.name).join(", ")}.`}
              {loose.length > 0 && <span className="block text-flag-dark">Before pots lock: {loose.join(", ")}.</span>}
            </p>
            <Button
              variant="hazard"
              size="xl"
              full
              onClick={() => setFinalizing(true)}
              data-testid="finalize-round"
              leading={<span aria-hidden="true">🏁</span>}
            >
              Finalize round
            </Button>
          </>
        )}
      </Card>

      <ConfirmSheet
        open={finalizing && !final}
        title="Finalize the round?"
        emoji="🏁"
        tone="hazard"
        confirmLabel={issueCount > 0 ? "Finalize anyway" : "Finalize it"}
        body={
          <FinalizeSummary
            issues={issues}
            playerById={derived?.playerById ?? {}}
            onFix={fix}
            noVenmo={noVenmo}
            onRoster={() => {
              setFinalizing(false);
              onGo("roster");
            }}
          />
        }
        onConfirm={finalize}
        onCancel={() => setFinalizing(false)}
      />
    </>
  );
}
