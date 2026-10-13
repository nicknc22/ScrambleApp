"use client";
// The team hole screen: one team, one hole at a time. Follows the team's current hole (so it
// moves when another phone tees off the next one) unless the user opened another hole from the
// scorecard strip, or has an unsaved score on the hole it was showing (then it stays put and says
// so). Every write goes through usePlayActions -> store.dispatch.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DrinkType, MulliganSource, TripState, UUID } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";
import { Card, TeamPill, cx, displayName, useToast, IconUserSwap } from "@/components/ui";
import { readPref, writePref } from "@/lib/client/ui-prefs";
import { Screen } from "@/components/shell/Screen";
import { ClosestToPinSheet } from "@/components/contests/ClosestToPinSheet";
import { LongDriveSheet } from "@/components/contests/LongDriveSheet";
import {
  HOLE_MOVE_GUARD_MS,
  advanceConfirm,
  canEditPlay,
  drinksForRound,
  drinksOnHole,
  driveView,
  hasUnsavedDraft,
  isOwnMove,
  mulliganOptions,
  needsOverride,
  nextAction,
  nineOf,
  pinAfterTeamMove,
  roundSummary,
  scoreDraft,
  teamMoveNotice,
  teeCtaHole,
  unscoredHoles,
  viewingHole,
  type AdvanceConfirm,
  type LocalMove,
} from "./model";
import { usePlayActions } from "./usePlayActions";
import { useDrinkUndo } from "./drinkUndo";
import { useMulliganUndo } from "./mulliganUndo";
import { useElementHeight, useStickyTop } from "./useStickyTop";
import { HoleHeader } from "./HoleHeader";
import { ScorePanel } from "./ScorePanel";
import { TeeShotPanel } from "./TeeShotPanel";
import { DrinksPanel } from "./DrinksPanel";
import { MulliganPanel } from "./MulliganPanel";
import { ContestPanel } from "./ContestPanel";
import { ThreesomeReminder } from "./ThreesomeReminder";
import { ScorecardStrip } from "./ScorecardStrip";
import { RoundSummaryCard } from "./RoundSummaryCard";
import { ActionBar, ActionBarSpacer, NextButton, PlayToastPlacement, SaveButton, TeeButton } from "./ActionBar";
import { AdvanceSheet, type AdvanceChoice } from "./AdvanceSheet";

