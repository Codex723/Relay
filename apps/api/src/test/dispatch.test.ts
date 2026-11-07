import { createHmac } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { createDb } from "../db";
import type { OrderStatusName } from "../db/types";
import { createDispatcher } from "../dispatch/dispatcher";
import { transitionOrder } from "../orders/transitions";
import { createFakePaystack } from "./fakePaystack";

const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "" });
const db = createDb(config.DATABASE_URL);

const BASE = Date.parse("2026-11-04T12:00:00Z");
let nowMs = BASE;
const advance = (seconds: number) => {
  nowMs += seconds * 1000;
};
const clock = () => new Date(nowMs);

const makeDispatcher = () => {
  const onOffer = vi.fn();
  const onAlert = vi.fn();
  const d = createDispatcher({ db, config, now: clock, onOffer, onAdminAlert: onAlert });
  return { d, onOffer, onAlert };
};

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const userIds: string[] = [];
const emails: string[] = [];
let vendorId: string;
let itemId: string;
let customerId: string;

// Vendor is at (9.0, 7.4). One degree of latitude is about 111 km, so 0.001 is about 111 m.
const mkUser = async (label: string, role: "CUSTOMER" | "RIDER") => {
  const email = `test-dp-${label}-${run}@relay.test`;
  emails.push(email);
  const u = await db
    .insertInto("users")
    .values({ name: label, email, phone: null, password_hash: "not-a-real-hash", role })
    .returning("id")
    .executeTakeFirstOrThrow();
  userIds.push(u.id);
  return u.id;
};

let riderCount = 0;
const mkRider = async (o: { lat?: number | null; lng?: number; online?: boolean; seenSecondsAgo?: number; real?: boolean } = {}) => {
  const id = await mkUser(`rider${++riderCount}`, "RIDER");
  const at = o.real ? new Date() : clock();
  await db
    .insertInto("riders")
    .values({
      user_id: id,
      is_online: o.online ?? true,
      current_lat: o.lat === null ? null : (o.lat ?? 9.001),
      current_lng: o.lat === null ? null : (o.lng ?? 7.4),
      last_seen_at: new Date(at.getTime() - (o.seenSecondsAgo ?? 0) * 1000),
      vehicle_type: "motorbike",
    })
    .execute();
  return id;
};

