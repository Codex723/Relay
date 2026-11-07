# TRD: RELAY (spec-driven)

Source of truth for behavior. If implementation must deviate: stop, update this spec, get approval, continue. Builds on `prd-relay.md`.

## Context
Portfolio-grade delivery platform used by three roles; must show payments, real-time and race-safe data handling.

## Stack and architecture
- Frontend: Next.js (App Router), TypeScript, Tailwind CSS, GSAP ScrollTrigger, Lenis. Deployed on Vercel. Reason: matches the user's stack and fast static delivery for the cinematic page.
- API: Node.js, Express, TypeScript, Socket.IO. Deployed on Render. Reason: Vercel does not hold long-lived WebSocket connections.
- Database: PostgreSQL on Neon with SQL up/down migrations. Reason: relational integrity for orders and payments, and real rollbacks. Typed data access: Kysely over `pg`.
- Payments: Paystack (initialize, verify, webhook).
- Maps: Leaflet with OpenStreetMap tiles.
- Email: Resend or EmailJS for receipts.
- Monorepo: `apps/web`, `apps/api`, `packages/shared` (types and Zod schemas).

## Behavior spec (given / when / then)
**Auth**
- Given valid input, when POST /auth/register, then 201 with the user and an access token, and a refresh cookie is set. Only CUSTOMER and RIDER roles can be requested (ADMIN returns 400); a RIDER also gets a riders row. A duplicate email returns 409.
- Given valid credentials, when POST /auth/login, then 200 with JWT (15 min) and refresh cookie (HttpOnly, 7 days, SameSite None and Secure in production).
- Given the refresh cookie, when POST /auth/refresh, then 200 with a new access token. Access and refresh tokens use different secrets and are not interchangeable.
- Known limitation (v1): refresh tokens are stateless, so logout clears the cookie but does not revoke a stolen token before it expires.
- Given a wrong password, then 401 with generic message.
- Given a rider token, when calling an admin route, then 403.

**Order creation**
- Given a cart from one open vendor, when POST /orders, then order is created PENDING_PAYMENT, totals computed server-side from current item prices, and a Paystack authorization URL is returned.
- Given an unavailable item or closed vendor, then 409 with the reason.
- Given client-supplied prices, then they are ignored.
- Given a vendor and drop-off point, then delivery fee = max(MIN_FEE, BASE_FEE + PER_KM * distance_km), where distance is straight-line (Haversine) rounded up to 0.1 km, computed server-side. Defaults: BASE_FEE 50000 kobo, PER_KM 15000 kobo, MIN_FEE 80000 kobo, all from env vars.
- Given a vendor and drop-off in different cities, then 422 CITY_MISMATCH. A city is the nearest city centre within 60 km of the point; a drop-off outside both returns 422 OUTSIDE_SERVICE_AREA.
- Order creation returns the order as PENDING_PAYMENT and writes the first order_events row. The Paystack authorization URL is added in step 6.
- Rejections: unknown vendor 404, closed vendor 409 VENDOR_CLOSED, unavailable item 409 ITEM_UNAVAILABLE, item from another vendor 422 INVALID_ITEMS, more than 20 of one item 400 QUANTITY_TOO_HIGH. Repeated items are merged into one line.

**Payment**
- Given a valid signed webhook for an unpaid order, then payment row stored, order moves PAID then SEARCHING_RIDER, in one transaction, with an order_events row for each step.
- Payment references look like `rly_<order id without dashes>_<6 hex>`, so every payment traces back to its order and a retry gets a fresh reference. The amount sent to Paystack always comes from the stored order total.
- Given Paystack is unreachable when an order is created, then the order is still created with `payment: null` and POST /orders/:id/pay retries (502 if still down, 409 if the order is no longer PENDING_PAYMENT).
- Given the webhook is late, GET /payments/verify/:reference asks Paystack and settles the order the same way, once (owner or admin only, other users get 404).
- Webhook events other than charge.success, and references that match no order, are acknowledged with 200 and ignored so Paystack stops retrying.
- Known limitation (v1): `payments.order_id` is unique, so a second successful payment for an already-paid order is only logged (not stored) and needs a manual refund in Paystack.
- Given a duplicate reference, then 200 and no state change.
- Given an invalid signature, then 401 and nothing stored.
- Given amount mismatch, then order flagged PAYMENT_REVIEW and admin alerted.

