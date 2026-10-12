"use client";
// Client entry for /t/[code]: store + toast/confirm/fanfare providers around the shell.
// Everything loads from the local cache first, so the page works with no signal.
import Link from "next/link";
import { TripProvider } from "@/lib/client/react";
import { ConfirmProvider, FanfareProvider, ToastProvider, buttonClasses } from "@/components/ui";
import { ErrorBoundary } from "@/components/shell/ErrorBoundary";
import { TripShell } from "@/components/shell/TripShell";

export function TripApp({ code }: { code: string }) {
  return (
    <ErrorBoundary where="app" fallback={(error) => <AppCrash error={error} />}>
      <TripProvider code={code}>
        <ToastProvider>
          <ConfirmProvider>
            <FanfareProvider>
              <TripShell code={code} />
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
