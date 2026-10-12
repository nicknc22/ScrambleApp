"use client";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { cx } from "./cx";
import { IconBackspace } from "./icons";

export interface PinPadProps {
  value: string;
  onChange: (next: string) => void;
  /** Called with the PIN when the submit key is pressed (only when length >= minLength). */
  onSubmit?: (pin: string) => void;
  minLength?: number;
  maxLength?: number;
  /** Error line under the dots (also shakes the dots). */
  error?: ReactNode;
  busy?: boolean;
  submitLabel?: string;
  label?: ReactNode;
  className?: string;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** Phone-style digit pad for the commissioner PIN. Works with a hardware keyboard too. */
export function PinPad({
  value,
  onChange,
  onSubmit,
  minLength = 4,
  maxLength = 8,
  error,
  busy = false,
  submitLabel = "Unlock",
  label = "Commissioner PIN",
  className,
}: PinPadProps) {
  const press = (d: string) => {
    if (busy || value.length >= maxLength) return;
    onChange(value + d);
  };
  const back = () => {
    if (!busy) onChange(value.slice(0, -1));
  };
  const canSubmit = value.length >= minLength && !busy;
  const submit = () => {
    if (canSubmit) onSubmit?.(value);
  };
  const slots = Math.min(maxLength, Math.max(minLength, value.length + (value.length < maxLength ? 1 : 0)));

  return (
    <div
      className={cx("flex flex-col items-center gap-4 outline-none", className)}
      tabIndex={0}
      aria-label={typeof label === "string" ? label : "PIN pad"}
      onKeyDown={(e) => {
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          press(e.key);
        } else if (e.key === "Backspace") {
          e.preventDefault();
          back();
        } else if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      }}
    >
      {label && <div className="text-sm font-extrabold uppercase tracking-widest text-muted">{label}</div>}
      <div
        key={error ? `err-${String(value.length)}` : "ok"}
        className={cx("flex h-6 items-center gap-3", error ? "animate-shake" : null)}
        aria-live="polite"
        aria-label={`${value.length} digits entered`}
      >
        {Array.from({ length: slots }, (_, i) => (
          <span
            key={i}
            className={cx(
              "h-5 w-5 rounded-full border-[3px]",
              error ? "border-flag" : "border-ink",
              i < value.length && (error ? "bg-flag" : "bg-ink"),
            )}
          />
        ))}
      </div>
      <div className="grid w-full max-w-xs grid-cols-3 gap-2.5">
        {KEYS.map((k) => (
          <PadKey key={k} onClick={() => press(k)} disabled={busy}>
            {k}
          </PadKey>
        ))}
        <PadKey onClick={back} disabled={busy || value.length === 0} label="Delete digit">
          <IconBackspace size={30} />
        </PadKey>
        <PadKey onClick={() => press("0")} disabled={busy}>
          0
        </PadKey>
        <PadKey onClick={() => onChange("")} disabled={busy || value.length === 0} label="Clear" small>
          CLR
        </PadKey>
      </div>
      {/* Error sits right above the submit button: that's where your eyes are after a wrong PIN. */}
      <div className="min-h-6 text-center text-base font-extrabold text-flag" role={error ? "alert" : undefined}>
        {error}
      </div>
      {onSubmit && (
        <Button variant="primary" size="xl" full className="max-w-xs" disabled={!canSubmit} loading={busy} onClick={submit}>
          {submitLabel}
        </Button>
      )}
    </div>
  );
}

function PadKey({
  children,
  onClick,
  disabled,
  label,
  small,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cx(
        "btn h-16 rounded-2xl! border-ink bg-paper text-ink shadow-hard-sm active:bg-sand",
        small ? "text-base font-black" : "num text-3xl font-black",
      )}
    >
      {children}
    </button>
  );
}
