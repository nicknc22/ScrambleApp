// The shareable recap card (1080x1350 PNG via next/og ImageResponse in
// src/app/api/t/[code]/recap/route.tsx). Server-safe: no hooks, no client modules.
//
// Satori rules this follows: every element with several children is display:flex; only the
// bundled Geist Regular font (no network fonts), so "bold" is faked with a text stroke; NO emoji
// or symbols outside Latin/punctuation (those make next/og fetch twemoji / Google Fonts at render
// time, which fails offline) — every string goes through sanitizeOgText.
import type { CSSProperties } from "react";
import type { TripState } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";
import { formatToPar } from "@/lib/engine/format";
import { displayName } from "@/components/ui/PlayerName";
import { teamColor } from "@/components/ui/teamColors";

export const RECAP_WIDTH = 1080;
export const RECAP_HEIGHT = 1350;

const INK = "#0b0f0c";
const FAIRWAY = "#0a7d3e";
const FAIRWAY_DARK = "#075c2d";
const HAZARD = "#ffd60a";
const GOLD = "#f5c518";
const FLAG = "#e5262d";
const MUTED = "#3f4a43";

/**
 * Keep only characters the bundled font draws (ASCII, Latin-1/Extended-A/B, common punctuation,
 * ← →); drop emoji, symbols and everything else; collapse whitespace; cap the length with "…".
 */
