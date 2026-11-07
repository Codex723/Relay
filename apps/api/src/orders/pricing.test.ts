import { describe, expect, it } from "vitest";
import { cityForPoint, deliveryFeeKobo, haversineMeters, roundedDistanceM } from "./pricing";

const rates = { baseKobo: 50000, perKmKobo: 15000, minKobo: 80000 };

describe("distance", () => {
  it("one degree of latitude is about 111 km", () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(Math.abs(d - 111195)).toBeLessThan(150);
  });

  it("is zero for the same point and rounds up to the next 100 m", () => {
    const p = { lat: 9.07, lng: 7.47 };
    expect(roundedDistanceM(p, p)).toBe(0);
    // About 11 m away rounds up to 100 m, never down to 0.
    expect(roundedDistanceM(p, { lat: 9.0701, lng: 7.47 })).toBe(100);
  });
});

describe("delivery fee", () => {
  it("applies the minimum fee for short trips", () => {
    expect(deliveryFeeKobo(0, rates)).toBe(80000);
    expect(deliveryFeeKobo(1000, rates)).toBe(80000);
  });

  it("is base plus per-km above the minimum", () => {
    expect(deliveryFeeKobo(3000, rates)).toBe(95000);
    expect(deliveryFeeKobo(10000, rates)).toBe(200000);
  });

  it("always returns whole kobo", () => {
    expect(Number.isInteger(deliveryFeeKobo(3300, rates))).toBe(true);
  });
});

describe("service area", () => {
  it("recognises Abuja and Lagos", () => {
    expect(cityForPoint({ lat: 9.0765, lng: 7.4698 })).toBe("ABUJA");
    expect(cityForPoint({ lat: 6.4474, lng: 3.47 })).toBe("LAGOS");
  });

  it("returns null outside every city", () => {
    expect(cityForPoint({ lat: 0, lng: 0 })).toBeNull();
    expect(cityForPoint({ lat: 7.3775, lng: 3.947 })).toBeNull(); // Ibadan
  });
});
