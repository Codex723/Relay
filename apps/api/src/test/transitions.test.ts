import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { createDb } from "../db";
import { createDispatcher } from "../dispatch/dispatcher";
import type { OrderStatusName } from "../db/types";
import { ALLOWED_TRANSITIONS, canTransition, transitionOrder } from "../orders/transitions";
import { createFakePaystack } from "./fakePaystack";

const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "" });
const db = createDb(config.DATABASE_URL);

// Test-only route so the state machine can be exercised over HTTP (real routes arrive in later steps).
const app = createApp({ db, config, dispatcher: createDispatcher({ db, config }), paystack: createFakePaystack().client }, (a) => {
  a.post("/test/orders/:id/transition", async (req, res, next) => {
    try {
      const { to, riderId, actorId } = req.body as { to: OrderStatusName; riderId?: string; actorId?: string };
      const result = await db
        .transaction()
        .execute((trx) => transitionOrder(trx, { orderId: String(req.params.id), to, riderId, actorId: actorId ?? null }));
      res.json(result);
    } catch (err) {
      next(err);
    }
  });
});

const ALL: OrderStatusName[] = ["PENDING_PAYMENT", "PAYMENT_REVIEW", "PAID", "SEARCHING_RIDER", "ASSIGNED", "PICKED_UP", "DELIVERED", "CANCELLED"];

const EXPECTED: Record<OrderStatusName, OrderStatusName[]> = {
  PENDING_PAYMENT: ["PAID", "PAYMENT_REVIEW", "CANCELLED"],
  PAYMENT_REVIEW: ["PAID", "CANCELLED"],
  PAID: ["SEARCHING_RIDER", "CANCELLED"],
  SEARCHING_RIDER: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["PICKED_UP", "SEARCHING_RIDER", "CANCELLED"],
  PICKED_UP: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

describe("transition table", () => {
  it("allows exactly the documented transitions, for every one of the 64 pairs", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(EXPECTED[from].includes(to));
      }
    }
  });

  it("covers every status, has no self-transitions, and DELIVERED and CANCELLED are final", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ALL].sort());
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
    expect(ALLOWED_TRANSITIONS.DELIVERED).toHaveLength(0);
    expect(ALLOWED_TRANSITIONS.CANCELLED).toHaveLength(0);
  });
});

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const userIds: string[] = [];
let vendorId: string;
let customerId: string;
let riderA: string;
let riderB: string;
let riderC: string;

const mkUser = async (label: string, role: "CUSTOMER" | "RIDER") => {
  const u = await db
    .insertInto("users")
    .values({ name: label, email: `test-tr-${label}-${run}@relay.test`, phone: null, password_hash: "not-a-real-hash", role })
    .returning("id")
    .executeTakeFirstOrThrow();
  userIds.push(u.id);
  return u.id;
};
const mkOrder = async (status: OrderStatusName, riderId?: string) =>
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
const go = (orderId: string, to: OrderStatusName, extra: { riderId?: string; actorId?: string } = {}) =>
  request(app).post(`/test/orders/${orderId}/transition`).send({ to, ...extra });
const row = (id: string) => db.selectFrom("orders").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const events = (id: string) =>
  db.selectFrom("order_events").select(["from_status", "to_status", "actor_id"]).where("order_id", "=", id).orderBy("created_at").execute();