**Dispatch**
- A **round** is one attempt to find a rider. It fails when an offer is declined, an offer expires, or no rider is available. After 3 failed rounds (`DISPATCH_MAX_ROUNDS`) the order is flagged (`dispatch_alerted_at`), the admin is alerted once, and automatic offers stop for that order until an admin resets it or reassigns.
- Given SEARCHING_RIDER, then the nearest eligible rider receives an offer with a 30 s expiry. Eligible means: online, seen within 120 s, has coordinates, within 15 km of the vendor, no ASSIGNED or PICKED_UP order, no other open offer, and never offered this order before.
- Given no eligible rider, then the round fails and the next attempt waits 20 s, so a short gap does not alert the admin at once.
- After a decline or an expiry, the next rider is offered immediately. Declining is allowed only for the rider who holds the offer and only while it is open (404 or 409 otherwise).
- Concurrency: the order and the chosen rider are locked while an offer is created, so one order never gets two open offers and one rider never holds two.
- A background loop runs every 2 s to expire offers and to pick up orders that are due, so nothing depends on in-memory timers and a restart loses nothing. An order is also offered immediately after payment. `DISPATCH_ENABLED=false` switches the loop and the post-payment offer off.
- Moving an order back to SEARCHING_RIDER (rider dropped, reassigned) resets its dispatch record.
- Given an accept, when the offer is PENDING and unexpired, then order becomes ASSIGNED under a row lock; other offers are cancelled.
- Given two simultaneous accepts, then exactly one succeeds and the other gets 409.
- Given decline or expiry, then the next nearest rider is offered; after 3 rounds the admin is alerted.

**Order state machine** (every status change goes through one function, `transitionOrder`, inside a transaction)
| From | Allowed next states |
|------|---------------------|
| PENDING_PAYMENT | PAID, PAYMENT_REVIEW, CANCELLED |
| PAYMENT_REVIEW | PAID, CANCELLED (an admin decides) |
| PAID | SEARCHING_RIDER, CANCELLED |
| SEARCHING_RIDER | ASSIGNED, CANCELLED |
| ASSIGNED | PICKED_UP, SEARCHING_RIDER (rider dropped or reassigned), CANCELLED |
| PICKED_UP | DELIVERED |
| DELIVERED, CANCELLED | none (final) |
- Any other change returns 422 INVALID_TRANSITION and changes and logs nothing. Moving to the same state is also invalid.
- The order row is locked first, so simultaneous changes are applied one at a time and later ones are checked against the new state.
- ASSIGNED requires a rider (422 RIDER_REQUIRED) who must have the RIDER role (422 INVALID_RIDER). A rider who already has an ASSIGNED or PICKED_UP order gets 409 RIDER_BUSY and nothing changes. Going back to SEARCHING_RIDER clears the rider.
- Every successful transition writes one order_events row (from, to, actor; actor is null for system changes) in the same transaction, and `updated_at` is refreshed.

**Delivery**
- Given the assigned rider, when marking PICKED_UP then DELIVERED, then transitions are accepted only in order; any other attempt returns 422.

**Tracking**
- Given an active order, rider location events are broadcast to `order:{id}` at most every 3 s; clients receive only their own order's room.

## API contract
All responses JSON. Errors: `{ "error": { "code": string, "message": string } }`. Status codes: 200, 201, 401, 403, 404, 409, 422, 429, 500.
- Auth: POST /auth/register, POST /auth/login, GET /auth/me
- Public: GET /vendors (optional `?city=ABUJA|LAGOS`, includes closed vendors flagged `isOpen: false`), GET /vendors/:id/items (includes unavailable items flagged)
- Customer: POST /orders/quote (prices a cart without creating an order), POST /orders, GET /orders/:id, GET /orders/mine. Someone else's order returns 404, not 403, so ids cannot be probed.
- Payments: POST /orders/:id/pay (customer), POST /payments/webhook, GET /payments/verify/:reference
- Rider: POST /rider/online, POST /rider/offline, POST /rider/location, POST /rider/offers/:id/accept, POST /rider/offers/:id/decline, POST /rider/orders/:id/status
- Admin: GET /admin/orders, POST /admin/orders/:id/assign, GET /admin/stats
Request and response schemas live in `packages/shared` as Zod types and are published as OpenAPI.

## Data
Schema changes and migrations are specified in `database-schema-relay.md`.

## UI states
Every screen defines loading, empty, error and success states (see `uiux-brief-relay.md`).

## Non-functional requirements
- Security: bcrypt or argon2 hashing, JWT with short expiry, input validation with Zod on every route, rate limiting on auth, order creation and webhook endpoints, CORS locked to the web origin, no secrets in the repo, webhook signature verified with HMAC SHA-512.
- Reliability: idempotent webhook handling; transactions for state changes.
- Performance: API p95 under 300 ms for reads in the demo; landing page under 15 MB of assets, first 30 frames preloaded.
- Accessibility: WCAG AA contrast, keyboard navigation, reduced-motion fallback.
- Logging: structured logs, no card data or tokens in logs.

## Third-party failure handling
- Paystack down: order stays PENDING_PAYMENT and customer can retry; no rider search.
- Map tiles down: list view of status remains usable.
- Socket failure: polling fallback every 10 s.

## Non-goals
Real GPS hardware, chat, ratings, promo codes, multi-city pricing, refund UI, native apps.

## Acceptance checklist
- [ ] Customer pays in Paystack test mode and the order reaches ASSIGNED in the demo.
- [ ] Duplicate webhook test passes.
- [ ] Forged webhook rejected.
- [ ] Two-riders-accept race test passes.
- [ ] Invalid state transitions rejected and logged.
- [ ] Rider simulator moves markers on customer and admin maps.
- [ ] Role checks verified for every route.
- [ ] Landing page works with reduced motion and on 390 px width.
- [ ] CI green: lint, typecheck, tests.
- [ ] `docker compose up` starts API and database.
