"use client";
// Height of the shell's sticky header (it grows when the offline strip shows), so Play's own
// sticky banners can sit right under it.
import { useEffect, useState } from "react";

const FALLBACK = 56;

export function useStickyTop(): number {
  const [top, setTop] = useState(FALLBACK);
  useEffect(() => {
    const header = document.querySelector<HTMLElement>('[data-testid="trip-shell"] > header') ?? document.querySelector<HTMLElement>("header");
    if (!header) return;
    const update = () => {
      const h = Math.round(header.getBoundingClientRect().height);
      if (h > 0) setTop(h);
    };
    let ro: ResizeObserver | null = null;
    let raf = 0;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(update); // fires once on observe
      ro.observe(header);
    } else {
      raf = requestAnimationFrame(update);
    }
    window.addEventListener("resize", update);
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
    };
  }, []);
  return top;
}

/** An element's current height (0 while it isn't mounted). Pass it from a callback ref. */
export function useElementHeight(el: HTMLElement | null): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!el) return;
    const update = () => setHeight(Math.round(el.getBoundingClientRect().height));
    if (typeof ResizeObserver === "undefined") {
      const raf = requestAnimationFrame(update);
      return () => cancelAnimationFrame(raf);
    }
    const ro = new ResizeObserver(update); // fires once on observe
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return el ? height : 0;
}
