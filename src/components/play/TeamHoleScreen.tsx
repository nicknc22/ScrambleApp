"use client";
// The team hole screen: one team, one hole at a time. Follows the team's current hole (so it
// moves when another phone tees off the next one) unless the user opened another hole from the
// scorecard strip. Every write goes through usePlayActions -> store.dispatch.
import { useState } from "react";
import type { DrinkType, MulliganSource, TripState, UUID } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";
import { Button, Card, TeamPill, displayName, useConfirm, useToast, IconUserSwap } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";
import { ClosestToPinSheet } from "@/components/contests/ClosestToPinSheet";
import { LongDriveSheet } from "@/components/contests/LongDriveSheet";
import {
  advanceConfirm,
  canEditPlay,
  drinksForRound,
  drinksOnHole,
  driveView,
  mulliganOptions,
  needsOverride,
  nextAction,
  nineOf,
  roundSummary,
  scoreDraft,
  teeCtaHole,
  unscoredHoles,
  viewingHole,
} from "./model";
import { usePlayActions } from "./usePlayActions";
import { useStickyTop } from "./useStickyTop";
import { HoleHeader } from "./HoleHeader";
import { ScorePanel } from "./ScorePanel";
import { TeeShotPanel } from "./TeeShotPanel";
import { DrinksPanel } from "./DrinksPanel";
import { MulliganPanel } from "./MulliganPanel";
import { ContestPanel } from "./ContestPanel";
import { ThreesomeReminder } from "./ThreesomeReminder";
import { ScorecardStrip } from "./ScorecardStrip";
import { RoundSummaryCard } from "./RoundSummaryCard";
import { ActionBar, ActionBarSpacer, NextButton, SaveButton, TeeButton } from "./ActionBar";

