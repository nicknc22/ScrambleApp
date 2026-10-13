// Venmo hand-off links for settle-up. Pure (no DOM), shared by the Money tab and tests.
// The app never moves money: it opens Venmo with the recipient, amount and note prefilled and
// the payer confirms inside Venmo.
//
//   app: venmo://paycharge?txn=pay&recipients=<handle>&amount=12.50&note=<note>
//   web: https://venmo.com/<handle>?txn=pay&amount=12.50&note=<note>   (no app installed)

/** Venmo usernames: letters, digits, "-" and "_" (Venmo itself says 5-30 chars; we are lenient). */
const HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Clean whatever the commissioner typed into a bare Venmo username, or null when it can't be one.
 *   "@Nick-Caster" -> "Nick-Caster"; " @@nick " -> "nick";
 *   "https://venmo.com/u/Nick-Caster" / "venmo.com/Nick-Caster?txn=pay" -> "Nick-Caster";
 *   "Nick Caster" (a display name, not a username) -> null.
 */
export function normalizeVenmoHandle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  // A pasted profile link: take the path segment after the host (and after "/u/").
  const url = s.match(/^(?:https?:\/\/)?(?:www\.|account\.)?venmo\.com\/(?:u\/)?([^/?#\s]+)/i);
  if (url) s = url[1];
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as typed */
  }
  s = s.trim().replace(/^@+/, "").trim();
  return HANDLE_RE.test(s) ? s : null;
}

/** "@handle" for display. */
export function venmoAt(handle: string): string {
  return `@${handle}`;
}

/** Whole cents -> Venmo's amount format: 1250 -> "12.50", 5 -> "0.05", 100000 -> "1000.00". null when not a positive amount. */
export function formatVenmoAmount(cents: number): string | null {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
  const c = Math.round(cents);
  if (c <= 0) return null;
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

/** Strict RFC 3986 component encoding (encodeURIComponent leaves !'()* alone). Spaces become %20, never "+". */
export function encodeComponent(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** "<app name>: <trip name> settle-up", whitespace collapsed. */
export function venmoNote(appName: string | null | undefined, tripName: string | null | undefined): string {
  const clean = (s: string | null | undefined) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
  const app = clean(appName) || "Scramble";
  const trip = clean(tripName);
  return trip ? `${app}: ${trip} settle-up` : `${app} settle-up`;
}

export interface VenmoPayLinks {
  /** Normalized username (no "@"). */
  handle: string;
  /** "12.50" */
  amount: string;
  note: string;
  /** venmo://paycharge?... — opens the Venmo app with everything prefilled. */
  app: string;
  /** https://venmo.com/<handle>?... — fallback when the app isn't installed. */
  web: string;
}

/**
 * Deep links to pay `handle` `amountCents` with `note`. null when the handle isn't a usable
 * Venmo username or the amount isn't positive (the UI then shows the amount + "ask for their Venmo").
 */
export function buildVenmoPayLinks(input: { handle: string | null | undefined; amountCents: number; note: string }): VenmoPayLinks | null {
  const handle = normalizeVenmoHandle(input.handle);
  const amount = formatVenmoAmount(input.amountCents);
  if (!handle || !amount) return null;
  const note = input.note.replace(/\s+/g, " ").trim();
  const h = encodeComponent(handle);
  const n = encodeComponent(note);
  return {
    handle,
    amount,
    note,
    app: `venmo://paycharge?txn=pay&recipients=${h}&amount=${amount}&note=${n}`,
    web: `https://venmo.com/${h}?txn=pay&amount=${amount}&note=${n}`,
  };
}
