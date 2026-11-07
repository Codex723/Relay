import bcrypt from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { createDb } from "../db";
import { createDispatcher } from "../dispatch/dispatcher";
import { createFakePaystack } from "./fakePaystack";

const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "" });
const db = createDb(config.DATABASE_URL);
const app = createApp({ db, config, dispatcher: createDispatcher({ db, config }), paystack: createFakePaystack().client });

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "a-long-test-password";
const emails: string[] = [];
const vendorIds: string[] = [];

// Test vendor in Abuja. A drop-off 0.0899 degrees north is 9,996 m away, which rounds up to 10,000 m.
const VENDOR = { lat: 9.0, lng: 7.4 };
const NEAR_DROP = { dropAddress: "12 Test Street, Abuja", dropLat: 9.0899, dropLng: 7.4 };

let openVendorId: string;
let closedVendorId: string;
let otherVendorId: string;
let itemA: string; // 350,000 kobo
let itemB: string; // 80,000 kobo
let itemOff: string; // unavailable
let itemOther: string; // belongs to another vendor

const asCustomer = async (label: string, role: "CUSTOMER" | "RIDER" = "CUSTOMER") => {
  const email = `test-${label}-${run}@relay.test`;
  emails.push(email);
  const res = await request(app).post("/auth/register").send({ name: `T ${label}`, email, password: PASSWORD, role });
  return { token: res.body.accessToken as string, id: res.body.user.id as string };
};
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const body = (extra: Record<string, unknown> = {}) => ({
  vendorId: openVendorId,
  items: [
    { itemId: itemA, quantity: 2 },
    { itemId: itemB, quantity: 1 },
  ],
  ...NEAR_DROP,
  ...extra,
});

