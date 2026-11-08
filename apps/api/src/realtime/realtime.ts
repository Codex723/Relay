import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { LocationInput, type RiderOfferView } from "@relay/shared";
import { z } from "zod";
import { verifyAccessToken, type AccessClaims } from "../auth/tokens";
import type { Config } from "../config";
import type { Database } from "../db";
import type { AdminAlert, OfferNotice } from "../dispatch/dispatcher";
import { updateRiderLocation } from "../rider/presence";
import { loadRiderOrderView } from "../rider/view";

// What the rest of the app uses to push live updates. Every method is safe to call at any time:
// if no socket server is attached (tests, scripts) they do nothing.
//
// Rooms (clients can never name a room to join, the server decides):
//   user:<id>    one user's own messages (rider offers)
//   order:<id>   the customer, the assigned rider and any admin who subscribed
//   admin        every admin
export interface Realtime {
  attach(server: HttpServer): void;
  close(): Promise<void>;
  /** Call after an order's status changed and the change is committed. */
  orderChanged(orderId: string): void;
  offerCreated(offer: OfferNotice): void;
  adminAlert(alert: AdminAlert): void;
  riderLocation(riderId: string, lat: number, lng: number): void;
  readonly io: Server | null;
}

export const noopRealtime: Realtime = {
  attach: () => undefined,
  close: async () => undefined,
  orderChanged: () => undefined,
  offerCreated: () => undefined,
  adminAlert: () => undefined,
  riderLocation: () => undefined,
  io: null,
};

const OrderRef = z.object({ orderId: z.string().uuid() });
const MAX_ROOMS_PER_SOCKET = 25;
const MIN_SOCKET_LOCATION_INTERVAL_MS = 1000;
const FINAL_STATUSES = ["DELIVERED", "CANCELLED"] as const;

type Ack = ((reply: { ok: boolean; error?: string }) => void) | undefined;
const reply = (ack: Ack, body: { ok: boolean; error?: string }) => {
  if (typeof ack === "function") ack(body);
};

