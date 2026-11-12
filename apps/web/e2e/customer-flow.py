"""Manual browser test of the whole customer journey (Playwright for Python).

Run it against a running API and web app, both started with demo data (npm run db:seed -w @relay/api):
  API:  PORT=4040 WEB_ORIGIN=http://localhost:3040 PAYSTACK_SECRET_KEY=sk_test_... (and the usual database and JWT settings)
  Web:  NEXT_PUBLIC_API_URL=http://localhost:4040 npx next build && npx next start -p 3040
  Test: WEB_URL=http://localhost:3040 API_URL=http://localhost:4040 PAYSTACK_SECRET_KEY=sk_test_... python3 apps/web/e2e/customer-flow.py

It browses, fills a cart, signs up, pays with a signed test webhook, and drives a rider through the API while
checking that the page updates live. It is replaced by a @playwright/test suite in step 15 of the plan.
"""
import hashlib, hmac, json, os, re, sys, time, urllib.request, uuid
from playwright.sync_api import sync_playwright, expect

WEB = os.environ["WEB_URL"]; API = os.environ["API_URL"]; SECRET = os.environ["PAYSTACK_SECRET_KEY"]
SHOTS = "/tmp/e2e"
results = []

def ok(name):
    results.append(name); print("  ok  ", name, flush=True)

def api(method, path, token=None, body=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"content-type": "application/json", **(headers or {})}
    if token: h["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(API + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=10) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")

