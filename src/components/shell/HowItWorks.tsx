"use client";
// "How it works" in words, for the guys who'd rather read than watch the cartoon:
// - HowItWorksSteps: the numbered card on the pre-round screen (WaitingForStart).
// - RulesSheet: ☰ → "Rules & lingo", the same steps plus a Lingo list (to par, thru, banked...)
//   and a button that plays the 40-second explainer.
// Personalised from the roster (the groom's name) and trip.base_team_size (the ghost beer line).
// Every claim here must match docs/SPEC.md + CLAUDE.md; tests/ui/how-it-works.test.tsx pins the
// rule-sensitive bits.
import type { SVGProps } from "react";
import type { TripState } from "@/lib/types";
import { useClientState } from "@/lib/client/react";
import { BottomSheet, Button, Card, IconPlayCircle, displayName } from "@/components/ui";
import { useShellNav } from "./nav";

export interface RulesInput {
  /** The groom's display name; null when nobody is flagged groom. */
  groomName: string | null;
  /** trip.base_team_size: the team size every team "drinks for" (ghost beers). */
  baseTeamSize: number;
}

export interface RuleStep {
  key: string;
  text: string;
}

/** The roster bits the rules mention. */
export function rulesInput(view: Pick<TripState, "trip" | "players">): RulesInput {
  const groom = view.players.find((p) => p.is_groom && !p.deleted_at) ?? null;
  return { groomName: groom ? displayName(groom) : null, baseTeamSize: view.trip.base_team_size };
}

/**
 * The short-handed line. With the usual foursome base it spells out the two cases that happen
 * (credit(d) = floor(base * d / n): a threesome's drinks go 1, 1, 2; a twosome's 2, 2, 2).
 * Any other base gets the general version.
 */
export function ghostStepText(base: number): string {
  if (base === 4) {
    return "Threesome? Every 3rd drink counts 2 (👻 ghost beer) and someone hits a 4th ball every shot. Twosome? Every drink counts 2.";
  }
  return `Every team drinks for ${base}. Short-handed? Some drinks count 2 (👻 ghost beers). Bigger team? Some count 0. The app does the math.`;
}

/** The numbered steps, in the order you'll need them on the course. */
export function howItWorksSteps(input: RulesInput): RuleStep[] {
  const groom = input.groomName?.trim() || "the groom";
  return [
    { key: "tee", text: "On the first tee, hit the big yellow ON THE TEE button. Drinks before that don't count. Drink them anyway." },
    { key: "drinks", text: "Every drink you log takes a stroke off your team's score (🍺 = −1). Log your teammates' too. Nobody remembers after six." },
    { key: "ghost", text: ghostStepText(input.baseTeamSize) },
    { key: "score", text: "After you hole out: pick whose drive you used, set the TEAM score, tap Save, then tee off the next hole." },
    { key: "drives", text: "Everybody's drive gets used at least once per nine. Yes, even yours." },
    {
      key: "mulligans",
      text: `Shotguns and shots bank a mulligan; ${groom} 👑 gets one Groom's Mulligan. Mulligans never change the score.`,
    },
    { key: "contests", text: "🎯 Closest-to-pin and 💣 long-drive holes get a badge on the hole. Tap the contest button on that hole to enter." },
  ];
}

/** One line each: the words the app throws at you. */
export const LINGO: readonly { term: string; text: string }[] = [
  { term: "To par", text: "your net vs par so far. Lowest wins." },
  { term: "Thru", text: "holes scored." },
  { term: "Net", text: "strokes minus drinks (the strokes your drinks took off)." },
  { term: "🍺 banked", text: "drinks on a hole with no score yet; they count once it's scored." },
  { term: "👻 Ghost beer", text: "a drink worth 2 because your team is short a man." },
  { term: "Drive minimum", text: "everybody's tee shot used once per nine. The app yells when you're running out of holes." },
  {
    term: "Pots & antes",
    text: "antes go into the team match and each contest hole. An empty contest pot rolls to the next hole of the same kind, then into the team match.",
  },
  { term: "Settle up", text: "Venmo buttons on the Money tab once the commissioner finalizes. The app never touches money." },
];