export function createRealtime({ db, config }: { db: Database; config: Config }): Realtime {
  let io: Server | null = null;
  const lastBroadcast = new Map<string, number>();

  const log = (what: string, err: unknown) => console.error(`realtime ${what} failed`, err instanceof Error ? err.message : err);

  async function canAccessOrder(auth: AccessClaims, orderId: string): Promise<boolean> {
    const o = await db.selectFrom("orders").select(["customer_id", "rider_id"]).where("id", "=", orderId).executeTakeFirst();
    if (!o) return false;
    if (auth.role === "ADMIN") return true;
    if (auth.role === "CUSTOMER") return o.customer_id === auth.userId;
    return o.rider_id === auth.userId;
  }

  // After a reconnect a client lands back in the rooms for its own open orders.
  async function rejoinOrders(socket: Socket, auth: AccessClaims) {
    if (auth.role === "CUSTOMER") {
      const rows = await db
        .selectFrom("orders")
        .select("id")
        .where("customer_id", "=", auth.userId)
        .where("status", "not in", [...FINAL_STATUSES])
        .orderBy("created_at", "desc")
        .limit(20)
        .execute();
      for (const r of rows) await socket.join(`order:${r.id}`);
    } else if (auth.role === "RIDER") {
      const rows = await db.selectFrom("orders").select("id").where("rider_id", "=", auth.userId).where("status", "in", ["ASSIGNED", "PICKED_UP"]).execute();
      for (const r of rows) await socket.join(`order:${r.id}`);
    }
  }

  function onConnection(socket: Socket) {
    const auth = socket.data.auth as AccessClaims;
    void socket.join(`user:${auth.userId}`);
    if (auth.role === "ADMIN") void socket.join("admin");
    rejoinOrders(socket, auth).catch((err) => log("rejoin", err));

    // The access token has a short life. When it ends the connection ends; the client reconnects with a fresh one.
    const expiry = setTimeout(() => socket.disconnect(true), Math.max(0, auth.expiresAt - Date.now()));
    socket.on("disconnect", () => clearTimeout(expiry));

    socket.on("order:subscribe", async (payload: unknown, ack: Ack) => {
      try {
        const ref = OrderRef.safeParse(payload);
        if (!ref.success) return reply(ack, { ok: false, error: "INVALID_ORDER" });
        if (socket.rooms.size >= MAX_ROOMS_PER_SOCKET) return reply(ack, { ok: false, error: "TOO_MANY_SUBSCRIPTIONS" });
        // Same answer for "does not exist" and "not yours", so ids cannot be probed.
        if (!(await canAccessOrder(auth, ref.data.orderId))) return reply(ack, { ok: false, error: "NOT_FOUND" });
        await socket.join(`order:${ref.data.orderId}`);
        reply(ack, { ok: true });
      } catch (err) {
        log("subscribe", err);
        reply(ack, { ok: false, error: "INTERNAL" });
      }
    });

    socket.on("order:unsubscribe", async (payload: unknown, ack: Ack) => {
      const ref = OrderRef.safeParse(payload);
      if (ref.success) await socket.leave(`order:${ref.data.orderId}`);
      reply(ack, { ok: ref.success });
    });

    let lastLocationAt = 0;
    socket.on("rider:location", async (payload: unknown, ack: Ack) => {
      try {
        if (auth.role !== "RIDER") return reply(ack, { ok: false, error: "FORBIDDEN" });
        const now = Date.now();
        if (now - lastLocationAt < MIN_SOCKET_LOCATION_INTERVAL_MS) return reply(ack, { ok: false, error: "TOO_FAST" });
        const loc = LocationInput.safeParse(payload);
        if (!loc.success) return reply(ack, { ok: false, error: "INVALID_LOCATION" });
        lastLocationAt = now;
        await updateRiderLocation(db, api, auth.userId, loc.data.lat, loc.data.lng);
        reply(ack, { ok: true });
      } catch (err) {
        log("location", err);
        reply(ack, { ok: false, error: "INTERNAL" });
      }
    });
  }

  async function publishOrder(orderId: string) {
    if (!io) return;
    const o = await db
      .selectFrom("orders")
      .select(["id", "status", "customer_id", "rider_id", "updated_at"])
      .where("id", "=", orderId)
      .executeTakeFirst();
    if (!o) return;
    const room = `order:${o.id}`;

    // The customer and the assigned rider are always in the room, with no action needed on their side.
    io.in(`user:${o.customer_id}`).socketsJoin(room);
    if (o.rider_id) io.in(`user:${o.rider_id}`).socketsJoin(room);

    const payload = { orderId: o.id, status: o.status, updatedAt: o.updated_at.toISOString() };
    io.to(room).to("admin").emit("order:status", payload);

    // A rider who is no longer assigned (dropped, reassigned) stops receiving this order's updates.
    for (const s of await io.in(room).fetchSockets()) {
      const a = s.data.auth as AccessClaims;
      if (a.role === "RIDER" && a.userId !== o.rider_id) s.leave(room);
    }
  }

  async function publishLocation(riderId: string, lat: number, lng: number) {
    if (!io) return;
    const at = new Date().toISOString();
    const active = await db
      .selectFrom("orders")
      .select("id")
      .where("rider_id", "=", riderId)
      .where("status", "in", ["ASSIGNED", "PICKED_UP"])
      .executeTakeFirst();
    // Admins see every rider. A customer sees only the rider on their own order, and not who the rider is.
    io.to("admin").emit("rider:location", { riderId, orderId: active?.id ?? null, lat, lng, at });
    if (active) io.to(`order:${active.id}`).emit("rider:location", { orderId: active.id, lat, lng, at });
  }

  const api: Realtime = {
    attach(server) {
      io = new Server(server, {
        cors: { origin: config.WEB_ORIGIN, credentials: true },
        maxHttpBufferSize: 100_000,
      });
      io.use((socket, next) => {
        const token = socket.handshake.auth?.token;
        const claims = typeof token === "string" ? verifyAccessToken(token, config) : null;
        if (!claims) return next(new Error("UNAUTHENTICATED"));
        socket.data.auth = claims;
        next();
      });
      io.on("connection", onConnection);
    },
    async close() {
      const server = io;
      io = null;
      if (server) await new Promise<void>((resolve) => void server.close(() => resolve()));
    },
    orderChanged(orderId) {
      publishOrder(orderId).catch((err) => log("order update", err));
    },
    offerCreated(offer) {
      if (!io) return;
      const target = io;
      void (async () => {
        const order = await loadRiderOrderView(db, offer.orderId);
        if (!order) return;
        const view: RiderOfferView = { offerId: offer.offerId, expiresAt: offer.expiresAt.toISOString(), order };
        target.to(`user:${offer.riderId}`).emit("offer:new", view);
      })().catch((err) => log("offer", err));
    },
    adminAlert(alert) {
      io?.to("admin").emit("admin:alert", alert);
    },
    riderLocation(riderId, lat, lng) {
      const now = Date.now();
      const last = lastBroadcast.get(riderId) ?? 0;
      if (now - last < config.REALTIME_LOCATION_THROTTLE_MS) return;
      lastBroadcast.set(riderId, now);
      if (lastBroadcast.size > 500) {
        for (const [id, t] of lastBroadcast) if (now - t > 60_000) lastBroadcast.delete(id);
      }
      publishLocation(riderId, lat, lng).catch((err) => log("location", err));
    },
    get io() {
      return io;
    },
  };
  return api;
}
