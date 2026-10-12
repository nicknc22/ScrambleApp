"use client";
// Design-system gallery: every primitive in its states, with mock data (no store needed).
import { useState, type ReactNode } from "react";
import type { Player, Team } from "@/lib/types";
import {
  Avatar,
  Badge,
  BottomSheet,
  Button,
  Card,
  Chip,
  ConfirmProvider,
  Countdown,
  EmptyState,
  FanfareProvider,
  IconButton,
  IconCamera,
  IconClose,
  IconGear,
  IconMenu,
  OfflineBadge,
  PinPad,
  PlayerName,
  SectionHeader,
  SegmentedControl,
  Spinner,
  StatTile,
  Stepper,
  TEAM_PALETTE,
  TeamPill,
  TextField,
  ToastProvider,
  Toggle,
  useConfirm,
  useFanfare,
  useToast,
  type BadgeTone,
  type ButtonVariant,
  type CardTone,
} from "@/components/ui";
import { InstallGuide } from "@/components/join/InstallGuide";
import { Splash, Wordmark } from "@/components/shell/Splash";
import { TabBar } from "@/components/shell/TabBar";
import type { TabKey } from "@/components/shell/tabs";

const mkPlayer = (name: string, nickname: string | null, is_groom = false): Pick<Player, "name" | "nickname" | "is_groom"> => ({
  name,
  nickname,
  is_groom,
});
const PLAYERS = [
  mkPlayer("Nick Caster", "Big Nick", true),
  mkPlayer("Dave Thompson", null),
  mkPlayer("Mike O'Sullivan", "Sully"),
  mkPlayer("Christopher Montgomery-Wellington III", null),
];
const TEAMS: Pick<Team, "name" | "sort_order">[] = [
  { name: "Grip It and Sip It", sort_order: 0 },
  { name: "Shank Redemption", sort_order: 1 },
  { name: "Fore Play", sort_order: 2 },
  { name: "Ghost Riders", sort_order: 3 },
];

const VARIANTS: ButtonVariant[] = ["primary", "secondary", "danger", "ghost", "hazard", "ghostbeer", "ink"];
const BADGES: BadgeTone[] = ["neutral", "ink", "fairway", "hazard", "flag", "ghost", "beer", "sky", "outline", "gold"];
const CARDS: CardTone[] = ["default", "fairway", "hazard", "flag", "ghost", "beer", "sky", "sand", "ink"];
const SWATCHES = [
  ["ink", "#0b0f0c", "#fff"],
  ["paper", "#ffffff", "#0b0f0c"],
  ["muted", "#3f4a43", "#fff"],
  ["fairway", "#0a7d3e", "#fff"],
  ["fairway-dark", "#075c2d", "#fff"],
  ["hazard", "#ffd60a", "#0b0f0c"],
  ["flag", "#e5262d", "#fff"],
  ["ghost", "#7c3aed", "#fff"],
  ["beer", "#f59e0b", "#0b0f0c"],
  ["sky", "#0369a1", "#fff"],
] as const;

export default function DevUiPage() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <FanfareProvider>
          <Gallery />
        </FanfareProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t-2 border-ink pt-5">
      <SectionHeader title={title} />
      {children}
    </section>
  );
}

