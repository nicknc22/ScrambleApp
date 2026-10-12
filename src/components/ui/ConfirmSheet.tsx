"use client";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";

export type ConfirmTone = "primary" | "danger" | "hazard" | "ghostbeer";

export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  /** Big emoji above the body. */
  emoji?: string;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  tone?: ConfirmTone;
}

export interface ConfirmSheetProps extends ConfirmOptions {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Spinner on the confirm button. */
  busy?: boolean;
}

/** Controlled confirm dialog as a bottom sheet: big confirm on top, cancel at the bottom. */
export function ConfirmSheet({
  open,
  title,
  body,
  emoji,
  confirmLabel = "Do it",
  cancelLabel = "Never mind",
  tone = "primary",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmSheetProps) {
  return (
    <BottomSheet
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <div className="flex flex-col gap-2.5">
          <Button variant={tone} size="xl" full loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button variant="secondary" size="lg" full onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
        </div>
      }
    >
      {(emoji || body) && (
        <div className="flex flex-col items-center gap-2 pt-1 pb-2 text-center">
          {emoji && (
            <div className="text-6xl leading-none" aria-hidden="true">
              {emoji}
            </div>
          )}
          {body && <div className="text-lg font-semibold text-ink">{body}</div>}
        </div>
      )}
    </BottomSheet>
  );
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
  seq: number;
}

/** Hosts one ConfirmSheet for the whole app; use with useConfirm(). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<PendingConfirm | null>(null);
  const pending = useRef<PendingConfirm | null>(null);
  const seq = useRef(0);

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        // A new confirm replaces (and cancels) any open one.
        pending.current?.resolve(false);
        const req = { opts, resolve, seq: ++seq.current };
        pending.current = req;
        setCurrent(req);
      }),
    [],
  );

  const settle = useCallback((ok: boolean) => {
    const req = pending.current;
    pending.current = null;
    setCurrent(null);
    req?.resolve(ok);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmSheet
        key={current?.seq ?? 0}
        open={current !== null}
        {...(current?.opts ?? { title: "" })}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </ConfirmContext.Provider>
  );
}

/**
 * `const confirm = useConfirm(); if (await confirm({ title: "Delete?" })) ...`
 * Falls back to window.confirm outside a ConfirmProvider.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return (
    ctx ??
    (async (opts) => {
      if (typeof window === "undefined") return false;
      const text = typeof opts.title === "string" ? opts.title : "Are you sure?";
      return window.confirm(text);
    })
  );
}
