"use client";
// First run (once per device): Add to Home Screen -> location -> notifications. Every step skippable.
import { useRef, useState, type ReactNode } from "react";
import { requestLocationPermission } from "@/lib/client/geo";
import { enablePush, pushSupported } from "@/lib/client/push";
import { isStandalone, setOnboarded } from "@/lib/client/ui-prefs";
import { Button, cx } from "@/components/ui";
import { InstallGuide } from "./InstallGuide";

export type OnboardingStep = "install" | "location" | "notify";

export const LOCATION_REASON = "So long drives get measured by GPS, not by ego.";
export const NOTIFY_REASON = "So you hear about lead changes and the Groom's Mulligan the second they happen.";

/** Steps for this device: skip "install" when already running from the Home Screen. */
export function onboardingSteps(standalone: boolean): OnboardingStep[] {
  return standalone ? ["location", "notify"] : ["install", "location", "notify"];
}

const COUNT_WORDS = ["Zero", "One", "Two", "Three", "Four"];

/** "You're in, Tom. Two quick things, then golf." The count always matches the steps shown. */
export function onboardingIntro(playerName: string, stepCount: number): string {
  const n = COUNT_WORDS[stepCount] ?? String(stepCount);
  return `You're in, ${playerName}. ${n} quick ${stepCount === 1 ? "thing" : "things"}, then golf.`;
}

export interface OnboardingProps {
  code: string;
  playerId: string;
  playerName: string;
  vapidPublicKey: string | null;
  /** Finished or skipped: go to Play. */
  onDone: () => void;
}

export function Onboarding({ code, playerId, playerName, vapidPublicKey, onDone }: OnboardingProps) {
  const [steps] = useState(() => onboardingSteps(isStandalone()));
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; good: boolean } | null>(null);
  const [answered, setAnswered] = useState(false);
  const step = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;

  const finish = () => {
    setOnboarded(true);
    onDone();
  };
  /** Advance from step `from` (ignored if the user already moved on, e.g. tapped during an auto-advance). */
  const advanceFrom = (from: number) => {
    if (indexRef.current !== from) return;
    if (from >= steps.length - 1) {
      finish();
      return;
    }
    indexRef.current = from + 1;
    setNote(null);
    setAnswered(false);
    setIndex(from + 1);
  };
  const next = () => advanceFrom(index);

  const askLocation = async () => {
    setBusy(true);
    const r = await requestLocationPermission();
    setBusy(false);
    setAnswered(true);
    if (r === "granted") {
      setNote({ text: "Locked on. Your drives are now legally binding.", good: true });
      const from = index;
      setTimeout(() => advanceFrom(from), 900);
    } else if (r === "denied") {
      setNote({ text: "No GPS, no long-drive glory. You can allow it later in your browser settings.", good: false });
    } else {
      setNote({ text: "Couldn't get a fix right now. We'll ask again when you measure a drive.", good: false });
    }
  };

  const askNotify = async () => {
    setBusy(true);
    const r = await enablePush({ code, playerId, vapidPublicKey });
    setBusy(false);
    setAnswered(true);
    setNote({ text: r.message, good: r.status === "subscribed" });
    if (r.status === "subscribed") setTimeout(finish, 1100);
  };

  let body: ReactNode;
  if (step === "install") {
    body = (
      <StepBody emoji="📲" title="Put it on your Home Screen" reason="Full screen, opens with no signal, and it's the only way iPhones get notifications.">
        <InstallGuide />
      </StepBody>
    );
  } else if (step === "location") {
    body = <StepBody emoji="📍" title="Let us see the course" reason={LOCATION_REASON} />;
  } else {
    body = (
      <StepBody emoji="🔔" title="Get the gossip live" reason={NOTIFY_REASON}>
        {!pushSupported() && (
          <p className="rounded-xl border-2 border-ink bg-hazard-soft px-3 py-2 text-base font-bold">
            On iPhone, notifications only work from the Home Screen app. Add it first, then turn them on in Settings.
          </p>
        )}
      </StepBody>
    );
  }

  const primary =
    step === "install" ? (
      <Button variant="primary" size="xl" full onClick={next}>
        Done, it&apos;s on there
      </Button>
    ) : step === "location" ? (
      answered ? (
        <Button variant="primary" size="xl" full onClick={next}>
          Next
        </Button>
      ) : (
        <Button variant="primary" size="xl" full loading={busy} onClick={askLocation}>
          Allow location
        </Button>
      )
    ) : answered || !pushSupported() ? (
      <Button variant="primary" size="xl" full onClick={finish}>
        Let&apos;s play
      </Button>
    ) : (
      <Button variant="primary" size="xl" full loading={busy} onClick={askNotify}>
        Turn on notifications
      </Button>
    );

  return (
    <div className="flex min-h-dvh flex-col bg-paper" data-testid="onboarding">
      <div className="mx-auto flex w-full max-w-xl items-center justify-between px-gutter pt-[calc(14px+env(safe-area-inset-top))]">
        <div className="flex items-center gap-2" aria-label={`Step ${index + 1} of ${steps.length}`}>
          {steps.map((s, i) => (
            <span
              key={s}
              className={cx("h-2.5 rounded-full border-2 border-ink transition-all", i === index ? "w-8 bg-fairway" : i < index ? "w-2.5 bg-ink" : "w-2.5 bg-paper")}
            />
          ))}
        </div>
        <button type="button" onClick={finish} className="min-h-12 px-2 text-base font-extrabold text-ink underline underline-offset-4">
          Skip setup
        </button>
      </div>

      <div className="mx-auto w-full max-w-xl flex-1 px-gutter pt-4">
        {index === 0 && (
          <p className="mb-2 text-base font-extrabold text-fairway-dark" data-testid="onboarding-intro">
            {onboardingIntro(playerName, steps.length)}
          </p>
        )}
        {body}
        {note && (
          <p
            role="status"
            className={cx(
              "mt-4 rounded-xl border-2 px-3 py-2 text-base font-extrabold",
              note.good ? "border-fairway bg-fairway-soft text-fairway-dark" : "border-ink bg-hazard-soft text-ink",
            )}
          >
            {note.good ? "✅ " : "🤷 "}
            {note.text}
          </p>
        )}
      </div>

      <div className="mx-auto w-full max-w-xl space-y-2.5 px-gutter pt-4 pb-[calc(20px+env(safe-area-inset-bottom))]">
        {primary}
        {!(answered && step !== "install") && (
          <Button variant="secondary" size="lg" full onClick={next} disabled={busy}>
            {last ? "Skip, let's play" : "Skip"}
          </Button>
        )}
      </div>
    </div>
  );
}

function StepBody({ emoji, title, reason, children }: { emoji: string; title: string; reason: string; children?: ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="text-7xl leading-none" aria-hidden="true">
        {emoji}
      </div>
      <h1 className="loud text-[clamp(2.3rem,11vw,3.4rem)]">{title}</h1>
      <p className="text-xl font-extrabold text-ink">{reason}</p>
      {children}
    </div>
  );
}
