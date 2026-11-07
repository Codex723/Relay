# User journey flow: RELAY

Builds on `prd-relay.md` and `trd-relay.md`.

## Journey 1: Customer places and tracks an order
```mermaid
flowchart TD
  A[Landing page: cinematic hero] --> B[Browse vendors]
  B --> C[View vendor items]
  C --> D[Add to cart]
  D --> E{Signed in?}
  E -- No --> F[Register or log in]
  F --> G[Checkout: address and summary]
  E -- Yes --> G
  G --> H[Paystack payment]
  H --> I{Payment confirmed by webhook?}
  I -- No, pending --> J[Confirming payment screen, poll verify]
  J --> I
  I -- Failed --> K[Retry payment or cancel]
  I -- Yes --> L[Finding a rider]
  L --> M[Rider assigned: live map]
  M --> N[Picked up]
  N --> O[Delivered: receipt and email]
```
**Narrative:** the visitor lands on the hero, scrolls into vendors, builds a cart, signs in, pays, waits on a short "finding a rider" state, then watches the rider move until delivery.
**Risk points:** payment redirect return (customer closes tab: order stays recoverable from "My orders"); long rider search (show progress and honest wording after 90 s); lost connection (auto-reconnect and refetch).

## Journey 2: Rider accepts and delivers
```mermaid
flowchart TD
  A[Rider logs in] --> B[Go online]
  B --> C[Waiting for jobs]
  C --> D[Offer card: pickup, drop, fee, 30 s timer]
  D -- Accept --> E{Still available?}
  E -- No --> C
  E -- Yes --> F[Navigate to vendor]
  D -- Decline or timeout --> C
  F --> G[Mark picked up]
  G --> H[Navigate to customer]
  H --> I[Mark delivered]
  I --> C
```
**Risk points:** two riders accept at once (loser sees "job taken" and returns to waiting); rider app loses connection (location stops, admin sees "last seen").

## Journey 3: Admin monitors and intervenes
```mermaid
flowchart TD
  A[Admin logs in] --> B[Dashboard: live map and orders table]
  B --> C{Stuck or flagged order?}
  C -- No --> B
  C -- Yes --> D[Open order detail and audit trail]
  D --> E[Reassign rider or contact customer]
  E --> F[Event logged]
  F --> B
  B --> G[Revenue and rider stats]
```
**Risk points:** payment review flag (admin must confirm amount mismatch); reassignment while rider is mid-trip (confirm dialog).
