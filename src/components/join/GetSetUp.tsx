"use client";
// "Get set up": Home Screen + notifications, both optional, never blocking. Pre-round it's a card at
// the top of WaitingForStart; while the round is live (players who first open the link after Start
// land on Play) it's one compact row on Play, below the scorecard. Hide is remembered per trip on
// this device; it also hides itself once every row is done. (Location isn't asked up front: Measure
// drive asks the first time it's needed.)
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useClientState } from "@/lib/client/react";
import { enablePush, hasPushSubscription, pushPermission, pushSupported } from "@/lib/client/push";
import { detectPlatform, isGetSetUpHidden, isStandalone, setGetSetUpHidden } from "@/lib/client/ui-prefs";
import { BottomSheet, Button, IconCheck, IconChevronRight, Spinner, cx, useIsClient, useToast } from "@/components/ui";
import { InstallGuide } from "./InstallGuide";
import { getSetUpIntro, getSetUpNextRow, getSetUpRows, showGetSetUp, type GetSetUpRows } from "./getSetUp";

export const INSTALL_REASON = "Full screen, opens with no signal, and on an iPhone it's the only way to get notifications.";
export const NOTIFY_REASON = "Lead changes, contest steals and the Groom's Mulligan, the second they happen.";
export const NOTIFY_INSTALL_FIRST = "Add it to your Home Screen first, then turn these on from there.";
/** The compact row on Play: short enough for one line of sub-text on a 360px phone. */
export const COMPACT_INSTALL_SUB = "Full screen, works with no signal.";
export const COMPACT_NOTIFY_SUB = "Lead changes and contest steals, live.";

/** `compact`: the one-row form for Play during the round. */
export function GetSetUp({ compact = false }: { compact?: boolean }) {
  const code = useClientState((s) => s.code);
  const me = useClientState((s) => (s.view && s.meId ? (s.view.players.find((p) => p.id === s.meId && !p.deleted_at) ?? null) : null));
  const vapidKey = useClientState((s) => s.snapshot?.meta.vapid_public_key ?? null);
  const pushOnServer = useClientState((s) => s.snapshot?.meta.push_enabled ?? false);
  const toast = useToast();
  // Client-only reads (the shell only renders tabs once the client store has loaded, but be safe).
  const isClient = useIsClient();
  const supported = isClient && pushSupported();

  const [hidden, setHidden] = useState(() => isGetSetUpHidden(code));
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!supported || !pushOnServer) return;
    let live = true;
    void hasPushSubscription(vapidKey).then((subscribed) => {
      if (live) setPushOn(subscribed && pushPermission() === "granted");
    });
    return () => {
      live = false;
    };
  }, [supported, pushOnServer, vapidKey]);

  if (!me || !isClient) return null;

  const rows = getSetUpRows({
    standalone: isStandalone(),
    platform: detectPlatform(),
    pushOnServer,
    pushSupported: supported,
    pushOn,
  });
  if (!showGetSetUp(rows, hidden)) return null;
  if (compact && getSetUpNextRow(rows) === null) return null;

  const turnOnPush = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const r = await enablePush({ code, playerId: me.id, vapidPublicKey: vapidKey });
    if (!alive.current) return;
    setBusy(false);
    if (r.status === "subscribed") {
      setPushOn(true);
      toast.success(r.message, { emoji: "🔔" });
    } else {
      setNote(r.message);
    }
  };

  const hide = () => {
    setGetSetUpHidden(code, true);
    setHidden(true);
  };

  return (
    <>
      <GetSetUpCard
        rows={rows}
        compact={compact}
        busy={busy}
        note={note}
        onInstall={() => setInstallOpen(true)}
        onNotify={() => void turnOnPush()}
        onHide={hide}
      />
      <BottomSheet
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        title="Put it on your Home Screen"
        footer={
          <Button variant="primary" size="lg" full onClick={() => setInstallOpen(false)}>
            Got it
          </Button>
        }
      >
        <div className="space-y-4 pb-2" data-testid="get-set-up-install-sheet">
          <p className="text-base font-bold">{INSTALL_REASON}</p>
          <InstallGuide />
          <p className="text-sm font-bold text-muted">
            The icon already knows it&apos;s you. If it ever asks, tap your name once more.
          </p>
        </div>
      </BottomSheet>
    </>
  );
}

export interface GetSetUpCardProps {
  rows: GetSetUpRows;
  /** One row (the next thing to do) and Hide: Play during the round. */
  compact?: boolean;
  /** Turning notifications on. */
  busy?: boolean;
  /** Why notifications didn't turn on (denied, error...). */
  note?: string | null;
  onInstall: () => void;
  onNotify: () => void;
  onHide: () => void;
}

