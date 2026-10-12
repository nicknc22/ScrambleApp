// Great-circle distances for long drive measurement. Pure math, no I/O.

export interface LatLng {
  lat: number;
  lng: number;
}

/** IUGG mean Earth radius in meters. */
const EARTH_RADIUS_M = 6371008.8;
const METERS_PER_YARD = 0.9144;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in meters (haversine, mean Earth radius 6371008.8 m), elevation ignored. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dPhi = toRad(b.lat - a.lat);
  const dLambda = toRad(b.lng - a.lng);
  const sinDPhi = Math.sin(dPhi / 2);
  const sinDLambda = Math.sin(dLambda / 2);
  const h = sinDPhi * sinDPhi + Math.cos(phi1) * Math.cos(phi2) * sinDLambda * sinDLambda;
  // Clamp: floating point can push h a hair outside [0, 1] for (near-)antipodal points.
  const c = 2 * Math.atan2(Math.sqrt(Math.min(1, Math.max(0, h))), Math.sqrt(Math.max(0, 1 - h)));
  return EARTH_RADIUS_M * c;
}

export function metersToYards(m: number): number {
  return m / METERS_PER_YARD;
}

/** Rounded to the nearest yard. */
export function haversineYards(a: LatLng, b: LatLng): number {
  return Math.round(metersToYards(haversineMeters(a, b)));
}
