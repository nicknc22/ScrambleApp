"use client";
// The trip page shell: splash / load error / join / tabs. Lives inside TripProvider and the
// Toast/Confirm/Fanfare providers (see TripApp). Picking your name goes straight into the app; the
// pre-round screen offers Home Screen + notifications (GetSetUp) without blocking anything.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Player } from "@/lib/types";
import { useClientState, useTripStore } from "@/lib/client/react";
import { carriesIdentityInUrl, dropForeignMe, loadMe, syncHomeScreenIdentity } from "@/lib/client/identity";
import { detectPlatform } from "@/lib/client/ui-prefs";
import { IconChevronRight, displayName, useToast } from "@/components/ui";
import { JoinScreen } from "@/components/join/JoinScreen";
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
import { TAB_LABEL, resolveTab, type TabKey } from "./tabs";
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

export function TripShell({ code, adoptedMe = null }: { code: string; adoptedMe?: string | null }) {
  const store = useTripStore();
  const s = useClientState();
  const toast = useToast();
  const [urlTab, setUrlTab] = useUrlTab();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const me = view && s.meId ? (view.players.find((p) => p.id === s.meId && !p.deleted_at) ?? null) : null;

  // With no PIN, the name is the only check: say who this phone is now, with a one-tap way out.
  const sayWhoYouAre = (p: Player, carried: boolean) => {
    toast.show({
      id: "you-are",
      tone: "success",
      emoji: "👋",
      title: `You're in, ${displayName(p)}.`,
      message: carried ? "Picked up from Safari. Wrong guy? Tap Not you." : "Fat thumb? Tap Not you.",
      action: { label: "Not you?", onAction: switchPlayer },
    });
  };
  // The Home Screen app adopted its player from the launch URL (TripApp): say so once.
  const announcedAdopt = useRef(false);
  useEffect(() => {
    if (announcedAdopt.current || !adoptedMe || !me || me.id !== adoptedMe) return;
    announcedAdopt.current = true;
    sayWhoYouAre(me, true);
  });

  // Before the trip loads (Splash, or LoadError on a first visit with no signal): drop a `me` in the
  // address bar that isn't this phone's own player, so a link carrying the sender's player is never
  // what "Add to Home Screen" saves. Off iOS the URL never carries one, so any `me` goes. Deferred
  // one task: on hydration Next.js hooks history.replaceState in an effect that runs after this one
  // (parents run last), and an unhooked replaceState would leave its router on the old URL.
  useEffect(() => {
    const t = setTimeout(() => dropForeignMe(carriesIdentityInUrl(detectPlatform()) ? loadMe(code) : null), 0);
    return () => clearTimeout(t);
  }, [code]);

  // iPhone only: carry the player into "Add to Home Screen" via ?me= on the manifest link and in the
  // address bar (dropped after Switch player); the Home Screen app's first launch adopts it (TripApp).
  // Elsewhere the same call keeps both clean. Only once the trip has loaded (the store has read who
  // this phone is). Re-asserted on tab changes; cheap, idempotent.
  const knownMe = view ? (me?.id ?? null) : undefined;
  useEffect(() => {
    if (knownMe !== undefined) syncHomeScreenIdentity(code, carriesIdentityInUrl(detectPlatform()) ? knownMe : null);
  }, [code, knownMe, tab]);

  if (!view) {
    if (s.loadError) return <LoadError code={code} message={s.loadError} online={s.online} onRetry={reload} />;
    return <Splash onRetry={reload} />;
  }

  const noPlayers = activePlayers(view).length === 0;
  // A commissioner building the roster from scratch keeps working when the first player appears
  // (instead of being bounced to the join screen mid-setup).
  if (s.isCommissioner && noPlayers && !skipJoin) setSkipJoin(true);
  // A stale meId (player deleted) also lands here.
  const showJoin = !me && !(s.isCommissioner && (skipJoin || noPlayers));
  if (showJoin) {
    return (
      <JoinScreen
        onJoined={(id) => {
          const picked = view.players.find((p) => p.id === id);
          if (picked) sayWhoYouAre(picked, false);
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
          code={code}
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
