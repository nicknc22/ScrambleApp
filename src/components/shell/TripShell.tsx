"use client";
// The trip page shell: splash / load error / join / onboarding / tabs. Lives inside TripProvider
// and the Toast/Confirm/Fanfare providers (see TripApp).
import { useState, type ReactNode } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { isOnboarded } from "@/lib/client/ui-prefs";
import { IconChevronRight } from "@/components/ui";
import { JoinScreen } from "@/components/join/JoinScreen";
import { Onboarding } from "@/components/join/Onboarding";
import { displayName } from "@/components/ui/PlayerName";
import { PlayScreen } from "@/components/screens/PlayScreen";
import { LeaderboardScreen } from "@/components/screens/LeaderboardScreen";
import { FeedScreen } from "@/components/screens/FeedScreen";
import { ContestsScreen } from "@/components/screens/ContestsScreen";
import { MoneyScreen } from "@/components/screens/MoneyScreen";
import { SetupScreen } from "@/components/screens/SetupScreen";
import { AwardsScreen } from "@/components/screens/AwardsScreen";
import { ErrorBoundary } from "./ErrorBoundary";
import { countUnread, latestFeedAt, readFeedSeen, useFeedFanfare, useRejectedToasts, useRememberTrip, writeFeedSeen } from "./hooks";
import { MenuSheet } from "./MenuSheet";
import { ShellNavContext, type ShellNav } from "./nav";
import { activePlayers, teamOfPlayer } from "./roster";
import { SettingsSheet } from "./SettingsSheet";
import { LoadError, Splash } from "./Splash";
import { TabBar } from "./TabBar";
import { TAB_LABEL, defaultTab, resolveTab, type TabKey } from "./tabs";
import { TripHeader } from "./TripHeader";
import { useUrlTab } from "./useUrlTab";

const SCREENS: Record<TabKey, () => ReactNode> = {
  play: () => <PlayScreen />,
  leaderboard: () => <LeaderboardScreen />,
  feed: () => <FeedScreen />,
  contests: () => <ContestsScreen />,
  money: () => <MoneyScreen />,
  setup: () => <SetupScreen />,
  awards: () => <AwardsScreen />,
};

const reload = () => window.location.reload();

export function TripShell({ code }: { code: string }) {
  const store = useTripStore();
  const s = useClientState();
  const [urlTab, setUrlTab] = useUrlTab();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingFor, setOnboardingFor] = useState<string | null>(null);
  const [skipJoin, setSkipJoin] = useState(false);
  const [feedSeen, setFeedSeen] = useState<string | null>(() => readFeedSeen(code));

  const view = s.loaded ? s.view : null;
  const myTeam = view ? teamOfPlayer(view, s.meId) : null;
  const status = view?.trip.status ?? "setup";
  const ctx = { isCommissioner: s.isCommissioner, status };
  const tab = resolveTab(urlTab, ctx);

  useRejectedToasts(s.rejected);
  useFeedFanfare(view, s.derived, s.meId, myTeam?.id ?? null, s.snapshot?.meta.server_time ?? null);
  useRememberTrip(code, view?.trip.name);

  const setTab = (next: TabKey) => {
    if (tab === "feed" || next === "feed") {
      const latest = latestFeedAt(view);
      setFeedSeen(latest);
      writeFeedSeen(code, latest);
    }
    setMenuOpen(false);
    setUrlTab(next);
    try {
      window.scrollTo({ top: 0 });
    } catch {
      /* ignore */
    }
  };

  const switchPlayer = () => {
    setMenuOpen(false);
    setSettingsOpen(false);
    setSkipJoin(false);
    setOnboardingFor(null);
    store.setMe(null);
  };

  const nav: ShellNav = {
    tab,
    setTab,
    openMenu: () => setMenuOpen(true),
    openSettings: () => {
      setMenuOpen(false);
      setSettingsOpen(true);
    },
    switchPlayer,
  };

  if (!view) {
    if (s.loadError) return <LoadError code={code} message={s.loadError} online={s.online} onRetry={reload} />;
    return <Splash onRetry={reload} />;
  }

  const me = s.meId ? (view.players.find((p) => p.id === s.meId && !p.deleted_at) ?? null) : null;

  if (onboardingFor && me && onboardingFor === me.id) {
    return (
      <Onboarding
        code={code}
        playerId={me.id}
        playerName={displayName(me)}
        vapidPublicKey={s.snapshot?.meta.vapid_public_key ?? null}
        onDone={() => {
          setOnboardingFor(null);
          setTab(defaultTab(ctx));
        }}
      />
    );
  }

  const noPlayers = activePlayers(view).length === 0;
  // A stale meId (player deleted) also lands here.
  const showJoin = !me && !(s.isCommissioner && (skipJoin || noPlayers));
  if (showJoin) {
    return (
      <JoinScreen
        onJoined={(id) => {
          if (!isOnboarded()) setOnboardingFor(id);
        }}
        onSkip={s.isCommissioner ? () => setSkipJoin(true) : undefined}
      />
    );
  }

  const unread = tab === "feed" ? 0 : countUnread(view, feedSeen, s.meId);

  return (
    <ShellNavContext.Provider value={nav}>
      <div className="flex min-h-dvh flex-col bg-paper" data-testid="trip-shell" data-tab={tab}>
        <TripHeader
          appName={view.trip.app_name || "Scramble"}
          tripName={view.trip.name}
          team={myTeam}
          isCommissioner={s.isCommissioner}
          hasPlayer={!!me}
          canPickPlayer={!noPlayers}
          onMenu={() => setMenuOpen(true)}
          onPickPlayer={switchPlayer}
        />
        {status === "final" && tab !== "awards" && (
          <button
            type="button"
            onClick={() => setTab("awards")}
            className="flex min-h-14 w-full items-center gap-3 border-b-2 border-ink bg-gold px-4 text-left text-ink"
          >
            <span className="text-3xl leading-none" aria-hidden="true">
              🏆
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-lg leading-tight font-black uppercase">Final results are in</span>
              <span className="block text-sm font-bold">Awards, shame and the photo gallery</span>
            </span>
            <IconChevronRight size={24} strokeWidth={3} />
          </button>
        )}
        <main className="flex-1 pb-tabbar" id="main">
          <ErrorBoundary key={tab} where={`${TAB_LABEL[tab]} screen`}>
            {SCREENS[tab]()}
          </ErrorBoundary>
        </main>
        <TabBar tab={tab} onSelect={setTab} badges={{ feed: unread }} />
        <MenuSheet
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          tripName={view.trip.name}
          isCommissioner={s.isCommissioner}
          isFinal={status === "final"}
          tab={tab}
          onGo={setTab}
          onSettings={() => {
            setMenuOpen(false);
            setSettingsOpen(true);
          }}
          onSwitchPlayer={switchPlayer}
        />
        <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} onSwitchPlayer={switchPlayer} />
      </div>
    </ShellNavContext.Provider>
  );
}
