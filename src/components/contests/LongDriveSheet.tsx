"use client";
// Contract: bottom-sheet flow for "Measure drive" on a par 5 (GPS -> rank preview -> required photo -> submit).
// Opened from the Play screen and the Contests tab.
//
// Flow: pick who you're measuring for (defaults to you) -> stand at the ball -> Measure (5 s of
// high-accuracy GPS, best reading wins) -> weak? hold still + retry; after 3 failed tries the best
// weak reading can go to the commissioner -> distance from the hole's tee point, huge, with
// "You'd be 2nd" and the leader across all groups -> photo (required) -> submit.
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { UUID } from "@/lib/types";
import { useClientState } from "@/lib/client/react";
import { GEO_ERROR_MESSAGES, GeoError, sampleBestPosition, type GeoErrorCode } from "@/lib/client/geo";
import { BottomSheet, Button, Card, EmptyState, PlayerName, TeamPill, cx, displayName } from "@/components/ui";
import { useShellNav } from "@/components/shell/nav";
import {
  GPS_INITIAL,
  MAX_GPS_TRIES,
  canAcceptWeak,
  defaultEntrant,
  entrantChoices,
  gpsReducer,
  ldDistanceYards,
  ldSubmitInput,
  ldVerdict,
  previewRank,
  teePoint,
  triesLeft,
} from "./flow";
import { entryOf, formatContestDistance } from "./model";
import { CameraButton, EntrantPicker, PhotoPreview, PhotoSlot, usePhotoDraft } from "./parts";
import { useSubmitEntry } from "./useSubmitEntry";

export interface LongDriveSheetProps {
  open: boolean;
  onClose: () => void;
  /** Hole number (a long-drive hole, the team's current hole). */
  hole: number;
}

const SAMPLE_MS = 5000;

export function LongDriveSheet(props: LongDriveSheetProps) {
  // Fresh state every time it opens.
  if (!props.open) return null;
  return <LongDriveFlow key={props.hole} {...props} />;
}

