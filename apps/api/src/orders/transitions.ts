import type { Transaction } from "kysely";
import type { DB, OrderStatusName } from "../db/types";
import { HttpError } from "../http";

// The order state machine. Every status change in the app goes through transitionOrder().
//
//   PENDING_PAYMENT -> PAID -> SEARCHING_RIDER -> ASSIGNED -> PICKED_UP -> DELIVERED
//
// Side exits: PAYMENT_REVIEW (money arrived but the amount was wrong, an admin decides),
// CANCELLED (allowed until the rider has picked the order up), and ASSIGNED -> SEARCHING_RIDER
// (the rider is dropped or an admin reassigns).
export const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatusName, readonly OrderStatusName[]>> = {
  PENDING_PAYMENT: ["PAID", "PAYMENT_REVIEW", "CANCELLED"],
  PAYMENT_REVIEW: ["PAID", "CANCELLED"],
  PAID: ["SEARCHING_RIDER", "CANCELLED"],
  SEARCHING_RIDER: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["PICKED_UP", "SEARCHING_RIDER", "CANCELLED"],
  PICKED_UP: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatusName, to: OrderStatusName): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface TransitionInput {
  orderId: string;
  to: OrderStatusName;
  /** The user making the change, or null when the system does (webhook, dispatcher timer). */
  actorId: string | null;
  /** Required when moving to ASSIGNED. Moving back to SEARCHING_RIDER clears the rider. */
  riderId?: string;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

// Must run inside a transaction. The order row is locked first, so two callers changing the same order
// are handled one after the other, and the second one is checked against the first one's result.
// The status change and its order_events row are written together or not at all.
export async function transitionOrder(
  trx: Transaction<DB>,
  { orderId, to, actorId, riderId }: TransitionInput,
): Promise<{ from: OrderStatusName; to: OrderStatusName }> {
  const order = await trx.selectFrom("orders").select(["id", "status"]).where("id", "=", orderId).forUpdate().executeTakeFirst();
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found.");

  const from = order.status;
  if (!canTransition(from, to)) {
    throw new HttpError(422, "INVALID_TRANSITION", `An order that is ${from} cannot become ${to}.`);
  }

  if (to === "ASSIGNED") {
    if (!riderId) throw new HttpError(422, "RIDER_REQUIRED", "A rider is required to assign an order.");
    const rider = await trx.selectFrom("users").select("role").where("id", "=", riderId).executeTakeFirst();
    if (!rider || rider.role !== "RIDER") throw new HttpError(422, "INVALID_RIDER", "That user is not a rider.");
  }

  try {
    await trx
      .updateTable("orders")
      .set({
        status: to,
        updated_at: new Date(),
        ...(to === "ASSIGNED" ? { rider_id: riderId } : {}),
        // A new search (first time, or the rider dropped) starts with a clean dispatch record.
        ...(to === "SEARCHING_RIDER"
          ? { rider_id: null, dispatch_attempts: 0, dispatch_next_at: null, dispatch_alerted_at: null }
          : {}),
      })
      .where("id", "=", orderId)
      .execute();
  } catch (err) {
    // The partial unique index allows each rider only one ASSIGNED or PICKED_UP order.
    if (isUniqueViolation(err)) throw new HttpError(409, "RIDER_BUSY", "This rider already has an active order.");
    throw err;
  }

  await trx.insertInto("order_events").values({ order_id: orderId, from_status: from, to_status: to, actor_id: actorId }).execute();
  return { from, to };
}
