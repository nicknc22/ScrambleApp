"use client";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "hazard" | "ghostbeer" | "ink";
export type ButtonSize = "md" | "lg" | "xl";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-fairway text-white border-fairway-dark shadow-hard-sm active:bg-fairway-dark",
  secondary: "bg-paper text-ink border-ink active:bg-sand",
  danger: "bg-flag text-white border-flag-dark shadow-hard-sm active:bg-flag-dark",
  ghost: "bg-transparent text-ink border-transparent underline-offset-4 active:bg-sand",
  hazard: "bg-hazard text-ink border-ink shadow-hard-sm active:bg-hazard-dark",
  ghostbeer: "bg-ghost text-white border-ghost-dark shadow-hard-sm active:bg-ghost-dark",
  ink: "bg-ink text-white border-ink active:bg-muted",
};

const SIZE: Record<ButtonSize, string> = {
  md: "text-base",
  lg: "btn-lg",
  xl: "btn-xl",
};

/** Class string for anything that should look like a Button (links, labels). */
export function buttonClasses(opts: { variant?: ButtonVariant; size?: ButtonSize; full?: boolean; className?: string } = {}) {
  const { variant = "primary", size = "md", full = false, className } = opts;
  return cx("btn", SIZE[size], VARIANT[variant], full && "w-full", className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width. */
  full?: boolean;
  /** Shows a spinner, disables the button, keeps its width. */
  loading?: boolean;
  /** Icon or emoji before the label. */
  leading?: ReactNode;
  /** Icon or emoji after the label. */
  trailing?: ReactNode;
}

/** The big, thumb-friendly button. md 48px, lg 56px, xl 64px tall. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", full, loading = false, leading, trailing, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, full, className })}
      {...rest}
    >
      {loading ? <Spinner size={size === "xl" ? 26 : 20} label="Working" /> : leading}
      {children !== undefined && children !== null && <span className="min-w-0">{children}</span>}
      {!loading && trailing}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: what the button does, for screen readers. */
  label: string;
  variant?: ButtonVariant;
  /** 48 (default) or 56 / 64 px square. */
  size?: 48 | 56 | 64;
  round?: boolean;
  children: ReactNode;
}

/** Square (or round) icon-only button with a required accessible label. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = "ghost", size = 48, round = false, className, children, type = "button", ...rest },
  ref,
) {
  const dim = size === 64 ? "h-16 w-16" : size === 56 ? "h-14 w-14" : "h-12 w-12";
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx("btn shrink-0 p-0!", dim, VARIANT[variant], round ? "rounded-full!" : "", className)}
      {...rest}
    >
      {children}
    </button>
  );
});
