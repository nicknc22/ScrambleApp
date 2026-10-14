"use client";
// Commissioner Setup tab: Roster · Teams · Course · Pots · Settings · Round.
// Non-commissioners get a read-only roster and an "Unlock commissioner" button.
import { useState } from "react";
import { useClientState } from "@/lib/client/react";
import { readPref, writePref } from "@/lib/client/ui-prefs";
import { cx } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";
import { CourseEditor } from "@/components/setup/course/CourseEditor";
import { ReadOnlySetup } from "@/components/setup/ReadOnlySetup";
import { RosterSection } from "@/components/setup/RosterSection";
import { TeamsSection } from "@/components/setup/TeamsSection";
import { PotsSection } from "@/components/setup/PotsSection";
import { SettingsSection } from "@/components/setup/SettingsSection";
import { RoundSection } from "@/components/setup/RoundSection";
import {
  SECTION_LABEL,
  SETUP_SECTIONS,
  isSetupSection,
  nextStep,
  preflight,
  sectionBadges,
  type NextStep,
  type SectionBadge,
  type SetupSection,
} from "@/components/setup/model";
import { useHeaderHeight } from "@/components/setup/shared";

const sectionKey = (code: string) => `scramble:setup-section:${code}`;

/** Icon + short label so all six fit one row on a 360px phone (no sideways scrolling, nothing clipped). */
const SECTION_TAB: Record<SetupSection, { icon: string; short: string }> = {
  roster: { icon: "👥", short: "Roster" },
  teams: { icon: "🤝", short: "Teams" },
  course: { icon: "⛳", short: "Course" },
  pots: { icon: "💰", short: "Pots" },
  settings: { icon: "⚙️", short: "Trip" },
  round: { icon: "🏁", short: "Round" },
};

interface SectionTab {
  value: SetupSection;
  icon: string;
  label: string;
  /** Accessible name; starts with the visible label. */
  name: string;
  badge?: SectionBadge;
}

export function SetupScreen() {
  const view = useClientState((s) => s.view);
  const code = useClientState((s) => s.code);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const status = view?.trip.status ?? "setup";
  const headerH = useHeaderHeight();
  // Before the round: wherever the commissioner left off (Roster, where Send the link lives, the
  // first time). Once it's live or final, Setup always opens on the Live/Final tools: that's what
  // it's for on the course. A tap picks a section for as long as this screen is open.
  const [saved] = useState<SetupSection | null>(() => {
    const v = readPref(sectionKey(code));
    return isSetupSection(v) ? v : null;
  });
  const [picked, setPicked] = useState<SetupSection | null>(null);
  const section: SetupSection = picked ?? (status === "setup" ? (saved ?? "roster") : "round");

  if (!view) return null;
  if (!isCommissioner) {
    return (
      <Screen>
        <ReadOnlySetup />
      </Screen>
    );
  }

  const go = (s: SetupSection) => {
    setPicked(s);
    if (status === "setup") writePref(sectionKey(code), s);
    try {
      window.scrollTo({ top: 0 });
    } catch {
      /* ignore */
    }
  };

  const pf = preflight(view);
  // Before the round, a dot flags optional extras too; once it's live only real problems badge.
  const badges = sectionBadges(pf, { warnings: status === "setup" });
  const step = status === "setup" ? nextStep(pf) : null;
  const tabs: SectionTab[] = SETUP_SECTIONS.map((s) => {
    const live = s === "round" && status !== "setup";
    const label = live ? (status === "live" ? "Live" : "Final") : SECTION_TAB[s].short;
    return {
      value: s,
      icon: live && status === "live" ? "🔴" : SECTION_TAB[s].icon,
      label,
      name: s === "settings" ? `${label} ${SECTION_LABEL[s].toLowerCase()}` : live ? `${label} round` : label,
      badge: badges[s],
    };
  });

  return (
    <Screen className="pb-4">
      <div className="sticky z-20 -mx-4 -mt-4 border-b-2 border-line bg-paper/95 px-4 pt-3 pb-3 backdrop-blur" style={{ top: headerH }}>
        <SectionTabs tabs={tabs} value={section} onChange={go} />
      </div>
      {/* The pre-flight lives on Round, so the strip only shows elsewhere (and never points at the page you're on). */}
      {step && section !== "round" && step.section !== section && <NextStrip step={step} onGo={go} />}
      <div data-testid="setup-screen" data-section={section}>
        {section === "roster" && <RosterSection />}
        {section === "teams" && <TeamsSection />}
        {section === "course" && <CourseEditor />}
        {section === "pots" && <PotsSection />}
        {section === "settings" && <SettingsSection />}
        {section === "round" && <RoundSection onGo={go} />}
      </div>
    </Screen>
  );
}

function SectionTabs({ tabs, value, onChange }: { tabs: SectionTab[]; value: SetupSection; onChange: (s: SetupSection) => void }) {
  return (
    <div role="tablist" aria-label="Setup sections" className="grid grid-cols-6 gap-0.5 rounded-2xl border-2 border-ink bg-sand p-1" data-testid="setup-tabs">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={t.badge ? `${t.name} (${t.badge.note})` : t.name}
            onClick={() => onChange(t.value)}
            className={cx(
              "relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-0.5 transition-colors",
              active ? "bg-ink text-white shadow-hard-sm" : "text-ink active:bg-line",
            )}
          >
            <span className="text-lg leading-none" aria-hidden="true">
              {t.icon}
            </span>
            <span className="max-w-full truncate text-xs leading-none font-black min-[400px]:text-[13px]">{t.label}</span>
            {t.badge?.level === "block" && (
              <span
                className={cx(
                  "absolute top-0.5 right-0.5 min-w-4 rounded-full bg-flag px-1 text-center text-[11px] leading-4 font-black text-white",
                  active && "ring-2 ring-white",
                )}
                aria-hidden="true"
                data-testid="setup-tab-badge"
                data-level="block"
              >
                !
              </span>
            )}
            {t.badge?.level === "warn" && (
              <span
                className={cx("absolute top-1 right-1 h-3 w-3 rounded-full border-2 border-ink bg-hazard", active && "ring-2 ring-white")}
                aria-hidden="true"
                data-testid="setup-tab-badge"
                data-level="warn"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** "Next: 10 not on a team →": the one thing to do next, a tap away. Ready → go start it. */
function NextStrip({ step, onGo }: { step: NextStep; onGo: (s: SetupSection) => void }) {
  const ready = step.kind === "ok";
  return (
    <button
      type="button"
      onClick={() => onGo(step.section)}
      data-testid="setup-next"
      data-level={step.kind}
      data-section={step.section}
      className={cx(
        "flex min-h-12 w-full items-center gap-2 rounded-2xl border-2 px-3 py-2 text-left active:scale-[0.99]",
        ready ? "border-fairway-dark bg-fairway text-white" : step.kind === "block" ? "border-ink bg-flag-soft text-ink" : "border-ink bg-hazard-soft text-ink",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] leading-tight font-black [overflow-wrap:anywhere]">
          {ready ? "✅ Ready. Start it on the first tee →" : `Next: ${step.title} →`}
        </span>
        {step.kind === "warn" && <span className="block text-sm leading-tight font-bold text-muted">Optional. You can start without it.</span>}
      </span>
    </button>
  );
}
