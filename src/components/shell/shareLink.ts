// "Send the link": the clean trip URL (/t/<code>: never ?tab=, never a player's ?me=) through the
// phone's share sheet, else copied to the clipboard. Pure helpers (tested in
// tests/ui/share-link.test.ts); ShareTripLink.tsx is the button.
import { copyText } from "@/components/money/clipboard";

/** What goes in the group chat with the link. */
export const SHARE_TEXT = "Open it, tap your name, you're in. No PIN, no app store, no excuses. ⛳🍻";

/** The trip's clean link on this origin. */
export function tripLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/t/${encodeURIComponent(code)}`;
}

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

/** The bits of navigator used (injectable for tests). */
export interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>;
}

/**
 * Share sheet when the phone has one (iPhone, Android); "cancelled" when the user closed it.
 * Otherwise, or when sharing fails (desktop without a share target, no user activation), copy the
 * link. Never throws.
 */
export async function shareTripLink(opts: {
  url: string;
  title: string;
  text?: string;
  nav?: ShareNavigator | null;
  copy?: (text: string) => Promise<boolean>;
}): Promise<ShareOutcome> {
  const nav = opts.nav === undefined ? (typeof navigator === "undefined" ? null : (navigator as ShareNavigator)) : opts.nav;
  if (nav && typeof nav.share === "function") {
    try {
      await nav.share.call(nav, { title: opts.title, text: opts.text ?? SHARE_TEXT, url: opts.url });
      return "shared";
    } catch (e) {
      if ((e as { name?: unknown } | null)?.name === "AbortError") return "cancelled";
      /* fall through to copying */
    }
  }
  try {
    return (await (opts.copy ?? copyText)(opts.url)) ? "copied" : "failed";
  } catch {
    return "failed";
  }
}
