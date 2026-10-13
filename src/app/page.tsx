"use client";
// Home: join by code, commissioner creates the trip (with the roster pre-loaded), or try the demo.
// Remembers recent trips.
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  APP_VERSION,
  RECENT_TRIPS_KEY,
  forgetTrip,
  getRecentTrips,
  isStandalone,
  normalizeTripCode,
  readPref,
  rememberTrip,
} from "@/lib/client/ui-prefs";
import { getLastTripCode, saveMe } from "@/lib/client/identity";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin";
import {
  MAX_ROSTER_SIZE,
  carryGroomChoice,
  defaultRosterText,
  groomChoiceLost,
  nameKey,
  parseRosterText,
  resolveGroomIndex,
  rosterPayload,
} from "@/lib/roster";
import { Button, Card, IconChevronRight, IconClose, TextField, cx } from "@/components/ui";
import { Wordmark } from "@/components/shell/Splash";

// ---- recent trips straight from localStorage (stable string snapshot; null on the server) ----
const RECENT_EVENT = "scramble:recent-changed";
function subscribeRecent(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(RECENT_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(RECENT_EVENT, cb);
  };
}
const recentSnapshot = () => readPref(RECENT_TRIPS_KEY);
const recentServerSnapshot = () => null;

/** Pull a human error out of a JSON error body. */
function serverError(status: number, data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    for (const k of ["error", "message", "reason"]) {
      if (typeof d[k] === "string" && (d[k] as string).trim()) return d[k] as string;
    }
  }
  if (status === 401 || status === 403) return "Wrong PIN. The real commissioner would know it.";
  if (status === 404) return fallback;
  if (status === 429) return "Easy, tiger. Too many tries. Wait a minute.";
  if (status >= 500) return "The server shanked it. Try again in a sec.";
  return `Something went sideways (HTTP ${status}).`;
}

function extractCode(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const raw = typeof d.code === "string" ? d.code : d.trip && typeof (d.trip as Record<string, unknown>).code === "string" ? ((d.trip as Record<string, unknown>).code as string) : null;
  return normalizeTripCode(raw);
}

