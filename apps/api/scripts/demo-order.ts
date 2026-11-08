// Places a demo order, "pays" it with a correctly signed test webhook, and shows the live updates until delivery.
// For development only: it needs the demo data from `npm run db:seed`, a running API, and (for the --auto
// riders) the simulator:  npm run sim -w @relay/api -- --riders 3 --auto
//
//   npm run demo:order -w @relay/api
//
// Environment: API_URL (default http://localhost:4000), PAYSTACK_SECRET_KEY (from .env, used to sign the webhook),
// DEMO_TIMEOUT_S (default 120), SIM_PASSWORD (the seeded demo password).
import "../src/env";
import { createHmac, randomBytes } from "node:crypto";
import { io } from "socket.io-client";

const API = process.env.API_URL ?? "http://localhost:4000";
const PASSWORD = process.env.SIM_PASSWORD ?? "relay-demo-123";
const TIMEOUT_S = Number(process.env.DEMO_TIMEOUT_S ?? "120");

async function call(method: string, path: string, token?: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function login(email: string): Promise<string> {
  const res = await call("POST", "/auth/login", undefined, { email, password: PASSWORD });
  const token = (res.json as { accessToken?: string } | null)?.accessToken;
  if (res.status !== 200 || !token) throw new Error(`${email} could not log in (${res.status}). Did you run npm run db:seed?`);
  return token;
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("This demo script must not run in production.");
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not set (it is needed to sign the test webhook).");

  const customerToken = await login(process.env.DEMO_CUSTOMER ?? "customer1@relay.demo");
  const adminToken = await login("admin@relay.demo");

  const vendors = ((await call("GET", "/vendors?city=ABUJA")).json as { vendors: { id: string; name: string; isOpen: boolean; lat: number; lng: number }[] }).vendors;
  const vendor = vendors.find((v) => v.isOpen);
  if (!vendor) throw new Error("No open vendor found. Run npm run db:seed.");
  const items = ((await call("GET", `/vendors/${vendor.id}/items`)).json as { items: { id: string; isAvailable: boolean }[] }).items.filter((i) => i.isAvailable);
  if (items.length < 2) throw new Error("The vendor has fewer than two available items.");

  const placed = await call("POST", "/orders", customerToken, {
    vendorId: vendor.id,
    items: [
      { itemId: items[0].id, quantity: 1 },
      { itemId: items[1].id, quantity: 2 },
    ],
    dropAddress: "Demo drop-off, about 1.5 km from the vendor",
    dropLat: vendor.lat + 0.0135,
    dropLng: vendor.lng,
  });
  if (placed.status !== 201) throw new Error(`Order failed: ${placed.status} ${JSON.stringify(placed.json)}`);
  const body = placed.json as { order: { id: string; totalKobo: number }; payment: { reference: string } | null };
  const orderId = body.order.id;
  console.log(`Placed order ${orderId.slice(0, 8)} at ${vendor.name}, total ${body.order.totalKobo / 100} naira`);

  // Live feed, as the customer and as an admin.
  const watched = new Map<string, number>();
  let finalStatus = "";
  const statuses: string[] = [];
  const customer = io(API, { auth: { token: customerToken }, transports: ["websocket"], reconnection: false });
  const admin = io(API, { auth: { token: adminToken }, transports: ["websocket"], reconnection: false });
  let customerLocations = 0;
  customer.on("order:status", (p: { status: string }) => {
    statuses.push(p.status);
    finalStatus = p.status;
    console.log(`  customer sees: ${p.status}`);
  });
  customer.on("rider:location", () => customerLocations++);
  admin.on("rider:location", (p: { riderId: string }) => watched.set(p.riderId, (watched.get(p.riderId) ?? 0) + 1));
  admin.on("admin:alert", (p: { orderId: string; reason: string }) => console.log(`  ADMIN ALERT: ${p.reason} for ${p.orderId.slice(0, 8)}`));
  await Promise.all([
    new Promise<void>((r) => customer.once("connect", () => r())),
    new Promise<void>((r) => admin.once("connect", () => r())),
  ]);
  await customer.emitWithAck("order:subscribe", { orderId });

  // "Pay": the same signed message Paystack would send.
  const reference = body.payment?.reference ?? `rly_${orderId.replaceAll("-", "")}_${randomBytes(3).toString("hex")}`;
  const raw = JSON.stringify({ event: "charge.success", data: { reference, amount: body.order.totalKobo, currency: "NGN", status: "success" } });
  const signature = createHmac("sha512", secret).update(raw).digest("hex");
  const hook = await call("POST", "/payments/webhook", undefined, raw, { "x-paystack-signature": signature });
  console.log(`Test payment sent (webhook ${hook.status}: ${JSON.stringify(hook.json)})`);

  const end = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < end && finalStatus !== "DELIVERED") await new Promise((r) => setTimeout(r, 250));

  customer.disconnect();
  admin.disconnect();
  console.log("---");
  console.log(`Customer saw: ${statuses.join(" -> ") || "nothing"}`);
  console.log(`Customer received ${customerLocations} rider location updates; the admin feed showed ${watched.size} different riders moving`);
  if (finalStatus !== "DELIVERED") {
    console.log("The order was not delivered in time. Is the simulator running with --auto?");
    process.exit(1);
  }
  console.log("Delivered.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
