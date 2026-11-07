import { createHmac } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { createDb } from "../db";
import { createDispatcher } from "../dispatch/dispatcher";
import { makeReference, orderIdFromReference } from "../payments/reference";
import { createFakePaystack } from "./fakePaystack";

const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "" });
const db = createDb(config.DATABASE_URL);
const fake = createFakePaystack();
const app = createApp({ db, config, dispatcher: createDispatcher({ db, config }), paystack: fake.client });

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "a-long-test-password";
const emails: string[] = [];
let vendorId: string;
let itemId: string;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const sign = (raw: string, secret = config.PAYSTACK_SECRET_KEY) => createHmac("sha512", secret).update(raw).digest("hex");

const newCustomer = async (label: string) => {
  const email = `test-pay-${label}-${run}@relay.test`;
  emails.push(email);
  const res = await request(app).post("/auth/register").send({ name: `P ${label}`, email, password: PASSWORD });
  return { token: res.body.accessToken as string, id: res.body.user.id as string, email };
};

// 100,000 kobo item + 200,000 kobo delivery fee (10 km) = 300,000 kobo total.
const placeOrder = async (token: string) => {
  const res = await request(app)
    .post("/orders")
    .set(bearer(token))
    .send({
      vendorId,
      items: [{ itemId, quantity: 1 }],
      dropAddress: "12 Test Street, Abuja",
      dropLat: 9.0899,
      dropLng: 7.4,
    });
  return {
    status: res.status,
    orderId: res.body.order.id as string,
    totalKobo: res.body.order.totalKobo as number,
    payment: res.body.payment as { authorizationUrl: string; reference: string } | null,
  };
};

const chargeBody = (reference: string, amount: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({ event: "charge.success", data: { reference, amount, currency: "NGN", status: "success", ...over } });

const sendWebhook = (raw: string, signature = sign(raw)) =>
  request(app).post("/payments/webhook").set("Content-Type", "application/json").set("x-paystack-signature", signature).send(raw);

const orderRow = (id: string) => db.selectFrom("orders").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const paymentCount = async (orderId: string) =>
  (await db.selectFrom("payments").select("id").where("order_id", "=", orderId).execute()).length;
const events = (orderId: string) =>
  db.selectFrom("order_events").select(["from_status", "to_status"]).where("order_id", "=", orderId).orderBy("created_at").execute();

beforeAll(async () => {
  const v = await db
    .insertInto("vendors")
    .values({ name: `Pay Test Vendor ${run}`, city: "ABUJA", address: "Test", lat: 9.0, lng: 7.4, is_open: true })
    .returning("id")
    .executeTakeFirstOrThrow();
  vendorId = v.id;
  itemId = (
    await db.insertInto("items").values({ vendor_id: vendorId, name: "Pay Test Item", price_kobo: 100000 }).returning("id").executeTakeFirstOrThrow()
  ).id;
});

beforeEach(() => {
  fake.state.failInitialize = false;
  fake.state.failVerify = false;
  fake.state.verifyResult = null;
  fake.initializeCalls.length = 0;
});

afterAll(async () => {
  const users = await db.selectFrom("users").select("id").where("email", "in", emails).execute();
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    const orders = await db.selectFrom("orders").select("id").where("customer_id", "in", ids).execute();
    const orderIds = orders.map((o) => o.id);
    if (orderIds.length > 0) await db.deleteFrom("payments").where("order_id", "in", orderIds).execute();
    await db.deleteFrom("orders").where("customer_id", "in", ids).execute();
  }
  await db.deleteFrom("items").where("vendor_id", "=", vendorId).execute();
  await db.deleteFrom("vendors").where("id", "=", vendorId).execute();
  if (emails.length > 0) await db.deleteFrom("users").where("email", "in", emails).execute();
  await db.destroy();
});

describe("references", () => {
  it("round-trips the order id and rejects anything else", () => {
    const id = "0b7f3f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const ref = makeReference(id);
    expect(orderIdFromReference(ref)).toBe(id);
    expect(makeReference(id)).not.toBe(ref);
    expect(orderIdFromReference("garbage")).toBeNull();
    expect(orderIdFromReference(`${ref}x`)).toBeNull();
  });
});

