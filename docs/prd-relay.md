# PRD: RELAY

Delivery and dispatch platform for Abuja and Lagos, with a cinematic scroll-driven landing page. Portfolio project: seeded vendors and simulated riders are demo data.

## Problem statement
Ordering food or parcels in Nigerian cities means phone calls, unclear rider status and cash handling. Customers cannot see where an order is; vendors cannot dispatch reliably; riders get no fair job allocation.

## Success metrics (demo and portfolio)
- A customer can go from landing page to a paid order in under 3 minutes (measured in the E2E test run).
- 100% of paid orders reach a rider or alert the admin within 90 seconds (dispatcher test).
- Zero double-assigned orders and zero double-charged references in tests.
- Live tracking updates at least every 5 seconds in the demo.
- Lighthouse performance 80+ on the landing page (mobile).

## Users and roles
- Customer: orders, pays in naira, tracks the rider.
- Rider: goes online, accepts jobs, updates delivery status.
- Admin: monitors all orders on a live map, reassigns, sees revenue.

## User stories and acceptance criteria
1. As a customer, I browse vendors and add items to a cart. AC: items from one vendor per order; totals shown in naira; unavailable items cannot be added.
2. As a customer, I pay with Paystack. AC: order becomes PAID only after a verified webhook; a duplicate webhook does not create a second payment.
3. As a customer, I watch my rider on a map. AC: rider marker updates at least every 5 s; status text matches the order state.
4. As a rider, I toggle online and accept a job within 30 s. AC: if two riders accept at once, exactly one wins; a rider holds at most one active order.
5. As a rider, I mark picked up and delivered. AC: only valid state transitions are accepted.
6. As an admin, I see all orders and reassign a stuck one. AC: reassignment is logged in the audit trail.
7. As a visitor, I see the cinematic landing page. AC: scroll drives the video frames; a static fallback loads with reduced motion.

## Scope
**v1 ships:** landing page, auth with roles, vendors and items, cart, Paystack checkout, dispatcher, rider flow, live tracking with a rider simulator, admin dashboard, audit trail, CI, Docker, docs.
**v1 does not ship:** real GPS hardware, in-app chat, ratings, promo codes, multi-city pricing, refunds UI, push notifications.

## Data model changes
New system: users, vendors, items, orders, order_items, riders, dispatch_offers, payments, order_events. Detail in `database-schema-relay.md`.

## Edge cases and failure states
- Payment succeeds but webhook is late: customer sees "confirming payment" and the verify endpoint is polled.
- Duplicate or forged webhook: signature check and unique reference reject it.
- No rider online or all decline: after 3 rounds the admin is alerted and the customer sees "finding a rider".
- Rider goes offline mid-order: admin alert and manual reassign.
- Vendor closes after cart creation: checkout blocked with a clear message.
- Socket disconnect: client reconnects and re-fetches the order state.

## Decisions (confirmed 2026-11-03)
- Demo cities: Abuja first, then Lagos (vendors, riders and map centres for both; Abuja seeded first).
- Delivery fee: by distance. Default formula: 500 naira base + 150 naira per km, minimum 800 naira, rates set by env vars so they can change.
- Paystack: the owner has test keys ready (test mode only for the demo).
- Defaults unless changed: one vendor per order, dark map tiles, keep the name RELAY.

## Open questions
- Confirm the default fee rates (500 base, 150 per km, 800 minimum) or give your own.
- Which domain or subdomain will the demo live on (a Vercel subdomain is fine for v1)?
