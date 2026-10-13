"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  BottomSheet,
  IconChevronRight,
  IconClipboard,
  IconGear,
  IconHome,
  IconShare,
  IconTrophy,
  IconUserSwap,
  cx,
} from "@/components/ui";
import { useShareTripLink } from "./ShareTripLink";
import type { TabKey } from "./tabs";

/** The ☰ menu: extra destinations (Setup, Awards, Settings), the trip link and housekeeping. */
export function MenuSheet({
  open,
  onClose,
  code,
  tripName,
  isCommissioner,
  isFinal,
  tab,
  onGo,
  onSettings,
  onSwitchPlayer,
}: {
  open: boolean;
  onClose: () => void;
  code: string;
  tripName: string;
  isCommissioner: boolean;
  isFinal: boolean;
  tab: TabKey;
  onGo: (tab: TabKey) => void;
  onSettings: () => void;
  onSwitchPlayer: () => void;
}) {
  const [sendLink] = useShareTripLink(code, tripName);
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
            label="Setup"
            sub="Roster, teams, course, pots, settings"
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
