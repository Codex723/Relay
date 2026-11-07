# Database schema: RELAY

Builds on `trd-relay.md`.

## Client and migrations
PostgreSQL on Neon. Migrations are plain SQL folders (`apps/api/db/migrations/NNN_name/up.sql` and `down.sql`) applied by a small runner (`npm run db:migrate`, `db:rollback`, `db:rollback:all`, `db:status`). Reason: the plan requires a tested rollback for every migration, and Prisma Migrate has no down migrations. Typed data access uses Kysely; its table types live in `apps/api/src/db/types.ts` and must be updated together with the migrations.

## Tables
**users:** id uuid pk, name text not null, email text unique not null, phone text, password_hash text not null, role enum(CUSTOMER, RIDER, ADMIN) not null, created_at timestamptz default now().
**vendors:** id uuid pk, name text not null, city enum(ABUJA, LAGOS) not null, address text, lat numeric(9,6), lng numeric(9,6), is_open boolean default true, created_at.
**items:** id uuid pk, vendor_id uuid fk vendors, name text not null, description text, price_kobo integer not null check (price_kobo >= 0), image_url text, is_available boolean default true.
**orders:** id uuid pk, customer_id fk users, vendor_id fk vendors, rider_id fk users null, status enum(PENDING_PAYMENT, PAID, SEARCHING_RIDER, ASSIGNED, PICKED_UP, DELIVERED, CANCELLED, PAYMENT_REVIEW) not null, subtotal_kobo int, delivery_fee_kobo int, total_kobo int not null, drop_address text, drop_lat numeric, drop_lng numeric, distance_m integer, paystack_reference text unique, created_at, updated_at.
**order_items:** id uuid pk, order_id fk orders on delete cascade, item_id fk items, quantity int check (quantity > 0), unit_price_kobo int not null.
**riders:** user_id uuid pk fk users, is_online boolean default false, current_lat numeric, current_lng numeric, last_seen_at timestamptz, vehicle_type text.
**dispatch_offers:** id uuid pk, order_id fk orders, rider_id fk users, status enum(PENDING, ACCEPTED, DECLINED, EXPIRED), offered_at timestamptz, expires_at timestamptz.
**payments:** id uuid pk, order_id fk orders unique, reference text unique not null, amount_kobo int not null, status text, raw_webhook jsonb, paid_at timestamptz.
**order_events:** id uuid pk, order_id fk orders, from_status, to_status, actor_id fk users null, created_at.

## Indexes (each tied to a hot query)
- `orders(customer_id, created_at desc)`: "My orders".
- `orders(status, created_at)`: admin table and dispatcher scan.
- `orders(rider_id)` unique partial where status in (ASSIGNED, PICKED_UP): one active order per rider.
- `riders(is_online)` plus lat/lng: nearest-rider lookup.
- `dispatch_offers(order_id, status)` and `(rider_id, status)`: offer handling.
- `items(vendor_id, is_available)`: menu listing.
- `payments(reference)` already unique: webhook idempotency.

## Integrity rules
- Order status changes only through one service function that validates the transition and writes order_events in the same transaction.
- Offer acceptance: `SELECT ... FOR UPDATE` on the order row, then check offer is PENDING and unexpired, then set ASSIGNED.
- Money is integer kobo everywhere; totals are recomputed server-side from items.
- Webhook handling is idempotent on `payments.reference`.
- Foreign keys use restrict by default; only order_items cascades with its order.

## Migrations and rollback
1. `001_users_vendors_items`: create the three tables; rollback drops them.
2. `002_orders_payments`: orders, order_items, payments, enums; rollback drops them in reverse order.
3. `003_riders_dispatch`: riders, dispatch_offers, partial unique index; rollback drops them.
4. `004_order_events`: audit table; rollback drops it.
5. `005_indexes`: remaining indexes; rollback drops the indexes.
6. `006_event_clock`: order_events.created_at defaults to clock_timestamp() instead of now(), so events written in one transaction keep their real order; rollback restores now().
7. `007_dispatch_state`: adds orders.dispatch_attempts, dispatch_next_at and dispatch_alerted_at, plus indexes for due orders and pending offer expiry; rollback drops them.
Each migration ships with a down script. All five were applied, rolled back one at a time and all at once, and reapplied on a real Postgres in step 3. `npm run db:check` verifies the integrity rules (one active order per rider, unique references, positive quantities, total = subtotal + fee).

## Access rules and pooling
Single-tenant, so no row-level security; authorization is enforced in the API (customers read only their own orders, riders only their assigned order and offers). Use Neon's pooled connection string for the API and the direct string for migrations.

## Environment variables (names only)
`DATABASE_URL`, `DELIVERY_BASE_FEE_KOBO`, `DELIVERY_PER_KM_KOBO`, `DELIVERY_MIN_FEE_KOBO`, `DIRECT_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `WEB_ORIGIN`, `RESEND_API_KEY`. Real values never committed; `.env.example` lists names with empty values.

## Seed and proof
Seed 6 vendors in Abuja and 3 in Lagos with items, 1 admin, 5 demo riders, 3 demo customers. Proof step: insert one vendor, read it back, and print the output before moving on.
