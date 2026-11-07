import type { City } from "@relay/shared";

export interface Point {
  lat: number;
  lng: number;
}

// City centres and the radius we treat as "inside the city" for service-area checks.
export const CITY_CENTRES: Record<City, Point> = {
  ABUJA: { lat: 9.0579, lng: 7.4951 },
  LAGOS: { lat: 6.5244, lng: 3.3792 },
};
export const SERVICE_RADIUS_M = 60_000;

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMeters(a: Point, b: Point): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Straight-line distance, rounded up to the next 0.1 km (100 m).
export function roundedDistanceM(a: Point, b: Point): number {
  return Math.ceil(haversineMeters(a, b) / 100) * 100;
}

// The nearest city whose centre is within the service radius, or null if the point is outside every city.
export function cityForPoint(p: Point): City | null {
  let best: { city: City; d: number } | null = null;
  for (const city of Object.keys(CITY_CENTRES) as City[]) {
    const d = haversineMeters(p, CITY_CENTRES[city]);
    if (d <= SERVICE_RADIUS_M && (!best || d < best.d)) best = { city, d };
  }
  return best?.city ?? null;
}

export interface FeeRates {
  baseKobo: number;
  perKmKobo: number;
  minKobo: number;
}

// All integer kobo. Only the per-km part is rounded.
export function deliveryFeeKobo(distanceM: number, rates: FeeRates): number {
  return Math.max(rates.minKobo, rates.baseKobo + Math.round((rates.perKmKobo * distanceM) / 1000));
}
