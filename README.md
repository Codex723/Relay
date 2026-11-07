# RELAY

Delivery and dispatch platform for Abuja and Lagos, with a cinematic scroll-driven landing page.
Planning documents live in `docs/`. Build follows `docs/implementation-plan-relay.md`, one step at a time.

## Layout
- `apps/web`: Next.js frontend
- `apps/api`: Express API (Socket.IO added in step 10)
- `packages/shared`: shared types and Zod schemas

## Run
```bash
cp .env.example .env
npm install
npm run dev   # web on :3000, api on :4000
```
## Docker
```bash
docker compose up --build   # Postgres on :5432, API on :4000
```

## Secrets
Generate both JWT secrets and put them in `.env`:
```bash
openssl rand -hex 32   # run twice: JWT_SECRET and JWT_REFRESH_SECRET
```

## Auth
`POST /auth/register` (CUSTOMER or RIDER only), `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`.
Admin accounts are never created through the API; the seed creates `admin@relay.demo`.

## Orders and vendors
`GET /vendors`, `GET /vendors/:id/items` (public); `POST /orders/quote`, `POST /orders`, `GET /orders/mine`, `GET /orders/:id` (customer). Prices, delivery fee and totals are always computed on the server.

## Payments (Paystack, test mode)
1. Put your **test** secret key in `.env` as `PAYSTACK_SECRET_KEY` (the API refuses live keys outside production).
2. `POST /orders` creates the order and returns `payment.authorizationUrl`; send the customer there. If Paystack is unreachable, `payment` is `null` and `POST /orders/:id/pay` retries.
3. Paystack calls `POST /payments/webhook` when a payment succeeds. In the Paystack dashboard set the test webhook URL to `https://<your-api-host>/payments/webhook`. To try it locally, expose port 4000 with a tunnel (for example `cloudflared tunnel --url http://localhost:4000` or ngrok) and use that URL.
4. If the webhook is late, the web app can call `GET /payments/verify/:reference`.

Paystack test cards are listed in Paystack's docs. Payments are only trusted after the webhook signature and exact amount are verified.

## Dispatch
When an order is paid it is offered to the nearest eligible rider for 30 seconds. An offer that is declined or expires, or a moment with no rider available, counts as a failed round; after 3 failed rounds the order is flagged for an admin (`orders.dispatch_alerted_at`) and automatic offers stop. See the DISPATCH_* settings in `.env.example`. Set `DISPATCH_ENABLED=false` to turn it off.

## Order status changes
All status changes go through `transitionOrder` in `apps/api/src/orders/transitions.ts`; the allowed transitions are listed in `docs/trd-relay.md`. Never update `orders.status` directly.

## Tests
```bash
npm test -w @relay/api   # needs a migrated database in DATABASE_URL
```

## Database
```bash
docker compose up -d db
cp .env.example .env
npm run db:migrate -w @relay/api    # apply all migrations
npm run db:seed -w @relay/api       # demo data (password: relay-demo-123)
npm run db:check -w @relay/api      # verify integrity rules
npm run db:rollback -w @relay/api   # undo the latest migration
```

## Checks (same as CI)
```bash
npm run lint && npm run build && npm run typecheck
```

API health check: `GET http://localhost:4000/health`
