import type { CreateOrderInput, QuoteView } from "@relay/shared";
import type { Config } from "../config";
import type { Database } from "../db";
import { HttpError } from "../http";
import { cityForPoint, deliveryFeeKobo, roundedDistanceM } from "./pricing";

const MAX_QTY_PER_ITEM = 20;

// Prices, fee and totals are always computed here from database values; the client only says what and where.
export async function priceCart(db: Database, input: CreateOrderInput, config: Config): Promise<QuoteView> {
  const vendor = await db
    .selectFrom("vendors")
    .select(["id", "city", "lat", "lng", "is_open"])
    .where("id", "=", input.vendorId)
    .executeTakeFirst();
  if (!vendor) throw new HttpError(404, "VENDOR_NOT_FOUND", "Vendor not found.");
  if (!vendor.is_open) throw new HttpError(409, "VENDOR_CLOSED", "This vendor is closed right now.");

  // Merge repeated items into one line.
  const quantities = new Map<string, number>();
  for (const line of input.items) quantities.set(line.itemId, (quantities.get(line.itemId) ?? 0) + line.quantity);
  for (const qty of quantities.values()) {
    if (qty > MAX_QTY_PER_ITEM) {
      throw new HttpError(400, "QUANTITY_TOO_HIGH", `You can order at most ${MAX_QTY_PER_ITEM} of one item.`);
    }
  }

  const rows = await db
    .selectFrom("items")
    .select(["id", "name", "price_kobo", "is_available"])
    .where("vendor_id", "=", vendor.id)
    .where("id", "in", [...quantities.keys()])
    .execute();
  if (rows.length !== quantities.size) {
    throw new HttpError(422, "INVALID_ITEMS", "Some items do not belong to this vendor.");
  }
  const unavailable = rows.filter((r) => !r.is_available);
  if (unavailable.length > 0) {
    throw new HttpError(409, "ITEM_UNAVAILABLE", `Not available right now: ${unavailable.map((r) => r.name).join(", ")}.`);
  }

  const drop = { lat: input.dropLat, lng: input.dropLng };
  const dropCity = cityForPoint(drop);
  if (!dropCity) throw new HttpError(422, "OUTSIDE_SERVICE_AREA", "We do not deliver to this location yet.");
  if (dropCity !== vendor.city) {
    throw new HttpError(422, "CITY_MISMATCH", "The delivery address must be in the same city as the vendor.");
  }

  const lines = rows.map((r) => ({
    itemId: r.id,
    name: r.name,
    quantity: quantities.get(r.id)!,
    unitPriceKobo: r.price_kobo,
  }));
  const subtotalKobo = lines.reduce((sum, l) => sum + l.unitPriceKobo * l.quantity, 0);
  const distanceM = roundedDistanceM({ lat: Number(vendor.lat), lng: Number(vendor.lng) }, drop);
  const fee = deliveryFeeKobo(distanceM, {
    baseKobo: config.DELIVERY_BASE_FEE_KOBO,
    perKmKobo: config.DELIVERY_PER_KM_KOBO,
    minKobo: config.DELIVERY_MIN_FEE_KOBO,
  });

  return {
    vendorId: vendor.id,
    lines,
    subtotalKobo,
    deliveryFeeKobo: fee,
    totalKobo: subtotalKobo + fee,
    distanceM,
  };
}
