import type { ReactNode } from "react";
import { cx } from "./cx";

/** Friendly "nothing here yet" block with a big emoji, a joke and an optional action. */
export function EmptyState({
  emoji = "🦗",
  title,
  children,
  action,
  className,
}: {
  emoji?: string;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center px-4 py-10 text-center", className)}>
      <div className="mb-3 text-6xl leading-none" aria-hidden="true">
        {emoji}
      </div>
      <h3 className="text-2xl font-black text-ink">{title}</h3>
      {children && <div className="mt-2 max-w-sm text-base font-semibold text-muted">{children}</div>}
      {action && <div className="mt-5 w-full max-w-xs">{action}</div>}
    </div>
  );
}