/** The card itself (no store, no browser APIs): rendered by GetSetUp and in tests. */
export function GetSetUpCard({ rows, compact = false, busy = false, note = null, onInstall, onNotify, onHide }: GetSetUpCardProps) {
  if (compact) {
    const next = getSetUpNextRow(rows);
    if (!next) return null;
    return (
      <section
        className="flex items-stretch overflow-hidden rounded-2xl border-2 border-ink bg-paper shadow-hard-sm"
        data-testid="get-set-up"
        data-variant="compact"
        aria-label="Get set up"
      >
        <ul className="min-w-0 flex-1">
          {next === "install" ? (
            <SetupRow
              testId="get-set-up-install"
              emoji="📲"
              title="Add to Home Screen"
              done={false}
              doneText=""
              sub={COMPACT_INSTALL_SUB}
              onTap={onInstall}
            />
          ) : (
            <SetupRow
              testId="get-set-up-notify"
              emoji="🔔"
              title="Turn on notifications"
              done={false}
              doneText=""
              sub={COMPACT_NOTIFY_SUB}
              busy={busy}
              note={note}
              onTap={onNotify}
            />
          )}
        </ul>
        <button
          type="button"
          onClick={onHide}
          className="min-h-12 min-w-14 shrink-0 border-l-2 border-line px-2 text-base font-extrabold underline underline-offset-4 active:bg-sand"
          data-testid="get-set-up-hide"
        >
          Hide
        </button>
      </section>
    );
  }
  return (
    <section className="overflow-hidden rounded-3xl border-2 border-ink bg-paper shadow-hard-sm" data-testid="get-set-up" aria-labelledby="get-set-up-title">
      <div className="flex items-center gap-2 border-b-2 border-ink bg-hazard py-1 pr-2 pl-4">
        <h2 id="get-set-up-title" className="min-w-0 flex-1 text-lg leading-tight font-black uppercase">
          Get set up
        </h2>
        <button
          type="button"
          onClick={onHide}
          className="min-h-12 min-w-12 px-2 text-base font-extrabold underline underline-offset-4"
          data-testid="get-set-up-hide"
        >
          Hide
        </button>
      </div>
      <p className="px-4 pt-3 text-base font-bold" data-testid="get-set-up-intro">
        {getSetUpIntro(rows)}
      </p>
      <ul className="mt-2 divide-y-2 divide-line border-t-2 border-line">
        <SetupRow
          testId="get-set-up-install"
          emoji="📲"
          title="Put it on your Home Screen"
          done={rows.install === "done"}
          doneText="On your Home Screen. Chef's kiss."
          sub="Full screen, and it opens with no signal."
          onTap={onInstall}
        />
        {rows.notify !== null && (
          <SetupRow
            testId="get-set-up-notify"
            emoji="🔔"
            title="Turn on notifications"
            done={rows.notify === "done"}
            doneText="Notifications on. Brace yourself."
            disabled={rows.notify === "install_first"}
            sub={rows.notify === "install_first" ? NOTIFY_INSTALL_FIRST : NOTIFY_REASON}
            busy={busy}
            note={note}
            onTap={onNotify}
          />
        )}
      </ul>
    </section>
  );
}

function SetupRow({
  testId,
  emoji,
  title,
  sub,
  done,
  doneText,
  disabled = false,
  busy = false,
  note = null,
  onTap,
}: {
  testId: string;
  emoji: string;
  title: string;
  sub: string;
  done: boolean;
  doneText: string;
  disabled?: boolean;
  busy?: boolean;
  note?: string | null;
  onTap: () => void;
}) {
  let body: ReactNode;
  if (done) {
    body = (
      <div className="flex min-h-16 items-center gap-3 px-4 py-2" data-testid={testId} data-state="done">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fairway text-white" aria-hidden="true">
          <IconCheck size={22} strokeWidth={3.5} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-lg leading-tight font-black text-muted line-through decoration-2">{title}</span>
          <span className="block text-sm font-extrabold text-fairway-dark">{doneText}</span>
        </span>
      </div>
    );
  } else {
    body = (
      <button
        type="button"
        onClick={onTap}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        data-testid={testId}
        data-state={disabled ? "blocked" : "todo"}
        className={cx(
          "flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left transition-colors active:bg-sand",
          disabled && "cursor-not-allowed",
        )}
      >
        <span
          className={cx(
            "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-ink text-xl leading-none",
            disabled ? "bg-sand opacity-60" : "bg-hazard-soft",
          )}
          aria-hidden="true"
        >
          {emoji}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cx("block text-lg leading-tight font-black", disabled && "text-muted")}>{title}</span>
          <span className="block text-sm font-bold text-muted">{sub}</span>
        </span>
        {busy ? <Spinner size={22} label="Working" /> : !disabled && <IconChevronRight size={24} strokeWidth={3} />}
      </button>
    );
  }
  return (
    <li>
      {body}
      {note && !done && (
        <p role="status" className="mx-4 mb-3 rounded-xl border-2 border-ink bg-hazard-soft px-3 py-2 text-sm font-extrabold">
          🤷 {note}
        </p>
      )}
    </li>
  );
}
