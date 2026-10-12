"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { enablePush, hasPushSubscription, pushPermission, pushSupported } from "@/lib/client/push";
import { APP_BUILD, APP_VERSION, DEV_KEY, isDevMode, writePref } from "@/lib/client/ui-prefs";
import {
  Avatar,
  BottomSheet,
  Button,
  Card,
  IconBell,
  IconLock,
  IconUnlock,
  IconUserSwap,
  PlayerName,
  TeamPill,
  Toggle,
  useToast,
} from "@/components/ui";
import { InstallGuide } from "@/components/join/InstallGuide";
import { CommissionerUnlock } from "./CommissionerUnlock";
import { GpsSimulator } from "./GpsSimulator";
import { teamOfPlayer } from "./roster";

/** Settings: switch player, notifications, commissioner PIN, install help, dev GPS, version. */
export function SettingsSheet({ open, onClose, onSwitchPlayer }: { open: boolean; onClose: () => void; onSwitchPlayer: () => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Settings" size="tall">
      {open && <SettingsBody onSwitchPlayer={onSwitchPlayer} />}
    </BottomSheet>
  );
}

function SettingsBody({ onSwitchPlayer }: { onSwitchPlayer: () => void }) {
  const store = useTripStore();
  const s = useClientState();
  const toast = useToast();
  const view = s.view;
  const me = view?.players.find((p) => p.id === s.meId && !p.deleted_at) ?? null;
  const myTeam = view && me ? teamOfPlayer(view, me.id) : null;

  // ----- push -----
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    let alive = true;
    void hasPushSubscription().then((v) => {
      if (alive) setSubscribed(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  const vapidKey = s.snapshot?.meta.vapid_public_key ?? null;
  const pushOnServer = s.snapshot?.meta.push_enabled ?? false;
  const supported = pushSupported();
  const permission = pushPermission();

  const turnOnPush = async () => {
    if (!me) {
      toast.roast("Pick your name first. Notifications need to know who to roast.");
      return;
    }
    setPushBusy(true);
    const r = await enablePush({ code: s.code, playerId: me.id, vapidPublicKey: vapidKey });
    setPushBusy(false);
    setPushNote(r.message);
    if (r.status === "subscribed") {
      setSubscribed(true);
      toast.success(r.message, { emoji: "🔔" });
    }
  };

  const setMuted = (muted: boolean) => {
    if (!me) return;
    const r = store.dispatch({ type: "player.mute", player_id: me.id, muted });
    if (!r.ok) toast.error(r.reason);
    else toast.info(muted ? "Muted. You'll have to check the feed like an animal." : "Unmuted. Brace yourself.", { emoji: muted ? "🔕" : "🔔" });
  };

  // ----- commissioner -----
  const [showPin, setShowPin] = useState(false);
  const [locking, setLocking] = useState(false);
  const lock = async () => {
    setLocking(true);
    try {
      await store.lockCommissioner();
      toast.info("Commissioner powers off. Back to being a regular degenerate.", { emoji: "🔒" });
    } catch {
      toast.error("Couldn't lock right now. Try again with signal.");
    } finally {
      setLocking(false);
    }
  };

  // ----- dev mode (tap the version 7 times) -----
  const [dev, setDev] = useState(() => isDevMode());
  const taps = useRef(0);
  const tapVersion = () => {
    taps.current += 1;
    if (taps.current >= 7 && !dev) {
      writePref(DEV_KEY, "1");
      setDev(true);
      toast.info("Dev mode on. GPS simulator unlocked.", { emoji: "🧪" });
    }
  };

  return (
    <div className="space-y-6 pt-1 pb-4">
      <Section title="You">
        {me ? (
          <div className="flex items-center gap-3">
            <Avatar player={me} teamSortOrder={myTeam?.sort_order ?? null} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xl font-black">
                <PlayerName player={me} showRealName />
              </div>
              <div className="mt-1">
                <TeamPill team={myTeam} size="sm" />
              </div>
            </div>
          </div>
        ) : (
          <p className="text-base font-bold">No player picked on this phone yet.</p>
        )}
        <Button variant="secondary" size="lg" full onClick={onSwitchPlayer} leading={<IconUserSwap size={22} />}>
          {me ? "Not you? Switch player" : "Pick your name"}
        </Button>
      </Section>

      <Section title="Notifications">
        {!pushOnServer && s.snapshot ? (
          <p className="text-base font-bold text-muted">Push isn&apos;t set up for this trip. The feed still has everything.</p>
        ) : !supported ? (
          <p className="text-base font-bold text-ink">
            This browser can&apos;t do notifications. On iPhone, add the app to your Home Screen and open it from there.
          </p>
        ) : subscribed && permission === "granted" ? (
          <p className="text-base font-extrabold text-fairway-dark">🔔 Notifications are on for this phone.</p>
        ) : (
          <>
            <p className="text-base font-bold text-ink">Lead changes, contest steals and the Groom&apos;s Mulligan, live.</p>
            <Button variant="primary" size="lg" full loading={pushBusy} onClick={turnOnPush} leading={<IconBell size={22} />}>
              Enable notifications
            </Button>
          </>
        )}
        {pushNote && <p className="text-sm font-bold text-muted">{pushNote}</p>}
        {me && (
          <Toggle
            checked={me.muted_push}
            onChange={setMuted}
            label="Mute notifications"
            description="Stops pushes to you on every device. The feed still has everything."
          />
        )}
      </Section>

      <Section title="Commissioner">
        {s.isCommissioner ? (
          <Card tone="fairway" className="space-y-3">
            <p className="text-lg font-black text-ink">🫡 Commissioner powers: ON</p>
            <p className="text-sm font-bold text-ink">Every edit you make posts to the feed as a Commissioner override. Transparency, baby.</p>
            <Button variant="secondary" full loading={locking} onClick={lock} leading={<IconLock size={20} />}>
              Lock commissioner powers
            </Button>
          </Card>
        ) : showPin ? (
          <Card className="pt-5">
            <CommissionerUnlock onUnlocked={() => setShowPin(false)} />
            <Button variant="ghost" full className="mt-2" onClick={() => setShowPin(false)}>
              Cancel
            </Button>
          </Card>
        ) : (
          <Button variant="secondary" size="lg" full onClick={() => setShowPin(true)} leading={<IconUnlock size={22} />}>
            Unlock commissioner
          </Button>
        )}
      </Section>

      <Section title="Add to Home Screen">
        <InstallGuide compact />
      </Section>

      {dev && view && (
        <Section title="GPS simulator (dev)">
          <GpsSimulator holes={view.holes} />
        </Section>
      )}

      <div className="pt-2 text-center">
        <button type="button" onClick={tapVersion} className="min-h-12 px-4 text-sm font-bold text-muted">
          Scramble v{APP_VERSION}
          {APP_BUILD ? ` (${APP_BUILD})` : ""} · trip {s.code}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="border-b-2 border-ink pb-1 text-sm font-black tracking-[0.12em] uppercase">{title}</h3>
      {children}
    </section>
  );
}
