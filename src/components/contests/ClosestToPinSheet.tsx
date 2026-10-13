"use client";
// Contract: bottom-sheet flow for "Closest to pin" on a par 3 (photo -> feet/inches -> drag marker around pin -> submit).
// Opened from the Play screen and the Contests tab.
//
// 1. Photo with the ball and the flagstick in frame (strongly encouraged; "no photo" allowed with
//    a warning that the AI judge can't verify it). 2. Distance in feet + inches. 3. Drag your ball
//    around the pin to show which side you're on (radius comes from the distance). Submit.
// Edits are allowed: a new submission replaces the player's entry.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UUID } from "@/lib/types";
import { useClientState } from "@/lib/client/react";
import { formatFeetInches } from "@/lib/engine/format";
import { BottomSheet, Button, Card, Chip, EmptyState, Stepper, displayName } from "@/components/ui";
import {
  CTP_MAX_FT,
  CTP_STEPS,
  clampFeet,
  clampInches,
  ctpCanAdvance,
  ctpDistance,
  ctpNextStep,
  ctpPrevStep,
  ctpSubmitInput,
  defaultEntrant,
  entrantChoices,
  previewRank,
  type CtpStep,
} from "./flow";
import { feetToFeetInches, normalizeAngle, sideOfPin } from "./geometry";
import { GreenPlot } from "./GreenPlot";
import { entryOf, formatContestDistance, plotEntries } from "./model";
import { CameraButton, EntrantPicker, PhotoPreview, StepDots, usePhotoDraft } from "./parts";
import { useSubmitEntry } from "./useSubmitEntry";

export interface ClosestToPinSheetProps {
  open: boolean;
  onClose: () => void;
  /** Hole number (a closest-to-pin hole). */
  hole: number;
}

const STEP_LABEL: Record<CtpStep, string> = { photo: "Photo", distance: "Distance", where: "Where" };
const QUICK_FEET = [3, 6, 10, 15, 20, 30] as const;
const DEFAULT_FEET = 10;
const DEFAULT_ANGLE = 180;

export function ClosestToPinSheet(props: ClosestToPinSheetProps) {
  // Fresh state every time it opens.
  if (!props.open) return null;
  return <ClosestToPinFlow key={props.hole} {...props} />;
}

