// Settle-up: "A pays B $X" cards. When final and the payee has a Venmo handle: a Pay with Venmo
// deep link, an https fallback and copy buttons. Presentational; copying is a callback.
import type { Player, UUID } from "@/lib/types";
import type { Derived, Payment } from "@/lib/engine/types";
import { formatCents } from "@/lib/engine/format";
import { buildVenmoPayLinks, normalizeVenmoHandle, venmoAt } from "@/lib/venmo";
import { Avatar, Badge, IconClipboard, PlayerName, cx, displayName } from "@/components/ui";
import { orderPayments } from "./money";

export type CopyFn = (text: string, what: string) => void;

type People = Pick<Derived, "playerById" | "teamById" | "teamOfPlayer">;

function sortOf(people: People, id: UUID): number | null {
  const t = people.teamById[people.teamOfPlayer[id]];
  return t ? t.sort_order : null;
}

function CopyButton({ text, what, label, onCopy }: { text: string; what: string; label: string; onCopy: CopyFn }) {
  return (
    <button
      type="button"
      onClick={() => onCopy(text, what)}
      className="btn min-w-0 flex-1 border-ink bg-paper px-3 text-[15px] text-ink active:bg-sand"
      aria-label={`Copy ${what}`}
    >
      <IconClipboard size={18} strokeWidth={2.75} className="shrink-0" />
      <span className="num min-w-0 truncate">{label}</span>
    </button>
  );
}

export function PaymentCard({
  payment,
  people,
  meId,
  final,
  note,
  onCopy,
}: {
  payment: Payment;
  people: People;
  meId: UUID | null;
  final: boolean;
  note: string;
  onCopy: CopyFn;
}) {
  const from: Player | undefined = people.playerById[payment.from_player_id];
  const to: Player | undefined = people.playerById[payment.to_player_id];
  const iPay = !!meId && payment.from_player_id === meId;
  const iGet = !!meId && payment.to_player_id === meId;
  const amount = formatCents(payment.amount_cents);
  const rawHandle = to?.venmo_handle?.trim() || null;
  const handle = normalizeVenmoHandle(rawHandle);
  const links = buildVenmoPayLinks({ handle, amountCents: payment.amount_cents, note });
  const plainAmount = (payment.amount_cents / 100).toFixed(2);

  const sentence = (
    <>
      {iPay ? "You" : <PlayerName player={from} />} <span className="font-bold text-muted">{iPay ? "pay" : "pays"}</span>{" "}
      {iGet ? "you" : <PlayerName player={to} />}
    </>
  );

  const noVenmo = (
    <p className="text-[15px] leading-snug font-bold text-ink">
      {rawHandle ? (
        <>
          &ldquo;{rawHandle}&rdquo; isn&apos;t a Venmo username. Ask {displayName(to)} for their Venmo.
        </>
      ) : (
        <>No Venmo on file for {displayName(to)}. Ask for their Venmo.</>
      )}
    </p>
  );

  // The payer's own card: big amount, big Pay button, copy buttons, web fallback.
  if (iPay) {
    return (
      <li data-testid="payment" data-mine="pay" className="rounded-2xl border-2 border-ink bg-hazard-soft p-3 shadow-hard-sm">
        <div className="flex items-start gap-3">
          <div className="flex shrink-0 -space-x-2 pt-1">
            <Avatar player={from} teamSortOrder={sortOf(people, payment.from_player_id)} size="md" showCrown={false} />
            <Avatar player={to} teamSortOrder={sortOf(people, payment.to_player_id)} size="md" showCrown={false} />
          </div>
          <div className="min-w-0 flex-1">
            <Badge tone="flag">You owe</Badge>
            <p className="mt-1 text-xl leading-tight font-black text-ink [overflow-wrap:anywhere]" data-testid="payment-text">
              {sentence}
            </p>
            <p className="num text-[2.6rem] leading-none font-black text-ink">{amount}</p>
          </div>
        </div>
        {final && links && (
          <div className="mt-3 space-y-2">
            <a
              href={links.app}
              data-testid="venmo-pay"
              className="btn btn-lg w-full border-sky-dark bg-sky text-white shadow-hard-sm active:bg-sky-dark"
            >
              <span aria-hidden="true">💸</span>
              <span>Pay {amount} with Venmo</span>
            </a>
            <div className="flex gap-2">
              <CopyButton text={venmoAt(links.handle)} what={`${displayName(to)}'s Venmo`} label={venmoAt(links.handle)} onCopy={onCopy} />
              <CopyButton text={links.amount} what="the amount" label={links.amount} onCopy={onCopy} />
            </div>
            <a
              href={links.web}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="venmo-web"
              className="flex min-h-12 items-center justify-center text-center text-[15px] font-bold text-sky-dark underline underline-offset-4 [overflow-wrap:anywhere]"
            >
              No Venmo app? Open venmo.com/{links.handle}
            </a>
          </div>
        )}
        {final && !links && (
          <div className="mt-3 space-y-2 rounded-xl border-2 border-line bg-paper px-3 py-2">
            {noVenmo}
            <div className="flex gap-2">
              <CopyButton text={plainAmount} what="the amount" label={`Copy ${amount}`} onCopy={onCopy} />
            </div>
          </div>
        )}
      </li>
    );
  }

  // Everyone else's payment: one compact row plus a slim Venmo link.
  return (
    <li
      data-testid="payment"
      data-mine={iGet ? "get" : undefined}
      className={cx("rounded-2xl border-2 p-3", iGet ? "border-fairway bg-fairway-soft" : "border-line bg-paper")}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex shrink-0 -space-x-2">
          <Avatar player={from} teamSortOrder={sortOf(people, payment.from_player_id)} size="sm" showCrown={false} />
          <Avatar player={to} teamSortOrder={sortOf(people, payment.to_player_id)} size="sm" showCrown={false} />
        </div>
        <p className="min-w-0 flex-1 text-[17px] leading-tight font-black text-ink [overflow-wrap:anywhere]" data-testid="payment-text">
          {sentence}
        </p>
        <span className="num shrink-0 text-2xl leading-none font-black text-ink">{amount}</span>
      </div>
      {final && links && (
        <a
          href={links.app}
          data-testid="venmo-pay"
          className="btn mt-2 w-full border-sky bg-sky-soft text-[15px] text-sky-dark active:bg-sky-soft/60"
        >
          <span aria-hidden="true">💸</span>
          <span className="min-w-0 truncate">Venmo {venmoAt(links.handle)}</span>
        </a>
      )}
      {final && !links && <div className="mt-2 rounded-xl bg-sand px-3 py-2">{noVenmo}</div>}
    </li>
  );
}

export function SettleUpList({
  payments,
  people,
  meId,
  final,
  note,
  onCopy,
}: {
  payments: readonly Payment[];
  people: People;
  meId: UUID | null;
  final: boolean;
  note: string;
  onCopy: CopyFn;
}) {
  const ordered = orderPayments(payments, meId);
  return (
    <ul className="space-y-2.5" data-testid="payments">
      {ordered.map((p) => (
        <PaymentCard
          key={`${p.from_player_id}>${p.to_player_id}`}
          payment={p}
          people={people}
          meId={meId}
          final={final}
          note={note}
          onCopy={onCopy}
        />
      ))}
    </ul>
  );
}