def naira(text): return float(re.sub(r"[^\d.]", "", text))

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page(); page.set_default_timeout(15000)
    problems = []
    rsc_noise = []
    IGNORE = ("cartocdn", "googleapis", "gstatic", "ERR_NAME_NOT_RESOLVED", "ERR_INTERNET_DISCONNECTED", "paystack")
    def on_console(m):
        if m.type != "error": return
        url = (m.location or {}).get("url", "")
        if any(i in m.text or i in url for i in IGNORE): return
        if m.text.startswith("Failed to fetch RSC payload"): rsc_noise.append(m.text.split("\n")[0]); return
        # The browser logs every failed request. These two are expected: signed-out visitors have no refresh cookie,
        # and the wrong-city pin is deliberately refused.
        if "Failed to load resource" in m.text and ((url.endswith("/auth/refresh") and "401" in m.text) or (url.endswith("/orders/quote") and "422" in m.text)): return
        problems.append(("console", m.text, url))
    page.on("console", on_console)
    page.on("pageerror", lambda e: problems.append(("pageerror", str(e))))

    # 1. Browse vendors
    page.goto(f"{WEB}/vendors?city=ABUJA")
    expect(page.get_by_role("heading", name="Vendors")).to_be_visible()
    expect(page.get_by_role("link", name=re.compile("Wuse Grill House"))).to_be_visible()
    page.screenshot(path=f"{SHOTS}/1-vendors.png"); ok("vendor grid lists Abuja vendors")
    page.get_by_role("link", name="Lagos").click()
    expect(page.get_by_role("link", name=re.compile("VI Seafood Deck"))).to_be_visible()
    expect(page.get_by_role("link", name=re.compile("Wuse Grill House"))).to_have_count(0)
    ok("Lagos tab shows Lagos vendors only")
    page.get_by_role("link", name="Abuja").click()

    # 2. Menu and cart
    page.get_by_role("link", name=re.compile("Wuse Grill House")).click()
    expect(page.get_by_text("Suya platter")).to_be_visible()
    expect(page.get_by_text("₦3,500.00").first).to_be_visible()
    page.get_by_role("button", name="Add Suya platter to cart").click()
    page.get_by_role("button", name="Add one more Suya platter").click()
    page.get_by_role("button", name="Add Zobo (500ml) to cart").click()
    expect(page.get_by_test_id("cart-count")).to_have_text("3")
    expect(page.get_by_text(re.compile(r"3 items · ₦7,800\.00"))).to_be_visible()
    page.screenshot(path=f"{SHOTS}/2-menu.png"); ok("menu: add items, stepper, cart bar shows 3 items and 7,800 naira")

    # one vendor per order
    page.goto(f"{WEB}/vendors?city=ABUJA")
    page.get_by_role("link", name=re.compile("Maitama Bites")).click()
    page.get_by_role("button", name=re.compile("^Add Fried plantain")).click()
    expect(page.get_by_role("alertdialog")).to_contain_text("One order is from one vendor")
    page.get_by_role("button", name="Keep my cart").click()
    expect(page.get_by_test_id("cart-count")).to_have_text("3")
    ok("adding from a second vendor asks first; keeping the cart leaves it unchanged")

    page.reload()
    expect(page.get_by_test_id("cart-count")).to_have_text("3"); ok("cart survives a page reload")

    page.goto(f"{WEB}/cart")
    expect(page.get_by_test_id("cart-subtotal")).to_have_text("₦7,800.00")
    page.screenshot(path=f"{SHOTS}/3-cart.png")
    page.get_by_role("link", name="Checkout").click()
    page.wait_for_url(re.compile(r"/login\?next=(%2F|/)checkout")); ok("checkout sends a signed-out visitor to sign in")

    # 3. Sign up, come back to checkout
    page.get_by_role("link", name="Create an account").click()
    email = f"e2e-{uuid.uuid4().hex[:10]}@relay.test"
    page.get_by_label("Full name").fill("E2E Customer"); page.get_by_label("Email").fill(email)
    page.get_by_label(re.compile("^Password")).fill("a-long-e2e-password")
    page.get_by_role("button", name="Create account").click()
    page.wait_for_url(re.compile(r"/checkout$")); ok("registering returns to checkout")
    page.reload()
    expect(page.get_by_role("heading", name="Checkout")).to_be_visible()
    assert "/login" not in page.url; ok("still signed in after a full reload (refresh cookie works)")

    # 4. Checkout
    pay = page.get_by_role("button", name=re.compile(r"^Pay"))
    expect(pay).to_be_disabled(); ok("pay is disabled until address and pin are set")
    page.get_by_label("Delivery address").fill("12 Test Street, Wuse 2")
    m = page.get_by_test_id("dropoff-map"); m.scroll_into_view_if_needed(); box = m.bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2 - 90)
    expect(page.get_by_test_id("pin-status")).to_contain_text("Pin set")
    expect(page.get_by_test_id("quote-total")).to_be_visible()
    sub = naira(page.get_by_test_id("quote-subtotal").inner_text()); fee = naira(page.get_by_test_id("quote-fee").inner_text()); total = naira(page.get_by_test_id("quote-total").inner_text())
    assert sub == 7800.0 and abs(sub + fee - total) < 0.005 and fee >= 800, (sub, fee, total)
    page.screenshot(path=f"{SHOTS}/4-checkout.png", full_page=True); ok(f"server quote shown: subtotal {sub}, fee {fee}, total {total}")

    page.get_by_text("Enter coordinates instead").click()
    page.get_by_label("Latitude").fill("6.45"); page.get_by_label("Longitude").fill("3.47")
    expect(page.get_by_role("alert").filter(has_text="different city")).to_be_visible()
    expect(pay).to_be_disabled(); ok("a Lagos pin for an Abuja vendor is refused with a clear message")
    page.get_by_label("Latitude").fill("9.0899"); page.get_by_label("Longitude").fill("7.4698")
    expect(page.get_by_test_id("quote-total")).to_be_visible(); ok("fixing the pin brings the quote back")

    # a rider comes online before payment so the offer is immediate
    s, r = api("POST", "/auth/login", body={"email": "rider1@relay.demo", "password": "relay-demo-123"}); rider = r["accessToken"]
    api("POST", "/rider/online", rider, {"lat": 9.0765, "lng": 7.4698})

    pay.click()
    page.wait_for_url(re.compile(r"/orders/[0-9a-f-]{36}\?payment=unavailable"))
    order_id = re.search(r"/orders/([0-9a-f-]{36})", page.url).group(1)
    expect(page.get_by_test_id("status-title")).to_have_text("Waiting for payment")
    expect(page.get_by_text("We could not start your payment just now")).to_be_visible()
    expect(page.get_by_test_id("cart-count")).to_have_count(0)
    page.screenshot(path=f"{SHOTS}/5-awaiting-payment.png"); ok("order created; Paystack unreachable is handled with a retry card; cart cleared")

    # 5. Payment arrives by signed webhook; the page must update by itself
    shown_total = naira(page.get_by_test_id("order-total").inner_text()); assert shown_total == total
    raw = json.dumps({"event": "charge.success", "data": {"reference": f"rly_{order_id.replace('-','')}_a1b2c3", "amount": int(round(total * 100)), "currency": "NGN"}})
    sig = hmac.new(SECRET.encode(), raw.encode(), hashlib.sha512).hexdigest()
    s, r = api("POST", "/payments/webhook", raw=raw.encode(), headers={"x-paystack-signature": sig}); assert s == 200 and r["outcome"] == "settled", (s, r)
    expect(page.get_by_test_id("status-title")).to_have_text("Finding a rider", timeout=10000)
    expect(page.get_by_text("Complete your payment")).to_have_count(0); ok("live: page moved to 'Finding a rider' with no reload")

    # 6. Rider accepts, moves, delivers
    for _ in range(40):
        s, r = api("GET", "/rider/offers/current", rider)
        if r and r.get("offer"): break
        time.sleep(0.25)
    offer = r["offer"]; assert offer["order"]["id"] == order_id
    s, r = api("POST", f"/rider/offers/{offer['offerId']}/accept", rider); assert s == 200, (s, r)
    expect(page.get_by_test_id("status-title")).to_have_text("Rider on the way to the vendor", timeout=10000)
    expect(page.get_by_test_id("rider-note")).to_have_text(re.compile("Waiting for your rider"))
    expect(page.locator(".map-dot--rider")).to_have_count(0); ok("live: rider assigned; map waits for the rider's location")

    api("POST", "/rider/location", rider, {"lat": 9.0780, "lng": 7.4700})
    expect(page.locator(".map-dot--rider")).to_have_count(1, timeout=10000)
    expect(page.get_by_test_id("rider-note")).to_contain_text("Rider last seen")
    first = page.locator(".leaflet-marker-icon").filter(has=page.locator(".map-dot--rider")).evaluate("e => e.style.transform")
    time.sleep(0.7); api("POST", "/rider/location", rider, {"lat": 9.0850, "lng": 7.4690})
    page.wait_for_function("(t) => { const e=[...document.querySelectorAll('.leaflet-marker-icon')].find(x=>x.querySelector('.map-dot--rider')); return e && e.style.transform !== t }", arg=first, timeout=10000)
    page.screenshot(path=f"{SHOTS}/6-tracking.png", full_page=True); ok("live: rider marker appears and then moves on the map")

    api("POST", f"/rider/orders/{order_id}/status", rider, {"status": "PICKED_UP"})
    expect(page.get_by_test_id("status-title")).to_have_text("On the way to you", timeout=10000)
    api("POST", f"/rider/orders/{order_id}/status", rider, {"status": "DELIVERED"})
    expect(page.get_by_test_id("status-title")).to_have_text("Delivered", timeout=10000)
    page.screenshot(path=f"{SHOTS}/7-delivered.png"); ok("live: picked up, then delivered")

    # 7. Orders list, access control, sign out
    page.get_by_role("link", name="Orders", exact=True).click()
    expect(page.get_by_role("link", name=re.compile("Wuse Grill House"))).to_contain_text("Delivered")
    page.screenshot(path=f"{SHOTS}/8-my-orders.png"); ok("my orders lists the delivered order")

    page.get_by_role("button", name=re.compile("Sign out")).click()
    expect(page.get_by_role("link", name="Sign in")).to_be_visible()
    page.goto(f"{WEB}/orders/{order_id}")
    page.wait_for_url(re.compile(r"/login\?next=%2Forders%2F")); ok("signed-out visitors cannot open an order; they are sent to sign in")

    other = ctx.new_page(); other.set_default_timeout(15000)
    other.goto(f"{WEB}/register?next=%2Forders%2F{order_id}")
    other.get_by_label("Full name").fill("Other Customer"); other.get_by_label("Email").fill(f"e2e-{uuid.uuid4().hex[:10]}@relay.test")
    other.get_by_label(re.compile("^Password")).fill("a-long-e2e-password"); other.get_by_role("button", name="Create account").click()
    expect(other.get_by_role("heading", name="Order not found")).to_be_visible(); ok("another customer sees 'Order not found' for this order")

    # 8. open-redirect guard
    other.get_by_role("button", name=re.compile("Sign out")).click()
    other.goto(f"{WEB}/login?next=https%3A%2F%2Fevil.example")
    other.get_by_label("Email").fill("customer1@relay.demo"); other.get_by_label("Password").fill("relay-demo-123"); other.get_by_role("button", name="Sign in").click()
    other.wait_for_url(re.compile(r"/vendors$")); ok("a login link to another site is ignored (stays in the app)")

    # 9. Click-only navigation (no forced page jumps) must be completely quiet
    strict = browser.new_context(viewport={"width": 390, "height": 844}).new_page(); strict.set_default_timeout(15000)
    quiet = []
    def on_strict(m):
        if m.type != "error": return
        url = (m.location or {}).get("url", "")
        if any(i in m.text or i in url for i in IGNORE): return
        if "Failed to load resource" in m.text and url.endswith("/auth/refresh") and "401" in m.text: return
        quiet.append((m.text.split("\n")[0], url))
    strict.on("console", on_strict); strict.on("pageerror", lambda e: quiet.append(("pageerror", str(e))))
    strict.goto(f"{WEB}/"); strict.wait_for_load_state("networkidle")
    strict.get_by_role("link", name="Browse vendors").click(); expect(strict.get_by_role("heading", name="Vendors")).to_be_visible()
    strict.get_by_role("link", name=re.compile("Wuse Grill House")).click(); expect(strict.get_by_text("Suya platter")).to_be_visible()
    strict.get_by_role("button", name="Add Suya platter to cart").click()
    strict.get_by_role("link", name="Vendors").first.click(); expect(strict.get_by_role("heading", name="Vendors")).to_be_visible()
    strict.get_by_role("link", name="Cart").first.click(); expect(strict.get_by_test_id("cart-subtotal")).to_be_visible()
    strict.get_by_role("link", name="Sign in").click(); expect(strict.get_by_role("heading", name="Sign in")).to_be_visible()
    strict.wait_for_timeout(1500)
    assert not quiet, quiet
    ok("click-only navigation across 6 screens is free of console errors")

    # desktop look
    d = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()
    d.goto(f"{WEB}/vendors?city=ABUJA"); d.screenshot(path=f"{SHOTS}/9-desktop-vendors.png")
    d.goto(f"{WEB}/vendors"); d.get_by_role("link", name=re.compile("Wuse Grill House")).click(); d.screenshot(path=f"{SHOTS}/10-desktop-menu.png")
    browser.close()

    print("\nAborted-prefetch notes during forced page jumps (harmless):", len(rsc_noise))
    print("Unexpected console/page errors:", problems or "none")
    assert not problems, problems
    print(f"\n{len(results)} checks passed")