function LongDriveFlow({ onClose, hole }: LongDriveSheetProps) {
  const derived = useClientState((s) => s.derived);
  const settings = useClientState((s) => s.view?.trip.settings ?? null);
  const meId = useClientState((s) => s.meId);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const isDemo = useClientState((s) => s.view?.trip.is_demo ?? false);
  const nav = useShellNav();
  const submitEntry = useSubmitEntry();

  const choices = derived ? entrantChoices(derived, meId) : [];
  const [picked, setPicked] = useState<UUID | null>(null);
  const entrantId = picked && choices.some((p) => p.id === picked) ? picked : defaultEntrant(choices, meId);

  const [gps, send] = useReducer(gpsReducer, GPS_INITIAL);
  const { photo, set: setPhoto } = usePhotoDraft();
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const holeRow = derived?.holeByNumber[hole];
  const summary = derived?.contests.find((c) => c.hole === hole);
  const limitM = settings?.ld_accuracy_limit_m ?? 12;
  const title = `Long drive · Hole ${hole}`;

  if (!derived || !settings) {
    return (
      <BottomSheet open onClose={onClose} title={title}>
        <EmptyState emoji="⏳" title="Loading the trip…" />
      </BottomSheet>
    );
  }
  if (!holeRow || holeRow.contest !== "ld") {
    return (
      <BottomSheet open onClose={onClose} title={title}>
        <EmptyState emoji="🤷" title={`Hole ${hole} isn't a long drive hole`}>
          Long drive is on the par 5s. Nice try though.
        </EmptyState>
      </BottomSheet>
    );
  }

  const hasTee = teePoint(holeRow) !== null;
  const entrant = entrantId ? derived.playerById[entrantId] : undefined;
  const existing = entryOf(summary, entrantId);

  const measure = () => {
    if (gps.phase === "measuring") return;
    const mine = ++attempt.current;
    const live = () => alive.current && mine === attempt.current;
    send({ type: "start" });
    sampleBestPosition({
      durationMs: SAMPLE_MS,
      onProgress: (reading) => {
        if (live()) send({ type: "progress", reading });
      },
    }).then(
      (reading) => {
        if (live()) send({ type: "result", reading, limitM });
      },
      (err: unknown) => {
        if (live()) send({ type: "error", code: err instanceof GeoError ? err.code : "unavailable" });
      },
    );
  };

  const yards = gps.phase === "fixed" && gps.fix ? ldDistanceYards(holeRow, gps.fix) : null;
  // A simulated position goes out tagged (ldSubmitInput) and lands with the commissioner on a real trip.
  const verdict = yards !== null ? ldVerdict(yards, gps.lowAccuracy, settings, gps.fix?.simulated === true && !isDemo) : null;
  const preview = yards !== null && verdict && !verdict.review && !verdict.blocked ? previewRank(summary, entrantId, yards) : null;
  const leader = summary?.entries.find((v) => v.valid && v.player_id !== entrantId) ?? null;

  const submit = async () => {
    if (busy || !entrantId || yards === null || !gps.fix || !photo || verdict?.blocked) return;
    setBusy(true);
    const fix = gps.fix;
    const res = await submitEntry({
      kind: "ld",
      hole,
      playerId: entrantId,
      photo: photo.file,
      previous: existing?.entry ?? null,
      build: (entryId, photoPath) =>
        ldSubmitInput({ entryId, hole, playerId: entrantId, yards, fix, lowAccuracy: gps.lowAccuracy, photoPath: photoPath ?? "" }),
    });
    if (!alive.current) return;
    setBusy(false);
    if (res.ok) onClose();
  };

  // Re-measuring replaces the entry: say so where the thumb is, louder when it's a downgrade.
  const shorterBy = existing && yards !== null ? existing.distance - yards : 0;
  const replaceLine =
    existing && yards !== null ? (
      <p className={cx("text-center text-sm leading-tight font-black", shorterBy > 0 ? "text-flag" : "text-muted")} data-testid="ld-replace-footer">
        {shorterBy > 0
          ? `⚠️ Replaces ${displayName(entrant)}'s ${formatContestDistance("ld", existing.distance)}: ${shorterBy} yd SHORTER`
          : `♻️ Replaces ${displayName(entrant)}'s ${formatContestDistance("ld", existing.distance)} drive`}
      </p>
    ) : null;

  let footer: ReactNode;
  if (!hasTee) {
    footer = isCommissioner ? (
      <Button
        variant="ink"
        size="lg"
        full
        onClick={() => {
          onClose();
          nav.setTab("setup");
        }}
      >
        Set the tee point in Setup
      </Button>
    ) : (
      <Button variant="secondary" size="lg" full onClick={onClose}>
        Got it
      </Button>
    );
  } else if (gps.phase === "idle") {
    footer = (
      <Button variant="hazard" size="xl" full onClick={measure} disabled={!entrantId} leading={<span aria-hidden="true">📡</span>} data-testid="ld-measure">
        Measure drive
      </Button>
    );
  } else if (gps.phase === "measuring") {
    footer = (
      <Button variant="hazard" size="xl" full disabled loading>
        Measuring…
      </Button>
    );
  } else if (gps.phase === "weak" || gps.phase === "error") {
    footer = (
      <div className="space-y-2">
        <Button variant="primary" size="xl" full onClick={measure} leading={<span aria-hidden="true">🔁</span>} data-testid="ld-retry">
          Retry
        </Button>
        {canAcceptWeak(gps) && (
          <Button variant="secondary" size="lg" full onClick={() => send({ type: "accept_weak" })} data-testid="ld-accept-weak">
            Submit for commissioner review
          </Button>
        )}
      </div>
    );
  } else if (!photo && !verdict?.blocked) {
    footer = (
      <div className="space-y-1.5">
        {replaceLine}
        <CameraButton cta="Photo of your ball" onFile={setPhoto} testId="ld-photo" />
        <p className="text-center text-sm font-black text-muted uppercase">Required. No photo, no drive.</p>
      </div>
    );
  } else {
    const label = verdict?.review ? "Send to the commish" : yards !== null ? `Submit ${yards} yd` : "Submit";
    footer = (
      <div className="space-y-1.5">
        {replaceLine}
        <Button
          variant="primary"
          size="xl"
          full
          disabled={!photo || !entrantId || yards === null || !!verdict?.blocked}
          loading={busy}
          onClick={() => void submit()}
          data-testid="ld-submit"
        >
          {label}
        </Button>
      </div>
    );
  }

  return (
    <BottomSheet open onClose={onClose} title={title} size="tall" footer={footer} dismissible={!busy}>
      <div className="space-y-4 pb-2" data-testid="ld-sheet" data-phase={gps.phase}>
        <EntrantPicker label="Measuring for" choices={choices} value={entrantId} onChange={setPicked} meId={meId} derived={derived} />

        {!hasTee ? (
          <Card tone="hazard" className="space-y-2" data-testid="ld-no-tee">
            <p className="text-4xl leading-none" aria-hidden="true">
              📍
            </p>
            <p className="text-xl leading-tight font-black">No tee point for hole {hole} yet.</p>
            <p className="text-base font-bold">
              Drives are measured from the hole&apos;s tee point, and nobody has dropped it. The commissioner sets it on the Course screen (Setup → Course):
              tap the tee box on the satellite map, save, done. Everyone gets measured from the same spot, so it stays fair.
            </p>
          </Card>
        ) : gps.phase === "idle" ? (
          <IdleCard />
        ) : gps.phase === "measuring" ? (
          <MeasuringCard attempt={gps.attempts} accuracy={gps.live?.accuracy ?? null} />
        ) : gps.phase === "weak" ? (
          <WeakCard accuracy={gps.live?.accuracy ?? gps.last?.accuracy ?? null} limitM={limitM} triesLeft={triesLeft(gps)} canReview={canAcceptWeak(gps)} />
        ) : gps.phase === "error" ? (
          <ErrorCard code={gps.error ?? "unavailable"} canReview={canAcceptWeak(gps)} />
        ) : (
          yards !== null && (
            <div className="space-y-4">
              <div className="rounded-3xl border-2 border-ink bg-ink px-4 py-5 text-center text-white" data-testid="ld-distance" data-yards={yards}>
                <p className="text-xs font-black tracking-widest text-hazard uppercase">
                  {entrant ? `${displayName(entrant)}'s drive` : "The drive"}
                </p>
                <p className="loud num mt-1 text-[clamp(5rem,30vw,7.5rem)] leading-none">
                  {yards}
                  <span className="ml-1 text-[0.36em]">yd</span>
                </p>
                <p className="mt-2 text-sm font-bold text-white/80">
                  From the hole {hole} tee · GPS ±{Math.round(gps.fix?.accuracy ?? 0)} m{gps.fix?.simulated ? " · simulated" : ""}
                  {gps.lowAccuracy ? " · weak" : ""}
                </p>
              </div>

              {verdict?.reason && (
                <Card tone={verdict.blocked ? "flag" : "hazard"} className="text-base font-bold" data-testid="ld-verdict">
                  <span aria-hidden="true">{verdict.blocked ? "🛑 " : "⚖️ "}</span>
                  {verdict.reason}
                </Card>
              )}

              {!verdict?.review && !verdict?.blocked && (
                <Card tone={preview?.rank === 1 ? "fairway" : "sky"} className="space-y-1" data-testid="ld-preview">
                  <p className="loud text-3xl">
                    {preview?.rank === 1 ? (leader ? "You'd take the lead 🔥" : "First on the board 🔥") : `You'd be ${preview?.label ?? "on the board"}`}
                  </p>
                  {leader ? (
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-base font-bold">
                      <span>Leader across all groups:</span>
                      <span className="font-black">
                        <PlayerName player={derived.playerById[leader.player_id]} you={leader.player_id === meId} />
                      </span>
                      <span className="num font-black">{formatContestDistance("ld", leader.distance)}</span>
                      <TeamPill team={derived.teamById[leader.team_id]} size="sm" />
                    </p>
                  ) : (
                    <p className="text-base font-bold">Nobody has a drive on the board yet. Instant leader, instant target.</p>
                  )}
                </Card>
              )}

              {existing && (
                <Card tone="flag" className="text-base font-bold" data-testid="ld-replace">
                  <span aria-hidden="true">♻️ </span>
                  This replaces {entrant ? `${displayName(entrant)}'s` : "the"} current {formatContestDistance("ld", existing.distance)} drive. One entry per
                  player per hole.
                </Card>
              )}

              {photo ? (
                <PhotoPreview photo={photo} onFile={setPhoto} testId="ld-photo" />
              ) : (
                !verdict?.blocked && <PhotoSlot title="Now the photo" hint="Your ball, in the fairway, from where you're standing. It goes to the feed." />
              )}

              <Button variant="ghost" full onClick={measure} className="underline" data-testid="ld-remeasure">
                Not at your ball yet? Measure again
              </Button>
            </div>
          )
        )}
      </div>
    </BottomSheet>
  );
}

