import { createHmac, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import type { Config } from "../config";
import type { Database } from "../db";
import { HttpError, asyncHandler } from "../http";
import { makeLimiter } from "../rateLimit";
import type { PaystackClient } from "./paystack";
import { orderIdFromReference } from "./reference";
import { settleCharge } from "./settle";

export function isValidSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!/^[0-9a-f]{128}$/i.test(signature)) return false;
  const expected = createHmac("sha512", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

const EventName = z.object({ event: z.string() });
const ChargeData = z.object({
  data: z.object({
    reference: z.string(),
    amount: z.number().int(),
    currency: z.string(),
  }),
});

// Mount this BEFORE express.json(): the webhook signature is computed over the exact raw bytes.
export function paymentsRouter(
  db: Database,
  config: Config,
  paystack: PaystackClient,
  onOrderPaid?: (orderId: string) => void,
): Router {
  const router = Router();
  const webhookLimiter = makeLimiter(config, 60_000, 300);
  const verifyLimiter = makeLimiter(config, 60_000, 30);

  router.post(
    "/webhook",
    webhookLimiter,
    express.raw({ type: "*/*", limit: "100kb" }),
    asyncHandler(async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const signature = req.header("x-paystack-signature") ?? "";
      if (!isValidSignature(raw, signature, config.PAYSTACK_SECRET_KEY)) {
        throw new HttpError(401, "INVALID_SIGNATURE", "Invalid signature.");
      }
      let json: unknown;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON.");
      }
      const name = EventName.safeParse(json);
      if (!name.success) throw new HttpError(400, "INVALID_PAYLOAD", "Unexpected payload.");
      // Only successful charges matter. Acknowledge everything else so Paystack does not retry it.
      if (name.data.event !== "charge.success") return void res.json({ received: true });

      const charge = ChargeData.safeParse(json);
      if (!charge.success) throw new HttpError(400, "INVALID_PAYLOAD", "Unexpected payload.");
      const outcome = await settleCharge(db, {
        reference: charge.data.data.reference,
        amountKobo: charge.data.data.amount,
        currency: charge.data.data.currency,
        raw: json,
      });
      if (outcome === "settled") {
        const orderId = orderIdFromReference(charge.data.data.reference);
        if (orderId) onOrderPaid?.(orderId);
      }
      res.json({ received: true, outcome });
    }),
  );

  // Lets the customer's app confirm a payment if the webhook is late.
  router.get(
    "/verify/:reference",
    requireAuth(config),
    requireRole("CUSTOMER", "ADMIN"),
    verifyLimiter,
    asyncHandler(async (req, res) => {
      const reference = String(req.params.reference);
      const orderId = orderIdFromReference(reference);
      const order = orderId
        ? await db.selectFrom("orders").select(["id", "customer_id"]).where("id", "=", orderId).executeTakeFirst()
        : undefined;
      const allowed = order && (req.auth!.role === "ADMIN" || order.customer_id === req.auth!.userId);
      if (!order || !allowed) throw new HttpError(404, "PAYMENT_NOT_FOUND", "Payment not found.");

      let result;
      try {
        result = await paystack.verify(reference);
      } catch (err) {
        console.error("paystack verify failed", { reference, message: err instanceof Error ? err.message : "unknown" });
        throw new HttpError(502, "PAYMENT_PROVIDER_ERROR", "Could not confirm the payment right now. Try again shortly.");
      }
      if (result.status === "success") {
        const outcome = await settleCharge(db, {
          reference,
          amountKobo: result.amountKobo,
          currency: result.currency,
          raw: result.raw,
        });
        if (outcome === "settled") onOrderPaid?.(order.id);
      }
      const current = await db.selectFrom("orders").select("status").where("id", "=", order.id).executeTakeFirstOrThrow();
      res.json({ orderStatus: current.status, paymentStatus: result.status });
    }),
  );

  return router;
}