describe("starting a payment", () => {
  it("creates the order and returns a Paystack link built from the stored total", async () => {
    const c = await newCustomer("init");
    const o = await placeOrder(c.token);
    expect(o.status).toBe(201);
    expect(o.totalKobo).toBe(300000);
    expect(o.payment?.authorizationUrl).toContain(o.payment!.reference);

    const call = fake.initializeCalls.at(-1)!;
    expect(call.amountKobo).toBe(300000);
    expect(call.email).toBe(c.email);
    expect(call.reference).toBe(o.payment!.reference);
    expect(call.callbackUrl).toContain(o.orderId);
    expect(orderIdFromReference(call.reference)).toBe(o.orderId);
    expect((await orderRow(o.orderId)).paystack_reference).toBe(o.payment!.reference);
  });

  it("keeps the order and lets the customer retry when Paystack is down", async () => {
    const c = await newCustomer("retry");
    fake.state.failInitialize = true;
    const o = await placeOrder(c.token);
    expect(o.status).toBe(201);
    expect(o.payment).toBeNull();
    expect((await orderRow(o.orderId)).status).toBe("PENDING_PAYMENT");

    const stillDown = await request(app).post(`/orders/${o.orderId}/pay`).set(bearer(c.token));
    expect(stillDown.status).toBe(502);

    fake.state.failInitialize = false;
    const retry = await request(app).post(`/orders/${o.orderId}/pay`).set(bearer(c.token));
    expect(retry.status).toBe(200);
    expect((await orderRow(o.orderId)).paystack_reference).toBe(retry.body.payment.reference);
  });

  it("only the owner can retry, and only while the order awaits payment", async () => {
    const owner = await newCustomer("payowner");
    const other = await newCustomer("payother");
    const o = await placeOrder(owner.token);
    expect((await request(app).post(`/orders/${o.orderId}/pay`).set(bearer(other.token))).status).toBe(404);
    expect((await request(app).post(`/orders/${o.orderId}/pay`)).status).toBe(401);

    await sendWebhook(chargeBody(o.payment!.reference, o.totalKobo));
    const afterPaid = await request(app).post(`/orders/${o.orderId}/pay`).set(bearer(owner.token));
    expect(afterPaid.status).toBe(409);
    expect(afterPaid.body.error.code).toBe("NOT_PAYABLE");
  });
});

describe("webhook signature", () => {
  it("rejects a missing, malformed or forged signature and changes nothing", async () => {
    const c = await newCustomer("sig");
    const o = await placeOrder(c.token);
    const raw = chargeBody(o.payment!.reference, o.totalKobo);

    const missing = await request(app).post("/payments/webhook").set("Content-Type", "application/json").send(raw);
    const malformed = await sendWebhook(raw, "not-a-signature");
    const forged = await sendWebhook(raw, sign(raw, "sk_test_some_other_secret"));
    const tamperedBody = await sendWebhook(chargeBody(o.payment!.reference, 1), sign(raw));
    for (const res of [missing, malformed, forged, tamperedBody]) expect(res.status).toBe(401);

    expect((await orderRow(o.orderId)).status).toBe("PENDING_PAYMENT");
    expect(await paymentCount(o.orderId)).toBe(0);
  });
});

