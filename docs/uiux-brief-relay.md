# UI/UX design brief: RELAY

Builds on `prd-relay.md` and `user-journey-relay.md`.

## Audience and brand
- Audience: urban customers in Abuja and Lagos ordering on mobile, riders using a phone one-handed, an admin on desktop.
- Brand: midnight blue (#070B14) with warm amber (#FFB347), off-white text (#F4F1EA). Mood: night city, motion, trust.
- Direction (studied, never copied): scroll-driven video hero sites with a giant display word and glass cards, plus clean delivery-tracking apps.

## Screens and layout
**Landing (desktop 1920 and mobile 390):** full-bleed frame-sequence canvas, giant "RELAY" word, thin nav, headline "Move the city.", 3 glass cards (rider on the way, secure payment, on-time rate marked demo). 12-column grid with thin vertical lines; hero content padded 6vw; cards stack under the headline on mobile.
**Vendor grid:** 3 columns desktop, 1 column mobile, image-first cards with name, area and open/closed pill.
**Vendor menu and cart:** item list with sticky cart summary (bottom sheet on mobile).
**Checkout:** address, order summary, total in naira, single primary button.
**Tracking:** map takes 60% of the screen (full width on mobile), status stepper beneath, rider card with vehicle and ETA.
**Rider app:** large online toggle, offer card with a 30 s countdown ring, two-tap status buttons (min 48 px).
**Admin:** left nav, top KPI row (orders, revenue, active riders), live map, orders table with filters.
Breakpoints: 390, 768, 1280, 1920.

## Component inventory and states
- Button (primary, ghost, pill): default, hover, focus ring, pressed, loading, disabled.
- Glass card: default, hover lift, selected.
- Vendor card: default, hover, closed (dimmed with label), loading skeleton.
- Cart item: default, quantity change, removed, out of stock.
- Input: default, focus, error with message, disabled.
- Offer card: pending (countdown), accepted, expired, taken by another rider.
- Status stepper: pending, active, complete, error.
- Map marker (rider, vendor, drop): live, stale (greyed after 15 s without update), offline.
- Table: loading skeleton, empty ("No orders yet"), error with retry, populated.
- Toasts: success, warning, error.

## Typography and color tokens
- Display: Anton (condensed, uppercase) for the giant word; accent: Playfair Display Italic for second headline lines; body: Inter.
- Fluid sizes with clamp(); body 16 px minimum, line height 1.5.
- Tokens: `--bg #070B14`, `--surface rgba(255,255,255,0.06)`, `--border rgba(255,255,255,0.18)`, `--text #F4F1EA`, `--muted #A9B1C3`, `--accent #FFB347`, `--success #3DDC97`, `--danger #FF5C5C`.
- Light and dark: dark is default; a light variant swaps bg and text tokens for the admin tables.

## Motion
- Intro (0 to 2.4 s): video fade-up 0.6 s; letters of RELAY stagger 0.12 s, rise 40 px with blur to sharp, ease `power3.out`; nav and cards fade in at 1.8 s.
- Scroll: frame index mapped to scroll progress with Lenis smoothing; headline swaps at 25%, 50% and 75% with 0.4 s crossfades.
- Cards float 6 s loop, 6 px amplitude; tilt toward cursor up to 4 degrees (desktop only).
- Offer countdown ring animates linearly over 30 s.
- Reduced motion: static poster frame, no float or tilt, instant transitions.

## Accessibility
- Contrast AA on all text over video (add a gradient scrim behind copy).
- Full keyboard path through checkout and rider accept/decline; visible focus rings.
- Map is never the only status channel: stepper text always present.
- Buttons and toggles at least 48 px tap size; labels on all inputs; aria-live for status changes.
