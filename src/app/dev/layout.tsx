// /dev/* (the design-system gallery) is a 404 in deployed builds. Vercel sets VERCEL=1 at build and
// run time; a local `next start` (the e2e suite) keeps the gallery.
import type { ReactNode } from "react";
import { notFound } from "next/navigation";

export default function DevLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === "production" && process.env.VERCEL) notFound();
  return children;
}