export function sanitizeOgText(input: string | null | undefined, max = 80): string {
  if (typeof input !== "string") return "";
  let out = "";
  for (const ch of input.normalize("NFC")) {
    const cp = ch.codePointAt(0)!;
    const ok =
      (cp >= 0x20 && cp <= 0x7e) ||
      (cp >= 0xa0 && cp <= 0x24f) ||
      (cp >= 0x2010 && cp <= 0x2027) ||
      cp === 0x2190 ||
      cp === 0x2192;
    out += ok ? ch : cp === 0x0a || cp === 0x09 ? " " : "";
  }
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > max) out = `${out.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
  return out;
}

export interface RecapStanding {
  pos: string;
  team: string;
  color: string;
  members: string;
  net: number;
  toPar: string;
  thru: string;
}

export interface RecapAward {
  title: string;
  winners: string;
  value: string;
  awarded: boolean;
}

export interface RecapModel {
  appName: string;
  tripName: string;
  dateLabel: string;
  courseName: string;
  final: boolean;
  champion: { team: string; toPar: string; net: number } | null;
  standings: RecapStanding[];
  awards: RecapAward[];
}

/** "SAT, OCT 24, 2026" in the course's time zone (Poconos = America/New_York). */
export function recapDateLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d
      .toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric" })
      .toUpperCase();
  } catch {
    return iso.slice(0, 10);
  }
}

/** Everything the card shows, as plain sanitized strings. */
export function buildRecapModel(state: TripState, d: Derived): RecapModel {
  const trip = state.trip;
  const standings: RecapStanding[] = d.standings.slice(0, 8).map((r) => {
    const team = d.teamById[r.team_id];
    const members = (d.membersOfTeam[r.team_id] ?? []).map((p) => sanitizeOgText(displayName(p), 18)).filter(Boolean);
    return {
      pos: r.pos_label,
      team: sanitizeOgText(team?.name, 26) || "Team",
      color: teamColor(team?.sort_order).bg,
      members: sanitizeOgText(members.join(", "), 60),
      net: r.net,
      toPar: r.thru > 0 ? formatToPar(r.net_to_par) : "–",
      thru: r.thru_label,
    };
  });

  const champAward = d.awards.find((a) => a.key === "champions");
  let champion: RecapModel["champion"] = null;
  if (champAward?.awarded && champAward.team_ids.length > 0) {
    const rows = champAward.team_ids.map((id) => d.standings.find((r) => r.team_id === id)).filter((r) => !!r);
    const teams = champAward.team_ids.map((id) => sanitizeOgText(d.teamById[id]?.name, 26) || "Team");
    if (rows.length > 0) champion = { team: sanitizeOgText(teams.join(" & "), 44), toPar: formatToPar(rows[0]!.net_to_par), net: rows[0]!.net };
  }

  const awards: RecapAward[] = d.awards
    .filter((a) => a.key !== "champions")
    .map((a) => {
      const who =
        a.player_ids.length > 0
          ? a.player_ids.map((id) => sanitizeOgText(displayName(d.playerById[id]), 18) || "Somebody")
          : a.team_ids.map((id) => sanitizeOgText(d.teamById[id]?.name, 22) || "Team");
      return {
        title: sanitizeOgText(a.title, 28),
        winners: a.awarded ? sanitizeOgText(who.join(" & "), 48) || "Somebody" : "Nobody",
        value: a.awarded ? sanitizeOgText(a.value_label, 40) : "Boring.",
        awarded: a.awarded,
      };
    });

  return {
    appName: sanitizeOgText(trip.app_name, 24) || "Scramble",
    tripName: sanitizeOgText(trip.name, 48) || "The Scramble",
    dateLabel: recapDateLabel(trip.finalized_at ?? trip.started_at ?? trip.created_at),
    courseName: sanitizeOgText(trip.settings?.course_name, 40),
    final: trip.status === "final",
    champion,
    standings,
    awards,
  };
}

const flex = (s: CSSProperties): CSSProperties => ({ display: "flex", ...s });

/** Thick "bold" text (the only bundled font is Regular). */
function bold(px: number): CSSProperties {
  return { WebkitTextStroke: `${px}px currentColor` } as CSSProperties;
}

/** Award winner line: shrink for long ties ("A & B & C") so they fit a tile; ellipsis past that. */
export function awardWinnerSize(text: string): number {
  if (text.length <= 26) return 28;
  if (text.length <= 32) return 24;
  return 20;
}

/** One line that ends in "…" instead of running into the tile border. */
const oneLine: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" };

/** Champions line (uppercase): a tie of two long names steps down instead of running off the card. */
function championSize(team: string): number {
  if (team.length <= 18) return 52;
  if (team.length <= 26) return 40;
  return 32;
}

function tripNameSize(name: string): number {
  if (name.length <= 16) return 92;
  if (name.length <= 24) return 74;
  if (name.length <= 34) return 58;
  return 48;
}

export function RecapImage({ model }: { model: RecapModel }) {
  const n = Math.max(1, model.standings.length);
  const rowH = n <= 3 ? 86 : n <= 5 ? 66 : 52;
  const teamSize = n <= 3 ? 40 : n <= 5 ? 34 : 28;
  const tileH = n <= 4 ? 96 : 82;
  return (
    <div
      style={flex({
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: FAIRWAY,
        color: "#ffffff",
        padding: "40px 44px",
        overflow: "hidden",
      })}
    >
      {/* Header */}
      <div style={flex({ alignItems: "center", justifyContent: "space-between" })}>
        <div
          style={flex({
            backgroundColor: HAZARD,
            color: INK,
            border: `4px solid ${INK}`,
            borderRadius: 999,
            padding: "6px 22px",
            fontSize: 30,
            letterSpacing: 3,
            textTransform: "uppercase",
            ...bold(1.2),
          })}
        >
          {model.appName}
        </div>
        <div
          style={flex({
            backgroundColor: model.final ? FLAG : HAZARD,
            color: model.final ? "#ffffff" : INK,
            border: `4px solid ${INK}`,
            borderRadius: 14,
            padding: "6px 20px",
            fontSize: 34,
            letterSpacing: 4,
            transform: "rotate(-4deg)",
            ...bold(1.5),
          })}
        >
          {model.final ? "FINAL" : "PROJECTED"}
        </div>
      </div>
      <div
        style={flex({
          marginTop: 18,
          fontSize: tripNameSize(model.tripName),
          lineHeight: 1.02,
          textTransform: "uppercase",
          color: "#ffffff",
          WebkitTextStroke: `3px ${INK}`,
          textShadow: `0 7px 0 ${INK}`,
          transform: "skewX(-8deg)",
        } as CSSProperties)}
      >
        {model.tripName}
      </div>
      <div style={flex({ marginTop: 26, fontSize: 28, letterSpacing: 2, color: HAZARD, textTransform: "uppercase", ...bold(0.8) })}>
        {[model.dateLabel, model.courseName].filter(Boolean).join("  ·  ")}
      </div>

      {/* Champions */}
      {model.champion && (
        <div
          style={flex({
            marginTop: 22,
            alignItems: "center",
            backgroundColor: GOLD,
            color: INK,
            border: `5px solid ${INK}`,
            borderRadius: 26,
            boxShadow: `0 8px 0 ${INK}`,
            padding: "12px 24px",
          })}
        >
          <div style={flex({ flexDirection: "column", flexGrow: 1, minWidth: 0 })}>
            <div style={flex({ fontSize: 24, letterSpacing: 5, ...bold(0.8) })}>CHAMPIONS</div>
            <div style={flex({ fontSize: championSize(model.champion.team), lineHeight: 1.05, textTransform: "uppercase", ...oneLine, ...bold(2) })}>
              {model.champion.team}
            </div>
          </div>
          <div style={flex({ flexDirection: "column", alignItems: "flex-end", marginLeft: 16 })}>
            <div style={flex({ fontSize: 64, lineHeight: 1, ...bold(2.5) })}>{model.champion.toPar}</div>
            <div style={flex({ fontSize: 22, ...bold(0.6) })}>{`${model.champion.net} NET`}</div>
          </div>
        </div>
      )}

      {/* Standings */}
      <div style={flex({ marginTop: 24, fontSize: 26, letterSpacing: 5, color: HAZARD, ...bold(0.8) })}>FINAL STANDINGS</div>
      <div
        style={flex({
          marginTop: 8,
          flexDirection: "column",
          backgroundColor: "#ffffff",
          color: INK,
          border: `5px solid ${INK}`,
          borderRadius: 26,
          padding: "6px 20px",
        })}
      >
        {model.standings.length === 0 && <div style={flex({ fontSize: 30, padding: 16 })}>No teams. No glory.</div>}
        {model.standings.map((s, i) => (
          <div
            key={i}
            style={flex({
              height: rowH,
              alignItems: "center",
              borderTop: i === 0 ? "none" : "3px solid #c3ccc6",
            })}
          >
            <div style={flex({ width: 84, fontSize: teamSize + 6, ...bold(1.8) })}>{s.pos}</div>
            <div style={flex({ width: 14, height: rowH - 24, borderRadius: 7, backgroundColor: s.color, marginRight: 16 })} />
            <div style={flex({ flexDirection: "column", flexGrow: 1, minWidth: 0, overflow: "hidden" })}>
              <div style={flex({ fontSize: teamSize, lineHeight: 1.05, ...oneLine, ...bold(1.2) })}>{s.team}</div>
              {n <= 5 && s.members && <div style={flex({ fontSize: 20, color: MUTED, marginTop: 2, ...oneLine })}>{s.members}</div>}
            </div>
            <div style={flex({ flexDirection: "column", alignItems: "flex-end", marginLeft: 12 })}>
              <div style={flex({ fontSize: teamSize + 6, lineHeight: 1, color: FAIRWAY_DARK, ...bold(1.8) })}>{s.toPar}</div>
              <div style={flex({ fontSize: 18, color: MUTED })}>{`${s.net} net · thru ${s.thru}`}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Awards */}
      <div style={flex({ marginTop: 22, fontSize: 26, letterSpacing: 5, color: HAZARD, ...bold(0.8) })}>AWARDS</div>
      <div style={flex({ marginTop: 8, flexWrap: "wrap", justifyContent: "space-between" })}>
        {model.awards.slice(0, 10).map((a, i) => (
          <div
            key={i}
            style={flex({
              width: "49%",
              height: tileH,
              marginBottom: 10,
              flexDirection: "column",
              justifyContent: "center",
              backgroundColor: a.awarded ? "#ffffff" : "#e2f3e8",
              color: INK,
              border: `4px solid ${INK}`,
              borderRadius: 20,
              padding: "6px 16px",
              overflow: "hidden",
            })}
          >
            <div style={flex({ fontSize: 18, letterSpacing: 2, color: FAIRWAY_DARK, textTransform: "uppercase", ...bold(0.5) })}>
              {a.title}
            </div>
            <div style={flex({ fontSize: awardWinnerSize(a.winners), lineHeight: 1.1, ...oneLine, ...bold(1) })}>{a.winners}</div>
            <div style={flex({ fontSize: 19, color: MUTED, ...oneLine })}>{a.value}</div>
          </div>
        ))}
      </div>

      <div style={flex({ marginTop: "auto", justifyContent: "center", fontSize: 22, color: "#e2f3e8", letterSpacing: 1 })}>
        {`Scored live in ${model.appName}. Ghost beers are real. Settle up in the app.`}
      </div>
    </div>
  );
}
