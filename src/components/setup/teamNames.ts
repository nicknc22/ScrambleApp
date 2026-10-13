// Team name generator: AI names from POST /api/t/<code>/ai/team-names, with a built-in list of
// unhinged golf / drinking / bachelor-party names when AI is off, the route fails or there's no signal.
// Tone rule: roast golf, drinking and on-course decisions only.

export const LOCAL_TEAM_NAMES: readonly string[] = [
  "Grip It & Sip It",
  "The Shank Redemption",
  "Bogey Nights",
  "Fore Play",
  "Sons of Pitches",
  "Weapons of Grass Destruction",
  "The Mulligan Mafia",
  "Lager Than Life",
  "Ghost Beer Gang",
  "Shotgun Start",
  "Bunker Busters",
  "Hazardous Materials",
  "Caddyshackled",
  "Par-Tee Animals",
  "The Chili Dippers",
  "Three Putt Thunder",
  "Wedge Issues",
  "Snowmen on the Card",
  "Duff Daddies",
  "Slice Slice Baby",
  "Out of Bounds, Out of Beer",
  "Sand Trap Kings",
  "Beer Gods of the Back Nine",
  "The Divot Diggers",
  "Hookers & Slicers",
  "Big Drive Energy",
  "Last Swing Before the Ring",
  "The Groom's Last Stand",
  "Fairway to Heaven",
  "Tin Cup Tragedies",
  "19th Hole Heroes",
  "Shank You Very Much",
  "Rough Night",
  "Booze Cruise Control",
  "The Breakfast Ball Boys",
  "Tee Totalers (Ironically)",
  "Bogey Bombers",
  "Lip Out Legends",
  "Cart Path Only",
  "Pin Seekers, Beer Keepers",
  "Whiskey Wedges",
  "The Worm Burners",
  "Dimple Damage",
  "Drunk in the Rough",
  "Hold My Putter",
  "Gimme Gimme Gimme",
  "Water Hazard Swimteam",
  "The Bachelor Party Foul",
];

/** `count` distinct names from the local list, skipping ones already in use (case-insensitive). */
export function localTeamNames(count: number, exclude: readonly string[] = [], random: () => number = Math.random): string[] {
  const used = new Set(exclude.map((n) => n.trim().toLowerCase()));
  const pool = LOCAL_TEAM_NAMES.filter((n) => !used.has(n.toLowerCase()));
  const source = pool.length >= count ? pool : [...LOCAL_TEAM_NAMES];
  const a = [...source];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}

/** Clean an AI response into up to `count` usable, distinct names (<= 40 chars, no quotes/numbering). */
export function cleanNames(raw: unknown, count = 5): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const name = v
      .replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "")
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!name || name.length > 40) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= count) break;
  }
  return out;
}

export type TeamNamesSource = "ai" | "local";

export interface TeamNamesResult {
  names: string[];
  source: TeamNamesSource;
}

/**
 * Ask the AI route (POST /api/t/<code>/ai/team-names → {names, ai}) for 5 names (8 s timeout). Falls back to the local list on any failure,
 * including AI being off, no signal, or a weird response. Never throws.
 */
export async function generateTeamNames(opts: {
  code: string;
  exclude?: readonly string[];
  aiEnabled?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  random?: () => number;
}): Promise<TeamNamesResult> {
  const { code, exclude = [], aiEnabled = true, timeoutMs = 8000, random = Math.random } = opts;
  const fallback = (): TeamNamesResult => ({ names: localTeamNames(5, exclude, random), source: "local" });
  const doFetch = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!aiEnabled || !doFetch) return fallback();
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
  try {
    const res = await doFetch(`/api/t/${encodeURIComponent(code)}/ai/team-names`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A fresh seed per tap so re-rolls don't come back identical.
      body: JSON.stringify({ seed: random().toString(36).slice(2, 10) }),
      signal: ctrl?.signal,
    });
    if (!res.ok) return fallback();
    const data = (await res.json()) as { names?: unknown; ai?: unknown };
    const names = cleanNames(data?.names, 5);
    // The route answers with its own built-in names (ai: false) when the model is off or slow.
    const source: TeamNamesSource = data?.ai === false ? "local" : "ai";
    if (names.length === 0) return fallback();
    if (names.length < 5) {
      const lower = new Set(names.map((n) => n.toLowerCase()));
      const extra = localTeamNames(10, [...exclude, ...names], random).filter((n) => !lower.has(n.toLowerCase()));
      names.push(...extra.slice(0, 5 - names.length));
    }
    return { names, source };
  } catch {
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}
