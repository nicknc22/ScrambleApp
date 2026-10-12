"use client";
import { detectPlatform, isStandalone, type Platform } from "@/lib/client/ui-prefs";
import { Button, IconCheck, IconPlusSquare, IconShare, cx, useIsClient } from "@/components/ui";
import { promptInstall, useCanPromptInstall } from "./installPrompt";

/** Simple drawing of Safari's toolbar (share highlighted) and the share sheet row. */
export function IosInstallIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 300 156" className={cx("h-auto w-full max-w-[320px]", className)} role="img" aria-label="Tap Share in Safari's toolbar, then Add to Home Screen">
      {/* Panel 1: Safari toolbar */}
      <rect x="6" y="6" width="132" height="144" rx="18" fill="#ffffff" stroke="#0b0f0c" strokeWidth="3" />
      <rect x="18" y="22" width="108" height="14" rx="7" fill="#e2e8e4" />
      <rect x="18" y="44" width="80" height="8" rx="4" fill="#e2e8e4" />
      <rect x="18" y="58" width="96" height="8" rx="4" fill="#e2e8e4" />
      <line x1="6" y1="106" x2="138" y2="106" stroke="#0b0f0c" strokeWidth="2" />
      <path d="M26 128l-6-6 6-6" fill="none" stroke="#0b0f0c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M44 116l6 6-6 6" fill="none" stroke="#8a968f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="72" cy="124" r="15" fill="#ffd60a" stroke="#0b0f0c" strokeWidth="2.5" />
      <path d="M72 115v12M67.5 119.5L72 115l4.5 4.5M67 122.5h-2.5v9h15v-9H77" fill="none" stroke="#0b0f0c" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="94" y="117" width="12" height="14" rx="2" fill="none" stroke="#0b0f0c" strokeWidth="2.5" />
      <rect x="114" y="117" width="12" height="12" rx="2" fill="none" stroke="#0b0f0c" strokeWidth="2.5" />
      <circle cx="22" cy="14" r="11" fill="#0a7d3e" />
      <text x="22" y="18.5" textAnchor="middle" fontSize="13" fontWeight="900" fill="#fff" fontFamily="system-ui, sans-serif">1</text>
      {/* Arrow */}
      <path d="M144 78h12" stroke="#0b0f0c" strokeWidth="3" strokeLinecap="round" />
      <path d="M152 72l7 6-7 6" fill="none" stroke="#0b0f0c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {/* Panel 2: share sheet */}
      <rect x="164" y="6" width="130" height="144" rx="18" fill="#f2f4f1" stroke="#0b0f0c" strokeWidth="3" />
      <rect x="174" y="24" width="110" height="26" rx="8" fill="#ffffff" />
      <text x="182" y="41" fontSize="12" fontWeight="700" fill="#3f4a43" fontFamily="system-ui, sans-serif">Copy</text>
      <rect x="174" y="58" width="110" height="34" rx="9" fill="#ffd60a" stroke="#0b0f0c" strokeWidth="2.5" />
      <text x="180" y="73" fontSize="10.5" fontWeight="900" fill="#0b0f0c" fontFamily="system-ui, sans-serif">Add to</text>
      <text x="180" y="86" fontSize="10.5" fontWeight="900" fill="#0b0f0c" fontFamily="system-ui, sans-serif">Home Screen</text>
      <rect x="261" y="66" width="17" height="17" rx="5" fill="none" stroke="#0b0f0c" strokeWidth="2.5" />
      <path d="M269.5 70v9M265 74.5h9" stroke="#0b0f0c" strokeWidth="2.5" strokeLinecap="round" />
      <rect x="174" y="100" width="110" height="26" rx="8" fill="#ffffff" />
      <text x="182" y="117" fontSize="12" fontWeight="700" fill="#3f4a43" fontFamily="system-ui, sans-serif">Find on Page</text>
      <circle cx="180" cy="14" r="11" fill="#0a7d3e" />
      <text x="180" y="18.5" textAnchor="middle" fontSize="13" fontWeight="900" fill="#fff" fontFamily="system-ui, sans-serif">2</text>
    </svg>
  );
}

/** Add-to-Home-Screen instructions for this platform (or a check mark when already installed). */
export function InstallGuide({ platform: forced, compact = false }: { platform?: Platform; compact?: boolean }) {
  // Client-only reads (SSR/hydration render the generic iOS guide, then settle).
  const isClient = useIsClient();
  const platform: Platform = forced ?? (isClient ? detectPlatform() : "ios");
  const installed = isClient && isStandalone();
  const canPrompt = useCanPromptInstall();

  if (installed) {
    return (
      <p className="flex items-center gap-2 text-base font-extrabold text-fairway-dark">
        <IconCheck size={22} strokeWidth={3.5} /> Running from your Home Screen. Chef&apos;s kiss.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {canPrompt && (
        <Button variant="primary" size="lg" full onClick={() => void promptInstall()} leading={<IconPlusSquare size={22} />}>
          Install the app
        </Button>
      )}
      {platform === "ios" || platform === "other" ? (
        <>
          {!compact && (
            <div className="flex justify-center">
              <IosInstallIllustration />
            </div>
          )}
          <ol className="space-y-2 text-base font-bold text-ink">
            <li className="flex items-start gap-2">
              <Step n={1} />
              <span>
                In Safari, tap <ShareGlyph /> <b>Share</b> (bottom of the screen).
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Step n={2} />
              <span>
                Scroll down, tap <IconPlusSquare size={20} className="inline align-[-4px]" /> <b>Add to Home Screen</b>, then <b>Add</b>.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Step n={3} />
              <span>Open Scramble from your Home Screen from now on.</span>
            </li>
          </ol>
          {platform === "other" && (
            <p className="text-sm font-semibold text-muted">On Android: Chrome menu (⋮) → Add to Home screen.</p>
          )}
        </>
      ) : (
        <ol className="space-y-2 text-base font-bold text-ink">
          <li className="flex items-start gap-2">
            <Step n={1} />
            <span>
              Tap Chrome&apos;s menu <b>⋮</b> (top right).
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Step n={2} />
            <span>
              Tap <b>Add to Home screen</b> or <b>Install app</b>.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Step n={3} />
            <span>Open Scramble from your Home Screen from now on.</span>
          </li>
        </ol>
      )}
    </div>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="num mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-fairway text-sm font-black text-white">
      {n}
    </span>
  );
}

function ShareGlyph() {
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border-2 border-ink bg-hazard align-[-5px]">
      <IconShare size={16} strokeWidth={2.75} />
    </span>
  );
}
