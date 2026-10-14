"use client";
// Pre-round hero for players while the trip is in setup: who this phone is ("You're Greg · Not
// you?"), the optional "Get set up" card (Home Screen + notifications), a "How it works (40 sec)"
// replay of the explainer, the numbered "How it works" steps (incl. pre-round drinks don't count),
// then who's on which team and tee times. This is where the boys land when they open the link
// early. Flips to Play when the round starts.
import { useClientState } from "@/lib/client/react";
import { Avatar, Badge, Button, Card, EmptyState, IconPlayCircle, PlayerName, TeamPill, teamColor } from "@/components/ui";
import { GetSetUp } from "@/components/join/GetSetUp";
import { HowItWorksSteps } from "./HowItWorks";
import { useShellNav } from "./nav";
import { activeTeams, formatTeeTime, rosterGroups } from "./roster";

export function WaitingForStart() {
  const view = useClientState((s) => s.view);
  const meId = useClientState((s) => s.meId);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const nav = useShellNav();
  if (!view) return null;

  const groups = rosterGroups(view, { includeEmptyTeams: true });
  // Roster loaded but no teams yet: one "the field" card instead of "No team · Needs a team".
  const noTeams = activeTeams(view).length === 0;
  const settings = view.trip.settings;
  const myGroup = meId ? groups.find((g) => g.players.some((p) => p.id === meId)) : undefined;
  const me = myGroup?.players.find((p) => p.id === meId) ?? null;

  return (
    <div className="mx-auto w-full max-w-xl space-y-5 px-4 pt-4" data-testid="waiting-for-start">
      {me && (
        // No PIN: the name is the only check, so keep saying who this phone is (a mis-tap shows here).
        <div className="flex min-h-14 items-center gap-3 rounded-2xl border-2 border-ink bg-paper py-1 pr-1 pl-3" data-testid="you-are">
          <Avatar player={me} teamSortOrder={myGroup?.team?.sort_order ?? null} size="md" showCrown={false} />
          <p className="min-w-0 flex-1 truncate text-lg font-black">
            You&apos;re <PlayerName player={me} />
          </p>
          <button
            type="button"
            onClick={nav.switchPlayer}
            className="min-h-12 shrink-0 rounded-xl px-3 text-base font-extrabold text-fairway-dark underline underline-offset-4 active:bg-sand"
            data-testid="you-are-switch"
          >
            Not you?
          </button>
        </div>
      )}
      <GetSetUp />
      <section
        className="relative overflow-hidden rounded-3xl border-2 border-ink px-5 pt-6 pb-5 text-white shadow-hard"
        style={{ background: "radial-gradient(circle at 80% 0%, #15a356 0%, #0a7d3e 45%, #064d27 100%)" }}
      >
        <div className="flex items-center gap-2 text-sm font-black tracking-[0.15em] uppercase">
          <span className="relative inline-flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-hazard opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-hazard" />
          </span>
          Pre-round
        </div>
        {/* Sized so "COMMISSIONER" (12 letters) fits a 360px phone. */}
        <h1 className="loud mt-3 text-[clamp(1.75rem,8.5vw,3rem)]">Waiting for the commissioner to start the round</h1>
        <p className="mt-3 text-lg font-bold">
          Stretch. Hydrate. Lie about your handicap. This screen flips to the scorecard the second the round starts.
        </p>
        <p className="mt-2 text-sm font-extrabold tracking-wide uppercase opacity-95">⛳ {settings.course_name}</p>
        {isCommissioner && (
          <Button variant="hazard" size="lg" full className="mt-4" onClick={() => nav.setTab("setup")}>
            Go to Setup to start it
          </Button>
        )}
        <Button
          variant={isCommissioner ? "secondary" : "hazard"}
          size="lg"
          full
          className={isCommissioner ? "mt-3" : "mt-4"}
          onClick={nav.openExplainer}
          leading={<IconPlayCircle size={24} />}
          data-testid="how-it-works"
        >
          How it works (40 sec)
        </Button>
      </section>

      <HowItWorksSteps />

      <section className="space-y-3">
        <h2 className="text-xl font-black tracking-tight uppercase">{noTeams && groups.length > 0 ? "The field" : "The teams"}</h2>
        {groups.length === 0 && (
          <EmptyState emoji="🦗" title="No roster yet">
            The commissioner is still picking teams. Hassle him in the group chat.
          </EmptyState>
        )}
        {groups.map((g) => {
          const c = teamColor(g.team ? g.team.sort_order : null);
          const tee = formatTeeTime(g.team?.tee_time);
          const mine = g.players.some((p) => p.id === meId);
          return (
            <Card key={g.team?.id ?? "free"} padded={false} className="overflow-hidden" style={{ borderColor: mine ? "#0b0f0c" : undefined }}>
              <div className="flex items-center gap-2 px-4 py-3" style={{ backgroundColor: c.soft }}>
                {noTeams ? (
                  <span className="min-w-0 flex-1 text-base leading-tight font-extrabold">Teams drop soon. The commissioner is agonizing.</span>
                ) : (
                  <>
                    <TeamPill team={g.team} size="md" you={mine} />
                    <span className="min-w-0 flex-1" />
                    {g.team ? tee ? <Badge tone="outline">Tee {tee}</Badge> : null : <Badge tone="hazard">Needs a team</Badge>}
                  </>
                )}
              </div>
              {g.players.length === 0 ? (
                <p className="px-4 py-3 text-base font-bold text-muted">Nobody yet.</p>
              ) : (
                <ul className="divide-y-2 divide-line">
                  {g.players.map((p) => (
                    <li key={p.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                      <Avatar player={p} teamSortOrder={g.team?.sort_order ?? null} size="md" />
                      <span className="min-w-0 flex-1 truncate text-lg font-extrabold">
                        <PlayerName player={p} you={p.id === meId} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {g.team && g.players.length > 0 && g.players.length < view.trip.base_team_size && (
                <p className="border-t-2 border-line px-4 py-2 text-sm font-bold text-ghost-dark">
                  👻 Short-handed: ghost beers in play for this team.
                </p>
              )}
            </Card>
          );
        })}
      </section>
    </div>
  );
}