beforeAll(async () => {
  vendorId = (
    await db
      .insertInto("vendors")
      .values({ name: `Transition Test Vendor ${run}`, city: "ABUJA", address: "Test", lat: 9.0, lng: 7.4 })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  customerId = await mkUser("customer", "CUSTOMER");
  riderA = await mkUser("riderA", "RIDER");
  riderB = await mkUser("riderB", "RIDER");
  riderC = await mkUser("riderC", "RIDER");
});

afterAll(async () => {
  await db.deleteFrom("orders").where("customer_id", "=", customerId).execute();
  await db.deleteFrom("vendors").where("id", "=", vendorId).execute();
  await db.deleteFrom("users").where("id", "in", userIds).execute();
  await db.destroy();
});

describe("transitionOrder", () => {
  it("walks the full lifecycle, logging every step in order with the actor", async () => {
    const id = await mkOrder("PENDING_PAYMENT");
    expect((await go(id, "PAID")).status).toBe(200);
    expect((await go(id, "SEARCHING_RIDER")).status).toBe(200);
    const before = (await row(id)).updated_at;
    expect((await go(id, "ASSIGNED", { riderId: riderA, actorId: riderA })).body).toEqual({ from: "SEARCHING_RIDER", to: "ASSIGNED" });
    expect((await go(id, "PICKED_UP", { actorId: riderA })).status).toBe(200);
    expect((await go(id, "DELIVERED", { actorId: riderA })).status).toBe(200);

    const final = await row(id);
    expect(final.status).toBe("DELIVERED");
    expect(final.rider_id).toBe(riderA);
    expect(final.updated_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(await events(id)).toEqual([
      { from_status: "PENDING_PAYMENT", to_status: "PAID", actor_id: null },
      { from_status: "PAID", to_status: "SEARCHING_RIDER", actor_id: null },
      { from_status: "SEARCHING_RIDER", to_status: "ASSIGNED", actor_id: riderA },
      { from_status: "ASSIGNED", to_status: "PICKED_UP", actor_id: riderA },
      { from_status: "PICKED_UP", to_status: "DELIVERED", actor_id: riderA },
    ]);
  });

  it("rejects invalid transitions with 422 and changes and logs nothing", async () => {
    const cases: [OrderStatusName, OrderStatusName][] = [
      ["PENDING_PAYMENT", "SEARCHING_RIDER"], // skipping steps
      ["PAID", "DELIVERED"],
      ["DELIVERED", "PICKED_UP"], // going backwards
      ["PICKED_UP", "CANCELLED"], // too late to cancel
      ["CANCELLED", "PAID"], // final state
      ["DELIVERED", "DELIVERED"], // same state
    ];
    for (const [from, to] of cases) {
      const id = await mkOrder(from);
      const res = await go(id, to);
      expect(res.status, `${from} -> ${to}`).toBe(422);
      expect(res.body.error.code).toBe("INVALID_TRANSITION");
      expect((await row(id)).status).toBe(from);
      expect(await events(id)).toHaveLength(0);
    }
  });

  it("returns 404 for an unknown order", async () => {
    expect((await go("00000000-0000-4000-8000-000000000000", "PAID")).status).toBe(404);
  });

  it("requires a real rider to assign an order, and leaves the order untouched otherwise", async () => {
    const id = await mkOrder("SEARCHING_RIDER");
    const none = await go(id, "ASSIGNED");
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe("RIDER_REQUIRED");
    const notRider = await go(id, "ASSIGNED", { riderId: customerId });
    expect(notRider.status).toBe(422);
    expect(notRider.body.error.code).toBe("INVALID_RIDER");
    expect((await row(id)).status).toBe("SEARCHING_RIDER");
    expect((await row(id)).rider_id).toBeNull();
    expect(await events(id)).toHaveLength(0);
  });

  it("refuses to give a rider a second active order (409) and rolls the change back", async () => {
    const first = await mkOrder("SEARCHING_RIDER");
    const second = await mkOrder("SEARCHING_RIDER");
    expect((await go(first, "ASSIGNED", { riderId: riderB })).status).toBe(200);
    const busy = await go(second, "ASSIGNED", { riderId: riderB });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("RIDER_BUSY");
    expect((await row(second)).status).toBe("SEARCHING_RIDER");
    expect(await events(second)).toHaveLength(0);

    // Once the first order is delivered the rider is free again.
    await go(first, "PICKED_UP");
    await go(first, "DELIVERED");
    expect((await go(second, "ASSIGNED", { riderId: riderB })).status).toBe(200);
  });

  it("clears the rider when an assigned order goes back to searching, freeing that rider", async () => {
    const a = await mkOrder("SEARCHING_RIDER");
    const b = await mkOrder("SEARCHING_RIDER");
    await go(a, "ASSIGNED", { riderId: riderA });
    expect((await go(a, "SEARCHING_RIDER")).status).toBe(200);
    expect((await row(a)).rider_id).toBeNull();
    expect((await go(b, "ASSIGNED", { riderId: riderA })).status).toBe(200);
  });

  it("allows cancelling before pickup and then treats the order as final", async () => {
    const id = await mkOrder("SEARCHING_RIDER");
    expect((await go(id, "CANCELLED")).status).toBe(200);
    expect((await go(id, "SEARCHING_RIDER")).status).toBe(422);
    expect((await events(id)).map((e) => e.to_status)).toEqual(["CANCELLED"]);
  });

  it("lets an admin resolve PAYMENT_REVIEW by accepting or cancelling", async () => {
    const accept = await mkOrder("PAYMENT_REVIEW");
    expect((await go(accept, "PAID")).status).toBe(200);
    const cancel = await mkOrder("PAYMENT_REVIEW");
    expect((await go(cancel, "CANCELLED")).status).toBe(200);
  });

  it("handles five simultaneous identical transitions exactly once", async () => {
    const id = await mkOrder("ASSIGNED", riderC);
    const results = await Promise.all(Array.from({ length: 5 }, () => go(id, "PICKED_UP")));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 422, 422, 422, 422]);
    expect((await row(id)).status).toBe("PICKED_UP");
    expect(await events(id)).toHaveLength(1);
  });

  it("keeps events in the order they happened even inside one transaction", async () => {
    const id = await mkOrder("PENDING_PAYMENT");
    await db.transaction().execute(async (trx) => {
      await transitionOrder(trx, { orderId: id, to: "PAID", actorId: null });
      await transitionOrder(trx, { orderId: id, to: "SEARCHING_RIDER", actorId: null });
    });
    expect((await events(id)).map((e) => e.to_status)).toEqual(["PAID", "SEARCHING_RIDER"]);
  });
});