function IdleCard() {
  return (
    <Card tone="sky" className="space-y-2 text-center" data-testid="ld-idle">
      <p className="text-6xl leading-none" aria-hidden="true">
        🏌️
      </p>
      <p className="loud text-3xl">Stand at your ball.</p>
      <p className="text-base font-bold">Fairway only (honor system). Hit Measure and hold the phone still for 5 seconds.</p>
    </Card>
  );
}

function MeasuringCard({ attempt, accuracy }: { attempt: number; accuracy: number | null }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof el.animate !== "function") return;
    const a = el.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: SAMPLE_MS, easing: "linear", fill: "forwards" });
    return () => a.cancel();
  }, [attempt]);
  return (
    <Card tone="sky" className="space-y-3 text-center" data-testid="ld-measuring" aria-live="polite">
      <p className="animate-wiggle text-6xl leading-none" aria-hidden="true">
        🛰️
      </p>
      <p className="loud text-3xl">Hold still…</p>
      <p className="text-base font-bold">
        Asking the satellites{attempt > 1 ? ` (try ${attempt})` : ""}.{" "}
        {accuracy !== null && Number.isFinite(accuracy) ? <span className="num font-black">Best so far ±{Math.round(accuracy)} m</span> : "No fix yet."}
      </p>
      <div className="h-3 overflow-hidden rounded-full border-2 border-ink bg-paper" role="progressbar" aria-label="Measuring">
        <div ref={bar} className="h-full origin-left bg-sky" style={{ transform: "scaleX(0)" }} />
      </div>
    </Card>
  );
}