function ClosestToPinFlow({ onClose, hole }: ClosestToPinSheetProps) {
  const derived = useClientState((s) => s.derived);
  const meId = useClientState((s) => s.meId);
  const submitEntry = useSubmitEntry();
  const summary = derived?.contests.find((c) => c.hole === hole);

  const choices = derived ? entrantChoices(derived, meId) : [];
  const initialEntrant = defaultEntrant(choices, meId);
  const [picked, setPicked] = useState<UUID | null>(initialEntrant);
  const entrantId = picked && choices.some((p) => p.id === picked) ? picked : initialEntrant;

  // Prefill from the entrant's current entry (edits replace it).
  const prefill = (playerId: UUID | null) => {
    const e = entryOf(summary, playerId)?.entry;
    if (!e) return { feet: DEFAULT_FEET, inches: 0, angle: DEFAULT_ANGLE };
    const fi = feetToFeetInches(e.distance_value);
    return { feet: clampFeet(fi.feet), inches: clampInches(fi.inches), angle: normalizeAngle(e.angle_deg ?? DEFAULT_ANGLE) };
  };
  const [initial] = useState(() => prefill(initialEntrant));
  const [step, setStep] = useState<CtpStep>("photo");
  const [feet, setFeet] = useState(initial.feet);
  const [inches, setInches] = useState(initial.inches);
  const [angle, setAngle] = useState(initial.angle);
  const [noPhoto, setNoPhoto] = useState(false);
  const { photo, set: setPhotoFile } = usePhotoDraft();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const title = `Closest to pin · Hole ${hole}`;
  if (!derived) {
    return (
      <BottomSheet open onClose={onClose} title={title}>
        <EmptyState emoji="⏳" title="Loading the trip…" />
      </BottomSheet>
    );
  }
  const holeRow = derived.holeByNumber[hole];
  if (!holeRow || holeRow.contest !== "ctp") {
    return (
      <BottomSheet open onClose={onClose} title={title}>
        <EmptyState emoji="🤷" title={`Hole ${hole} isn't a closest-to-pin hole`}>
          Closest to pin is on the par 3s. Put the wedge down.
        </EmptyState>
      </BottomSheet>
    );
  }

  const entrant = entrantId ? derived.playerById[entrantId] : undefined;
  const entrantName = entrant ? displayName(entrant) : "you";
  const existing = entryOf(summary, entrantId);
  const draft = { step, hasPhoto: photo !== null, noPhoto, feet, inches, angle };
  const distance = ctpDistance(draft);
  const preview = previewRank(summary, entrantId, distance);
  const stepIndex = CTP_STEPS.indexOf(step);

  const pickEntrant = (id: UUID) => {
    if (id === entrantId) return;
    setPicked(id);
    const p = prefill(id);
    setFeet(p.feet);
    setInches(p.inches);
    setAngle(p.angle);
  };

  const goNext = () => {
    if (!ctpCanAdvance(draft)) return;
    const n = ctpNextStep(step);
    if (n) setStep(n);
  };
  const goBack = () => {
    const p = ctpPrevStep(step);
    if (p) setStep(p);
  };

  const submit = async () => {
    if (busy || !entrantId) return;
    setBusy(true);
    const res = await submitEntry({
      kind: "ctp",
      hole,
      playerId: entrantId,
      photo: photo?.file ?? null,
      previous: existing?.entry ?? null,
      build: (entryId, photoPath) => ctpSubmitInput({ entryId, hole, playerId: entrantId, feet, inches, angle, photoPath }),
    });
    if (!alive.current) return;
    setBusy(false);
    if (res.ok) onClose();
  };

  let footer: ReactNode;
  if (step === "photo") {
    footer = (
      <div className="space-y-1">
        {photo ? (
          <Button variant="primary" size="xl" full disabled={!entrantId} onClick={goNext} data-testid="ctp-next">
            Next: distance
          </Button>
        ) : (
          <CameraButton
            cta="Ball + flag photo"
            onFile={(f) => {
              setPhotoFile(f);
              setNoPhoto(false);
            }}
            testId="ctp-photo"
          />
        )}
        {!photo && (
          <Button
            variant="ghost"
            full
            className="underline"
            disabled={!entrantId}
            onClick={() => {
              setNoPhoto(true);
              setStep("distance");
            }}
            data-testid="ctp-no-photo"
          >
            No photo (the AI judge can&apos;t verify it)
          </Button>
        )}
      </div>
    );
  } else {
    footer = (
      <div className="flex gap-2">
        <Button variant="secondary" size="xl" onClick={goBack} className="shrink-0 px-5" aria-label="Back">
          ←
        </Button>
        {step === "distance" ? (
          <Button variant="primary" size="xl" full className="min-w-0 flex-1" onClick={goNext} disabled={!ctpCanAdvance(draft)} data-testid="ctp-next">
            Next: where
          </Button>
        ) : (
          <Button
            variant="primary"
            size="xl"
            full
            className="min-w-0 flex-1"
            onClick={() => void submit()}
            loading={busy}
            disabled={!entrantId}
            data-testid="ctp-submit"
          >
            Submit {formatFeetInches(distance)}
          </Button>
        )}
      </div>
    );
  }

  return (
    <BottomSheet open onClose={onClose} title={title} size="tall" footer={footer} dismissible={!busy}>
      <div className="space-y-4 pb-2" data-testid="ctp-sheet" data-step={step}>
        <StepDots steps={CTP_STEPS.map((s) => STEP_LABEL[s])} current={stepIndex} />

        {existing && (
          <p className="rounded-2xl bg-flag-soft px-3 py-2.5 text-[15px] font-bold" data-testid="ctp-replace">
            ♻️ Editing: {entrantName}&apos;s entry is {formatContestDistance("ctp", existing.distance)}. Submitting replaces it (and the feed hears about it).
          </p>
        )}

        {step === "photo" && (
          <>
            <EntrantPicker label="Entry for" choices={choices} value={entrantId} onChange={pickEntrant} meId={meId} derived={derived} />
            <Card tone="sky" className="space-y-1">
              <p className="loud text-2xl">Own tee shot. On the green.</p>
              <p className="text-base font-bold">
                Snap the ball <u>and</u> the flagstick in one frame: stand behind the ball, looking at the pin. The AI judge sizes it up using
                the flag (~7 ft) and the cup (4.25&quot;).
              </p>
            </Card>
            {photo && (
              <PhotoPreview
                photo={photo}
                onFile={(f) => {
                  setPhotoFile(f);
                  setNoPhoto(false);
                }}
                testId="ctp-photo"
              />
            )}
          </>
        )}

        {step === "distance" && (
          <>
            {noPhoto && !photo && (
              <Card tone="hazard" className="text-[15px] font-bold" data-testid="ctp-no-photo-warning">
                📵 No photo: the AI judge can&apos;t verify it, and everyone will assume you&apos;re lying. Bold strategy.
              </Card>
            )}
            <div className="space-y-1 text-center">
              <p className="text-xs font-extrabold tracking-widest text-muted uppercase">{entrantName} is</p>
              <p className="loud num text-6xl" data-testid="ctp-distance">
                {formatFeetInches(distance)}
              </p>
              <p className="text-base font-bold text-muted">from the cup{distance === 0 ? ". IN THE HOLE?! 🚨" : ""}</p>
            </div>
            <Stepper
              value={feet}
              onChange={(v) => setFeet(clampFeet(v))}
              min={0}
              max={CTP_MAX_FT}
              label="Feet"
              size="lg"
              decrementLabel="One foot less"
              incrementLabel="One foot more"
            />
            <div className="grid grid-cols-6 gap-1.5" role="group" aria-label="Quick feet">
              {QUICK_FEET.map((n) => (
                <Chip
                  key={n}
                  selected={feet === n}
                  tone="ink"
                  showCheck={false}
                  onClick={() => setFeet(n)}
                  className="justify-center px-0!"
                  aria-label={`${n} feet`}
                >
                  {n}&apos;
                </Chip>
              ))}
            </div>
            <Stepper
              value={inches}
              onChange={(v) => setInches(clampInches(v))}
              min={0}
              max={11}
              label="Inches"
              size="lg"
              decrementLabel="One inch less"
              incrementLabel="One inch more"
            />
            <p className="rounded-2xl bg-sand px-3 py-2.5 text-[15px] leading-snug font-semibold text-muted">
              📏 Pace it off, count putter lengths (about 3 ft each), or use the iPhone Measure app. Hold a button to spin it faster.
            </p>
          </>
        )}

        {step === "where" && (
          <>
            {/* Fixed-height status: it changes while dragging, and the plot must not move under the finger. */}
            <div className="space-y-0.5">
              <p className="loud truncate text-[28px] leading-[34px]" data-testid="ctp-side">
                {distance === 0 ? "In the cup. Sure." : `${sideOfPin(angle)} · ${formatFeetInches(distance)}`}
              </p>
              <p className="truncate text-base leading-6 font-black text-fairway-dark" data-testid="ctp-preview">
                {preview
                  ? preview.rank === 1
                    ? preview.leader
                      ? "Takes the lead 🔥"
                      : "First on the board 🔥"
                    : `You'd be ${preview.label} · leader ${displayName(derived.playerById[preview.leader?.player_id ?? ""])} ${preview.leader ? formatContestDistance("ctp", preview.leader.distance) : ""}`
                  : " "}
              </p>
            </div>
            <GreenPlot
              hole={hole}
              fitHeight
              entries={plotEntries(summary, derived, { meId, excludePlayerId: entrantId })}
              marker={{
                feet: distance,
                angle,
                label: entrantName,
                onAngleChange: setAngle,
              }}
            />
            <p className="text-[15px] leading-snug font-bold text-muted">
              Drag your ball around the pin to where it sits (or use the arrow keys). Up is long, toward the back of the green; down is short. The
              distance stays what you entered.
            </p>
          </>
        )}
      </div>
    </BottomSheet>
  );
}
