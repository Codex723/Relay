import type { Transaction } from "kysely";
import type { Config } from "../config";
import type { Database } from "../db";
import type { DB } from "../db/types";
import { HttpError } from "../http";
import { haversineMeters } from "../orders/pricing";

export interface OfferNotice {
  offerId: string;
  orderId: string;
  riderId: string;
  expiresAt: Date;
  pickupDistanceM: number;
}

export interface AdminAlert {
  orderId: string;
  attempts: number;
  reason: "no_rider_available" | "offers_declined_or_expired";
}

export type DispatchResult =
  | { action: "offered"; offerId: string; riderId: string; expiresAt: Date }
  | { action: "no_rider"; attempts: number; alerted: boolean }
  | { action: "skipped"; reason: "not_found" | "locked" | "not_searching" | "alerted" | "waiting" | "offer_outstanding" };

export interface DispatcherDeps {
  db: Database;
  config: Config;
  /** Injectable clock so tests can move time forward. */
  now?: () => Date;
  /** Called after an offer is saved (step 10 pushes it to the rider over the socket). */
  onOffer?: (offer: OfferNotice) => void;
  /** Called once when an order has failed too many rounds and needs an admin. */
  onAdminAlert?: (alert: AdminAlert) => void;
}

export interface Dispatcher {
  dispatchOrder(orderId: string): Promise<DispatchResult>;
  declineOffer(offerId: string, riderId: string): Promise<{ orderId: string; alerted: boolean }>;
  expireOffers(): Promise<number>;
  resetDispatch(orderId: string): Promise<void>;
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

type Trx = Transaction<DB>;
type FailedRound = { attempts: number; alerted: boolean };

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { db, config } = deps;
  const clock = deps.now ?? (() => new Date());
  const alertAdmin =
    deps.onAdminAlert ?? ((a: AdminAlert) => console.warn("dispatch alert: order needs an admin", a));
  const notifyOffer = deps.onOffer ?? (() => undefined);
  const MAX_PICKUP_M = config.DISPATCH_MAX_PICKUP_KM * 1000;

  // One round has failed (an offer was declined or expired, or no rider was available).
  // After MAX_ROUNDS the order is flagged for an admin and automatic dispatch stops for it.
  async function failRound(trx: Trx, order: { id: string; dispatch_attempts: number }, now: Date, waitBeforeRetry: boolean): Promise<FailedRound> {
    const attempts = order.dispatch_attempts + 1;
    const alerted = attempts >= config.DISPATCH_MAX_ROUNDS;
    await trx
      .updateTable("orders")
      .set({
        dispatch_attempts: attempts,
        dispatch_next_at: !alerted && waitBeforeRetry ? new Date(now.getTime() + config.DISPATCH_RETRY_SECONDS * 1000) : null,
        dispatch_alerted_at: alerted ? now : null,
        updated_at: now,
      })
      .where("id", "=", order.id)
      .execute();
    return { attempts, alerted };
  }

