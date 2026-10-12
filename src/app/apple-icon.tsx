import { renderScrambleMark } from "./icon";

// iOS home-screen icon. Full-bleed (iOS rounds the corners itself and turns transparency black).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return renderScrambleMark(size.width);
}
