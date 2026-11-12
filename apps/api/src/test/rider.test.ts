import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { createDb } from "../db";
import type { OrderStatusName } from "../db/types";
import { createDispatcher } from "../dispatch/dispatcher";
import { createFakePaystack } from "./fakePaystack";

const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "" });
const db = createDb(config.DATABASE_URL);
const dispatcher = createDispatcher({ db, config });
const app = createApp({ db, config, paystack: createFakePaystack().client, dispatcher });

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "a-long-test-password";
const emails: string[] = [];
const riderIds: string[] = [];
let vendorId: string;
let itemId: string;
let customerId: string;
let customerToken: string;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
type Rider = { id: string; token: string };

let count = 0;
const mkRider = async (): Promise<Rider> => {
  const email = `test-rd-${++count}-${run}@relay.test`;
  emails.push(email);
  const res = await request(app).post("/auth/register").send({ name: `Rider ${count}`, email, password: PASSWORD, role: "RIDER" });
  riderIds.push(res.body.user.id);
  return { id: res.body.user.id, token: res.body.accessToken };
};
const goOnline = (r: Rider, lat = 9.001, lng = 7.4) => request(app).post("/rider/online").set(bearer(r.token)).send({ lat, lng });

const mkOrder = async (status: OrderStatusName = "SEARCHING_RIDER", riderId?: string) => {
  const id = (
    await db
      .insertInto("orders")
      .values({
        customer_id: customerId,
        vendor_id: vendorId,
        rider_id: riderId ?? null,
        status,
        subtotal_kobo: 1000,
        delivery_fee_kobo: 500,
        total_kobo: 1500,
        drop_address: "12 Test Street, Abuja",
        drop_lat: 9.0899,
        drop_lng: 7.4,
        distance_m: 10000,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  await db.insertInto("order_items").values({ order_id: id, item_id: itemId, quantity: 2, unit_price_kobo: 100000 }).execute();
  return id;
};

// Inserts an offer directly (the dispatcher normally does this).
const mkOffer = async (orderId: string, riderId: string, expired = false) => {
  const now = Date.now();
  return (
    await db
      .insertInto("dispatch_offers")
      .values({
        order_id: orderId,
        rider_id: riderId,
        offered_at: new Date(now - (expired ? 60_000 : 0)),
        expires_at: new Date(now + (expired ? -30_000 : 30_000)),
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
};

const accept = (r: Rider, offerId: string) => request(app).post(`/rider/offers/${offerId}/accept`).set(bearer(r.token));
const setStatus = (r: Rider, orderId: string, status: string) =>
  request(app).post(`/rider/orders/${orderId}/status`).set(bearer(r.token)).send({ status });
const orderRow = (id: string) => db.selectFrom("orders").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const offerRow = (id: string) => db.selectFrom("dispatch_offers").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const offersFor = (orderId: string) => db.selectFrom("dispatch_offers").selectAll().where("order_id", "=", orderId).orderBy("offered_at").execute();
const events = (orderId: string) =>
  db.selectFrom("order_events").select(["from_status", "to_status", "actor_id"]).where("order_id", "=", orderId).orderBy("created_at").execute();

beforeAll(async () => {
  vendorId = (
    await db
      .insertInto("vendors")
      .values({ name: `Rider Test Vendor ${run}`, city: "ABUJA", address: "1 Vendor Road, Abuja", lat: 9.0, lng: 7.4 })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  itemId = (
    await db.insertInto("items").values({ vendor_id: vendorId, name: "Rider Test Item", price_kobo: 100000 }).returning("id").executeTakeFirstOrThrow()
  ).id;
  const email = `test-rd-customer-${run}@relay.test`;
  emails.push(email);
  const res = await request(app).post("/auth/register").send({ name: "Customer", email, password: PASSWORD });
  customerId = res.body.user.id;
  customerToken = res.body.accessToken;
});

beforeEach(async () => {
  // Retire leftovers from earlier tests so only this test's riders and orders are in play.
  // These tests own the database: every rider is taken offline, including demo riders left online by a manual run.
  await db.updateTable("riders").set({ is_online: false }).execute();
  const old = await db.selectFrom("orders").select("id").where("customer_id", "=", customerId).execute();
  if (old.length > 0) {
    const ids = old.map((o) => o.id);
    await db.updateTable("dispatch_offers").set({ status: "EXPIRED" }).where("order_id", "in", ids).where("status", "=", "PENDING").execute();
    await db.updateTable("orders").set({ status: "CANCELLED" }).where("id", "in", ids).execute();
  }
});

afterAll(async () => {
  await db.deleteFrom("orders").where("customer_id", "=", customerId).execute();
  await db.deleteFrom("items").where("vendor_id", "=", vendorId).execute();
  await db.deleteFrom("vendors").where("id", "=", vendorId).execute();
  await db.deleteFrom("users").where("email", "in", emails).execute();
  await db.destroy();
});

describe("presence", () => {
  it("goes online with a location, updates it, and goes offline", async () => {
    const r = await mkRider();
    expect((await goOnline(r, 9.01, 7.41)).body).toEqual({ isOnline: true });
    let row = await db.selectFrom("riders").selectAll().where("user_id", "=", r.id).executeTakeFirstOrThrow();
    expect(row.is_online).toBe(true);
    expect(Number(row.current_lat)).toBeCloseTo(9.01);
    expect(Date.now() - row.last_seen_at!.getTime()).toBeLessThan(5000);

    expect((await request(app).post("/rider/location").set(bearer(r.token)).send({ lat: 9.02, lng: 7.42 })).status).toBe(200);
    row = await db.selectFrom("riders").selectAll().where("user_id", "=", r.id).executeTakeFirstOrThrow();
    expect(Number(row.current_lat)).toBeCloseTo(9.02);
    expect(row.is_online).toBe(true);

    expect((await request(app).post("/rider/offline").set(bearer(r.token))).body).toEqual({ isOnline: false });
    row = await db.selectFrom("riders").selectAll().where("user_id", "=", r.id).executeTakeFirstOrThrow();
    expect(row.is_online).toBe(false);
  });

  it("rejects bad coordinates, customers and anonymous callers", async () => {
    const r = await mkRider();
    expect((await request(app).post("/rider/online").set(bearer(r.token)).send({ lat: 123, lng: 7 })).status).toBe(400);
    expect((await request(app).post("/rider/online").set(bearer(r.token)).send({})).status).toBe(400);
    expect((await request(app).post("/rider/online").set(bearer(customerToken)).send({ lat: 9, lng: 7 })).status).toBe(403);
    expect((await request(app).get("/rider/offers/current").set(bearer(customerToken))).status).toBe(403);
    expect((await request(app).post("/rider/online").send({ lat: 9, lng: 7 })).status).toBe(401);
  });
});

describe("the delivery flow", () => {
  it("offer, accept, pick up and deliver, with a full audit trail", async () => {
    const r = await mkRider();
    await goOnline(r);
    const order = await mkOrder();
    await dispatcher.dispatchOrder(order);

    const current = await request(app).get("/rider/offers/current").set(bearer(r.token));
    expect(current.status).toBe(200);
    const offer = current.body.offer;
    expect(offer.order).toMatchObject({
      id: order,
      vendorName: `Rider Test Vendor ${run}`,
      dropAddress: "12 Test Street, Abuja",
      deliveryFeeKobo: 500,
      items: [{ name: "Rider Test Item", quantity: 2 }],
    });
    expect(new Date(offer.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const accepted = await accept(r, offer.offerId);
    expect(accepted.status).toBe(200);
    expect(accepted.body.order.status).toBe("ASSIGNED");
    expect((await orderRow(order)).rider_id).toBe(r.id);
    expect((await offerRow(offer.offerId)).status).toBe("ACCEPTED");
    expect((await request(app).get("/rider/offers/current").set(bearer(r.token))).body.offer).toBeNull();
    expect((await request(app).get("/rider/orders/current").set(bearer(r.token))).body.order.id).toBe(order);

    expect((await setStatus(r, order, "PICKED_UP")).body.order.status).toBe("PICKED_UP");
    expect((await request(app).get("/rider/orders/current").set(bearer(r.token))).body.order.status).toBe("PICKED_UP");
    expect((await setStatus(r, order, "DELIVERED")).body.order.status).toBe("DELIVERED");
    expect((await request(app).get("/rider/orders/current").set(bearer(r.token))).body.order).toBeNull();

    expect(await events(order)).toEqual([
      { from_status: "SEARCHING_RIDER", to_status: "ASSIGNED", actor_id: r.id },
      { from_status: "ASSIGNED", to_status: "PICKED_UP", actor_id: r.id },
      { from_status: "PICKED_UP", to_status: "DELIVERED", actor_id: r.id },
    ]);
  });

  it("declining passes the order straight to the next rider", async () => {
    const r1 = await mkRider();
    const r2 = await mkRider();
    await goOnline(r1, 9.001);
    await goOnline(r2, 9.02);
    const order = await mkOrder();
    await dispatcher.dispatchOrder(order);
    const [first] = await offersFor(order);
    expect(first.rider_id).toBe(r1.id);

    const res = await request(app).post(`/rider/offers/${first.id}/decline`).set(bearer(r1.token));
    expect(res.status).toBe(200);
    const offers = await offersFor(order);
    expect(offers.map((o) => [o.rider_id, o.status])).toEqual([
      [r1.id, "DECLINED"],
      [r2.id, "PENDING"],
    ]);
    expect((await orderRow(order)).dispatch_attempts).toBe(1);
    // Another rider cannot decline someone else's offer.
    expect((await request(app).post(`/rider/offers/${offers[1].id}/decline`).set(bearer(r1.token))).status).toBe(404);
  });
});

describe("accept rules", () => {
  it("returns 404 for another rider's offer or a malformed id", async () => {
    const a = await mkRider();
    const b = await mkRider();
    const offer = await mkOffer(await mkOrder(), a.id);
    expect((await accept(b, offer)).status).toBe(404);
    expect((await accept(a, "not-a-uuid")).status).toBe(404);
    expect((await offerRow(offer)).status).toBe("PENDING");
  });

  it("rejects an expired offer and changes nothing", async () => {
    const r = await mkRider();
    const order = await mkOrder();
    const offer = await mkOffer(order, r.id, true);
    const res = await accept(r, offer);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("OFFER_EXPIRED");
    expect((await orderRow(order)).status).toBe("SEARCHING_RIDER");
    expect((await orderRow(order)).rider_id).toBeNull();
    expect(await events(order)).toHaveLength(0);
  });

  it("rejects accepting the same offer twice", async () => {
    const r = await mkRider();
    const offer = await mkOffer(await mkOrder(), r.id);
    expect((await accept(r, offer)).status).toBe(200);
    const again = await accept(r, offer);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("OFFER_NOT_PENDING");
  });

  it("rejects an offer whose order was cancelled meanwhile, and closes the offer", async () => {
    const r = await mkRider();
    const order = await mkOrder();
    const offer = await mkOffer(order, r.id);
    await db.updateTable("orders").set({ status: "CANCELLED" }).where("id", "=", order).execute();
    const res = await accept(r, offer);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ORDER_NOT_AVAILABLE");
    expect((await offerRow(offer)).status).toBe("EXPIRED"); // the close was kept, not rolled back
    expect((await orderRow(order)).status).toBe("CANCELLED");
  });

  it("refuses a rider who already has an active order", async () => {
    const r = await mkRider();
    await mkOrder("ASSIGNED", r.id);
    const order2 = await mkOrder();
    const offer2 = await mkOffer(order2, r.id);
    const res = await accept(r, offer2);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RIDER_BUSY");
    expect((await orderRow(order2)).status).toBe("SEARCHING_RIDER");
    expect((await orderRow(order2)).rider_id).toBeNull();
    expect((await offerRow(offer2)).status).toBe("PENDING");
    expect(await events(order2)).toHaveLength(0);
  });

  it("closes the winner's other open offers without charging those orders a failed round", async () => {
    const r = await mkRider();
    const a = await mkOrder();
    const b = await mkOrder();
    const offerA = await mkOffer(a, r.id);
    const offerB = await mkOffer(b, r.id);
    expect((await accept(r, offerA)).status).toBe(200);
    expect((await offerRow(offerB)).status).toBe("EXPIRED");
    const orderB = await orderRow(b);
    expect(orderB.status).toBe("SEARCHING_RIDER");
    expect(orderB.dispatch_attempts).toBe(0);
  });
});

describe("simultaneous accepts: exactly one winner", () => {
  const statuses = (rs: { status: number }[]) => rs.map((r) => r.status).sort();

  it("the same rider tapping accept five times at once", async () => {
    const r = await mkRider();
    const order = await mkOrder();
    const offer = await mkOffer(order, r.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => accept(r, offer)));
    expect(statuses(results)).toEqual([200, 409, 409, 409, 409]);
    expect((await orderRow(order)).rider_id).toBe(r.id);
    expect(await events(order)).toHaveLength(1);
  });

  it("two riders holding offers on the same order", async () => {
    for (let i = 0; i < 3; i++) {
      const a = await mkRider();
      const b = await mkRider();
      const order = await mkOrder();
      const offerA = await mkOffer(order, a.id);
      const offerB = await mkOffer(order, b.id);
      const results = await Promise.all([accept(a, offerA), accept(b, offerB)]);
      expect(statuses(results)).toEqual([200, 409]);
      const winner = results[0].status === 200 ? a : b;
      const loser = winner === a ? b : a;
      const loserOffer = winner === a ? offerB : offerA;
      expect((await orderRow(order)).rider_id).toBe(winner.id);
      expect((await orderRow(order)).status).toBe("ASSIGNED");
      expect((await offerRow(loserOffer)).status).toBe("EXPIRED");
      expect(results.find((r) => r.status === 409)!.body.error.code).toBe("OFFER_NOT_PENDING");
      expect(await events(order)).toHaveLength(1);
      expect(loser.id).not.toBe(winner.id);
    }
  });

  it("one rider holding offers on two orders", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await mkRider();
      const a = await mkOrder();
      const b = await mkOrder();
      const offerA = await mkOffer(a, r.id);
      const offerB = await mkOffer(b, r.id);
      const results = await Promise.all([accept(r, offerA), accept(r, offerB)]);
      expect(statuses(results)).toEqual([200, 409]); // never a 500 (deadlock) and never two wins
      const active = await db.selectFrom("orders").select("id").where("rider_id", "=", r.id).where("status", "in", ["ASSIGNED", "PICKED_UP"]).execute();
      expect(active).toHaveLength(1);
      const pending = await db.selectFrom("dispatch_offers").select("id").where("rider_id", "=", r.id).where("status", "=", "PENDING").execute();
      expect(pending).toHaveLength(0);
    }
  });
});

describe("status updates by the assigned rider", () => {
  it("only the assigned rider can update, and only to PICKED_UP or DELIVERED in order", async () => {
    const r = await mkRider();
    const other = await mkRider();
    const order = await mkOrder("ASSIGNED", r.id);

    expect((await setStatus(other, order, "PICKED_UP")).status).toBe(404);
    expect((await request(app).post(`/rider/orders/${order}/status`).set(bearer(customerToken)).send({ status: "PICKED_UP" })).status).toBe(403);
    expect((await request(app).post(`/rider/orders/${order}/status`).send({ status: "PICKED_UP" })).status).toBe(401);
    expect((await setStatus(r, "not-a-uuid", "PICKED_UP")).status).toBe(404);

    // Riders cannot cancel or reassign through this route.
    expect((await setStatus(r, order, "CANCELLED")).status).toBe(400);
    expect((await setStatus(r, order, "SEARCHING_RIDER")).status).toBe(400);
    // Skipping a step is refused by the state machine.
    const skip = await setStatus(r, order, "DELIVERED");
    expect(skip.status).toBe(422);
    expect(skip.body.error.code).toBe("INVALID_TRANSITION");
    expect((await orderRow(order)).status).toBe("ASSIGNED");

    expect((await setStatus(r, order, "PICKED_UP")).status).toBe(200);
    expect((await setStatus(r, order, "PICKED_UP")).status).toBe(422);
    expect((await setStatus(r, order, "DELIVERED")).status).toBe(200);
    expect(await events(order)).toHaveLength(3 - 1); // PICKED_UP and DELIVERED (the order was created ASSIGNED)
  });
});