/** The first pre-loaded player's id (the creator) from a POST /api/trips response. */
function firstPlayerId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const players = (data as Record<string, unknown>).players;
  if (!Array.isArray(players) || !players[0] || typeof players[0] !== "object") return null;
  const id = (players[0] as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

const NO_SIGNAL = "No signal. Find a bar and try again.";

function go(path: string) {
  // Full navigation: lets the service worker serve the trip shell even on a dead network.
  window.location.assign(path);
}

export default function HomePage() {
  const recentRaw = useSyncExternalStore(subscribeRecent, recentSnapshot, recentServerSnapshot);
  // recentRaw is the change signal; getRecentTrips() re-reads and validates it.
  const recent = useMemo(() => (recentRaw ? getRecentTrips() : []), [recentRaw]);

  // Launched from the Home Screen icon? Jump straight back into the last trip.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has("home") || !isStandalone()) return;
      const last = normalizeTripCode(getLastTripCode()) ?? getRecentTrips()[0]?.code ?? null;
      if (last) window.location.replace(`/t/${last}`);
    } catch {
      /* stay home */
    }
  }, []);

  // ---- join ----
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const join = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeTripCode(joinCode);
    if (!code) {
      setJoinError("That's not a trip code. It's in the link from the group chat.");
      return;
    }
    go(`/t/${code}`);
  };

  // ---- create ----
  const [createOpen, setCreateOpen] = useState(false);
  const [tripName, setTripName] = useState("");
  const [pin, setPin] = useState("");
  const [rosterText, setRosterText] = useState(defaultRosterText);
  /** Groom picker: null = untouched (default groom when he's on the list), "" = none, else a nameKey. */
  const [groomChoice, setGroomChoice] = useState<string | null>(null);
  // One past the cap, so "too many" can be called out instead of silently dropping names.
  const rosterNames = useMemo(() => parseRosterText(rosterText, MAX_ROSTER_SIZE + 1), [rosterText]);
  const groomIndex = resolveGroomIndex(rosterNames, groomChoice);
  // Fixing a spelling keeps the crown on that line (carryGroomChoice), never moves it to Caster.
  const editRoster = (text: string) => {
    setGroomChoice((c) => carryGroomChoice(rosterNames, parseRosterText(text, MAX_ROSTER_SIZE + 1), c));
    setRosterText(text);
  };
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const name = tripName.trim();
    if (!name) {
      setCreateError("Name the trip. Something the groom will regret.");
      return;
    }
    if (rosterNames.length > MAX_ROSTER_SIZE) {
      setCreateError(`${MAX_ROSTER_SIZE} players max. This is a bachelor party, not the PGA Tour.`);
      return;
    }
    if (pin.trim().length < PIN_MIN_LENGTH) {
      setCreateError(`The commissioner PIN is at least ${PIN_MIN_LENGTH} digits.`);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const roster = rosterPayload(rosterNames, groomIndex);
      const { status, data } = await postJson("/api/trips", { pin: pin.trim(), name, roster });
      if (status < 200 || status >= 300) {
        setCreateError(serverError(status, data, "Trip creation isn't live on this server yet."));
        return;
      }
      const code = extractCode(data);
      if (!code) {
        setCreateError("The trip was created but the server forgot to say its code. Check with the build crew.");
        return;
      }
      rememberTrip(code, name);
      // The first name on the roster is the creator: this phone already knows who it is.
      const me = firstPlayerId(data);
      if (me) saveMe(code, me);
      go(`/t/${code}?tab=setup`);
    } catch {
      setCreateError(NO_SIGNAL);
    } finally {
      setCreating(false);
    }
  };

  // ---- demo ----
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const demo = async () => {
    setDemoBusy(true);
    setDemoError(null);
    try {
      const { status, data } = await postJson("/api/demo", {});
      if (status < 200 || status >= 300) {
        setDemoError(
          status === 404 ? "Demo mode isn't set up on this server yet. Blame the build crew." : serverError(status, data, "Demo mode isn't available."),
        );
        return;
      }
      const code = extractCode(data);
      if (!code) {
        setDemoError("The demo came back without a trip code. Weird. Try again.");
        return;
      }
      rememberTrip(code, "Demo trip");
      go(`/t/${code}`);
    } catch {
      setDemoError(NO_SIGNAL);
    } finally {
      setDemoBusy(false);
    }
  };

  const removeRecent = (code: string) => {
    forgetTrip(code);
    window.dispatchEvent(new Event(RECENT_EVENT));
  };

  return (
    <div className="min-h-dvh bg-paper pb-[calc(32px+env(safe-area-inset-bottom))]" data-testid="home">
      <header
        className="border-b-2 border-ink px-gutter pt-[calc(28px+env(safe-area-inset-top))] pb-12 text-white"
        style={{ background: "radial-gradient(circle at 85% 0%, #19ad5c 0%, #0a7d3e 42%, #053d1f 100%)" }}
      >
        <div className="mx-auto max-w-xl">
          <Wordmark name="Scramble" light size="xl" />
          <p className="loud mt-5 text-[clamp(1.9rem,9vw,2.6rem)] text-hazard" style={{ textShadow: "0 3px 0 rgba(0,0,0,0.35)" }}>
            18 holes. One groom. Zero dignity.
          </p>
          <p className="mt-3 max-w-md text-lg font-bold">
            Live scramble scoring where drinks are strokes, threesomes get ghost beers, and the feed roasts everyone.
          </p>
        </div>
      </header>

      <main className="mx-auto -mt-6 max-w-xl space-y-4 px-gutter">
        {recent.length > 0 && (
          <Card className="space-y-2 shadow-hard" data-testid="recent-trips">
            <h2 className="text-sm font-black tracking-[0.14em] uppercase">Jump back in</h2>
            <ul className="space-y-2">
              {recent.map((t) => (
                <li key={t.code} className="flex items-stretch gap-2">
                  <a
                    href={`/t/${t.code}`}
                    className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-2xl border-2 border-ink bg-fairway px-4 text-white active:bg-fairway-dark"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-lg leading-tight font-black">{t.name ?? "Unnamed trip"}</span>
                      <span className="block truncate font-mono text-sm font-bold opacity-90">{t.code}</span>
                    </span>
                    <IconChevronRight size={24} strokeWidth={3} className="shrink-0" />
                  </a>
                  <button
                    type="button"
                    onClick={() => removeRecent(t.code)}
                    aria-label={`Forget ${t.name ?? t.code}`}
                    className="flex w-12 shrink-0 items-center justify-center rounded-2xl border-2 border-line text-ink active:bg-sand"
                  >
                    <IconClose size={20} strokeWidth={3} />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card className={recent.length > 0 ? "" : "shadow-hard"}>
          <form onSubmit={join} className="space-y-3" noValidate>
            <h2 className="text-2xl font-black">Join a trip</h2>
            <TextField
              label="Trip code or link"
              placeholder="e.g. k7m2qx9fpt"
              value={joinCode}
              onChange={(e) => {
                setJoinCode(e.target.value);
                if (joinError) setJoinError(null);
              }}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="go"
              error={joinError}
              data-testid="join-code"
            />
            <Button type="submit" size="xl" full trailing={<IconChevronRight size={26} strokeWidth={3.2} />}>
              Let&apos;s go
            </Button>
          </form>
        </Card>

        <Card>
          <h2 className="text-2xl font-black">Commissioner</h2>
          {!createOpen ? (
            <>
              <p className="mt-1 text-base font-semibold text-ink">Running this circus? Create the trip with the boys already on it, then send them the link.</p>
              <Button variant="secondary" size="lg" full className="mt-3" onClick={() => setCreateOpen(true)}>
                Create the trip
              </Button>
            </>
          ) : (
            <form onSubmit={create} className="mt-3 space-y-3" noValidate>
              <TextField
                label="Trip name"
                placeholder="Caster's Last Scramble"
                value={tripName}
                onChange={(e) => setTripName(e.target.value)}
                maxLength={80}
                autoComplete="off"
              />
              <RosterFields
                text={rosterText}
                onText={editRoster}
                names={rosterNames}
                groomIndex={groomIndex}
                groomLost={groomChoiceLost(rosterNames, groomChoice)}
                onGroom={setGroomChoice}
              />
              <TextField
                label="Commissioner PIN"
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                placeholder="••••"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX_LENGTH))}
                hint="The PIN from the server setup. You'll use it to unlock powers on any phone."
              />
              {createError && (
                <p role="alert" className="rounded-xl border-2 border-flag bg-flag-soft px-3 py-2 text-base font-extrabold text-ink">
                  🚫 {createError}
                </p>
              )}
              <Button type="submit" size="xl" full loading={creating}>
                Create trip
              </Button>
              <Button variant="ghost" full onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
            </form>
          )}
        </Card>

        <Card tone="ghost">
          <h2 className="text-2xl font-black">Just looking?</h2>
          <p className="mt-1 text-base font-semibold text-ink">A fake trip with 10 fake degenerates and a full simulated round.</p>
          {demoError && (
            <p role="alert" className="mt-3 rounded-xl border-2 border-ink bg-paper px-3 py-2 text-base font-extrabold text-ink">
              👻 {demoError}
            </p>
          )}
          <Button variant="ghostbeer" size="lg" full className="mt-3" loading={demoBusy} onClick={demo}>
            Try the demo
          </Button>
        </Card>
      </main>

      <footer className="mx-auto mt-8 max-w-xl px-gutter text-center text-sm font-bold text-muted">
        Scramble v{APP_VERSION} · Drink responsibly. Golf irresponsibly.
      </footer>
    </div>
  );
}

/** "Who's playing" textarea + the groom picker. Names are parsed live (one per line or comma). */
function RosterFields({
  text,
  onText,
  names,
  groomIndex,
  groomLost,
  onGroom,
}: {
  text: string;
  onText: (v: string) => void;
  names: readonly string[];
  groomIndex: number;
  /** The picked groom's name was edited away: the picker reads "No groom yet". */
  groomLost: boolean;
  onGroom: (choice: string) => void;
}) {
  const id = useId();
  const over = names.length > MAX_ROSTER_SIZE;
  const shown = over ? names.slice(0, MAX_ROSTER_SIZE) : names;
  const hint =
    names.length === 0
      ? "Leave it empty to add everyone later in Setup."
      : over
        ? `Over ${MAX_ROSTER_SIZE}. Trim the list.`
        : `${names.length} player${names.length === 1 ? "" : "s"}. First name is you.`;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-roster`} className="text-sm font-extrabold tracking-wider text-ink uppercase">
          Who&apos;s playing
        </label>
        <textarea
          id={`${id}-roster`}
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={10}
          autoComplete="off"
          autoCapitalize="words"
          spellCheck={false}
          aria-describedby={`${id}-roster-hint`}
          aria-invalid={over || undefined}
          data-testid="create-roster"
          className={cx(
            "block min-h-36 w-full min-w-0 resize-y rounded-xl border-2 bg-paper px-4 py-3 text-lg leading-snug font-bold break-words text-ink placeholder:font-semibold placeholder:text-muted/80",
            over ? "border-flag" : "border-ink",
          )}
          placeholder={"One name per line.\nYou first."}
        />
        <p id={`${id}-roster-hint`} className={cx("text-sm font-bold", over ? "text-flag" : "text-muted")}>
          {hint}
        </p>
      </div>
      {shown.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-groom`} className="text-sm font-extrabold tracking-wider text-ink uppercase">
            <span aria-hidden="true">👑 </span>The groom
          </label>
          <select
            id={`${id}-groom`}
            value={groomIndex >= 0 && groomIndex < shown.length ? nameKey(shown[groomIndex]) : ""}
            onChange={(e) => onGroom(e.target.value)}
            data-testid="create-groom"
            aria-describedby={groomLost ? `${id}-groom-hint` : undefined}
            className={cx(
              "h-14 w-full min-w-0 rounded-xl border-2 bg-paper px-3 text-lg font-bold text-ink",
              groomLost ? "border-flag" : "border-ink",
            )}
          >
            {shown.map((n) => (
              <option key={nameKey(n)} value={nameKey(n)}>
                {n}
              </option>
            ))}
            <option value="">No groom yet</option>
          </select>
          {groomLost && (
            <p id={`${id}-groom-hint`} className="text-sm font-bold text-flag" data-testid="create-groom-lost">
              Your groom isn&apos;t on the list anymore. Pick him again.
            </p>
          )}
        </div>
      )}
    </>
  );
}
