"use client";
// Demo trips only (trip.is_demo): reset the fake round, replay it as a finished round, or go back
// to setup. Talks to POST /api/demo (which wipes and re-simulates the trip under the same code),
// then refetches the snapshot. Renders nothing on real trips.
import { useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { Button, Card, IconRefresh, IconTrophy, useConfirm, useToast } from "@/components/ui";

/** Same as the server's DEMO_PIN (src/lib/server/demo.ts); client code can't import server modules. */
const DEMO_PIN = "0000";

type DemoMode = "partial" | "full" | "setup";

const MODES: Record<DemoMode, { title: string; body: string; emoji: string; confirm: string; done: string }> = {
  partial: {
    title: "Reset the demo?",
    body: "Wipes everything on this fake trip (your scores, drinks, posts) and re-simulates a round in progress. Same link.",
    emoji: "🔄",
    confirm: "Reset it",
    done: "Demo reset. Fresh fake golf, same link.",
  },
  full: {
    title: "Replay the whole round?",
    body: "All 18 holes for every team, then the commissioner finalizes: awards, settle-up, the works.",
    emoji: "🏆",
    confirm: "Play all 18",
    done: "Round over. Check Awards and the Money tab.",
  },
  setup: {
    title: "Back to setup?",
    body: "Roster, teams, pots and tee points stay. No round yet: you start it from Setup.",
    emoji: "📋",
    confirm: "Back to setup",
    done: "Back to setup. Start the round when you're ready.",
  },
};

function errorMessage(status: number, data: unknown): string {
  const msg = data && typeof data === "object" ? (data as { error?: unknown }).error : null;
  if (typeof msg === "string" && msg.trim()) return msg;
  if (status === 429) return "Easy, tiger. Too many resets. Try again in a minute.";
  if (status >= 500) return "The server shanked it. Try again in a sec.";
  return `Couldn't reset the demo (HTTP ${status}).`;
}

export function DemoTools() {
  const store = useTripStore();
  const isDemo = useClientState((s) => s.snapshot?.state.trip.is_demo === true);
  const code = useClientState((s) => s.code);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState<DemoMode | null>(null);

  if (!isDemo) return null;

  const run = async (mode: DemoMode) => {
    const copy = MODES[mode];
    const ok = await confirm({ title: copy.title, body: copy.body, emoji: copy.emoji, confirmLabel: copy.confirm, tone: "ghostbeer" });
    if (!ok) return;
    setBusy(mode);
    try {
      let res: Response;
      try {
        res = await fetch("/api/demo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, mode }),
        });
      } catch {
        toast.error("No signal. The demo needs a bar of service to reset.");
        return;
      }
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        toast.error(errorMessage(res.status, data));
        return;
      }
      await store.refresh();
      // The reset hands out the demo's commissioner cookie; make this phone's UI agree.
      if (!isCommissioner) await store.unlockCommissioner(DEMO_PIN).catch(() => false);
      toast.success(copy.done, { emoji: copy.emoji });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3" data-testid="demo-tools">
      <h3 className="border-b-2 border-ink pb-1 text-sm font-black tracking-[0.12em] uppercase">Demo mode</h3>
      <Card tone="ghost" className="space-y-3">
        <p className="text-lg leading-snug font-black text-ink">🧪 This whole trip is fake.</p>
        <p className="text-base font-bold text-ink">
          Fake degenerates, fake beers, real chaos. Break anything you want; a reset puts it all back.
        </p>
        <div className="flex items-center justify-between gap-3 rounded-xl border-2 border-ink bg-paper px-3 py-2">
          <span className="text-sm font-black tracking-[0.08em] text-ink uppercase">Commissioner PIN</span>
          <span className="font-mono text-2xl font-black tracking-[0.2em] text-ink" data-testid="demo-pin">
            {DEMO_PIN}
          </span>
        </div>
        <Button
          variant="ghostbeer"
          size="xl"
          full
          loading={busy === "partial"}
          disabled={busy !== null}
          onClick={() => run("partial")}
          leading={<IconRefresh size={24} strokeWidth={3} />}
        >
          Reset demo
        </Button>
        <Button
          variant="secondary"
          size="lg"
          full
          loading={busy === "full"}
          disabled={busy !== null}
          onClick={() => run("full")}
          leading={<IconTrophy size={22} />}
        >
          Replay as full round
        </Button>
        <Button variant="ghost" full disabled={busy !== null} loading={busy === "setup"} onClick={() => run("setup")}>
          Start over from setup
        </Button>
      </Card>
    </section>
  );
}