const mkOrder = async (status: OrderStatusName = "SEARCHING_RIDER", riderId?: string) =>
  (
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
        drop_address: "Test drop",
        drop_lat: 9.0899,
        drop_lng: 7.4,
        distance_m: 100,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;

const orderRow = (id: string) => db.selectFrom("orders").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const offersFor = (orderId: string) =>
  db.selectFrom("dispatch_offers").selectAll().where("order_id", "=", orderId).orderBy("offered_at").execute();

beforeAll(async () => {
  vendorId = (
    await db
      .insertInto("vendors")
      .values({ name: `Dispatch Test Vendor ${run}`, city: "ABUJA", address: "Test", lat: 9.0, lng: 7.4 })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  itemId = (
    await db.insertInto("items").values({ vendor_id: vendorId, name: "Dispatch Test Item", price_kobo: 100000 }).returning("id").executeTakeFirstOrThrow()
  ).id;
  customerId = await mkUser("customer", "CUSTOMER");
});

beforeEach(async () => {
  nowMs = BASE;
  // Retire anything left over from earlier tests so scans (tick) only see this test's data.
  const riders = userIds.length > 0 ? userIds : ["00000000-0000-4000-8000-000000000000"];
  await db.updateTable("riders").set({ is_online: false }).where("user_id", "in", riders).execute();
  const old = await db.selectFrom("orders").select("id").where("customer_id", "=", customerId).execute();
  if (old.length > 0) {
    const ids = old.map((o) => o.id);
    await db.updateTable("dispatch_offers").set({ status: "EXPIRED" }).where("order_id", "in", ids).where("status", "=", "PENDING").execute();
    await db.updateTable("orders").set({ status: "CANCELLED" }).where("id", "in", ids).execute();
  }
});

afterAll(async () => {
  // Orders can belong to the customer made in beforeAll or to one registered inside a test.
  const users = await db.selectFrom("users").select("id").where("email", "in", emails).execute();
  const customerIds = users.map((u) => u.id);
  const orders = await db.selectFrom("orders").select("id").where("customer_id", "in", customerIds).execute();
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length > 0) await db.deleteFrom("payments").where("order_id", "in", orderIds).execute();
  await db.deleteFrom("orders").where("customer_id", "in", customerIds).execute();
  await db.deleteFrom("items").where("vendor_id", "=", vendorId).execute();
  await db.deleteFrom("vendors").where("id", "=", vendorId).execute();
  await db.deleteFrom("users").where("email", "in", emails).execute();
  await db.destroy();
});

describe("choosing a rider", () => {
  it("offers the order to the nearest eligible rider with a 30 second expiry", async () => {
    const { d, onOffer } = makeDispatcher();
    const near = await mkRider({ lat: 9.001 });
    await mkRider({ lat: 9.02 });
    await mkRider({ lat: 9.05 });
    const order = await mkOrder();

    const res = await d.dispatchOrder(order);
    expect(res).toMatchObject({ action: "offered", riderId: near });
    const offers = await offersFor(order);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ rider_id: near, status: "PENDING" });
    expect(offers[0].offered_at.getTime()).toBe(BASE);
    expect(offers[0].expires_at.getTime()).toBe(BASE + 30_000);
    expect(onOffer).toHaveBeenCalledTimes(1);
    const notice = onOffer.mock.calls[0][0];
    expect(notice).toMatchObject({ orderId: order, riderId: near });
    expect(Math.abs(notice.pickupDistanceM - 111)).toBeLessThan(5);
    expect((await orderRow(order)).dispatch_attempts).toBe(0);
  });

  it("skips riders who are offline, stale, without a location, busy, out of range or already holding an offer", async () => {
    const { d } = makeDispatcher();
    const offline = await mkRider({ lat: 9.001, online: false });
    const stale = await mkRider({ lat: 9.002, seenSecondsAgo: 121 });
    const noLocation = await mkRider({ lat: null });
    const busy = await mkRider({ lat: 9.003 });
    await mkOrder("ASSIGNED", busy);
    const tooFar = await mkRider({ lat: 9.2 }); // about 22 km, limit is 15 km
    const holdingOffer = await mkRider({ lat: 9.004 });
    const otherOrder = await mkOrder();
    await db
      .insertInto("dispatch_offers")
      .values({ order_id: otherOrder, rider_id: holdingOffer, offered_at: clock(), expires_at: new Date(nowMs + 30_000) })
      .execute();
    const eligible = await mkRider({ lat: 9.05 });

    const order = await mkOrder();
    const res = await d.dispatchOrder(order);
    expect(res).toMatchObject({ action: "offered", riderId: eligible });
    const offered = (await offersFor(order)).map((o) => o.rider_id);
    for (const r of [offline, stale, noLocation, busy, tooFar, holdingOffer]) expect(offered).not.toContain(r);
  });

  it("ignores orders that are not searching for a rider", async () => {
    const { d } = makeDispatcher();
    await mkRider();
    const paid = await mkOrder("PAID");
    expect(await d.dispatchOrder(paid)).toEqual({ action: "skipped", reason: "not_searching" });
    expect(await offersFor(paid)).toHaveLength(0);
    expect(await d.dispatchOrder("00000000-0000-4000-8000-000000000000")).toEqual({ action: "skipped", reason: "not_found" });
  });
});