beforeAll(async () => {
  const mk = async (name: string, isOpen: boolean) => {
    const v = await db
      .insertInto("vendors")
      .values({ name: `${name} ${run}`, city: "ABUJA", address: "Test", lat: VENDOR.lat, lng: VENDOR.lng, is_open: isOpen })
      .returning("id")
      .executeTakeFirstOrThrow();
    vendorIds.push(v.id);
    return v.id;
  };
  openVendorId = await mk("Test Open", true);
  closedVendorId = await mk("Test Closed", false);
  otherVendorId = await mk("Test Other", true);
  const mkItem = async (vendorId: string, name: string, price: number, available = true) =>
    (
      await db
        .insertInto("items")
        .values({ vendor_id: vendorId, name, price_kobo: price, is_available: available })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  itemA = await mkItem(openVendorId, "Test Item A", 350000);
  itemB = await mkItem(openVendorId, "Test Item B", 80000);
  itemOff = await mkItem(openVendorId, "Test Item Off", 100000, false);
  itemOther = await mkItem(otherVendorId, "Test Item Other", 100000);
  await mkItem(closedVendorId, "Test Item Closed", 100000);
});

afterAll(async () => {
  const users = await db.selectFrom("users").select("id").where("email", "in", emails).execute();
  const ids = users.map((u) => u.id);
  if (ids.length > 0) await db.deleteFrom("orders").where("customer_id", "in", ids).execute();
  await db.deleteFrom("items").where("vendor_id", "in", vendorIds).execute();
  await db.deleteFrom("vendors").where("id", "in", vendorIds).execute();
  if (emails.length > 0) await db.deleteFrom("users").where("email", "in", emails).execute();
  await db.destroy();
});

describe("vendors and items (public)", () => {
  it("lists vendors by city with their open state", async () => {
    const res = await request(app).get("/vendors?city=ABUJA");
    expect(res.status).toBe(200);
    const open = res.body.vendors.find((v: { id: string }) => v.id === openVendorId);
    const closed = res.body.vendors.find((v: { id: string }) => v.id === closedVendorId);
    expect(open).toMatchObject({ isOpen: true, city: "ABUJA", lat: VENDOR.lat });
    expect(closed.isOpen).toBe(false);
  });

  it("rejects an unknown city filter", async () => {
    expect((await request(app).get("/vendors?city=PARIS")).status).toBe(400);
  });

  it("lists a vendor's items including unavailable ones, flagged", async () => {
    const res = await request(app).get(`/vendors/${openVendorId}/items`);
    expect(res.status).toBe(200);
    const off = res.body.items.find((i: { id: string }) => i.id === itemOff);
    expect(off.isAvailable).toBe(false);
    expect(res.body.items.find((i: { id: string }) => i.id === itemA).priceKobo).toBe(350000);
  });

  it("returns 404 for an unknown or malformed vendor id", async () => {
    expect((await request(app).get("/vendors/00000000-0000-4000-8000-000000000000/items")).status).toBe(404);
    expect((await request(app).get("/vendors/not-a-uuid/items")).status).toBe(404);
  });
});

describe("create order", () => {
  it("computes everything on the server and ignores client-supplied prices", async () => {
    const c = await asCustomer("create");
    const res = await request(app)
      .post("/orders")
      .set(bearer(c.token))
      .send(
        body({
          // None of these exist in the schema; they must have no effect.
          totalKobo: 1,
          subtotalKobo: 1,
          deliveryFeeKobo: 0,
          priceKobo: 1,
          items: [
            { itemId: itemA, quantity: 2, unitPriceKobo: 1 },
            { itemId: itemB, quantity: 1, unitPriceKobo: 1 },
          ],
        }),
      );
    expect(res.status).toBe(201);
    const o = res.body.order;
    expect(o.status).toBe("PENDING_PAYMENT");
    expect(o.subtotalKobo).toBe(2 * 350000 + 80000);
    expect(o.distanceM).toBe(10000);
    expect(o.deliveryFeeKobo).toBe(200000); // 50,000 base + 10 km x 15,000
    expect(o.totalKobo).toBe(780000 + 200000);
    expect(o.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: itemA, quantity: 2, unitPriceKobo: 350000 }),
        expect.objectContaining({ itemId: itemB, quantity: 1, unitPriceKobo: 80000 }),
      ]),
    );

    // What was stored matches, and an audit event exists.
    const row = await db.selectFrom("orders").selectAll().where("id", "=", o.id).executeTakeFirstOrThrow();
    expect(row.total_kobo).toBe(980000);
    expect(row.customer_id).toBe(c.id);
    expect(row.rider_id).toBeNull();
    const ev = await db.selectFrom("order_events").selectAll().where("order_id", "=", o.id).execute();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ from_status: null, to_status: "PENDING_PAYMENT", actor_id: c.id });
  });

  it("merges repeated items and rejects more than 20 of one item", async () => {
    const c = await asCustomer("merge");
    const merged = await request(app)
      .post("/orders")
      .set(bearer(c.token))
      .send(body({ items: [{ itemId: itemA, quantity: 1 }, { itemId: itemA, quantity: 2 }] }));
    expect(merged.status).toBe(201);
    expect(merged.body.order.lines).toHaveLength(1);
    expect(merged.body.order.lines[0].quantity).toBe(3);

    const tooMany = await request(app)
      .post("/orders")
      .set(bearer(c.token))
      .send(body({ items: [{ itemId: itemA, quantity: 15 }, { itemId: itemA, quantity: 10 }] }));
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe("QUANTITY_TOO_HIGH");
  });

  it("requires a signed-in customer", async () => {
    const rider = await asCustomer("rider", "RIDER");
    expect((await request(app).post("/orders").send(body())).status).toBe(401);
    expect((await request(app).post("/orders").set(bearer(rider.token)).send(body())).status).toBe(403);
  });

  it("rejects a closed vendor, an unavailable item, foreign items and an unknown vendor", async () => {
    const c = await asCustomer("rules");
    const post = (b: object) => request(app).post("/orders").set(bearer(c.token)).send(b);

    const closed = await post(body({ vendorId: closedVendorId }));
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("VENDOR_CLOSED");

    const off = await post(body({ items: [{ itemId: itemOff, quantity: 1 }] }));
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("ITEM_UNAVAILABLE");

    const foreign = await post(body({ items: [{ itemId: itemOther, quantity: 1 }] }));
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe("INVALID_ITEMS");

    const unknown = await post(body({ vendorId: "00000000-0000-4000-8000-000000000000" }));
    expect(unknown.status).toBe(404);
  });

  it("rejects a drop-off in another city or outside every city", async () => {
    const c = await asCustomer("area");
    const post = (b: object) => request(app).post("/orders").set(bearer(c.token)).send(b);
    const lagos = await post(body({ dropLat: 6.4474, dropLng: 3.47 }));
    expect(lagos.status).toBe(422);
    expect(lagos.body.error.code).toBe("CITY_MISMATCH");
    const nowhere = await post(body({ dropLat: 0, dropLng: 0 }));
    expect(nowhere.status).toBe(422);
    expect(nowhere.body.error.code).toBe("OUTSIDE_SERVICE_AREA");
  });

  it("validates the request shape", async () => {
    const c = await asCustomer("shape");
    const post = (b: object) => request(app).post("/orders").set(bearer(c.token)).send(b);
    expect((await post(body({ items: [] }))).status).toBe(400);
    expect((await post(body({ items: [{ itemId: itemA, quantity: 0 }] }))).status).toBe(400);
    expect((await post(body({ items: [{ itemId: "nope", quantity: 1 }] }))).status).toBe(400);
    expect((await post(body({ dropAddress: "x" }))).status).toBe(400);
    expect((await post(body({ dropLat: 123 }))).status).toBe(400);
  });
});

