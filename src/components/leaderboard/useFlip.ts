"use client";
// FLIP animation for reordered rows: children marked data-flip="<key>" slide from their old
// spot to the new one when `orderKey` changes. Skipped under prefers-reduced-motion and when the
// Web Animations API is missing. Purely decorative: never affects layout or data.
import { useLayoutEffect, useRef, type RefObject } from "react";

function reducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function useFlip(container: RefObject<HTMLElement | null>, orderKey: string): void {
  const tops = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>("[data-flip]"));
    const next = new Map<string, number>();
    for (const n of nodes) next.set(n.dataset.flip ?? "", n.offsetTop);
    const prev = tops.current;
    tops.current = next;
    if (!prev || reducedMotion()) return;
    for (const n of nodes) {
      const key = n.dataset.flip ?? "";
      const was = prev.get(key);
      const now = next.get(key);
      if (was === undefined || now === undefined || was === now) continue;
      if (typeof n.animate !== "function") continue;
      try {
        n.animate([{ transform: `translateY(${was - now}px)` }, { transform: "translateY(0)" }], {
          duration: 520,
          easing: "cubic-bezier(0.2, 0.9, 0.3, 1.15)",
        });
      } catch {
        /* decorative only */
      }
    }
  }, [container, orderKey]);
}
