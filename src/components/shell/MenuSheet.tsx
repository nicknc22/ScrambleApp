"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import type { TripStatus } from "@/lib/types";
import {
  BottomSheet,
  IconChevronRight,
  IconClipboard,
  IconGear,
  IconHome,
  IconPlayCircle,
  IconShare,
  IconTrophy,
  IconUserSwap,
  cx,
} from "@/components/ui";
import { IconRulebook } from "./HowItWorks";
import { useShareTripLink } from "./ShareTripLink";
import type { TabKey } from "./tabs";

/**
 * The commissioner's Setup row: during the round it's where scores, drinks and contests get
 * fixed and the round gets finalized, so it says that instead of "Setup".
 */
export function setupRowCopy(status: TripStatus): { label: string; sub: string } {
  if (status === "live") return { label: "Commissioner desk", sub: "Fix scores, drinks, contests · Finalize" };
  if (status === "final") return { label: "Commissioner desk", sub: "Fix scores · Reopen" };
  return { label: "Setup", sub: "Roster, teams, course, pots, settings" };
}

/** The ☰ menu: extra destinations (Setup, Awards, Settings), the trip link, help and housekeeping. */
export function MenuSheet({
  open,
  onClose,
  code,
  tripName,
  isCommissioner,
  status,
  tab,
  onGo,
  onSettings,
  onSwitchPlayer,
  onHowItWorks,
  onRules,
}: {
  open: boolean;
  onClose: () => void;
  code: string;
  tripName: string;
  isCommissioner: boolean;
  status: TripStatus;
  tab: TabKey;
  onGo: (tab: TabKey) => void;
  onSettings: () => void;
  onSwitchPlayer: () => void;
  /** Replay the "How it works" explainer. */
  onHowItWorks: () => void;
  /** Open the "Rules & lingo" cheat sheet. */
  onRules: () => void;
}) {
  const [sendLink] = useShareTripLink(code, tripName);
  const isFinal = status === "final";
  const setupRow = setupRowCopy(status);
  return (
    <BottomSheet open={open} onClose={onClose} title={tripName}>
      <ul className="flex flex-col gap-2 pb-2">
        {isFinal && (
          <MenuRow
            icon={<IconTrophy size={26} />}
            label="Awards"
            sub="Champions, shame and the photo gallery"
            highlight
            active={tab === "awards"}
            onClick={() => onGo("awards")}
          />
        )}
        {isCommissioner && (
          <MenuRow
            icon={<IconClipboard size={26} />}
            label={setupRow.label}
            sub={setupRow.sub}
            active={tab === "setup"}
            onClick={() => onGo("setup")}
          />
        )}
        <MenuRow
          icon={<IconShare size={26} />}
          label="Send the trip link"
          sub="For the group chat: open it, tap your name, in"
          onClick={() => {
            onClose();
            void sendLink();
          }}
        />
        <MenuRow
          icon={<IconPlayCircle size={26} />}
          label="How it works"
          sub="40-second cartoon: drinks, ghost beers, contests, money"
          onClick={onHowItWorks}
        />
        <MenuRow icon={<IconRulebook size={26} />} label="Rules & lingo" sub="Cheat sheet: drinks, ghost beers, net, pots" onClick={onRules} />
        <MenuRow icon={<IconGear size={26} />} label="Settings" sub="Notifications, commissioner PIN, install" onClick={onSettings} />
        <MenuRow icon={<IconUserSwap size={26} />} label="Not you? Switch player" onClick={onSwitchPlayer} />
        <li>
          <Link
            href="/?home=1"
            className="flex min-h-14 items-center gap-3 rounded-2xl border-2 border-line bg-paper px-4 font-extrabold text-ink active:bg-sand"
          >
            <IconHome size={26} />
            <span className="flex-1">All trips</span>
            <IconChevronRight size={22} />
          </Link>
        </li>
      </ul>
    </BottomSheet>
  );
}

function MenuRow({
  icon,
  label,
  sub,
  onClick,
  active,
  highlight,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  onClick: () => void;
  active?: boolean;
  highlight?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={cx(
          "flex min-h-14 w-full items-center gap-3 rounded-2xl border-2 px-4 py-2 text-left text-ink active:scale-[0.99]",
          highlight ? "border-ink bg-gold shadow-hard-sm" : active ? "border-fairway bg-fairway-soft" : "border-line bg-paper active:bg-sand",
        )}
      >
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-lg leading-tight font-black">{label}</span>
          {sub && <span className="block text-sm font-semibold text-muted">{sub}</span>}
        </span>
        <IconChevronRight size={22} className="shrink-0" />
      </button>
    </li>
  );
}
