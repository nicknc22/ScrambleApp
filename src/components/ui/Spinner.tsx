import { cx } from "./cx";

/** Spinning ring that inherits the text color. Announces `label` to screen readers. */
export function Spinner({ size = 22, className, label = "Loading" }: { size?: number; className?: string; label?: string }) {
  return (
    <span role="status" className={cx("inline-flex items-center justify-center", className)}>
      <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3.5" />
        <path d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
