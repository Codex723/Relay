// Moves fake riders around Abuja through the real API, so the live feed has something to show.
//
//   npm run sim -w @relay/api -- --riders 3                 riders go online and wander
//   npm run sim -w @relay/api -- --riders 3 --auto          riders also accept offers and deliver orders
//
// Options: --riders N (1 to 5)  --auto  --speed X (multiplier on 8 m/s)  --tick MS (default 3000)  --duration S
// Environment: API_URL (default http://localhost:4000), SIM_PASSWORD (default: the seeded demo password)
// Uses the demo riders created by `npm run db:seed` (rider1@relay.demo ...). Demo data only.

const API = process.env.API_URL ?? "http://localhost:4000";
const PASSWORD = process.env.SIM_PASSWORD ?? "relay-demo-123";
const BASE_SPEED_MS = 8;
const ARRIVED_M = 25;

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const riderCount = Math.max(1, Math.min(5, Number(arg("riders", "3"))));
const auto = process.argv.includes("--auto");
const speedMultiplier = Number(arg("speed", "1"));
const tickMs = Number(arg("tick", "3000"));
const durationS = Number(arg("duration", "0"));

type Point = { lat: number; lng: number };
const HOMES: Point[] = [
  { lat: 9.0765, lng: 7.4698 },
  { lat: 9.083, lng: 7.493 },
  { lat: 9.03, lng: 7.49 },
  { lat: 9.07, lng: 7.42 },
  { lat: 9.11, lng: 7.4 },
];

const toRad = (d: number) => (d * Math.PI) / 180;
function metersBetween(a: Point, b: Point): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function moveToward(from: Point, to: Point, meters: number): Point {
  const d = metersBetween(from, to);
  if (d <= meters) return to;
  const f = meters / d;
  return { lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f };
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

type OfferResponse = { offer: { offerId: string } | null };
type OrderResponse = { order: { id: string; vendorLat: number; vendorLng: number; dropLat: number; dropLng: number } };

interface Rider {
  n: number;
  token: string;
  home: Point;
  pos: Point;
  target: Point;
  mode: "idle" | "toVendor" | "toDrop";
  orderId?: string;
  drop?: Point;
}

const say = (r: Rider, msg: string) => console.log(`[rider${r.n}] ${msg}`);
const wanderTarget = (home: Point): Point => ({
  lat: home.lat + (Math.random() - 0.5) * 0.004,
  lng: home.lng + (Math.random() - 0.5) * 0.004,
});

async function tick(r: Rider) {
  if (auto && r.mode === "idle") {
    const current = await call("GET", "/rider/offers/current", r.token);
    const offer = (current.json as OfferResponse | null)?.offer;
    if (offer) {
      const accepted = await call("POST", `/rider/offers/${offer.offerId}/accept`, r.token);
      if (accepted.status === 200) {
        const o = (accepted.json as OrderResponse).order;
        r.orderId = o.id;
        r.drop = { lat: o.dropLat, lng: o.dropLng };
        r.target = { lat: o.vendorLat, lng: o.vendorLng };
        r.mode = "toVendor";
        say(r, `accepted order ${o.id.slice(0, 8)}, heading to the vendor`);
      } else {
        say(r, `could not accept (${accepted.status})`);
      }
    }
  }

  r.pos = moveToward(r.pos, r.target, BASE_SPEED_MS * speedMultiplier * (tickMs / 1000));
  if (metersBetween(r.pos, r.target) <= ARRIVED_M) {
    if (r.mode === "toVendor" && r.orderId && r.drop) {
      const res = await call("POST", `/rider/orders/${r.orderId}/status`, r.token, { status: "PICKED_UP" });
      say(r, `picked up (${res.status}), heading to the customer`);
      r.target = r.drop;
      r.mode = "toDrop";
    } else if (r.mode === "toDrop" && r.orderId) {
      const res = await call("POST", `/rider/orders/${r.orderId}/status`, r.token, { status: "DELIVERED" });
      say(r, `delivered order ${r.orderId.slice(0, 8)} (${res.status})`);
      r.mode = "idle";
      r.orderId = undefined;
      r.target = wanderTarget(r.home);
    } else if (r.mode === "idle") {
      r.target = wanderTarget(r.home);
    }
  }
  await call("POST", "/rider/location", r.token, r.pos);
}

async function main() {
  const riders: Rider[] = [];
  for (let n = 1; n <= riderCount; n++) {
    const login = await call("POST", "/auth/login", undefined, { email: `rider${n}@relay.demo`, password: PASSWORD });
    const token = (login.json as { accessToken?: string } | null)?.accessToken;
    if (login.status !== 200 || !token) throw new Error(`rider${n}@relay.demo could not log in (${login.status}). Did you run npm run db:seed?`);
    const home = HOMES[n - 1];
    const r: Rider = { n, token, home, pos: home, target: wanderTarget(home), mode: "idle" };
    await call("POST", "/rider/online", token, home);
    say(r, `online at ${home.lat}, ${home.lng}`);
    riders.push(r);
  }
  console.log(`${riders.length} riders running${auto ? " (auto: accepting offers)" : ""}. Press Ctrl+C to stop.`);

  const timers = riders.map((r) =>
    setInterval(() => {
      tick(r).catch((err) => say(r, `tick failed: ${err instanceof Error ? err.message : err}`));
    }, tickMs),
  );

  const stop = async () => {
    timers.forEach(clearInterval);
    await Promise.all(riders.map((r) => call("POST", "/rider/offline", r.token).catch(() => null)));
    console.log("riders offline");
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  if (durationS > 0) setTimeout(() => void stop(), durationS * 1000);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