/** Threesome rule reminder dismissed on this device for this team's round. */
const reminderKey = (code: string, teamId: UUID) => `scramble:threesome-hint:${code}:${teamId}`;

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
  // The drinks panel's Undo chip (drinks count on the open window, else the current hole).
  const drinkUndo = useDrinkUndo(teamId, openWindow ?? currentHole);
  const mulliganUndo = useMulliganUndo(teamId);
  // Play's notices show right under the header and Play's sticky banners (never on the stepper).
  const [stickyEl, setStickyEl] = useState<HTMLDivElement | null>(null);
  const toastTop = stickyTop + useElementHeight(stickyEl) + 8;
  const roundComplete = rs?.status === "complete";
  const finished = roundComplete || tripStatus === "final";
  const lines = useMemo(() => derived.teamHoles[teamId] ?? [], [derived.teamHoles, teamId]);

  // Hole opened from the scorecard strip, or kept on screen for an unsaved score (null = follow
  // the team's current hole).
  const [pin, setPin] = useState<number | null>(null);
  // Stepper values the user changed but hasn't saved, per hole.
  const [drafts, setDrafts] = useState<Record<number, number>>({});
  // The team moved (another phone teed off, or this phone's score on N+1 opened it): follow, un-pin
  // on reaching the pinned hole, or stay on a hole with an unsaved score.
  const [seen, setSeen] = useState({ hole: currentHole, finished });
  // Save is disabled for a moment after the screen changed holes under the user's thumb.
  const [moveGuard, setMoveGuard] = useState(false);
  if (seen.hole !== currentHole || seen.finished !== finished) {
    setSeen({ hole: currentHole, finished });
    setMoveGuard(true);
    const nextPin = pinAfterTeamMove({
      from: seen.hole,
      to: currentHole,
      pin,
      wasSummary: seen.finished && pin === null,
      finished,
      unsavedOnFrom: hasUnsavedDraft(drafts, lines, seen.hole),
    });
    if (nextPin !== pin) setPin(nextPin);
  }
  const [reminderHidden, setReminderHidden] = useState(() => readPref(reminderKey(view.trip.code, teamId)) === "1");
  const [contestHole, setContestHole] = useState<number | null>(null);
  const [advancePrompt, setAdvancePrompt] = useState<{ from: number; to: number | "complete"; c: AdvanceConfirm } | null>(null);
  useEffect(() => {
    if (!moveGuard) return;
    const t = setTimeout(() => setMoveGuard(false), HOLE_MOVE_GUARD_MS);
    return () => clearTimeout(t);
  }, [moveGuard, seen]);
  // This phone's last write that can move the team: its own moves aren't announced again (it
  // already said so); any other move came from another phone.
  const localMove = useRef<LocalMove | null>(null);
  const expectMove = (to: LocalMove["to"]) => {
    localMove.current = { to, at: performance.now() };
  };
  const shown = useRef({ hole: currentHole, finished });
  useEffect(() => {
    if (shown.current.hole === currentHole && shown.current.finished === finished) return;
    shown.current = { hole: currentHole, finished };
    if (isOwnMove(localMove.current, currentHole, finished, performance.now())) return;
    const kept = pin !== null && hasUnsavedDraft(drafts, lines, pin) ? pin : null;
    const notice = teamMoveNotice({ to: currentHole, finished, keptHole: kept, keptValue: kept !== null ? (drafts[kept] ?? null) : null });
    if (notice) toast.show({ id: "tee-open", tone: kept !== null ? "roast" : "info", duration: kept !== null ? 6000 : 3500, ...notice });
  }, [currentHole, finished, pin, drafts, lines, toast]);

  const team = derived.teamById[teamId];
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
    expectMove(hole); // a score on hole N+1 opens it
    if (actions.saveScore(hole, draft.value)) clearDraft(hole);
  };

  /** "On the tee: hole N" / "Round complete" from the team's current hole, with a confirm. */
  const advance = (to: number | "complete") => {
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
    setAdvancePrompt({ from, to, c });
  };

  const finishAdvance = (choice: AdvanceChoice | null) => {
    const p = advancePrompt;
    setAdvancePrompt(null);
    if (!p || choice === null) return;
    // The untouched par default only fills an empty hole: a teammate's score this phone hasn't
    // received yet must win over a number nobody entered.
    if (choice === "confirm" && p.c.saveFirst !== null && !actions.saveScore(p.from, p.c.saveFirst, { announce: false, ifEmpty: p.c.saveIsDefault })) return;
    // Skipping drops an unsaved stepper value too (otherwise it would hold the screen on that hole).
    clearDraft(p.from);
    expectMove(p.to);
    const done = p.to === "complete" ? actions.completeRound() : actions.teeOff(p.to);
    if (done) {
      setPin(null);
      scrollTop();
    }
  };

  const onTee = () => {
    if (teeCta === null) return;
    if (teeCta === 1 && (rs?.open_hole ?? null) === null) {
      expectMove(1);
      if (actions.teeOff(1)) setPin(null);
      return;
    }
    advance(teeCta);
  };

  const hideReminder = () => {
    setReminderHidden(true);
    writePref(reminderKey(view.trip.code, teamId), "1");
  };

  // Whose card this is, for the commissioner (or a spectator): one compact row, not a team row in
  // the hole header plus a three-line override banner (together they pushed the stepper under the
  // action bar).
  const isMine = team.id === myTeamId;
  const overrideNote = `Commissioner override: changes to ${team.name} post to the feed as overrides.`;
  const teamStrip = (canSwitch || !isMine) && (
    <div
      className={cx("flex min-h-12 items-center gap-2 rounded-2xl border-2 py-0.5 pr-0.5 pl-2", override ? "border-ink bg-hazard" : "border-line bg-paper")}
      data-testid={override ? "override-banner" : "team-strip"}
      title={override ? overrideNote : undefined}
    >
      {override && (
        <span className="shrink-0 leading-none" aria-hidden="true">
          <span className="block text-[13px] font-black uppercase">👔 Override</span>
          <span className="block text-[11px] font-bold">posts to the feed</span>
        </span>
      )}
      {override && <span className="sr-only">{overrideNote}</span>}
      <TeamPill team={team} size="sm" you={isMine} className="min-w-0" />
      {canSwitch && (
        <button
          type="button"
          onClick={onSwitchTeam}
          aria-label="Switch team"
          className="btn ml-auto min-h-12 shrink-0 border-ink bg-paper px-3 text-sm font-black text-ink active:bg-sand"
        >
          <IconUserSwap size={18} strokeWidth={2.75} />
          Switch
        </button>
      )}
    </div>
  );

  const banners = (
    <>
      {teamStrip}
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
        <PlayToastPlacement top={toastTop} />
        {banners}
        <RoundSummaryCard summary={roundSummary(standing, lines)} final={tripStatus === "final"} teamName={team.name} canEdit={editable} />
        <ScorecardStrip lines={lines} currentHole={-1} viewing={null} unsavedHoles={unsavedHoles} onSelect={selectHole} canEdit={editable} />
      </Screen>
    );
  }

  const disabled = !editable;

  return (
    <>
      <Screen>
        <PlayToastPlacement top={toastTop} />
        {(editingOther || driveBanner) && (
          <div ref={setStickyEl} className="sticky z-20 -mx-4 mb-2 space-y-0 shadow-[0_6px_12px_rgba(0,0,0,0.12)]" style={{ top: stickyTop }}>
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
                className="flex items-start gap-2 border-y-2 border-flag-dark bg-flag px-4 py-0.5 text-sm leading-tight font-black text-white"
                role="alert"
                data-testid="drive-banner"
              >
                <span aria-hidden="true">🚨</span>
                <span className="min-w-0">{drive.bannerText ?? drive.text}</span>
              </div>
            )}
          </div>
        )}
        {/* The first screen, one tight group (closer than the rest of the screen): whose card, the
            hole, then the tee-shot chips (tee shots happen first) and the stepper next to Save. On a
            normal hole the chips and the stepper both fit a 390x664 phone (Safari's visible area). */}
        <div className="space-y-2">
          {banners}
          <HoleHeader hole={hole} holeRow={holeRow} teeSet={view.trip.settings.tee_set} standing={standing} />
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
          <TeeShotPanel
            hole={hole}
            members={members}
            selected={line.tee_shot_player_id}
            nine={nine}
            // The red sticky banner already says it: don't spend the first screen on it twice.
            driveView={driveBanner ? null : drive}
            disabled={disabled}
            onSelect={(pid) => {
              expectMove(hole); // a tee shot on hole N+1 opens it
              actions.setTeeShot(hole, pid);
            }}
          />
          <ScorePanel
            hole={hole}
            par={par}
            credit={line.credit}
            draft={draft}
            disabled={disabled}
            onChange={(v) => setDrafts((d) => ({ ...d, [hole]: v }))}
          />
        </div>
        {/* Below the chips and the stepper so it never pushes them off the first screen. */}
        {derived.teamSize[teamId] === 3 && !reminderHidden && <ThreesomeReminder onDismiss={hideReminder} />}
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
          undo={drinkUndo.chip}
          undonePlayerId={drinkUndo.undonePlayerId}
          savingPhotoFor={drinkUndo.savingPhotoFor}
          onUndo={() => void actions.undoLastDrink()}
        />
        <MulliganPanel
          hole={hole}
          options={mulliganOptions(bank)}
          groomOnTeam={!!bank?.groom_on_team}
          groomName={derived.groomId ? nameOf(derived.groomId) : "The groom"}
          disabled={disabled}
          onUse={(source: MulliganSource) => actions.spendMulligan(source, hole)}
          undo={mulliganUndo}
          onUndo={() => void actions.undoMulligan()}
        />
        <ScorecardStrip lines={lines} currentHole={currentHole} viewing={hole} unsavedHoles={unsavedHoles} onSelect={selectHole} canEdit={editable} />
        {editable && <ActionBarSpacer />}
      </Screen>

      {editable && (
        <ActionBar>
          {teeCta !== null ? (
            <TeeButton hole={teeCta} onClick={onTee} />
          ) : (
            <>
              {/* Disabled right after the hole changed under the thumb: a tap meant for the hole
                  that was on screen a moment ago must not score this one. */}
              <SaveButton value={draft.value} dirty={draft.dirty} disabled={moveGuard} onSave={save} />
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
                  onClick={() => advance(next.hole)}
                />
              ) : next.kind === "complete" ? (
                <NextButton ariaLabel="Round complete" sub="Hole 18 done?" label="Finish 🏁" tone="flag" testId="round-complete" onClick={() => advance("complete")} />
              ) : null}
            </>
          )}
        </ActionBar>
      )}

      <AdvanceSheet prompt={advancePrompt?.c ?? null} onChoose={finishAdvance} />
      <ClosestToPinSheet open={contestHole !== null && line.contest === "ctp"} onClose={() => setContestHole(null)} hole={contestHole ?? hole} />
      <LongDriveSheet open={contestHole !== null && line.contest === "ld"} onClose={() => setContestHole(null)} hole={contestHole ?? hole} />
    </>
  );
}
