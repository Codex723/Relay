import http from "node:http";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { io as ioClient, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { createDb } from "../db";
import type { OrderStatusName } from "../db/types";
import { createDispatcher } from "../dispatch/dispatcher";
import { transitionOrder } from "../orders/transitions";
import { createRealtime } from "../realtime/realtime";
import { LIVE_PAGE } from "../dev/livePage";
import { createFakePaystack } from "./fakePaystack";

const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "", REALTIME_LOCATION_THROTTLE_MS: "300" };
const cfg = loadConfig(env);
const db = createDb(cfg.DATABASE_URL);
const realtime = createRealtime({ db, config: cfg });
const dispatcher = createDispatcher({ db, config: cfg, onOffer: realtime.offerCreated, onAdminAlert: realtime.adminAlert });
const app = createApp({ db, config: cfg, paystack: createFakePaystack().client, dispatcher, realtime });
const server = http.createServer(app);
let url = "";

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "a-long-test-password";
const emails: string[] = [];
const userIds: string[] = [];
const sockets: Socket[] = [];
let vendorId: string;
type Account = { id: string; token: string };
let custA: Account;
let custB: Account;
let rider1: Account;
let rider2: Account;
let admin: Account;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(20);
  }
  return false;
};
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

type Inbox = { event: string; payload: Record<string, unknown> }[];
const connect = (token: string) =>
  new Promise<{ socket: Socket; inbox: Inbox }>((resolve, reject) => {
    const socket = ioClient(url, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
    sockets.push(socket);
    const inbox: Inbox = [];
    socket.onAny((event, payload) => inbox.push({ event, payload }));
    socket.once("connect", () => resolve({ socket, inbox }));
    socket.once("connect_error", (e) => reject(e));
  });
const received = (inbox: Inbox, event: string) => inbox.filter((m) => m.event === event).map((m) => m.payload);
const subscribe = (s: Socket, orderId: unknown) => s.emitWithAck("order:subscribe", { orderId }) as Promise<{ ok: boolean; error?: string }>;

const register = async (label: string, role: "CUSTOMER" | "RIDER"): Promise<Account> => {
  const email = `test-rt-${label}-${run}@relay.test`.toLowerCase(); // the API stores emails in lowercase
  emails.push(email);
  const res = await request(app).post("/auth/register").send({ name: label, email, password: PASSWORD, role });
  userIds.push(res.body.user.id);
  return { id: res.body.user.id, token: res.body.accessToken };
};

const mkOrder = async (customerId: string, status: OrderStatusName = "SEARCHING_RIDER", riderId?: string) =>
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
        drop_address: "12 Test Street, Abuja",
        drop_lat: 9.0899,
        drop_lng: 7.4,
        distance_m: 10000,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
  realtime.attach(server);
  vendorId = (
    await db
      .insertInto("vendors")
      .values({ name: `Realtime Test Vendor ${run}`, city: "ABUJA", address: "1 Vendor Road", lat: 9.0, lng: 7.4 })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  custA = await register("custA", "CUSTOMER");
  custB = await register("custB", "CUSTOMER");
  rider1 = await register("rider1", "RIDER");
  rider2 = await register("rider2", "RIDER");
  const adminEmail = `test-rt-admin-${run}@relay.test`;
  emails.push(adminEmail);
  const a = await db
    .insertInto("users")
    .values({ name: "admin", email: adminEmail, phone: null, password_hash: await bcrypt.hash(PASSWORD, 4), role: "ADMIN" })
    .returning("id")
    .executeTakeFirstOrThrow();
  userIds.push(a.id);
  const login = await request(app).post("/auth/login").send({ email: adminEmail, password: PASSWORD });
  admin = { id: a.id, token: login.body.accessToken };
});

beforeEach(async () => {
  // Retire leftovers from earlier tests so only this test's riders and orders are in play.
  // These tests own the database: every rider is taken offline, including demo riders left online by a manual run.
  await db.updateTable("riders").set({ is_online: false }).execute();
  const old = await db.selectFrom("orders").select("id").where("customer_id", "in", [custA.id, custB.id]).execute();
  if (old.length > 0) {
    const ids = old.map((o) => o.id);
    await db.updateTable("dispatch_offers").set({ status: "EXPIRED" }).where("order_id", "in", ids).where("status", "=", "PENDING").execute();
    await db.updateTable("orders").set({ status: "CANCELLED" }).where("id", "in", ids).execute();
  }
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await realtime.close();
  await db.deleteFrom("orders").where("customer_id", "in", [custA.id, custB.id]).execute();
  await db.deleteFrom("vendors").where("id", "=", vendorId).execute();
  await db.deleteFrom("users").where("email", "in", emails).execute();
  await db.destroy();
});

