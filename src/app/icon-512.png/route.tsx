import { renderScrambleMark } from "@/app/icon";

// Manifest icon (purpose any + maskable). Static: rendered once at build time.
export const dynamic = "force-static";

export function GET() {
  return renderScrambleMark(512);
}