  // The nearest rider who is online, recently seen, within range, has no active order, has no other open
  // offer, and was not already offered this order. Riders are locked one at a time (skipping any that another
  // dispatcher holds), so two orders never both get the same rider.
  async function pickRider(trx: Trx, orderId: string, vendor: { lat: number; lng: number }, now: Date) {
    const staleCutoff = new Date(now.getTime() - config.DISPATCH_RIDER_STALE_SECONDS * 1000);
    const candidates = await trx
      .selectFrom("riders")
      .select(["user_id", "current_lat", "current_lng"])
      .where("is_online", "=", true)
      .where("current_lat", "is not", null)
      .where("current_lng", "is not", null)
      .where("last_seen_at", ">=", staleCutoff)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("orders")
              .select("orders.id")
              .whereRef("orders.rider_id", "=", "riders.user_id")
              .where("orders.status", "in", ["ASSIGNED", "PICKED_UP"]),
          ),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("dispatch_offers")
              .select("dispatch_offers.id")
              .whereRef("dispatch_offers.rider_id", "=", "riders.user_id")
              .where("dispatch_offers.status", "=", "PENDING"),
          ),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("dispatch_offers")
              .select("dispatch_offers.id")
              .whereRef("dispatch_offers.rider_id", "=", "riders.user_id")
              .where("dispatch_offers.order_id", "=", orderId),
          ),
        ),
      )
      .execute();

    const ranked = candidates
      .map((c) => ({
        riderId: c.user_id,
        distanceM: haversineMeters({ lat: Number(c.current_lat), lng: Number(c.current_lng) }, vendor),
      }))
      .filter((c) => c.distanceM <= MAX_PICKUP_M)
      .sort((a, b) => a.distanceM - b.distanceM || a.riderId.localeCompare(b.riderId));

    for (const candidate of ranked) {
      const locked = await trx
        .selectFrom("riders")
        .select("user_id")
        .where("user_id", "=", candidate.riderId)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!locked) continue; // another dispatcher is offering to this rider right now
      // Re-check under the lock: a committed offer or assignment may have appeared since the query above.
      const taken = await trx
        .selectFrom("dispatch_offers")
        .select("id")
        .where("rider_id", "=", candidate.riderId)
        .where("status", "=", "PENDING")
        .executeTakeFirst();
      if (taken) continue;
      return candidate;
    }
    return null;
  }

  async function dispatchOrder(orderId: string): Promise<DispatchResult> {
    const now = clock();
    let alert: AdminAlert | null = null;
    let offer: OfferNotice | null = null;

    const result = await db.transaction().execute(async (trx): Promise<DispatchResult> => {
      const order = await trx
        .selectFrom("orders")
        .innerJoin("vendors", "vendors.id", "orders.vendor_id")
        .select([
          "orders.id",
          "orders.status",
          "orders.dispatch_attempts",
          "orders.dispatch_next_at",
          "orders.dispatch_alerted_at",
          "vendors.lat as vendor_lat",
          "vendors.lng as vendor_lng",
        ])
        .where("orders.id", "=", orderId)
        .forUpdate("orders")
        .skipLocked()
        .executeTakeFirst();
      if (!order) {
        const exists = await trx.selectFrom("orders").select("id").where("id", "=", orderId).executeTakeFirst();
        return { action: "skipped", reason: exists ? "locked" : "not_found" };
      }
      if (order.status !== "SEARCHING_RIDER") return { action: "skipped", reason: "not_searching" };
      if (order.dispatch_alerted_at) return { action: "skipped", reason: "alerted" };
      if (order.dispatch_next_at && order.dispatch_next_at > now) return { action: "skipped", reason: "waiting" };

      const outstanding = await trx
        .selectFrom("dispatch_offers")
        .select("id")
        .where("order_id", "=", orderId)
        .where("status", "=", "PENDING")
        .executeTakeFirst();
      if (outstanding) return { action: "skipped", reason: "offer_outstanding" };

      const rider = await pickRider(trx, orderId, { lat: Number(order.vendor_lat), lng: Number(order.vendor_lng) }, now);
      if (!rider) {
        const failed = await failRound(trx, order, now, true);
        if (failed.alerted) alert = { orderId, attempts: failed.attempts, reason: "no_rider_available" };
        return { action: "no_rider", attempts: failed.attempts, alerted: failed.alerted };
      }

      const expiresAt = new Date(now.getTime() + config.DISPATCH_OFFER_SECONDS * 1000);
      const created = await trx
        .insertInto("dispatch_offers")
        .values({ order_id: orderId, rider_id: rider.riderId, offered_at: now, expires_at: expiresAt })
        .returning("id")
        .executeTakeFirstOrThrow();
      offer = { offerId: created.id, orderId, riderId: rider.riderId, expiresAt, pickupDistanceM: Math.round(rider.distanceM) };
      return { action: "offered", offerId: created.id, riderId: rider.riderId, expiresAt };
    });

    // Side effects only after the transaction has committed.
    if (offer) notifyOffer(offer);
    if (alert) alertAdmin(alert);
    return result;
  }

  // Closes a pending offer (declined by the rider, or expired) and counts the failed round.
  async function closeOffer(offerId: string, status: "DECLINED" | "EXPIRED", riderId?: string) {
    const now = clock();
    let alert: AdminAlert | null = null;
    const outcome = await db.transaction().execute(async (trx) => {
      const probe = await trx.selectFrom("dispatch_offers").select(["order_id", "rider_id"]).where("id", "=", offerId).executeTakeFirst();
      if (!probe || (riderId && probe.rider_id !== riderId)) throw new HttpError(404, "OFFER_NOT_FOUND", "Offer not found.");

      // Lock the order first, then the offer, the same order every other code path uses.
      const order = await trx
        .selectFrom("orders")
        .select(["id", "status", "dispatch_attempts", "dispatch_alerted_at"])
        .where("id", "=", probe.order_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const offer = await trx.selectFrom("dispatch_offers").select(["id", "status"]).where("id", "=", offerId).forUpdate().executeTakeFirstOrThrow();
      if (offer.status !== "PENDING") throw new HttpError(409, "OFFER_NOT_PENDING", "This offer is no longer open.");

      await trx.updateTable("dispatch_offers").set({ status }).where("id", "=", offerId).execute();
      let alerted = false;
      if (order.status === "SEARCHING_RIDER" && !order.dispatch_alerted_at) {
        const failed = await failRound(trx, order, now, false);
        alerted = failed.alerted;
        if (failed.alerted) alert = { orderId: order.id, attempts: failed.attempts, reason: "offers_declined_or_expired" };
      }
      return { orderId: order.id, alerted };
    });
    if (alert) alertAdmin(alert);
    return outcome;
  }

  async function declineOffer(offerId: string, riderId: string) {
    const outcome = await closeOffer(offerId, "DECLINED", riderId);
    // The next rider is offered straight away rather than waiting for the next tick.
    if (!outcome.alerted) await dispatchOrder(outcome.orderId);
    return outcome;
  }

  async function expireOffers(): Promise<number> {
    const due = await db
      .selectFrom("dispatch_offers")
      .select("id")
      .where("status", "=", "PENDING")
      .where("expires_at", "<=", clock())
      .orderBy("expires_at")
      .limit(50)
      .execute();
    let expired = 0;
    for (const { id } of due) {
      try {
        await closeOffer(id, "EXPIRED");
        expired++;
      } catch (err) {
        // Someone else (a rider accepting or declining) closed it first. That is fine.
        if (!(err instanceof HttpError)) throw err;
      }
    }
    return expired;
  }

  async function resetDispatch(orderId: string): Promise<void> {
    await db
      .updateTable("orders")
      .set({ dispatch_attempts: 0, dispatch_next_at: null, dispatch_alerted_at: null, updated_at: clock() })
      .where("id", "=", orderId)
      .where("status", "=", "SEARCHING_RIDER")
      .execute();
  }

  async function tick(): Promise<void> {
    await expireOffers();
    const now = clock();
    const due = await db
      .selectFrom("orders")
      .select("id")
      .where("status", "=", "SEARCHING_RIDER")
      .where("dispatch_alerted_at", "is", null)
      .where((eb) => eb.or([eb("dispatch_next_at", "is", null), eb("dispatch_next_at", "<=", now)]))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("dispatch_offers")
              .select("dispatch_offers.id")
              .whereRef("dispatch_offers.order_id", "=", "orders.id")
              .where("dispatch_offers.status", "=", "PENDING"),
          ),
        ),
      )
      .orderBy("updated_at")
      .limit(50)
      .execute();
    for (const { id } of due) await dispatchOrder(id);
  }

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  return {
    dispatchOrder,
    declineOffer,
    expireOffers,
    resetDispatch,
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return; // never overlap two ticks
        running = true;
        tick()
          .catch((err) => console.error("dispatcher tick failed", err instanceof Error ? err.message : err))
          .finally(() => {
            running = false;
          });
      }, config.DISPATCH_TICK_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