/** The numbered list itself (shared by the card and the sheet). */
export function StepsList({ steps }: { steps: readonly RuleStep[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={s.key} className="flex gap-3" data-step={s.key}>
          <span
            className="num flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-hazard text-base font-black text-ink"
            aria-hidden="true"
          >
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 pt-0.5 text-base leading-snug font-bold">{s.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** The numbered card, from plain props (the render test uses this one). */
export function HowItWorksCard({ input, onLingo }: { input: RulesInput; onLingo?: () => void }) {
  return (
    <Card className="space-y-4 border-ink" data-testid="how-it-works-steps" aria-labelledby="how-it-works-title">
      <div>
        <h2 id="how-it-works-title" className="text-xl font-black tracking-tight uppercase">
          How it works
        </h2>
        <p className="text-sm font-bold text-muted">Seven things. Read them before beer three.</p>
      </div>
      <StepsList steps={howItWorksSteps(input)} />
      {onLingo && (
        <Button variant="secondary" full onClick={onLingo} data-testid="how-it-works-lingo">
          What&apos;s &ldquo;to par&rdquo;, &ldquo;thru&rdquo;, &ldquo;banked&rdquo;?
        </Button>
      )}
    </Card>
  );
}

/** The pre-round card, personalised from the trip on this phone. */
export function HowItWorksSteps() {
  const view = useClientState((s) => s.view);
  const nav = useShellNav();
  if (!view) return null;
  return <HowItWorksCard input={rulesInput(view)} onLingo={nav.openRules} />;
}

/** Steps + Lingo, from plain props (the sheet's body). */
export function RulesContent({ input }: { input: RulesInput }) {
  return (
    <div className="space-y-5 pb-2" data-testid="rules-content">
      <section className="space-y-3" aria-labelledby="rules-steps">
        <h3 id="rules-steps" className="text-lg font-black tracking-tight uppercase">
          How it works
        </h3>
        <StepsList steps={howItWorksSteps(input)} />
      </section>
      <section className="space-y-2" aria-labelledby="rules-lingo">
        <h3 id="rules-lingo" className="text-lg font-black tracking-tight uppercase">
          Lingo
        </h3>
        <dl className="divide-y-2 divide-line overflow-hidden rounded-2xl border-2 border-line" data-testid="rules-lingo">
          {LINGO.map((l) => (
            <div key={l.term} className="px-3 py-2.5">
              <dt className="text-base leading-tight font-black">{l.term}</dt>
              <dd className="text-[15px] leading-snug font-semibold text-muted">{l.text}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

/** ☰ → "Rules & lingo". */
export function RulesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const view = useClientState((s) => s.view);
  const nav = useShellNav();
  return (
    <BottomSheet
      open={open && !!view}
      onClose={onClose}
      title="Rules & lingo"
      footer={
        <Button
          variant="hazard"
          size="lg"
          full
          leading={<IconPlayCircle size={24} />}
          onClick={() => {
            onClose();
            nav.openExplainer();
          }}
          data-testid="rules-watch"
        >
          Watch the 40-sec cartoon
        </Button>
      }
    >
      {view && <RulesContent input={rulesInput(view)} />}
    </BottomSheet>
  );
}

/** Open book: the ☰ menu's "Rules & lingo" row (same stroke style as the ui icons). */
export function IconRulebook({ size = 24, strokeWidth = 2.5, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d="M12 6.5C10 4.8 7 4.5 3 5v13.5c4-.5 7-.2 9 1.5 2-1.7 5-2 9-1.5V5c-4-.5-7-.2-9 1.5z" />
      <path d="M12 6.5V20" />
    </svg>
  );
}