function Gallery() {
  const toast = useToast();
  const confirm = useConfirm();
  const fanfare = useFanfare();
  const [strokes, setStrokes] = useState(4);
  const [seg, setSeg] = useState("standings");
  const [chips, setChips] = useState<Record<number, boolean>>({ 0: true });
  const [sheet, setSheet] = useState(false);
  const [tallSheet, setTallSheet] = useState(false);
  const [confirmResult, setConfirmResult] = useState<string>("–");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [toggle, setToggle] = useState(false);
  const [tab, setTab] = useState<TabKey>("play");
  const [splash, setSplash] = useState(false);
  const [loading, setLoading] = useState(false);
  const [countdownTo] = useState(() => Date.now() + 2 * 3600_000 + 13 * 60_000);
  const [shortCountdown, setShortCountdown] = useState(() => Date.now() + 65_000);

  if (splash) {
    return (
      <div className="relative">
        <Splash />
        <div className="fixed top-[calc(12px+env(safe-area-inset-top))] right-3 z-10">
          <IconButton label="Close splash" variant="secondary" round onClick={() => setSplash(false)}>
            <IconClose />
          </IconButton>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-paper pb-tabbar" data-testid="dev-ui">
      <header className="border-b-2 border-ink bg-fairway px-gutter pt-[calc(16px+env(safe-area-inset-top))] pb-5 text-white">
        <div className="mx-auto max-w-xl">
          <Wordmark name="Scramble UI" light size="md" />
          <p className="mt-2 font-bold">Every primitive, every state. Mock data only.</p>
        </div>
      </header>
      <div className="mx-auto max-w-xl space-y-6 px-gutter pt-5">
        <Section title="Palette">
          <div className="grid grid-cols-2 gap-2">
            {SWATCHES.map(([name, bg, fg]) => (
              <div key={name} className="flex h-14 items-center justify-between rounded-xl border-2 border-ink px-3 font-extrabold" style={{ background: bg, color: fg }}>
                <span>{name}</span>
                <span className="font-mono text-xs">{bg}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {TEAM_PALETTE.map((c, i) => (
              <span key={c.name} className="rounded-full border-2 border-ink px-3 py-1 text-sm font-black" style={{ background: c.bg, color: c.fg }}>
                Team {i}
              </span>
            ))}
          </div>
        </Section>

        <Section title="Type">
          <p className="loud text-5xl">Ghost beer</p>
          <h1 className="text-4xl">Heading 900</h1>
          <h2 className="text-2xl font-extrabold">Heading 800</h2>
          <p className="text-lg font-semibold">Body copy is semibold ink. Never light gray for anything that matters.</p>
          <p className="text-base font-semibold text-muted">Muted text (#3f4a43) is still AA on white.</p>
        </Section>

        <Section title="Buttons">
          <div className="grid grid-cols-2 gap-2">
            {VARIANTS.map((v) => (
              <Button key={v} variant={v} full>
                {v}
              </Button>
            ))}
          </div>
          <Button size="lg" full leading={<IconCamera size={22} />}>
            Large with icon
          </Button>
          <Button size="xl" full>
            On the tee: hole 5
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="primary" full loading={loading} onClick={() => setLoading(true)}>
              {loading ? "Working" : "Tap = loading"}
            </Button>
            <Button variant="secondary" full disabled>
              Disabled
            </Button>
          </div>
          {loading && (
            <Button variant="ghost" full onClick={() => setLoading(false)}>
              Stop loading
            </Button>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <IconButton label="Menu">
              <IconMenu />
            </IconButton>
            <IconButton label="Settings" variant="secondary">
              <IconGear />
            </IconButton>
            <IconButton label="Camera" variant="primary" size={56} round>
              <IconCamera size={28} />
            </IconButton>
            <IconButton label="Close" variant="danger" size={64} round>
              <IconClose size={30} />
            </IconButton>
          </div>
        </Section>

        <Section title="Chips">
          <div className="flex flex-wrap gap-2">
            {PLAYERS.map((p, i) => (
              <Chip
                key={p.name}
                selected={!!chips[i]}
                onClick={() => setChips((c) => ({ ...c, [i]: !c[i] }))}
                leading={<Avatar player={p} teamSortOrder={0} size="sm" />}
              >
                <PlayerName player={p} />
              </Chip>
            ))}
            <Chip selected tone="ghost">
              Ghost tone
            </Chip>
            <Chip selected tone="hazard">
              Hazard tone
            </Chip>
            <Chip disabled>Disabled</Chip>
          </div>
        </Section>

        <Section title="Badges">
          <div className="flex flex-wrap gap-2">
            {BADGES.map((b) => (
              <Badge key={b} tone={b}>
                {b}
              </Badge>
            ))}
            <Badge tone="sky" size="md">
              Closest to pin
            </Badge>
            <Badge tone="beer" size="md">
              Long drive
            </Badge>
          </div>
        </Section>

        <Section title="Cards">
          <div className="grid grid-cols-2 gap-2">
            {CARDS.map((t) => (
              <Card key={t} tone={t} className="font-extrabold">
                {t}
              </Card>
            ))}
          </div>
        </Section>

        <Section title="Stepper">
          <Card>
            <Stepper
              label="Strokes"
              value={strokes}
              onChange={setStrokes}
              min={1}
              max={20}
              hint={`Par 4 · net ${strokes - 2} with 2 drinks`}
            />
          </Card>
          <Stepper size="lg" label="Feet" value={strokes} onChange={setStrokes} min={1} max={20} />
        </Section>

        <Section title="Segmented control">
          <SegmentedControl
            ariaLabel="Leaderboard views"
            value={seg}
            onChange={setSeg}
            options={[
              { value: "standings", label: "Standings" },
              { value: "drinkers", label: "Drinkers", badge: 11 },
              { value: "contests", label: "Contests" },
              { value: "drives", label: "Drives", badge: "!" },
            ]}
          />
          <p className="text-sm font-bold text-muted">Selected: {seg}</p>
        </Section>

        <Section title="Players and teams">
          <ul className="space-y-2">
            {PLAYERS.map((p, i) => (
              <li key={p.name} className="flex min-h-14 items-center gap-3">
                <Avatar player={p} teamSortOrder={i} size={i === 0 ? "lg" : "md"} />
                <span className="min-w-0 flex-1 truncate text-lg font-extrabold">
                  <PlayerName player={p} you={i === 1} showRealName />
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {TEAMS.map((t, i) => (
              <TeamPill key={t.name} team={t} you={i === 0} />
            ))}
            <TeamPill team={null} />
            <TeamPill team={TEAMS[1]} size="sm" />
            <TeamPill team={TEAMS[2]} size="lg" />
          </div>
        </Section>

        <Section title="Stat tiles">
          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Pos" value="T2" />
            <StatTile label="Net" value="-4" tone="fairway" />
            <StatTile label="Drinks" value={11} tone="beer" sub="2 ghosts" />
            <StatTile label="Mulligans" value={3} tone="ghost" />
            <StatTile label="Thru" value="F" tone="ink" />
            <StatTile label="Pot" value="$140" tone="sky" />
          </div>
        </Section>

        <Section title="Offline badge">
          <div className="space-y-2">
            <OfflineBadge pendingCount={3} online={false} />
            <OfflineBadge pendingCount={1} online={false} />
            <OfflineBadge pendingCount={0} online={false} />
            <OfflineBadge pendingCount={2} online syncing />
            <OfflineBadge pendingCount={3} online={false} variant="bar" />
            <p className="text-sm font-bold text-muted">Online with 0 pending: hidden.</p>
            <OfflineBadge pendingCount={0} online />
          </div>
        </Section>

        <Section title="Countdown">
          <p className="text-lg font-extrabold">
            Tee time in <Countdown to={countdownTo} className="rounded bg-hazard px-1.5" />
          </p>
          <p className="text-lg font-extrabold">
            Undo window: <Countdown to={shortCountdown} doneText="Expired" />
          </p>
          <Button variant="secondary" onClick={() => setShortCountdown(Date.now() + 10_000)}>
            Restart 10 s
          </Button>
        </Section>

        <Section title="Forms">
          <TextField label="Trip code" placeholder="k7m2qx9fpt" hint="It's in the group chat link." />
          <TextField label="With error" defaultValue="lol" error="That's not a trip code." />
          <Toggle checked={toggle} onChange={setToggle} label="Mute notifications" description="The feed still has everything." />
        </Section>

        <Section title="PIN pad">
          <Card className="pt-5">
            <PinPad
              value={pin}
              onChange={(v) => {
                setPin(v);
                setPinError(null);
              }}
              onSubmit={(v) => {
                if (v === "2468") {
                  toast.success("Commissioner powers: ON. Everything you touch gets posted.", { emoji: "🫡" });
                  setPin("");
                } else {
                  setPinError("Wrong PIN. Nice try, intern.");
                  setPin("");
                }
              }}
              error={pinError}
            />
            <p className="mt-2 text-center text-sm font-bold text-muted">Try 2468.</p>
          </Card>
        </Section>

        <Section title="Sheets">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" full onClick={() => setSheet(true)}>
              Bottom sheet
            </Button>
            <Button variant="secondary" full onClick={() => setTallSheet(true)}>
              Tall sheet
            </Button>
            <Button
              variant="danger"
              full
              onClick={async () => {
                const ok = await confirm({
                  title: "Delete this drink?",
                  body: "Ghost beer math recomputes for the whole team.",
                  emoji: "🍺",
                  confirmLabel: "Delete it",
                  tone: "danger",
                });
                setConfirmResult(ok ? "confirmed" : "cancelled");
              }}
            >
              Confirm (danger)
            </Button>
            <Button
              variant="hazard"
              full
              onClick={async () => {
                const ok = await confirm({ title: "On the tee: hole 5?", body: "This closes hole 4's drink window.", confirmLabel: "Tee it up", tone: "hazard" });
                setConfirmResult(ok ? "confirmed" : "cancelled");
              }}
            >
              Confirm (hazard)
            </Button>
          </div>
          <p className="text-sm font-bold text-muted">Last confirm: {confirmResult}</p>
        </Section>

        <Section title="Toasts">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ink" full onClick={() => toast.info("Team Shank Redemption teed off on 1.")}>
              Info
            </Button>
            <Button variant="primary" full onClick={() => toast.success("Score saved. Hole 6: 4.")}>
              Success
            </Button>
            <Button variant="danger" full onClick={() => toast.error("The round isn't live, so that didn't count.", { title: "That didn't save" })}>
              Error
            </Button>
            <Button variant="hazard" full onClick={() => toast.roast("Drinking before the first tee? Bold. Doesn't count.")}>
              Roast
            </Button>
          </div>
          <Button
            variant="secondary"
            size="lg"
            full
            onClick={() =>
              toast.show({
                tone: "success",
                emoji: "🍺",
                title: "Drink logged for Sully",
                message: "Hole 7 · −1 stroke",
                action: { label: "Undo", onAction: () => toast.info("Undone. Pretend it never happened.") },
              })
            }
          >
            Drink with 10 s undo
          </Button>
          <Button
            variant="secondary"
            full
            onClick={() => {
              toast.info("One");
              toast.success("Two");
              toast.roast("Three");
              toast.error("Four (oldest drops off the stack)");
            }}
          >
            Stack four
          </Button>
        </Section>

        <Section title="Fanfare">
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="ghostbeer"
              full
              onClick={() => fanfare.show({ tone: "ghost", emoji: "👻", title: "Ghost beer", subtitle: "Drink #3 counts double. Threesome math, baby." })}
            >
              Ghost beer
            </Button>
            <Button
              variant="hazard"
              full
              onClick={() =>
                fanfare.show({ tone: "groom", emoji: "👑", title: "Groom's Mulligan", subtitle: "Big Nick invokes his divine right to a do-over on 14." })
              }
            >
              Groom&apos;s Mulligan
            </Button>
            <Button variant="primary" full onClick={() => fanfare.show({ tone: "hype", emoji: "🔥", title: "New leader", subtitle: "Fore Play takes the lead at -6." })}>
              Hype
            </Button>
            <Button variant="danger" full onClick={() => fanfare.show({ tone: "alert", emoji: "🚨", title: "Drive check", subtitle: "Dave needs a drive. 2 holes left on this nine." })}>
              Alert
            </Button>
          </div>
        </Section>

        <Section title="Empty, spinner, splash">
          <Card>
            <EmptyState emoji="📭" title="Quiet so far" action={<Button full>Post something</Button>}>
              Nothing has happened yet. Go do something stupid.
            </EmptyState>
          </Card>
          <div className="flex items-center gap-4 text-fairway">
            <Spinner />
            <Spinner size={36} />
            <span className="text-ink">
              <Spinner size={28} />
            </span>
          </div>
          <Button variant="secondary" full onClick={() => setSplash(true)}>
            Show the splash screen
          </Button>
        </Section>

        <Section title="Install guide">
          <Card>
            <InstallGuide platform="ios" />
          </Card>
          <Card>
            <InstallGuide platform="android" compact />
          </Card>
        </Section>
      </div>

      <BottomSheet open={sheet} onClose={() => setSheet(false)} title="Bottom sheet">
        <div className="space-y-3 pb-2">
          <p className="text-lg font-semibold">Drag the handle down, tap outside, press Escape or the X to close. Focus is trapped in here.</p>
          <TextField label="Focusable field" placeholder="Tab cycles inside the sheet" />
          <Button full onClick={() => setSheet(false)}>
            Close
          </Button>
        </div>
      </BottomSheet>
      <BottomSheet
        open={tallSheet}
        onClose={() => setTallSheet(false)}
        title="Tall sheet with footer"
        size="tall"
        footer={
          <Button size="xl" full onClick={() => setTallSheet(false)}>
            Submit entry
          </Button>
        }
      >
        <div className="space-y-2 pb-2">
          {Array.from({ length: 24 }, (_, i) => (
            <Card key={i} padded className="font-bold">
              Scrollable row {i + 1}
            </Card>
          ))}
        </div>
      </BottomSheet>

      <TabBar tab={tab} onSelect={setTab} badges={{ feed: 3 }} />
    </div>
  );
}
