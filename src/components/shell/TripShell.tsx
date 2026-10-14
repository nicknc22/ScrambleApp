"use client";
// The trip page shell: splash / load error / join / tabs. Lives inside TripProvider and the
// Toast/Confirm/Fanfare providers (see TripApp). Picking your name goes straight into the app (and,
// the first time on this phone for this trip, plays the 40-second "How it works" explainer); the
// pre-round screen offers Home Screen + notifications (GetSetUp) without blocking anything.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Player } from "@/lib/types";
import { useClientState, useTripStore } from "@/lib/client/react";
import { carriesIdentityInUrl, dropForeignMe, loadMe, syncHomeScreenIdentity } from "@/lib/client/identity";
import { detectPlatform, isExplainerSeen, readGreetPending, setExplainerSeen, setGreetPending } from "@/lib/client/ui-prefs";
import { IconChevronRight, displayName, useToast } from "@/components/ui";
import { JoinScreen } from "@/components/join/JoinScreen";
import { LazyExplainer, prefetchExplainer } from "@/components/explainer/LazyExplainer";
import { parseExplainerParams, shouldAutoPlay, withoutExplainerParams } from "@/components/explainer/model";
import { explainerInput } from "@/components/explainer/personalize";
import type { ExplainerInput } from "@/components/explainer/script";
import { PlayScreen } from "@/components/screens/PlayScreen";
import { LeaderboardScreen } from "@/components/screens/LeaderboardScreen";
import { FeedScreen } from "@/components/screens/FeedScreen";
import { ContestsScreen } from "@/components/screens/ContestsScreen";
import { MoneyScreen } from "@/components/screens/MoneyScreen";
import { SetupScreen } from "@/components/screens/SetupScreen";
import { AwardsScreen } from "@/components/screens/AwardsScreen";
import { ErrorBoundary } from "./ErrorBoundary";
import { RulesSheet } from "./HowItWorks";
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

interface ExplainerOpen {
  /** Frozen at open: a roster poll mid-play never reshuffles the scenes. */
  input: ExplainerInput;
  start?: { index?: number | null; at?: number | null; paused?: boolean };
  /** Auto-played after "Who are you?": say "You're in, Joe" once it closes. */
  greet?: Player;
  /** ?explainer=1&rec=1: the group-chat recording. */
  recording?: boolean;
}

/** The explainer's own history entry is on top (a StrictMode re-run must not push a second one). */
const isExplainerEntry = () => {
  try {
    return (window.history.state as { scrambleExplainer?: boolean } | null)?.scrambleExplainer === true;
  } catch {
    return false;
  }
};

const scrollToTop = () => {
  try {
    window.scrollTo({ top: 0 });
  } catch {
    /* ignore */
  }
};

/** Drop ?explainer=1 (and its scene/at/paused) from the address bar once it has opened. */
function stripExplainerParams() {
  try {
    const { pathname, search, hash } = window.location;
    const next = withoutExplainerParams(`${pathname}${search}${hash}`);
    // null state, like useUrlTab: Next.js syncs its router with the new URL.
    if (next) window.history.replaceState(null, "", next);
  } catch {
    /* best effort */
  }
}

