import type { RiderOrderView } from "@relay/shared";
import type { Database } from "../db";

export async function loadRiderOrderView(db: Database, orderId: string): Promise<RiderOrderView | null> {
  const o = await db
    .selectFrom("orders")
    .innerJoin("vendors", "vendors.id", "orders.vendor_id")
    .select([
      "orders.id",
      "orders.status",
      "orders.drop_address",
      "orders.drop_lat",
      "orders.drop_lng",
      "orders.distance_m",
      "orders.delivery_fee_kobo",
      "vendors.name as vendor_name",
      "vendors.address as vendor_address",
      "vendors.lat as vendor_lat",
      "vendors.lng as vendor_lng",
    ])
    .where("orders.id", "=", orderId)
    .executeTakeFirst();
  if (!o) return null;
  const items = await db
    .selectFrom("order_items")
    .innerJoin("items", "items.id", "order_items.item_id")
    .select(["items.name", "order_items.quantity"])
    .where("order_items.order_id", "=", orderId)
    .orderBy("items.name")
    .execute();
  return {
    id: o.id,
    status: o.status,
    vendorName: o.vendor_name,
    vendorAddress: o.vendor_address,
    vendorLat: Number(o.vendor_lat),
    vendorLng: Number(o.vendor_lng),
    dropAddress: o.drop_address,
    dropLat: Number(o.drop_lat),
    dropLng: Number(o.drop_lng),
    distanceM: o.distance_m,
    deliveryFeeKobo: o.delivery_fee_kobo,
    items,
  };
}