export function TeamHoleScreen({
  view,
  derived,
  teamId,
  meId,
  isCommissioner,
  canSwitch,
  onSwitchTeam,
}: {
  view: TripState;
  derived: Derived;
  teamId: UUID;
  meId: UUID | null;
  isCommissioner: boolean;
  canSwitch: boolean;
  onSwitchTeam: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const stickyTop = useStickyTop();
  const tripStatus = view.trip.status;
  const myTeamId = meId ? (derived.teamOfPlayer[meId] ?? null) : null;
  const override = needsOverride({ isCommissioner, myTeamId, teamId, tripStatus });
  const editable = canEditPlay(tripStatus, isCommissioner);
  const actions = usePlayActions({ teamId, override });

  const rs = view.team_round_state.find((r) => r.team_id === teamId) ?? null;
  const currentHole = derived.currentHole[teamId] ?? 1;
  const openWindow = derived.openWindow[teamId] ?? null;
  const roundComplete = rs?.status === "complete";
  const finished = roundComplete || tripStatus === "final";

  // Hole opened from the scorecard strip (null = follow the team's current hole).
  const [pin, setPin] = useState<number | null>(null);
  // When the team reaches the pinned hole (e.g. saving a score on hole N+1 opened it), follow again.
  const [seenCurrent, setSeenCurrent] = useState(currentHole);
  if (seenCurrent !== currentHole) {
    setSeenCurrent(currentHole);
    if (pin === currentHole && !finished) setPin(null);
  }
  // Stepper values the user changed but hasn't saved, per hole.
  const [drafts, setDrafts] = useState<Record<number, number>>({});
  const [hiddenReminders, setHiddenReminders] = useState<number[]>([]);
  const [contestHole, setContestHole] = useState<number | null>(null);

  const team = derived.teamById[teamId];
  const lines = derived.teamHoles[teamId] ?? [];
  if (!team || lines.length !== 18) {
    return (
      <Screen>
        <Card tone="hazard" className="text-lg font-bold">
          This team&apos;s scorecard is missing. Ask the commissioner to check the teams.
        </Card>
      </Screen>
    );
  }

  const showSummary = finished && pin === null;
  const hole = showSummary ? currentHole : viewingHole(currentHole, pin);
  const editingOther = pin !== null && (finished || pin !== currentHole);
  const line = lines[hole - 1];
  const holeRow = derived.holeByNumber[hole];
  const par = line.par;
  const draft = scoreDraft(line.strokes, drafts[hole], par);
  const unsavedHoles = Object.entries(drafts)
    .filter(([h, v]) => lines[Number(h) - 1] && lines[Number(h) - 1].strokes !== v)
    .map(([h]) => Number(h));
  const members = derived.membersOfTeam[teamId] ?? [];
  const standing = derived.standings.find((r) => r.team_id === teamId);
  const nameOf = (id: UUID) => displayName(derived.playerById[id]);
  const nine = derived.driveMin[teamId]?.nines[nineOf(hole) - 1];
  const drive = nine ? driveView(nine, nameOf) : null;
  const driveBanner = !!drive?.banner && !finished && nineOf(hole) === nineOf(currentHole);
  const targetHole = openWindow ?? hole;
  const bank = derived.mulligans[teamId];
  const teeCta = editable && !showSummary ? teeCtaHole(rs, hole) : null;
  const next = nextAction(rs);
  const contestSummary = derived.contests.find((c) => c.hole === hole);

  const scrollTop = () => {
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      /* ignore */
    }
  };

  const clearDraft = (h: number) =>
    setDrafts((d) => {
      if (d[h] === undefined) return d;
      const n = { ...d };
      delete n[h];
      return n;
    });

  const selectHole = (h: number) => {
    setPin(!finished && h === currentHole ? null : h);
    scrollTop();
  };

  const backToCurrent = () => {
    setPin(null);
    scrollTop();
  };

  const save = () => {
    if (actions.saveScore(hole, draft.value)) clearDraft(hole);
  };

  /** "On the tee: hole N" / "Round complete" from the team's current hole, with a confirm. */
  const advance = async (to: number | "complete") => {
    const from = currentHole;
    const fromLine = lines[from - 1];
    const fromDraft = scoreDraft(fromLine.strokes, drafts[from], fromLine.par);
    const c = advanceConfirm({
      fromHole: from,
      to,
      draft: fromDraft,
      credit: fromLine.credit,
      otherMissing: to === "complete" ? unscoredHoles(lines) : undefined,
    });
    // Transient "saved" / "on the tee" toasts would only crowd the confirm sheet.
    toast.dismiss("score-saved");
    toast.dismiss("tee-open");
    const ok = await confirm({ title: c.title, body: c.body, emoji: c.emoji, confirmLabel: c.confirmLabel, tone: c.tone });
    if (!ok) return;
    if (c.saveFirst !== null) {
      if (!actions.saveScore(from, c.saveFirst, { announce: false })) return;
      clearDraft(from);
    }
    const done = to === "complete" ? actions.completeRound() : actions.teeOff(to);
    if (done) {
      setPin(null);
      scrollTop();
    }
  };

  const onTee = () => {
    if (teeCta === null) return;
    if (teeCta === 1 && (rs?.open_hole ?? null) === null) {
      if (actions.teeOff(1)) setPin(null);
      return;
    }
    void advance(teeCta);
  };

  const teamRow = (
    <div className="flex items-center gap-2">
      <TeamPill team={team} size="md" you={team.id === myTeamId} className="max-w-[60%]" />
      <span className="min-w-0 flex-1" />
      {canSwitch && (
        <Button variant="secondary" size="md" onClick={onSwitchTeam} leading={<IconUserSwap size={18} strokeWidth={2.75} />}>
          Switch team
        </Button>
      )}
    </div>
  );

  const banners = (
    <>
      {override && (
        <Card tone="hazard" padded={false} className="px-4 py-2 text-[15px] font-extrabold" data-testid="override-banner">
          👔 Commissioner override: changes to {team.name} post to the feed as overrides.
        </Card>
      )}
      {!editable && (
        <Card tone="sand" padded={false} className="border-ink px-4 py-2 text-[15px] font-extrabold">
          🏆 The round is final. Only the commissioner can change scores now.
        </Card>
      )}
    </>
  );

  if (showSummary) {
    return (
      <Screen>
        {(canSwitch || team.id !== myTeamId) && teamRow}
        {banners}
        <RoundSummaryCard summary={roundSummary(standing, lines)} final={tripStatus === "final"} teamName={team.name} />
        <ScorecardStrip lines={lines} currentHole={-1} viewing={null} unsavedHoles={unsavedHoles} onSelect={selectHole} />
      </Screen>
    );
  }

  const disabled = !editable;

  return (
    <>
      <Screen>
        {(editingOther || driveBanner) && (
          <div className="sticky z-20 -mx-4 space-y-0 shadow-[0_6px_12px_rgba(0,0,0,0.12)]" style={{ top: stickyTop }}>
            {editingOther && (
              <div className="flex min-h-14 items-center gap-2 border-y-2 border-ink bg-sky px-4 py-1.5 text-white" data-testid="editing-bar">
                <span className="min-w-0 flex-1 text-lg leading-tight font-black">
                  Editing hole {hole}
                  {!finished && <span className="block text-sm font-bold opacity-90">The team is on hole {currentHole}</span>}
                </span>
                <button
                  type="button"
                  onClick={backToCurrent}
                  className="btn min-h-12 shrink-0 border-ink bg-paper px-3 text-base font-black text-ink active:bg-sand"
                >
                  {finished ? "Back to summary" : `Back to hole ${currentHole}`}
                </button>
              </div>
            )}
            {driveBanner && drive && (
              <div
                className="flex items-start gap-2 border-y-2 border-flag-dark bg-flag px-4 py-2 text-[15px] leading-snug font-black text-white"
                role="alert"
                data-testid="drive-banner"
              >
                <span aria-hidden="true">🚨</span>
                <span className="min-w-0">{drive.text}</span>
              </div>
            )}
          </div>
        )}
        {banners}
        <HoleHeader
          hole={hole}
          holeRow={holeRow}
          teeSet={view.trip.settings.tee_set}
          team={team}
          isMyTeam={team.id === myTeamId}
          standing={standing}
          canSwitch={canSwitch}
          onSwitch={onSwitchTeam}
        />
        {teeCta !== null && (
          <Card tone="hazard" padded={false} className="flex items-center gap-3 px-3 py-2.5" data-testid="tee-cta-card">
            <span className="text-3xl leading-none" aria-hidden="true">
              ⛳
            </span>
            <p className="min-w-0 text-[15px] leading-snug font-bold">
              {teeCta === 1 && rs?.open_hole == null ? (
                <>
                  <span className="font-black uppercase">Not teed off yet.</span> Drinks don&apos;t count until you hit the big yellow button.
                </>
              ) : (
                <>
                  <span className="font-black uppercase">Hole {teeCta} isn&apos;t open.</span> Drinks keep landing on hole {openWindow ?? currentHole} until you tee off.
                </>
              )}
            </p>
          </Card>
        )}
        {derived.teamSize[teamId] === 3 && !hiddenReminders.includes(hole) && (
          <ThreesomeReminder onDismiss={() => setHiddenReminders((h) => [...h, hole])} />
        )}
        <ScorePanel
          hole={hole}
          par={par}
          credit={line.credit}
          draft={draft}
          disabled={disabled}
          onChange={(v) => setDrafts((d) => ({ ...d, [hole]: v }))}
        />
        <TeeShotPanel
          hole={hole}
          members={members}
          selected={line.tee_shot_player_id}
          nine={nine}
          driveView={drive}
          disabled={disabled}
          onSelect={(pid) => actions.setTeeShot(hole, pid)}
        />
        <ContestPanel
          hole={hole}
          contest={line.contest}
          summary={contestSummary}
          playerById={derived.playerById}
          canMeasure={hole === currentHole && rs?.status === "playing"}
          disabled={disabled}
          onOpen={() => setContestHole(hole)}
        />
        <DrinksPanel
          members={members}
          teamSortOrder={team.sort_order}
          meId={meId}
          targetHole={targetHole}
          viewingHole={hole}
          windowOpen={openWindow !== null}
          roundComplete={roundComplete}
          onHole={drinksOnHole(derived.drinkValues, teamId, targetHole)}
          forRound={drinksForRound(derived.drinkValues, teamId)}
          disabled={disabled}
          onLog={(pid: UUID, type: DrinkType, photo?: Blob | null) => void actions.logDrink(pid, type, photo)}
        />
        <MulliganPanel
          hole={hole}
          options={mulliganOptions(bank)}
          groomOnTeam={!!bank?.groom_on_team}
          groomName={derived.groomId ? nameOf(derived.groomId) : "The groom"}
          disabled={disabled}
          onUse={(source: MulliganSource) => actions.spendMulligan(source, hole)}
        />
        <ScorecardStrip lines={lines} currentHole={currentHole} viewing={hole} unsavedHoles={unsavedHoles} onSelect={selectHole} />
        {editable && <ActionBarSpacer />}
      </Screen>

      {editable && (
        <ActionBar>
          {teeCta !== null ? (
            <TeeButton hole={teeCta} onClick={onTee} />
          ) : (
            <>
              <SaveButton value={draft.value} dirty={draft.dirty} onSave={save} />
              {editingOther ? (
                <NextButton
                  ariaLabel={finished ? "Back to summary" : `Back to hole ${currentHole}`}
                  sub="Back to"
                  label={finished ? "Summary" : `Hole ${currentHole}`}
                  direction="back"
                  tone="secondary"
                  onClick={backToCurrent}
                />
              ) : next.kind === "tee" ? (
                <NextButton
                  ariaLabel={`On the tee: hole ${next.hole}`}
                  sub="On the tee"
                  label={`Hole ${next.hole}`}
                  testId="next-hole"
                  onClick={() => void advance(next.hole)}
                />
              ) : next.kind === "complete" ? (
                <NextButton ariaLabel="Round complete" sub="Hole 18 done?" label="Finish 🏁" tone="flag" testId="round-complete" onClick={() => void advance("complete")} />
              ) : null}
            </>
          )}
        </ActionBar>
      )}

      <ClosestToPinSheet open={contestHole !== null && line.contest === "ctp"} onClose={() => setContestHole(null)} hole={contestHole ?? hole} />
      <LongDriveSheet open={contestHole !== null && line.contest === "ld"} onClose={() => setContestHole(null)} hole={contestHole ?? hole} />
    </>
  );
}