describe("quote", () => {
  it("returns the same totals without creating an order", async () => {
    const c = await asCustomer("quote");
    const res = await request(app).post("/orders/quote").set(bearer(c.token)).send(body());
    expect(res.status).toBe(200);
    expect(res.body.quote).toMatchObject({ subtotalKobo: 780000, deliveryFeeKobo: 200000, totalKobo: 980000 });
    const count = await db.selectFrom("orders").select("id").where("customer_id", "=", c.id).execute();
    expect(count).toHaveLength(0);
  });
});

describe("reading orders", () => {
  it("owner and admin can read an order; other customers get 404; anonymous gets 401", async () => {
    const owner = await asCustomer("owner");
    const other = await asCustomer("other");
    const rider = await asCustomer("rd", "RIDER");
    const created = await request(app).post("/orders").set(bearer(owner.token)).send(body());
    const id = created.body.order.id;

    const adminEmail = `test-admin-${run}@relay.test`;
    emails.push(adminEmail);
    await db
      .insertInto("users")
      .values({ name: "T admin", email: adminEmail, phone: null, password_hash: await bcrypt.hash(PASSWORD, 4), role: "ADMIN" })
      .execute();
    const admin = await request(app).post("/auth/login").send({ email: adminEmail, password: PASSWORD });

    expect((await request(app).get(`/orders/${id}`).set(bearer(owner.token))).status).toBe(200);
    expect((await request(app).get(`/orders/${id}`).set(bearer(admin.body.accessToken))).status).toBe(200);
    expect((await request(app).get(`/orders/${id}`).set(bearer(other.token))).status).toBe(404);
    expect((await request(app).get(`/orders/${id}`).set(bearer(rider.token))).status).toBe(403);
    expect((await request(app).get(`/orders/${id}`)).status).toBe(401);
    expect((await request(app).get("/orders/not-a-uuid").set(bearer(owner.token))).status).toBe(404);
  });

  it("lists only the caller's own orders, newest first", async () => {
    const a = await asCustomer("mine-a");
    const b = await asCustomer("mine-b");
    const first = await request(app).post("/orders").set(bearer(a.token)).send(body());
    const second = await request(app).post("/orders").set(bearer(a.token)).send(body());
    await request(app).post("/orders").set(bearer(b.token)).send(body());

    const res = await request(app).get("/orders/mine").set(bearer(a.token));
    expect(res.status).toBe(200);
    expect(res.body.orders.map((o: { id: string }) => o.id)).toEqual([second.body.order.id, first.body.order.id]);
  });
});