describe("failed rounds", () => {
  it("moves to the next rider on expiry and decline, then alerts the admin after three failed rounds and stops", async () => {
    const { d, onAlert } = makeDispatcher();
    const r1 = await mkRider({ lat: 9.001 });
    const r2 = await mkRider({ lat: 9.02 });
    const r3 = await mkRider({ lat: 9.05 });
    const r4 = await mkRider({ lat: 9.08 });
    const order = await mkOrder();

    await d.dispatchOrder(order);
    expect((await offersFor(order)).map((o) => [o.rider_id, o.status])).toEqual([[r1, "PENDING"]]);

    // Round 1 fails: r1 does not answer within 30 seconds.
    advance(31);
    await d.tick();
    let offers = await offersFor(order);
    expect(offers.map((o) => [o.rider_id, o.status])).toEqual([[r1, "EXPIRED"], [r2, "PENDING"]]);
    expect((await orderRow(order)).dispatch_attempts).toBe(1);

    // Round 2 fails: r2 declines, and r3 is offered straight away.
    advance(1);
    const declined = await d.declineOffer(offers[1].id, r2);
    expect(declined.alerted).toBe(false);
    offers = await offersFor(order);
    expect(offers.map((o) => [o.rider_id, o.status])).toEqual([[r1, "EXPIRED"], [r2, "DECLINED"], [r3, "PENDING"]]);
    expect((await orderRow(order)).dispatch_attempts).toBe(2);
    expect(onAlert).not.toHaveBeenCalled();

    // Round 3 fails: r3 does not answer. The admin is alerted and r4 is never offered the order.
    advance(31);
    await d.tick();
    const row = await orderRow(order);
    expect(row.dispatch_attempts).toBe(3);
    expect(row.dispatch_alerted_at).not.toBeNull();
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith({ orderId: order, attempts: 3, reason: "offers_declined_or_expired" });
    offers = await offersFor(order);
    expect(offers.every((o) => o.status !== "PENDING")).toBe(true);
    expect(offers.map((o) => o.rider_id)).not.toContain(r4);

    // Automatic dispatch has stopped for this order.
    advance(60);
    await d.tick();
    expect(await d.dispatchOrder(order)).toEqual({ action: "skipped", reason: "alerted" });
    expect(await offersFor(order)).toHaveLength(3);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it("never offers an order to the same rider twice", async () => {
    const { d } = makeDispatcher();
    const only = await mkRider();
    const order = await mkOrder();
    await d.dispatchOrder(order);
    advance(31);
    await d.tick(); // the offer expires, and the only rider has already been offered this order
    expect((await offersFor(order)).map((o) => o.rider_id)).toEqual([only]);
    const row = await orderRow(order);
    expect(row.dispatch_attempts).toBe(2);
    expect(row.dispatch_next_at).not.toBeNull();
  });

  it("waits between rounds when no rider is available and alerts after the third", async () => {
    const { d, onAlert } = makeDispatcher();
    const order = await mkOrder();

    expect(await d.dispatchOrder(order)).toEqual({ action: "no_rider", attempts: 1, alerted: false });
    expect((await orderRow(order)).dispatch_next_at?.getTime()).toBe(BASE + 20_000);
    expect(await d.dispatchOrder(order)).toEqual({ action: "skipped", reason: "waiting" });
    advance(19);
    expect(await d.dispatchOrder(order)).toEqual({ action: "skipped", reason: "waiting" });

    advance(1);
    expect(await d.dispatchOrder(order)).toEqual({ action: "no_rider", attempts: 2, alerted: false });
    advance(20);
    expect(await d.dispatchOrder(order)).toEqual({ action: "no_rider", attempts: 3, alerted: true });
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith({ orderId: order, attempts: 3, reason: "no_rider_available" });
    expect(await d.dispatchOrder(order)).toEqual({ action: "skipped", reason: "alerted" });
  });

  it("offers the order to a rider who comes online between rounds", async () => {
    const { d } = makeDispatcher();
    const order = await mkOrder();
    await d.dispatchOrder(order); // nobody online: round 1 fails
    const late = await mkRider();
    advance(20);
    const res = await d.dispatchOrder(order);
    expect(res).toMatchObject({ action: "offered", riderId: late });
    expect((await orderRow(order)).dispatch_attempts).toBe(1);
  });

  it("only handles work that is due on each tick", async () => {
    const { d } = makeDispatcher();
    const rider = await mkRider();
    const waiting = await mkOrder();
    await db.updateTable("orders").set({ dispatch_next_at: new Date(nowMs + 60_000) }).where("id", "=", waiting).execute();
    const due = await mkOrder();

    advance(10);
    await d.tick();
    expect(await offersFor(waiting)).toHaveLength(0); // still waiting for its retry time, not touched
    const dueOffers = await offersFor(due);
    expect(dueOffers).toHaveLength(1);
    expect(dueOffers[0]).toMatchObject({ rider_id: rider, status: "PENDING" });

    // An offer that has not reached its expiry is left alone.
    advance(10);
    await d.tick();
    expect((await offersFor(due))[0].status).toBe("PENDING");
    expect((await orderRow(due)).dispatch_attempts).toBe(0);
  });
});

describe("declining an offer", () => {
  it("only the offered rider can decline, and an offer can be closed only once", async () => {
    const { d } = makeDispatcher();
    const rider = await mkRider({ lat: 9.001 });
    const other = await mkRider({ lat: 9.02 });
    const order = await mkOrder();
    await d.dispatchOrder(order);
    const [offer] = await offersFor(order);

    await expect(d.declineOffer(offer.id, other)).rejects.toMatchObject({ status: 404, code: "OFFER_NOT_FOUND" });
    await expect(d.declineOffer("00000000-0000-4000-8000-000000000000", rider)).rejects.toMatchObject({ status: 404 });

    await d.declineOffer(offer.id, rider);
    await expect(d.declineOffer(offer.id, rider)).rejects.toMatchObject({ status: 409, code: "OFFER_NOT_PENDING" });
    expect((await orderRow(order)).dispatch_attempts).toBe(1); // counted once
  });
});

describe("fresh searches", () => {
  it("resetDispatch clears the alert so the order is offered again", async () => {
    const { d } = makeDispatcher();
    const order = await mkOrder();
    for (let i = 0; i < 3; i++) {
      await d.dispatchOrder(order);
      advance(20);
    }
    expect((await orderRow(order)).dispatch_alerted_at).not.toBeNull();

    await d.resetDispatch(order);
    const row = await orderRow(order);
    expect(row).toMatchObject({ dispatch_attempts: 0, dispatch_next_at: null, dispatch_alerted_at: null });
    const rider = await mkRider();
    expect(await d.dispatchOrder(order)).toMatchObject({ action: "offered", riderId: rider });
  });

  it("an assigned order going back to searching starts with a clean dispatch record", async () => {
    const rider = await mkRider({ online: false });
    const order = await mkOrder("ASSIGNED", rider);
    await db.updateTable("orders").set({ dispatch_attempts: 2, dispatch_alerted_at: clock(), dispatch_next_at: clock() }).where("id", "=", order).execute();
    await db.transaction().execute((trx) => transitionOrder(trx, { orderId: order, to: "SEARCHING_RIDER", actorId: null }));
    expect(await orderRow(order)).toMatchObject({ status: "SEARCHING_RIDER", rider_id: null, dispatch_attempts: 0, dispatch_next_at: null, dispatch_alerted_at: null });
  });
});

describe("concurrency", () => {
  it("five simultaneous dispatches of one order create exactly one offer", async () => {
    const { d } = makeDispatcher();
    await mkRider({ lat: 9.001 });
    await mkRider({ lat: 9.02 });
    const order = await mkOrder();
    const results = await Promise.all(Array.from({ length: 5 }, () => d.dispatchOrder(order)));
    expect(results.filter((r) => r.action === "offered")).toHaveLength(1);
    expect(await offersFor(order)).toHaveLength(1);
  });

  it("two orders competing for one rider: only one gets the offer", async () => {
    for (let i = 0; i < 3; i++) {
      const { d } = makeDispatcher();
      await db.updateTable("riders").set({ is_online: false }).where("user_id", "in", userIds).execute();
      const rider = await mkRider();
      const a = await mkOrder();
      const b = await mkOrder();
      const results = await Promise.all([d.dispatchOrder(a), d.dispatchOrder(b)]);
      expect(results.filter((r) => r.action === "offered")).toHaveLength(1);
      expect(results.filter((r) => r.action === "no_rider")).toHaveLength(1);
      const pending = await db.selectFrom("dispatch_offers").select("id").where("rider_id", "=", rider).where("status", "=", "PENDING").execute();
      expect(pending).toHaveLength(1);
    }
  });
});

describe("background loop and payment hook-up", () => {
  const waitFor = async (check: () => Promise<boolean>, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  it("start() dispatches waiting orders in the background and stop() halts it", async () => {
    const fast = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "", DISPATCH_TICK_MS: "20" });
    const d = createDispatcher({ db, config: fast });
    const rider = await mkRider({ real: true });
    const order = await mkOrder();
    d.start();
    d.start(); // a second start must not create a second timer
    const offered = await waitFor(async () => (await offersFor(order)).length > 0);
    d.stop();
    d.stop();
    await new Promise((r) => setTimeout(r, 100)); // let a tick that is already running finish
    expect(offered).toBe(true);
    expect((await offersFor(order))[0].rider_id).toBe(rider);

    const later = await mkOrder();
    await new Promise((r) => setTimeout(r, 150));
    expect(await offersFor(later)).toHaveLength(0); // nothing runs after stop()
  });

  it("a paid order is offered to a rider straight away, without waiting for a tick", async () => {
    const d = createDispatcher({ db, config });
    const fake = createFakePaystack();
    const app = createApp({ db, config, dispatcher: createDispatcher({ db, config }), paystack: fake.client, onOrderPaid: (id) => void d.dispatchOrder(id) });
    const rider = await mkRider({ real: true });

    const email = `test-dp-pay-${run}@relay.test`;
    emails.push(email);
    const reg = await request(app).post("/auth/register").send({ name: "Pay", email, password: "a-long-test-password" });
    const created = await request(app)
      .post("/orders")
      .set({ Authorization: `Bearer ${reg.body.accessToken}` })
      .send({ vendorId, items: [{ itemId, quantity: 1 }], dropAddress: "12 Test Street, Abuja", dropLat: 9.0899, dropLng: 7.4 });
    expect(created.status).toBe(201);
    userIds.push(reg.body.user.id);
    const orderId = created.body.order.id as string;
    const raw = JSON.stringify({
      event: "charge.success",
      data: { reference: created.body.payment.reference, amount: created.body.order.totalKobo, currency: "NGN" },
    });
    const sig = createHmac("sha512", config.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
    const hook = await request(app).post("/payments/webhook").set("Content-Type", "application/json").set("x-paystack-signature", sig).send(raw);
    expect(hook.body.outcome).toBe("settled");

    const offered = await waitFor(async () => (await offersFor(orderId)).length > 0);
    expect(offered).toBe(true);
    expect((await offersFor(orderId))[0]).toMatchObject({ rider_id: rider, status: "PENDING" });
    expect((await orderRow(orderId)).status).toBe("SEARCHING_RIDER");
  });
});