describe("connecting", () => {
  it("refuses a missing, garbage or wrong-type token", async () => {
    await expect(connect("")).rejects.toThrow("UNAUTHENTICATED");
    await expect(connect("garbage")).rejects.toThrow("UNAUTHENTICATED");
    const refresh = jwt.sign({ typ: "refresh" }, cfg.JWT_REFRESH_SECRET, { subject: custA.id, expiresIn: 60 });
    await expect(connect(refresh)).rejects.toThrow("UNAUTHENTICATED");
    const wrongTyp = jwt.sign({ role: "ADMIN", typ: "refresh" }, cfg.JWT_SECRET, { subject: custA.id, expiresIn: 60 });
    await expect(connect(wrongTyp)).rejects.toThrow("UNAUTHENTICATED");
  });

  it("accepts a valid access token", async () => {
    const { socket } = await connect(custA.token);
    expect(socket.connected).toBe(true);
  });

  it("drops the connection when the access token expires", async () => {
    const shortLived = jwt.sign({ role: "CUSTOMER", typ: "access" }, cfg.JWT_SECRET, { subject: custA.id, expiresIn: 1 });
    const { socket } = await connect(shortLived);
    expect(socket.connected).toBe(true);
    expect(await until(() => !socket.connected, 3500)).toBe(true);
  });
});

describe("joining order rooms", () => {
  it("only the owner, the assigned rider and admins can subscribe", async () => {
    const mine = await mkOrder(custA.id);
    const assigned = await mkOrder(custB.id, "ASSIGNED", rider1.id);
    const a = (await connect(custA.token)).socket;
    const b = (await connect(custB.token)).socket;
    const r1 = (await connect(rider1.token)).socket;
    const r2 = (await connect(rider2.token)).socket;
    const adm = (await connect(admin.token)).socket;

    expect(await subscribe(a, mine)).toEqual({ ok: true });
    expect(await subscribe(adm, mine)).toEqual({ ok: true });
    expect(await subscribe(b, mine)).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await subscribe(r1, mine)).toEqual({ ok: false, error: "NOT_FOUND" });

    expect(await subscribe(r1, assigned)).toEqual({ ok: true });
    expect(await subscribe(r2, assigned)).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await subscribe(a, assigned)).toEqual({ ok: false, error: "NOT_FOUND" });

    // A missing order looks the same as someone else's, and bad ids are refused.
    expect(await subscribe(a, "00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await subscribe(a, "not-a-uuid")).toEqual({ ok: false, error: "INVALID_ORDER" });
    expect(await subscribe(a, 42)).toEqual({ ok: false, error: "INVALID_ORDER" });
  });

  it("puts a customer back in the rooms of their open orders after reconnecting", async () => {
    const open = await mkOrder(custA.id);
    const done = await mkOrder(custA.id, "DELIVERED");
    const { socket } = await connect(custA.token);
    await until(async () => (await realtime.io!.in(`order:${open}`).fetchSockets()).length > 0);
    expect((await realtime.io!.in(`order:${open}`).fetchSockets()).map((s) => s.id)).toContain(socket.id);
    expect(await realtime.io!.in(`order:${done}`).fetchSockets()).toHaveLength(0);
  });
});