function WeakCard({ accuracy, limitM, triesLeft: left, canReview }: { accuracy: number | null; limitM: number; triesLeft: number; canReview: boolean }) {
  return (
    <Card tone="hazard" className="space-y-2" data-testid="ld-weak" aria-live="polite">
      <p className="text-5xl leading-none" aria-hidden="true">
        📡
      </p>
      <p className="loud text-3xl">GPS is weak, hold still</p>
      <p className="text-base font-bold">
        Best fix was <span className="num font-black">±{accuracy !== null && Number.isFinite(accuracy) ? Math.round(accuracy) : "?"} m</span>; it needs ±{limitM} m
        or better. Step out from under the trees, hold the phone up, and retry.
      </p>
      <p className="text-sm font-bold text-muted">
        {canReview
          ? `${MAX_GPS_TRIES} tries down. You can send this one to the commissioner for review.`
          : `${left} more ${left === 1 ? "try" : "tries"} before you can send it to the commissioner instead.`}
      </p>
    </Card>
  );
}

function ErrorCard({ code, canReview }: { code: GeoErrorCode; canReview: boolean }) {
  if (code === "permission_denied") {
    return (
      <Card tone="flag" className="space-y-2" data-testid="ld-denied">
        <p className="text-5xl leading-none" aria-hidden="true">
          🔒
        </p>
        <p className="loud text-3xl">Location is blocked</p>
        <p className="text-base font-bold">This phone won&apos;t share its location with the app, so it can&apos;t measure. Fix it, then hit Retry:</p>
        <ul className="list-disc space-y-1.5 pl-5 text-base font-semibold">
          <li>
            <b>iPhone:</b> Settings → Privacy &amp; Security → Location Services → on. Then Safari Websites → <i>While Using the App</i>.
          </li>
          <li>
            <b>iPhone, in Safari:</b> tap <b>aA</b> in the address bar → Website Settings → Location → <i>Allow</i>.
          </li>
          <li>
            <b>Android:</b> tap the icon left of the address → Permissions → Location → <i>Allow</i>.
          </li>
        </ul>
        <p className="text-sm font-bold text-muted">Or hand the phone to a teammate whose GPS works and measure for yourself from theirs.</p>
      </Card>
    );
  }
  return (
    <Card tone="hazard" className={cx("space-y-2")} data-testid="ld-error" aria-live="polite">
      <p className="text-5xl leading-none" aria-hidden="true">
        🌲
      </p>
      <p className="loud text-3xl">No GPS fix</p>
      <p className="text-base font-bold">{GEO_ERROR_MESSAGES[code]}</p>
      {canReview && <p className="text-sm font-bold text-muted">You can send your best reading to the commissioner for review.</p>}
    </Card>
  );
}
