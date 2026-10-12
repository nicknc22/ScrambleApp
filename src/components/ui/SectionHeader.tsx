import type { ReactNode } from "react";
import { cx } from "./cx";

/** Heavy uppercase section title with optional subtitle and a right-side action. */
export function SectionHeader({
  title,
  subtitle,
  action,
  as: Tag = "h2",
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={cx("flex items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <Tag className="text-xl font-black uppercase tracking-tight text-ink">{title}</Tag>
        {subtitle && <p className="mt-0.5 text-[15px] font-semibold text-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
