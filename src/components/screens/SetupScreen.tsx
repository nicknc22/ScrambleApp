"use client";
// Commissioner Setup tab: Roster · Teams · Course · Pots · Settings · Round.
// Non-commissioners get a read-only roster and an "Unlock commissioner" button.
import { useState } from "react";
import { useClientState } from "@/lib/client/react";
import { readPref, writePref } from "@/lib/client/ui-prefs";
import { SegmentedControl, type SegmentOption } from "@/components/ui";
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

/** While a sheet is open, park toasts near the top so they never cover the sheet's fields or buttons. */
const SHEET_TOAST_RULE = `:root:has([role="dialog"][aria-modal="true"]){--toast-bottom:calc(100dvh - 150px - env(safe-area-inset-bottom, 0px)) !important}`;

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
  const options: SegmentOption<SetupSection>[] = SETUP_SECTIONS.map((s) => ({
    value: s,
    label: s === "round" && status !== "setup" ? (status === "live" ? "🔴 Live" : "🏁 Final") : SECTION_LABEL[s],
    badge: s === "roster" && players === 0 ? "!" : s === "teams" && issues > 0 ? issues : s === "round" && blockers > 0 ? "!" : undefined,
  }));

  return (
    <Screen className="pb-4">
      <style>{SHEET_TOAST_RULE}</style>
      <div className="sticky z-20 -mx-4 -mt-4 border-b-2 border-line bg-paper/95 px-4 pt-3 pb-3 backdrop-blur" style={{ top: headerH }}>
        <SegmentedControl options={options} value={section} onChange={go} ariaLabel="Setup sections" />
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
