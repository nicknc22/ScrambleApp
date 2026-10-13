"use client";
// Commissioner Setup tab: Roster · Teams · Course · Pots · Settings · Round.
// Non-commissioners get a read-only roster and an "Unlock commissioner" button.
import { useState, type ReactNode } from "react";
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
import { SECTION_LABEL, SETUP_SECTIONS, isSetupSection, livePlayers, preflight, teamIssues, type SetupSection } from "@/components/setup/model";
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
  badge?: ReactNode;
}

export function SetupScreen() {
  const view = useClientState((s) => s.view);
  const code = useClientState((s) => s.code);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const status = view?.trip.status ?? "setup";
  const headerH = useHeaderHeight();
  const [section, setSection] = useState<SetupSection>(() => {
    const saved = readPref(sectionKey(code));
    if (isSetupSection(saved)) return saved;
    return status === "setup" ? "roster" : "round";
  });

  if (!view) return null;
  if (!isCommissioner) {
    return (
      <Screen>
        <ReadOnlySetup />
      </Screen>
    );
  }

  const go = (s: SetupSection) => {
    setSection(s);
    writePref(sectionKey(code), s);
    try {
      window.scrollTo({ top: 0 });
    } catch {
      /* ignore */
    }
  };

  const players = livePlayers(view).length;
  const issues = teamIssues(view);
  const blockers = status === "setup" ? preflight(view).blocking : 0;
  const tabs: SectionTab[] = SETUP_SECTIONS.map((s) => {
    const live = s === "round" && status !== "setup";
    const label = live ? (status === "live" ? "Live" : "Final") : SECTION_TAB[s].short;
    return {
      value: s,
      icon: live && status === "live" ? "🔴" : SECTION_TAB[s].icon,
      label,
      name: s === "settings" ? `${label} ${SECTION_LABEL[s].toLowerCase()}` : live ? `${label} round` : label,
      badge: s === "roster" && players === 0 ? "!" : s === "teams" && issues > 0 ? issues : s === "round" && blockers > 0 ? "!" : undefined,
    };
  });

  return (
    <Screen className="pb-4">
      <div className="sticky z-20 -mx-4 -mt-4 border-b-2 border-line bg-paper/95 px-4 pt-3 pb-3 backdrop-blur" style={{ top: headerH }}>
        <SectionTabs tabs={tabs} value={section} onChange={go} />
      </div>
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
            aria-label={t.badge !== undefined ? `${t.name} (${t.badge})` : t.name}
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
            {t.badge !== undefined && (
              <span
                className={cx(
                  "num absolute top-0.5 right-0.5 min-w-4 rounded-full px-1 text-center text-[11px] leading-4 font-black",
                  active ? "bg-hazard text-ink" : "bg-flag text-white",
                )}
                aria-hidden="true"
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
