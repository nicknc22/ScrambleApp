// Small spherical helpers for the dev GPS simulator ("hole N tee + X yards").
export interface LatLngPoint {
  lat: number;
  lng: number;
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Initial bearing from a to b in degrees (0 = north, clockwise). */
export function bearingDeg(a: LatLngPoint, b: LatLngPoint): number {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const Δλ = rad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Point `meters` from `from` along `bearing` degrees. */
export function destinationPoint(from: LatLngPoint, bearing: number, meters: number): LatLngPoint {
  const δ = meters / R;
  const θ = rad(bearing);
  const φ1 = rad(from.lat);
  const λ1 = rad(from.lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lng: ((deg(λ2) + 540) % 360) - 180 };
}

export const YARD_M = 0.9144;

/** The point `yards` from the tee toward the green (due north when no green is set). */
export function pointFromTee(tee: LatLngPoint, green: LatLngPoint | null, yards: number): LatLngPoint {
  const b = green ? bearingDeg(tee, green) : 0;
  return destinationPoint(tee, b, yards * YARD_M);
}
