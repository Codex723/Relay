import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../apiClient";
import { MAX_QTY, cartCount, cartReducer, cartSubtotalKobo, emptyCart, parseStoredCart, wouldConflict, type Cart, type CartVendor } from "../cart";
import { formatKm, formatNaira } from "../money";
import { STEPS, isFinal, safeNext, statusMessage, stepIndex, type OrderStatus } from "../orderStatus";

const vendorA: CartVendor = { id: "a", name: "Vendor A", city: "ABUJA", lat: 9, lng: 7.4 };
const vendorB: CartVendor = { id: "b", name: "Vendor B", city: "LAGOS", lat: 6.5, lng: 3.4 };
const item = (id: string, price = 1000) => ({ itemId: id, name: `Item ${id}`, priceKobo: price });

describe("money", () => {
  it("formats kobo as naira", () => {
    expect(formatNaira(350000)).toBe("₦3,500.00");
    expect(formatNaira(80000)).toBe("₦800.00");
    expect(formatNaira(0)).toBe("₦0.00");
  });
  it("formats distance", () => expect(formatKm(10000)).toBe("10.0 km"));
});

describe("cart", () => {
  it("adds items, increments repeats, and totals", () => {
    let c = cartReducer(emptyCart, { type: "add", vendor: vendorA, line: item("x", 350000) });
    c = cartReducer(c, { type: "add", vendor: vendorA, line: item("x", 350000) });
    c = cartReducer(c, { type: "add", vendor: vendorA, line: item("y", 80000) });
    expect(c.lines).toHaveLength(2);
    expect(cartCount(c)).toBe(3);
    expect(cartSubtotalKobo(c)).toBe(2 * 350000 + 80000);
  });

  it("caps quantity at the server limit", () => {
    let c: Cart = emptyCart;
    for (let i = 0; i < 30; i++) c = cartReducer(c, { type: "add", vendor: vendorA, line: item("x") });
    expect(c.lines[0].quantity).toBe(MAX_QTY);
    expect(cartReducer(c, { type: "setQuantity", itemId: "x", quantity: 99 }).lines[0].quantity).toBe(MAX_QTY);
  });

  it("refuses to mix vendors, but replace starts a new cart", () => {
    const c = cartReducer(emptyCart, { type: "add", vendor: vendorA, line: item("x") });
    expect(wouldConflict(c, "b")).toBe(true);
    expect(wouldConflict(c, "a")).toBe(false);
    expect(wouldConflict(emptyCart, "b")).toBe(false);
    expect(cartReducer(c, { type: "add", vendor: vendorB, line: item("z") })).toBe(c);
    const replaced = cartReducer(c, { type: "replace", vendor: vendorB, line: item("z") });
    expect(replaced.vendor?.id).toBe("b");
    expect(replaced.lines).toEqual([{ ...item("z"), quantity: 1 }]);
  });

  it("removes a line at quantity zero and empties the vendor when the last line goes", () => {
    let c = cartReducer(emptyCart, { type: "add", vendor: vendorA, line: item("x") });
    c = cartReducer(c, { type: "add", vendor: vendorA, line: item("y") });
    c = cartReducer(c, { type: "setQuantity", itemId: "x", quantity: 0 });
    expect(c.lines.map((l) => l.itemId)).toEqual(["y"]);
    expect(cartReducer(c, { type: "remove", itemId: "y" })).toEqual(emptyCart);
    expect(cartReducer(c, { type: "clear" })).toEqual(emptyCart);
  });

  it("reads stored carts safely", () => {
    const good = cartReducer(emptyCart, { type: "add", vendor: vendorA, line: item("x", 500) });
    expect(parseStoredCart(JSON.stringify(good))).toEqual(good);
    for (const bad of [null, "", "not json", "{}", '{"vendor":null,"lines":[]}', JSON.stringify({ ...good, lines: [{ ...good.lines[0], quantity: 999 }] }),
      JSON.stringify({ ...good, lines: [{ ...good.lines[0], priceKobo: -5 }] }), JSON.stringify({ ...good, vendor: { ...good.vendor, city: "PARIS" } }),
      JSON.stringify({ ...good, lines: "x" })]) {
      expect(parseStoredCart(bad)).toEqual(emptyCart);
    }
  });
});

describe("order status", () => {
  it("maps every status to a message and a step", () => {
    const all: OrderStatus[] = ["PENDING_PAYMENT", "PAID", "SEARCHING_RIDER", "ASSIGNED", "PICKED_UP", "DELIVERED", "CANCELLED", "PAYMENT_REVIEW"];
    for (const s of all) expect(statusMessage(s).title.length).toBeGreaterThan(0);
    expect(all.map(stepIndex)).toEqual([0, 1, 1, 2, 3, 4, -1, -1]);
    expect(STEPS).toHaveLength(5);
    expect(all.filter(isFinal)).toEqual(["DELIVERED", "CANCELLED"]);
  });

  it("only allows in-app redirects after sign-in", () => {
    expect(safeNext("/checkout")).toBe("/checkout");
    expect(safeNext("/orders/123?x=1")).toBe("/orders/123?x=1");
    for (const bad of [null, undefined, "", "https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)"]) expect(safeNext(bad)).toBe("/vendors");
  });
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api client", () => {
  it("sends the bearer token and the JSON body", async () => {
    const fetchImpl = vi.fn(async () => json(200, { ok: true }));
    const client = createApiClient({ baseUrl: "http://api", getToken: () => "tok", refresh: async () => null, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.post("/orders", { a: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api/orders");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(init.body).toBe('{"a":1}');
    expect(init.credentials).toBe("include");
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    let token = "old";
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) =>
      (init.headers as Record<string, string>).authorization === "Bearer new" ? json(200, { done: true }) : json(401, { error: { code: "UNAUTHENTICATED", message: "x" } }),
    );
    const refresh = vi.fn(async () => {
      token = "new";
      return token;
    });
    const client = createApiClient({ baseUrl: "http://api", getToken: () => token, refresh, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.get("/orders/mine")).toEqual({ done: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry and when refresh fails", async () => {
    const always401 = vi.fn(async () => json(401, { error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }));
    const refresh = vi.fn(async () => "fresh");
    const client = createApiClient({ baseUrl: "http://api", getToken: () => "t", refresh, fetchImpl: always401 as unknown as typeof fetch });
    await expect(client.get("/x")).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(always401).toHaveBeenCalledTimes(2);

    const noRefresh = createApiClient({ baseUrl: "http://api", getToken: () => null, refresh: async () => null, fetchImpl: always401 as unknown as typeof fetch });
    await expect(noRefresh.get("/x")).rejects.toBeInstanceOf(ApiError);
  });

  it("does not refresh for auth endpoints", async () => {
    const f = vi.fn(async () => json(401, { error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." } }));
    const refresh = vi.fn(async () => "x");
    const client = createApiClient({ baseUrl: "http://api", getToken: () => null, refresh, fetchImpl: f as unknown as typeof fetch });
    await expect(client.post("/auth/login", {}, { skipRefresh: true })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." });
    expect(refresh).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("turns network failures and odd bodies into friendly errors", async () => {
    const down = createApiClient({ baseUrl: "http://api", getToken: () => null, refresh: async () => null, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(down.get("/x")).rejects.toMatchObject({ status: 0, code: "NETWORK" });
    const html = createApiClient({ baseUrl: "http://api", getToken: () => null, refresh: async () => null, fetchImpl: (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch });
    await expect(html.get("/x")).rejects.toMatchObject({ status: 502, code: "ERROR", message: "Something went wrong. Please try again." });
  });
});