describe("live order status", () => {
  it("pushes each change to the owner, the rider and admins, and to nobody else", async () => {
    const order = await mkOrder(custA.id);
    const offer = (
      await db
        .insertInto("dispatch_offers")
        .values({ order_id: order, rider_id: rider1.id, offered_at: new Date(), expires_at: new Date(Date.now() + 30_000) })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const a = await connect(custA.token);
    const b = await connect(custB.token);
    const r1 = await connect(rider1.token);
    const r2 = await connect(rider2.token);
    const adm = await connect(admin.token);

    expect((await request(app).post(`/rider/offers/${offer}/accept`).set(bearer(rider1.token))).status).toBe(200);
    expect(await until(() => received(a.inbox, "order:status").length >= 1)).toBe(true);
    expect(received(a.inbox, "order:status")[0]).toMatchObject({ orderId: order, status: "ASSIGNED" });

    expect((await request(app).post(`/rider/orders/${order}/status`).set(bearer(rider1.token)).send({ status: "PICKED_UP" })).status).toBe(200);
    expect(await until(() => received(a.inbox, "order:status").length >= 2)).toBe(true);
    expect(received(a.inbox, "order:status").map((p) => p.status)).toEqual(["ASSIGNED", "PICKED_UP"]);
    expect(Object.keys(received(a.inbox, "order:status")[0]).sort()).toEqual(["orderId", "status", "updatedAt"]);

    await until(() => received(adm.inbox, "order:status").length >= 2);
    expect(received(adm.inbox, "order:status")).toHaveLength(2); // one copy each, not two
    expect(received(r1.inbox, "order:status").length).toBeGreaterThanOrEqual(2);

    await sleep(200);
    expect(received(b.inbox, "order:status")).toHaveLength(0);
    expect(received(r2.inbox, "order:status")).toHaveLength(0);
  });

  it("stops sending a dropped rider this order's updates", async () => {
    const order = await mkOrder(custA.id, "ASSIGNED", rider1.id);
    const r1 = await connect(rider1.token);
    expect(await subscribe(r1.socket, order)).toEqual({ ok: true });

    await db.transaction().execute((trx) => transitionOrder(trx, { orderId: order, to: "SEARCHING_RIDER", actorId: null }));
    realtime.orderChanged(order);

    // The rider is told, then removed from the room.
    expect(await until(() => received(r1.inbox, "order:status").some((p) => p.status === "SEARCHING_RIDER"))).toBe(true);
    expect(await until(async () => (await realtime.io!.in(`order:${order}`).fetchSockets()).every((s) => s.data.auth.role !== "RIDER"))).toBe(true);
    realtime.io!.to(`order:${order}`).emit("probe", { n: 1 });
    await sleep(150);
    expect(received(r1.inbox, "probe")).toHaveLength(0);
  });
});

describe("live offers and alerts", () => {
  it("sends an offer only to the rider it was made to", async () => {
    const near = rider1;
    const far = rider2;
    await request(app).post("/rider/online").set(bearer(near.token)).send({ lat: 9.001, lng: 7.4 });
    await request(app).post("/rider/online").set(bearer(far.token)).send({ lat: 9.05, lng: 7.4 });
    const order = await mkOrder(custA.id);
    const r1 = await connect(near.token);
    const r2 = await connect(far.token);
    const a = await connect(custA.token);
    const adm = await connect(admin.token);

    await dispatcher.dispatchOrder(order);
    expect(await until(() => received(r1.inbox, "offer:new").length === 1)).toBe(true);
    const offer = received(r1.inbox, "offer:new")[0] as { offerId: string; expiresAt: string; order: { id: string; vendorName: string } };
    expect(offer.order).toMatchObject({ id: order, vendorName: `Realtime Test Vendor ${run}` });
    expect(new Date(offer.expiresAt).getTime()).toBeGreaterThan(Date.now());

    await sleep(200);
    expect(received(r2.inbox, "offer:new")).toHaveLength(0);
    expect(received(a.inbox, "offer:new")).toHaveLength(0);
    expect(received(adm.inbox, "offer:new")).toHaveLength(0);
  });

  it("sends dispatch alerts to admins only", async () => {
    const strict = loadConfig({ ...env, DISPATCH_MAX_ROUNDS: "1" });
    const d = createDispatcher({ db, config: strict, onAdminAlert: realtime.adminAlert });
    const order = await mkOrder(custA.id);
    const adm = await connect(admin.token);
    const a = await connect(custA.token);
    const r1 = await connect(rider1.token);

    await d.dispatchOrder(order); // nobody is online, so round 1 fails and the single allowed round alerts
    expect(await until(() => received(adm.inbox, "admin:alert").length === 1)).toBe(true);
    expect(received(adm.inbox, "admin:alert")[0]).toEqual({ orderId: order, attempts: 1, reason: "no_rider_available" });
    await sleep(200);
    expect(received(a.inbox, "admin:alert")).toHaveLength(0);
    expect(received(r1.inbox, "admin:alert")).toHaveLength(0);
  });
});

describe("live rider location", () => {
  it("shows a rider's position to their order's customer and to admins, with the rider's identity only for admins", async () => {
    const order = await mkOrder(custA.id, "ASSIGNED", rider1.id);
    realtime.orderChanged(order);
    const a = await connect(custA.token);
    const b = await connect(custB.token);
    const adm = await connect(admin.token);
    const r1 = await connect(rider1.token);
    await until(async () => (await realtime.io!.in(`order:${order}`).fetchSockets()).length >= 2);

    expect(await r1.socket.emitWithAck("rider:location", { lat: 9.01, lng: 7.41 })).toEqual({ ok: true });
    expect(await until(() => received(a.inbox, "rider:location").length === 1)).toBe(true);
    expect(received(a.inbox, "rider:location")[0]).toMatchObject({ orderId: order, lat: 9.01, lng: 7.41 });
    expect(received(a.inbox, "rider:location")[0]).not.toHaveProperty("riderId");
    expect(await until(() => received(adm.inbox, "rider:location").length === 1)).toBe(true);
    expect(received(adm.inbox, "rider:location")[0]).toMatchObject({ riderId: rider1.id, orderId: order, lat: 9.01 });

    await sleep(150);
    expect(received(b.inbox, "rider:location")).toHaveLength(0);
    const row = await db.selectFrom("riders").select(["current_lat", "current_lng"]).where("user_id", "=", rider1.id).executeTakeFirstOrThrow();
    expect(Number(row.current_lat)).toBeCloseTo(9.01);
  });

  it("broadcasts at most once per throttle window but always saves the latest position", async () => {
    const order = await mkOrder(custA.id, "ASSIGNED", rider2.id);
    realtime.orderChanged(order);
    const a = await connect(custA.token);
    await until(async () => (await realtime.io!.in(`order:${order}`).fetchSockets()).length >= 1);
    const post = (lat: number) => request(app).post("/rider/location").set(bearer(rider2.token)).send({ lat, lng: 7.4 });

    await post(9.011);
    await post(9.012);
    await post(9.013);
    await sleep(150);
    expect(received(a.inbox, "rider:location")).toHaveLength(1);
    expect(received(a.inbox, "rider:location")[0]).toMatchObject({ lat: 9.011 });
    const saved = await db.selectFrom("riders").select("current_lat").where("user_id", "=", rider2.id).executeTakeFirstOrThrow();
    expect(Number(saved.current_lat)).toBeCloseTo(9.013); // dropped from the feed, not from the database

    await sleep(350); // the 300 ms window has passed
    await post(9.014);
    expect(await until(() => received(a.inbox, "rider:location").length === 2)).toBe(true);
    expect(received(a.inbox, "rider:location")[1]).toMatchObject({ lat: 9.014 });
  });

  it("sends a rider with no active order to admins only", async () => {
    const lone = await register("lone", "RIDER");
    const a = await connect(custA.token);
    const adm = await connect(admin.token);
    await request(app).post("/rider/location").set(bearer(lone.token)).send({ lat: 9.02, lng: 7.4 });
    expect(await until(() => received(adm.inbox, "rider:location").length === 1)).toBe(true);
    expect(received(adm.inbox, "rider:location")[0]).toMatchObject({ riderId: lone.id, orderId: null });
    await sleep(150);
    expect(received(a.inbox, "rider:location")).toHaveLength(0);
  });

  it("limits and validates location events from a rider's socket", async () => {
    const r = await register("sockrider", "RIDER");
    const { socket } = await connect(r.token);
    expect(await socket.emitWithAck("rider:location", { lat: 9.03, lng: 7.4 })).toEqual({ ok: true });
    expect(await socket.emitWithAck("rider:location", { lat: 9.04, lng: 7.4 })).toEqual({ ok: false, error: "TOO_FAST" });
    await sleep(1050);
    expect(await socket.emitWithAck("rider:location", { lat: 999, lng: 7.4 })).toEqual({ ok: false, error: "INVALID_LOCATION" });
    expect(await socket.emitWithAck("rider:location", "nonsense")).toEqual({ ok: false, error: "INVALID_LOCATION" });
  });

  it("ignores location events from customers and admins", async () => {
    const before = await db.selectFrom("riders").select(["user_id", "current_lat"]).where("user_id", "in", userIds).execute();
    const a = await connect(custA.token);
    const adm = await connect(admin.token);
    expect(await a.socket.emitWithAck("rider:location", { lat: 1, lng: 1 })).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await adm.socket.emitWithAck("rider:location", { lat: 1, lng: 1 })).toEqual({ ok: false, error: "FORBIDDEN" });
    const after = await db.selectFrom("riders").select(["user_id", "current_lat"]).where("user_id", "in", userIds).execute();
    expect(after).toEqual(before);
  });
});

describe("dev live page", () => {
  it("is served outside production and its script is valid JavaScript", async () => {
    const res = await request(app).get("/dev/live");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toContain("'unsafe-inline'");
    const scripts = [...LIVE_PAGE.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0])).not.toThrow();
  });

  it("is not served in production", async () => {
    const prod = loadConfig({ ...env, NODE_ENV: "production" });
    const prodApp = createApp({ db, config: prod, paystack: createFakePaystack().client, dispatcher });
    expect((await request(prodApp).get("/dev/live")).status).toBe(404);
  });
});
