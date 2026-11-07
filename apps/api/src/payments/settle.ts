import type { Database } from "../db";
import { transitionOrder } from "../orders/transitions";
import { orderIdFromReference } from "./reference";

export interface Charge {
  reference: string;
  amountKobo: number;
  currency: string;
  raw: unknown;
}

// settled: order is now being dispatched. review: money arrived but the amount was wrong.
// duplicate: this reference was already processed. not_pending: the order was no longer waiting for payment.
// ignored: the reference does not belong to any order.
export type SettleOutcome = "settled" | "review" | "duplicate" | "not_pending" | "ignored";

// Called for a successful charge, from the webhook and from the verify endpoint. Safe to call many times
// for the same charge: the order row is locked, so concurrent calls are processed one after another.
export async function settleCharge(db: Database, charge: Charge): Promise<SettleOutcome> {
  const orderId = orderIdFromReference(charge.reference);
  if (!orderId) return "ignored";

  return db.transaction().execute(async (trx) => {
    const order = await trx
      .selectFrom("orders")
      .select(["id", "status", "total_kobo"])
      .where("id", "=", orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!order) return "ignored";

    const seen = await trx.selectFrom("payments").select("id").where("reference", "=", charge.reference).executeTakeFirst();
    if (seen) return "duplicate";

    if (order.status !== "PENDING_PAYMENT") {
      // For example a second payment for an order that is already paid. It needs a manual refund.
      console.warn("payment for an order that is not awaiting payment", { orderId, reference: charge.reference, status: order.status });
      return "not_pending";
    }

    const correct = charge.currency === "NGN" && charge.amountKobo === order.total_kobo;
    await trx
      .insertInto("payments")
      .values({
        order_id: orderId,
        reference: charge.reference,
        amount_kobo: charge.amountKobo,
        status: correct ? "success" : "amount_mismatch",
        raw_webhook: JSON.stringify(charge.raw),
        paid_at: new Date(),
      })
      .execute();

    if (!correct) {
      console.warn("payment amount mismatch, order flagged for review", {
        orderId,
        reference: charge.reference,
        expectedKobo: order.total_kobo,
        paidKobo: charge.amountKobo,
        currency: charge.currency,
      });
      await transitionOrder(trx, { orderId, to: "PAYMENT_REVIEW", actorId: null });
      return "review";
    }

    await transitionOrder(trx, { orderId, to: "PAID", actorId: null });
    await transitionOrder(trx, { orderId, to: "SEARCHING_RIDER", actorId: null });
    return "settled";
  });
}
