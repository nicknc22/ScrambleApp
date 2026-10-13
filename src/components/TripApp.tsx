"use client";
// Client entry for /t/[code]: store + toast/confirm/fanfare providers around the shell.
// Everything loads from the local cache first, so the page works with no signal.
import Link from "next/link";
import { useState } from "react";
import { adoptMeFromLaunch } from "@/lib/client/identity";
import { TripProvider } from "@/lib/client/react";
import { detectPlatform, isStandalone } from "@/lib/client/ui-prefs";
import { ConfirmProvider, FanfareProvider, ToastProvider, buttonClasses } from "@/components/ui";
import { ErrorBoundary } from "@/components/shell/ErrorBoundary";
import { TripShell } from "@/components/shell/TripShell";

/**
 * First launch of the iPhone Home Screen app (separate storage): adopt the player its start URL
 * carries (?me=), iOS + standalone only and never over a stored player (adoptMeFromLaunch). Runs
 * once, in the first client render, i.e. before TripProvider's effect starts the store and reads who
 * this phone is. Returns the adopted id (the shell says "You're Joe" once), else null.
 */
function useAdoptLaunchIdentity(code: string): string | null {
  const [adopted] = useState(() => {
    if (typeof window === "undefined") return null;
    try {
      return adoptMeFromLaunch({ code, search: window.location.search, standalone: isStandalone(), platform: detectPlatform() });
    } catch {
      return null;
    }
  });
  return adopted;
}

export function TripApp({ code }: { code: string }) {
  const adoptedMe = useAdoptLaunchIdentity(code);
  return (
    <ErrorBoundary where="app" fallback={(error) => <AppCrash error={error} />}>
      <TripProvider code={code}>
        <ToastProvider>
          <ConfirmProvider>
            <FanfareProvider>
              <TripShell code={code} adoptedMe={adoptedMe} />
            </FanfareProvider>
          </ConfirmProvider>
        </ToastProvider>
      </TripProvider>
    </ErrorBoundary>
  );
}

export default TripApp;

function AppCrash({ error }: { error: Error }) {
  return (
    <div className="flex min-h-dvh flex-col justify-between bg-paper px-4 pt-[calc(32px+env(safe-area-inset-top))] pb-[calc(24px+env(safe-area-inset-bottom))]">
      <div className="text-center">
        <div className="text-8xl leading-none" aria-hidden="true">
          🌲⛳
        </div>
        <h1 className="loud mt-6 text-5xl">Out of bounds</h1>
        <p className="mx-auto mt-4 max-w-sm text-lg font-bold">
          The app hit a tree. Everything you logged is saved on this phone and will sync when it&apos;s back up.
        </p>
        <p className="mx-auto mt-3 max-w-sm font-mono text-xs font-semibold break-words text-muted">{error.message}</p>
      </div>
      <div className="mx-auto flex w-full max-w-sm flex-col gap-3">
        <button type="button" className={buttonClasses({ variant: "primary", size: "xl", full: true })} onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link href="/?home=1" className={buttonClasses({ variant: "secondary", size: "lg", full: true })}>
          Go home
        </Link>
      </div>
    </div>
  );
}
