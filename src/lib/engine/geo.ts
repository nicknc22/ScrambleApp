export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in meters (haversine, mean Earth radius 6371008.8 m), elevation ignored. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  void a; void b;
  throw new Error("not implemented");
}

export function metersToYards(m: number): number {
  void m;
  throw new Error("not implemented");
}

/** Rounded to the nearest yard. */
export function haversineYards(a: LatLng, b: LatLng): number {
  void a; void b;
  throw new Error("not implemented");
}
