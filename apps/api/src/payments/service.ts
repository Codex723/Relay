import type { PaymentInit } from "@relay/shared";
import type { Config } from "../config";
import type { Database } from "../db";
import type { PaystackClient } from "./paystack";
import { makeReference } from "./reference";

// Starts a Paystack payment for an order. The amount always comes from the stored order total.
// Returns null if Paystack is unreachable; the order then stays PENDING_PAYMENT and can be retried.
export async function startPayment(
  db: Database,
  paystack: PaystackClient,
  config: Config,
  order: { id: string; totalKobo: number; email: string },
): Promise<PaymentInit | null> {
  const reference = makeReference(order.id);
  try {
    const init = await paystack.initialize({
      email: order.email,
      amountKobo: order.totalKobo,
      reference,
      callbackUrl: `${config.WEB_ORIGIN}/orders/${order.id}`,
    });
    await db.updateTable("orders").set({ paystack_reference: reference, updated_at: new Date() }).where("id", "=", order.id).execute();
    return { authorizationUrl: init.authorizationUrl, reference };
  } catch (err) {
    console.error("paystack initialize failed", { orderId: order.id, message: err instanceof Error ? err.message : "unknown" });
    return null;
  }
}