export function TripShell({ code, adoptedMe = null }: { code: string; adoptedMe?: string | null }) {
  const store = useTripStore();
  const s = useClientState();
  const toast = useToast();
  const [urlTab, setUrlTab] = useUrlTab();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [skipJoin, setSkipJoin] = useState(false);
  const [feedSeen, setFeedSeen] = useState<string | null>(() => readFeedSeen(code));
  const [explainer, setExplainer] = useState<ExplainerOpen | null>(null);
  // ?explainer=1 (recording, screenshots): open once the trip has loaded.
  const [explainerLink] = useState(() => (typeof window === "undefined" ? null : parseExplainerParams(window.location.search)));
  const explainerLinkUsed = useRef(false);

  const view = s.loaded ? s.view : null;
  const myTeam = view ? teamOfPlayer(view, s.meId) : null;
  const status = view?.trip.status ?? "setup";
  const ctx = { isCommissioner: s.isCommissioner, status };
  const tab = resolveTab(urlTab, ctx);

  useRejectedToasts(s.rejected);
  // Fanfares (say "We're live!") wait while the explainer is up: two stacked modals, one Escape for both.
  useFeedFanfare(view, s.derived, s.meId, myTeam?.id ?? null, s.snapshot?.meta.server_time ?? null, s.isCommissioner, explainer !== null);
  useRememberTrip(code, view?.trip.name);

  const setTab = (next: TabKey) => {
    if (tab === "feed" || next === "feed") {
      const latest = latestFeedAt(view);
      setFeedSeen(latest);
      writeFeedSeen(code, latest);
    }
    setMenuOpen(false);
    setUrlTab(next);
    scrollToTop();
  };

  const switchPlayer = () => {
    setMenuOpen(false);
    setSettingsOpen(false);
    setRulesOpen(false);
    setSkipJoin(false);
    store.setMe(null);
  };

  const aiEnabled = s.snapshot?.meta.ai_enabled ?? false;
  const openExplainer = (opts: { as?: string | null; start?: ExplainerOpen["start"]; greet?: Player; recording?: boolean } = {}) => {
    if (!view) return;
    setMenuOpen(false);
    setSettingsOpen(false);
    setRulesOpen(false);
    // "Seen" is set when it's actually on screen (LazyExplainer's onShown), not here: a chunk that
    // never loads must not use up the auto-play. The greeting it holds back survives a reload.
    if (opts.greet) setGreetPending(code, opts.greet.id);
    setExplainer({
      input: explainerInput(view, opts.as === undefined ? s.meId : opts.as, { aiEnabled }),
      start: opts.start,
      greet: opts.greet,
      recording: opts.recording,
    });
  };

  const openRules = () => {
    setMenuOpen(false);
    setSettingsOpen(false);
    setRulesOpen(true);
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
    openExplainer: () => openExplainer(),
    openRules,
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
  // A pick whose explainer was cut off (reload, Back out of the page): still owed "You're in".
  const checkedGreet = useRef(false);
  useEffect(() => {
    if (checkedGreet.current || !view || explainer) return;
    checkedGreet.current = true;
    const pending = readGreetPending(code);
    if (!pending) return;
    setGreetPending(code, null);
    if (me && me.id === pending) sayWhoYouAre(me, false);
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

  // The trip is on screen: fetch the explainer in the background (offline replays), and honor ?explainer=1.
  const tripLoaded = !!view;
  useEffect(() => {
    if (tripLoaded) prefetchExplainer();
  }, [tripLoaded]);
  useEffect(() => {
    if (!tripLoaded || explainerLinkUsed.current || !explainerLink?.open) return;
    explainerLinkUsed.current = true;
    openExplainer({ start: { index: explainerLink.scene, at: explainerLink.at, paused: explainerLink.paused }, recording: explainerLink.rec });
  });

  // Back (Android back, iOS swipe-back) closes the full-screen explainer instead of leaving the
  // trip: while it's open it owns a history entry (same URL). Skip / Let's go step back off it.
  const explainerOpen = explainer !== null;
  const ownsHistory = useRef(false);
  const closeRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!explainerOpen) return;
    try {
      if (!isExplainerEntry()) window.history.pushState({ scrambleExplainer: true }, "");
      ownsHistory.current = true;
    } catch {
      ownsHistory.current = false;
    }
    const onPop = () => {
      if (!ownsHistory.current) return;
      ownsHistory.current = false; // Back already left the entry
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [explainerOpen]);

  const closeExplainer = () => {
    const greet = explainer?.greet;
    setExplainer(null);
    setGreetPending(code, null);
    // (ownsHistory, not the entry's marker: a replaceState meanwhile, like the iPhone ?me= sync,
    // keeps the entry but drops our state on it.)
    if (ownsHistory.current) {
      // Step back off the explainer's entry, then tidy ?explainer=1 out of the URL we land on.
      ownsHistory.current = false;
      window.addEventListener("popstate", stripExplainerParams, { once: true });
      try {
        window.history.back();
      } catch {
        stripExplainerParams();
      }
    } else {
      ownsHistory.current = false;
      stripExplainerParams();
    }
    if (greet) {
      // A pick from low on "Who are you?" left the page scrolled down: start Play at the top.
      scrollToTop();
      sayWhoYouAre(greet, false);
    }
  };
  useEffect(() => {
    closeRef.current = closeExplainer;
  });
  // No signal and the explainer was never fetched on this phone: close, and (when someone asked for
  // it) say why instead of doing nothing. The auto-play after "Who are you?" just steps aside.
  const explainerUnavailable = () => {
    const asked = !explainer?.greet;
    closeExplainer();
    if (asked) toast.show({ id: "explainer-offline", tone: "info", emoji: "📵", title: "No signal", message: "How it works loads the first time you've got a bar. Try again in a sec." });
  };
  const explainerEl = explainer ? (
    <LazyExplainer
      key="explainer"
      input={explainer.input}
      start={explainer.start}
      recording={explainer.recording}
      onShown={() => setExplainerSeen(code)}
      onClose={closeExplainer}
      onUnavailable={explainerUnavailable}
    />
  ) : null;

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
  // The explainer sits at the same place in the tree whichever screen is under it, so picking a
  // name (join screen -> tabs) never remounts it mid-play.
  if (showJoin) {
    return (
      <>
        <JoinScreen
          onJoined={(id) => {
            const picked = view.players.find((p) => p.id === id);
            if (!picked) return;
            // A name low on the list left the page scrolled down: Play starts at the top.
            scrollToTop();
            // First time on this phone for this trip: the explainer, then "You're in, Joe" when it closes.
            if (shouldAutoPlay({ seen: isExplainerSeen(code), status })) openExplainer({ as: id, greet: picked });
            else sayWhoYouAre(picked, false);
          }}
          onSkip={s.isCommissioner ? () => setSkipJoin(true) : undefined}
        />
        {explainerEl}
      </>
    );
  }

  const unread = tab === "feed" ? 0 : countUnread(view, feedSeen, s.meId);

  return (
    <>
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
            status={status}
            tab={tab}
            onGo={setTab}
            onSettings={() => {
              setMenuOpen(false);
              setSettingsOpen(true);
            }}
            onSwitchPlayer={switchPlayer}
            onHowItWorks={() => openExplainer()}
            onRules={openRules}
          />
          <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} onSwitchPlayer={switchPlayer} />
          <RulesSheet open={rulesOpen} onClose={() => setRulesOpen(false)} />
        </div>
      </ShellNavContext.Provider>
      {explainerEl}
    </>
  );
}
