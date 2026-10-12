import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/** Standard screen column: centered, max 576px, 16px gutters, 16px top padding. The shell adds tab-bar space below. */
export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-xl space-y-4 px-4 pt-4", className)}>{children}</div>;
}
