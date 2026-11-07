import { Router } from "express";
import { CreateOrderInput, type OrderView } from "@relay/shared";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import type { Config } from "../config";
import type { Database } from "../db";
import { HttpError, asyncHandler } from "../http";
import { startPayment } from "../payments/service";
import type { PaystackClient } from "../payments/paystack";
import { makeLimiter } from "../rateLimit";
import { priceCart } from "./service";

const idSchema = z.string().uuid();

async function loadOrderView(db: Database, orderId: string): Promise<OrderView | null> {
  const order = await db.selectFrom("orders").selectAll().where("id", "=", orderId).executeTakeFirst();
  if (!order) return null;
  const lines = await db
    .selectFrom("order_items")
    .innerJoin("items", "items.id", "order_items.item_id")
    .select(["order_items.item_id", "items.name", "order_items.quantity", "order_items.unit_price_kobo"])
    .where("order_items.order_id", "=", order.id)
    .orderBy("items.name")
    .execute();
  return {
    id: order.id,
    vendorId: order.vendor_id,
    status: order.status,
    lines: lines.map((l) => ({
      itemId: l.item_id,
      name: l.name,
      quantity: l.quantity,
      unitPriceKobo: l.unit_price_kobo,
    })),
    subtotalKobo: order.subtotal_kobo,
    deliveryFeeKobo: order.delivery_fee_kobo,
    totalKobo: order.total_kobo,
    distanceM: order.distance_m,
    dropAddress: order.drop_address,
    createdAt: order.created_at.toISOString(),
  };
}

export function ordersRouter(db: Database, config: Config, paystack: PaystackClient): Router {
  const router = Router();
  router.use(requireAuth(config));
  const createLimiter = makeLimiter(config, 60_000, 20);

  // Price a cart without creating anything, so checkout can show the fee and total.
  router.post(
    "/quote",
    requireRole("CUSTOMER"),
    asyncHandler(async (req, res) => {
      const input = CreateOrderInput.parse(req.body);
      res.json({ quote: await priceCart(db, input, config) });
    }),
  );

  // Creates the order as PENDING_PAYMENT and starts a Paystack payment for it. If Paystack is unreachable the
  // order is still created with `payment: null`; the customer retries with POST /orders/:id/pay.
  router.post(
    "/",
    requireRole("CUSTOMER"),
    createLimiter,
    asyncHandler(async (req, res) => {
      const input = CreateOrderInput.parse(req.body);
      const customerId = req.auth!.userId;
      const orderId = await db.transaction().execute(async (trx) => {
        const quote = await priceCart(trx, input, config);
        const order = await trx
          .insertInto("orders")
          .values({
            customer_id: customerId,
            vendor_id: quote.vendorId,
            subtotal_kobo: quote.subtotalKobo,
            delivery_fee_kobo: quote.deliveryFeeKobo,
            total_kobo: quote.totalKobo,
            drop_address: input.dropAddress,
            drop_lat: input.dropLat,
            drop_lng: input.dropLng,
            distance_m: quote.distanceM,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("order_items")
          .values(
            quote.lines.map((l) => ({
              order_id: order.id,
              item_id: l.itemId,
              quantity: l.quantity,
              unit_price_kobo: l.unitPriceKobo,
            })),
          )
          .execute();
        await trx
          .insertInto("order_events")
          .values({ order_id: order.id, from_status: null, to_status: "PENDING_PAYMENT", actor_id: customerId })
          .execute();
        return order.id;
      });
      const order = (await loadOrderView(db, orderId))!;
      const customer = await db.selectFrom("users").select("email").where("id", "=", customerId).executeTakeFirstOrThrow();
      const payment = await startPayment(db, paystack, config, { id: order.id, totalKobo: order.totalKobo, email: customer.email });
      res.status(201).json({ order, payment });
    }),
  );

  // Start (or restart) payment for an order that is still waiting for it.
  router.post(
    "/:id/pay",
    requireRole("CUSTOMER"),
    createLimiter,
    asyncHandler(async (req, res) => {
      const id = idSchema.safeParse(req.params.id);
      const order = id.success
        ? await db
            .selectFrom("orders")
            .innerJoin("users", "users.id", "orders.customer_id")
            .select(["orders.id", "orders.customer_id", "orders.status", "orders.total_kobo", "users.email"])
            .where("orders.id", "=", id.data)
            .executeTakeFirst()
        : undefined;
      if (!order || order.customer_id !== req.auth!.userId) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
      if (order.status !== "PENDING_PAYMENT") throw new HttpError(409, "NOT_PAYABLE", "This order is not waiting for payment.");
      const payment = await startPayment(db, paystack, config, { id: order.id, totalKobo: order.total_kobo, email: order.email });
      if (!payment) throw new HttpError(502, "PAYMENT_PROVIDER_ERROR", "Could not start the payment. Try again shortly.");
      res.json({ payment });
    }),
  );

  router.get(
    "/mine",
    requireRole("CUSTOMER"),
    asyncHandler(async (req, res) => {
      const rows = await db
        .selectFrom("orders")
        .select("id")
        .where("customer_id", "=", req.auth!.userId)
        .orderBy("created_at", "desc")
        .limit(50)
        .execute();
      const orders = (await Promise.all(rows.map((r) => loadOrderView(db, r.id)))).filter((o) => o !== null);
      res.json({ orders });
    }),
  );

  router.get(
    "/:id",
    requireRole("CUSTOMER", "ADMIN"),
    asyncHandler(async (req, res) => {
      const id = idSchema.safeParse(req.params.id);
      const owner = id.success
        ? await db.selectFrom("orders").select("customer_id").where("id", "=", id.data).executeTakeFirst()
        : undefined;
      // Someone else's order looks the same as a missing one, so ids cannot be probed.
      const allowed = owner && (req.auth!.role === "ADMIN" || owner.customer_id === req.auth!.userId);
      if (!id.success || !allowed) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
      res.json({ order: await loadOrderView(db, id.data) });
    }),
  );

  return router;
}
