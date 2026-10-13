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
