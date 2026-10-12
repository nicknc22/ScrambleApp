"use client";
import { useEffect, useRef, useState } from "react";
import { useTripStore } from "@/lib/client/react";
import { PinPad, useToast } from "@/components/ui";

export const COMMISH_ON_TOAST = "Commissioner powers: ON. Everything you touch gets posted.";

/** PIN pad that unlocks commissioner powers via store.unlockCommissioner. */
export function CommissionerUnlock({ onUnlocked }: { onUnlocked?: () => void }) {
  const store = useTripStore();
  const toast = useToast();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Inside a scrolling sheet, bring the dots + error line into view, not just the keys.
  useEffect(() => {
    try {
      wrapRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch {
      /* old browsers */
    }
  }, []);

  const submit = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const ok = await store.unlockCommissioner(value);
      if (ok) {
        setPin("");
        toast.success(COMMISH_ON_TOAST, { emoji: "🫡" });
        onUnlocked?.();
      } else {
        setPin("");
        // The store reports network failures as `false` too; tell them apart.
        setError(store.getState().online ? "Wrong PIN. Nice try, intern." : "No signal. The PIN check needs one bar.");
      }
    } catch {
      setError("Couldn't reach the server. The PIN check needs one bar of signal.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={wrapRef} className="scroll-mt-2">
    <PinPad
      value={pin}
      onChange={(v) => {
        setPin(v);
        if (error) setError(null);
      }}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel="Unlock powers"
    />
    </div>
  );
}
