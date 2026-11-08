import { Router } from "express";
import { LocationInput, RiderOrderStatusInput, type RiderOfferView } from "@relay/shared";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import type { Config } from "../config";
import type { Database } from "../db";
import type { Dispatcher } from "../dispatch/dispatcher";
import { HttpError, asyncHandler } from "../http";
import { transitionOrder } from "../orders/transitions";
import { makeLimiter } from "../rateLimit";
import type { Realtime } from "../realtime/realtime";
import { updateRiderLocation } from "./presence";
import { loadRiderOrderView } from "./view";

const idSchema = z.string().uuid();

export function riderRouter(db: Database, config: Config, dispatcher: Dispatcher, realtime: Realtime): Router {
  const router = Router();
  router.use(requireAuth(config), requireRole("RIDER"));
  const locationLimiter = makeLimiter(config, 60_000, 120);

  const setPresence = (riderId: string, values: { is_online?: boolean; current_lat?: number; current_lng?: number }) =>
    db
      .updateTable("riders")
      .set({ ...values, last_seen_at: new Date() })
      .where("user_id", "=", riderId)
      .executeTakeFirst();

  // Going online needs a location: the dispatcher picks the nearest rider.
  router.post(
    "/online",
    asyncHandler(async (req, res) => {
      const { lat, lng } = LocationInput.parse(req.body);
      await setPresence(req.auth!.userId, { is_online: true, current_lat: lat, current_lng: lng });
      res.json({ isOnline: true });
    }),
  );

  router.post(
    "/offline",
    asyncHandler(async (req, res) => {
      await setPresence(req.auth!.userId, { is_online: false });
      res.json({ isOnline: false });
    }),
  );

  router.post(
    "/location",
    locationLimiter,
    asyncHandler(async (req, res) => {
      const { lat, lng } = LocationInput.parse(req.body);
      await updateRiderLocation(db, realtime, req.auth!.userId, lat, lng);
      res.json({ ok: true });
    }),
  );

  // Polling fallback for when the live connection is down (live push arrives in a later step).
  router.get(
    "/offers/current",
    asyncHandler(async (req, res) => {
      const offer = await db
        .selectFrom("dispatch_offers")
        .select(["id", "order_id", "expires_at"])
        .where("rider_id", "=", req.auth!.userId)
        .where("status", "=", "PENDING")
        .where("expires_at", ">", new Date())
        .orderBy("offered_at", "desc")
        .executeTakeFirst();
      if (!offer) return void res.json({ offer: null });
      const order = await loadRiderOrderView(db, offer.order_id);
      const view: RiderOfferView = { offerId: offer.id, expiresAt: offer.expires_at.toISOString(), order: order! };
      res.json({ offer: view });
    }),
  );

  router.post(
    "/offers/:id/accept",
    asyncHandler(async (req, res) => {
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) throw new HttpError(404, "OFFER_NOT_FOUND", "Offer not found.");
      const { orderId } = await dispatcher.acceptOffer(id.data, req.auth!.userId);
      realtime.orderChanged(orderId);
      res.json({ order: await loadRiderOrderView(db, orderId) });
    }),
  );

  router.post(
    "/offers/:id/decline",
    asyncHandler(async (req, res) => {
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) throw new HttpError(404, "OFFER_NOT_FOUND", "Offer not found.");
      await dispatcher.declineOffer(id.data, req.auth!.userId);
      res.json({ declined: true });
    }),
  );

  router.get(
    "/orders/current",
    asyncHandler(async (req, res) => {
      const active = await db
        .selectFrom("orders")
        .select("id")
        .where("rider_id", "=", req.auth!.userId)
        .where("status", "in", ["ASSIGNED", "PICKED_UP"])
        .executeTakeFirst();
      res.json({ order: active ? await loadRiderOrderView(db, active.id) : null });
    }),
  );

  router.post(
    "/orders/:id/status",
    asyncHandler(async (req, res) => {
      const { status } = RiderOrderStatusInput.parse(req.body);
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
      const riderId = req.auth!.userId;
      await db.transaction().execute(async (trx) => {
        const order = await trx.selectFrom("orders").select(["id", "rider_id"]).where("id", "=", id.data).forUpdate().executeTakeFirst();
        // Someone else's order looks the same as a missing one.
        if (!order || order.rider_id !== riderId) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");
        await transitionOrder(trx, { orderId: order.id, to: status, actorId: riderId });
      });
      realtime.orderChanged(id.data);
      res.json({ order: await loadRiderOrderView(db, id.data) });
    }),
  );

  return router;
}