describe("webhook processing", () => {
  it("marks a correct payment PAID then SEARCHING_RIDER and stores the payment", async () => {
    const c = await newCustomer("ok");
    const o = await placeOrder(c.token);
    const res = await sendWebhook(chargeBody(o.payment!.reference, o.totalKobo));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("settled");

    expect((await orderRow(o.orderId)).status).toBe("SEARCHING_RIDER");
    const p = await db.selectFrom("payments").selectAll().where("order_id", "=", o.orderId).executeTakeFirstOrThrow();
    expect(p).toMatchObject({ reference: o.payment!.reference, amount_kobo: 300000, status: "success" });
    expect(p.paid_at).not.toBeNull();
    expect(await events(o.orderId)).toEqual([
      { from_status: null, to_status: "PENDING_PAYMENT" },
      { from_status: "PENDING_PAYMENT", to_status: "PAID" },
      { from_status: "PAID", to_status: "SEARCHING_RIDER" },
    ]);
  });

  it("treats a duplicate delivery as a no-op", async () => {
    const c = await newCustomer("dup");
    const o = await placeOrder(c.token);
    const raw = chargeBody(o.payment!.reference, o.totalKobo);
    expect((await sendWebhook(raw)).body.outcome).toBe("settled");
    const again = await sendWebhook(raw);
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe("duplicate");
    expect(await paymentCount(o.orderId)).toBe(1);
    expect(await events(o.orderId)).toHaveLength(3);
  });

  it("handles five simultaneous deliveries of the same webhook exactly once", async () => {
    const c = await newCustomer("race");
    const o = await placeOrder(c.token);
    const raw = chargeBody(o.payment!.reference, o.totalKobo);
    const results = await Promise.all(Array.from({ length: 5 }, () => sendWebhook(raw)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === "settled")).toHaveLength(1);
    expect(await paymentCount(o.orderId)).toBe(1);
    expect(await events(o.orderId)).toHaveLength(3);
    expect((await orderRow(o.orderId)).status).toBe("SEARCHING_RIDER");
  });

  it("flags a wrong amount for review instead of accepting it", async () => {
    const c = await newCustomer("amount");
    const o = await placeOrder(c.token);
    const res = await sendWebhook(chargeBody(o.payment!.reference, o.totalKobo - 1));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("review");
    expect((await orderRow(o.orderId)).status).toBe("PAYMENT_REVIEW");
    const p = await db.selectFrom("payments").select("status").where("order_id", "=", o.orderId).executeTakeFirstOrThrow();
    expect(p.status).toBe("amount_mismatch");
  });

  it("flags a wrong currency for review", async () => {
    const c = await newCustomer("currency");
    const o = await placeOrder(c.token);
    const res = await sendWebhook(chargeBody(o.payment!.reference, o.totalKobo, { currency: "USD" }));
    expect(res.body.outcome).toBe("review");
    expect((await orderRow(o.orderId)).status).toBe("PAYMENT_REVIEW");
  });

  it("does not store a second payment for an order that is already paid", async () => {
    const c = await newCustomer("second");
    const o = await placeOrder(c.token);
    await sendWebhook(chargeBody(o.payment!.reference, o.totalKobo));
    const secondRef = makeReference(o.orderId);
    const res = await sendWebhook(chargeBody(secondRef, o.totalKobo));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("not_pending");
    expect(await paymentCount(o.orderId)).toBe(1);
    expect((await orderRow(o.orderId)).status).toBe("SEARCHING_RIDER");
  });

  it("acknowledges unknown references and other events without changing anything", async () => {
    const c = await newCustomer("ignore");
    const o = await placeOrder(c.token);

    const unknownRef = await sendWebhook(chargeBody("garbage-reference", 100));
    expect(unknownRef.status).toBe(200);
    expect(unknownRef.body.outcome).toBe("ignored");
    const unknownOrder = await sendWebhook(chargeBody(makeReference("00000000-0000-4000-8000-000000000000"), 100));
    expect(unknownOrder.body.outcome).toBe("ignored");

    const otherEvent = await sendWebhook(JSON.stringify({ event: "transfer.success", data: {} }));
    expect(otherEvent.status).toBe(200);
    const failedCharge = await sendWebhook(JSON.stringify({ event: "charge.failed", data: { reference: o.payment!.reference } }));
    expect(failedCharge.status).toBe(200);

    expect((await orderRow(o.orderId)).status).toBe("PENDING_PAYMENT");
    expect(await paymentCount(o.orderId)).toBe(0);
  });

  it("rejects a correctly signed body that is not JSON or not a charge payload", async () => {
    const garbage = "{not json";
    expect((await sendWebhook(garbage)).status).toBe(400);
    const noData = JSON.stringify({ event: "charge.success" });
    expect((await sendWebhook(noData)).status).toBe(400);
  });
});

describe("verify (late webhook)", () => {
  it("settles the order from Paystack's answer, once, and only for the owner", async () => {
    const owner = await newCustomer("vowner");
    const other = await newCustomer("vother");
    const o = await placeOrder(owner.token);
    const ref = o.payment!.reference;

    fake.state.verifyResult = { status: "success", amountKobo: o.totalKobo, currency: "NGN", reference: ref, raw: { status: "success" } };
    const first = await request(app).get(`/payments/verify/${ref}`).set(bearer(owner.token));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ orderStatus: "SEARCHING_RIDER", paymentStatus: "success" });
    const second = await request(app).get(`/payments/verify/${ref}`).set(bearer(owner.token));
    expect(second.status).toBe(200);
    expect(await paymentCount(o.orderId)).toBe(1);
    expect(await events(o.orderId)).toHaveLength(3);

    expect((await request(app).get(`/payments/verify/${ref}`).set(bearer(other.token))).status).toBe(404);
    expect((await request(app).get(`/payments/verify/${ref}`)).status).toBe(401);
    expect((await request(app).get("/payments/verify/garbage").set(bearer(owner.token))).status).toBe(404);
  });

  it("leaves the order alone when Paystack says it is not paid or is unreachable", async () => {
    const c = await newCustomer("vpending");
    const o = await placeOrder(c.token);
    const ref = o.payment!.reference;

    const notPaid = await request(app).get(`/payments/verify/${ref}`).set(bearer(c.token));
    expect(notPaid.status).toBe(200);
    expect(notPaid.body).toEqual({ orderStatus: "PENDING_PAYMENT", paymentStatus: "abandoned" });

    fake.state.failVerify = true;
    const down = await request(app).get(`/payments/verify/${ref}`).set(bearer(c.token));
    expect(down.status).toBe(502);
    expect((await orderRow(o.orderId)).status).toBe("PENDING_PAYMENT");
  });
});
